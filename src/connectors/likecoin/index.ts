import * as Sentry from '@sentry/node'
import axios, { AxiosRequestConfig } from 'axios'
import Knex from 'knex'
import _ from 'lodash'

import { environment } from 'common/environment'
import { fromGlobalId, toGlobalId } from 'common/utils'
import { knex, UserService } from 'connectors'
import { UserOAuthLikeCoin } from 'definitions'

const {
  likecoinApiURL,
  likecoinMigrationApiURL,
  likecoinClientId,
  likecoinClientSecret
} = environment

type LikeCoinLocale =
  | 'en'
  | 'zh'
  | 'cn'
  | 'de'
  | 'es'
  | 'fr'
  | 'it'
  | 'ja'
  | 'ko'
  | 'pt'
  | 'ru'

type RequestProps = {
  endpoint: string
  liker?: UserOAuthLikeCoin
  withClientCredential?: boolean
} & AxiosRequestConfig

const ENDPOINTS = {
  acccessToken: '/oauth/access_token',
  check: '/users/new/check',
  register: '/users/new/matters',
  edit: '/users/edit/matters',
  total: '/like/info/like/history/total',
  generateTempLikers: '/user',
  transferPendingLIKE: '/like',
  like: '/like/likebutton'
}

export class LikeCoin {
  knex: Knex

  constructor() {
    this.knex = knex
  }

  /**
   * Base Request
   */
  request = async ({
    endpoint,
    liker,
    withClientCredential,
    ...axiosOptions
  }: RequestProps) => {
    const makeRequest = ({ accessToken }: { accessToken?: string }) => {
      // Headers
      let headers = {}
      if (accessToken) {
        headers = {
          ...headers,
          Authorization: `Bearer ${accessToken}`
        }
      }

      // Params
      let params = {}
      if (withClientCredential) {
        if (axiosOptions.method === 'GET') {
          params = {
            ...params,
            client_id: likecoinClientId,
            client_secret: likecoinClientSecret
          }
        } else if (axiosOptions.data) {
          axiosOptions.data = {
            ...axiosOptions.data,
            client_id: likecoinClientId,
            client_secret: likecoinClientSecret
          }
        }
      }

      return axios({
        url: endpoint,
        baseURL: likecoinApiURL,
        params,
        headers,
        ...axiosOptions
      })
    }

    try {
      return await makeRequest({
        accessToken: liker ? liker.accessToken : undefined
      })
    } catch (e) {
      // refresh token and retry once
      if (liker && _.get(e, 'response.data') === 'TOKEN_EXPIRED') {
        const accessToken = await this.refreshToken({ liker })
        return makeRequest({ accessToken })
      } else {
        console.error(e)
        Sentry.captureException(e)
        throw e
      }
    }
  }

  refreshToken = async ({
    liker
  }: {
    liker: UserOAuthLikeCoin
  }): Promise<string> => {
    const res = await this.request({
      endpoint: ENDPOINTS.acccessToken,
      withClientCredential: true,
      method: 'POST',
      data: {
        grant_type: 'refresh_token',
        refresh_token: liker.refreshToken
      }
    })

    // update db
    const data = _.get(res, 'data')
    try {
      await this.knex('user_oauth_likecoin')
        .where({ likerId: liker.likerId })
        .update({
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          scope: data.scope,
          updatedAt: new Date()
        })
    } catch (e) {
      console.error(e)
      Sentry.captureException(e)
    }

    return data.access_token
  }

  /**
   * Register
   */
  check = async ({ user, email }: { user: string; email?: string }) => {
    try {
      const res = await this.request({
        endpoint: ENDPOINTS.check,
        method: 'POST',
        data: {
          user,
          email
        }
      })
      const data = _.get(res, 'data')

      if (data === 'OK') {
        return user
      } else {
        throw res
      }
    } catch (e) {
      const data = _.get(e, 'response.data')
      const alternative = _.get(data, 'alternative')

      if (alternative) {
        return alternative
      }

      throw e
    }
  }

  register = async ({
    user,
    token,
    displayName,
    email,
    locale = 'zh',
    isEmailEnabled
  }: {
    user: string
    token: string
    displayName?: string
    email?: string
    locale?: LikeCoinLocale
    isEmailEnabled?: boolean
  }) => {
    const res = await this.request({
      endpoint: ENDPOINTS.register,
      withClientCredential: true,
      method: 'POST',
      data: {
        user,
        token,
        displayName,
        email,
        locale,
        isEmailEnabled
      }
    })
    const data = _.get(res, 'data')

    if (data.accessToken && data.refreshToken) {
      return data
    } else {
      throw res
    }
  }

  /**
   * Claim, Transfer or Bind
   */
  edit = async ({
    action,
    payload
  }: {
    action: 'claim' | 'transfer' | 'bind'
    payload: { [key: string]: any }
  }) => {
    const res = await this.request({
      endpoint: ENDPOINTS.edit,
      withClientCredential: true,
      method: 'POST',
      data: {
        action,
        payload
      }
    })
    const data = _.get(res, 'data')

    if (!data) {
      throw res
    }

    return
  }

  /**
   * Info
   */
  total = async ({ liker }: { liker: UserOAuthLikeCoin }) => {
    const res = await this.request({
      endpoint: ENDPOINTS.total,
      method: 'GET',
      liker
    })
    const data = _.get(res, 'data')

    if (!data) {
      throw res
    }

    return data.total
  }

  /**
   * Migrations
   */
  // generate temporal likerId for users
  generateTempUsers = async ({
    step,
    userIds
  }: {
    step: number
    userIds?: string[]
  }) => {
    const userService = new UserService()
    const users = await userService.findNoLikerIdUsers({ limit: step, userIds })

    // normalize users for request body
    const normalizedUsers = users.map(({ id, userName }) => ({
      userId: userName,
      dbId: toGlobalId({ type: 'User', id })
    }))

    if (normalizedUsers.length <= 0) {
      return
    }

    const res = await this.request({
      baseURL: likecoinMigrationApiURL,
      endpoint: ENDPOINTS.generateTempLikers,
      withClientCredential: true,
      method: 'POST',
      data: {
        users: normalizedUsers
      }
    })
    const data = _.get(res, 'data')

    if (!data || data.length !== users.length) {
      throw res
    }

    // save
    await Promise.all(
      data.map(async ({ dbId, likerId, accessToken, refreshToken }: any) => {
        const userId = fromGlobalId(dbId).id

        await userService.saveLiker({
          userId,
          likerId,
          accessToken,
          refreshToken,
          accountType: 'temporal'
        })
      })
    )
  }

  // transfer user's MAT to pending LIKE
  transferLIKE = async ({
    step,
    userIds
  }: {
    step: number
    userIds?: string[]
  }) => {
    const MAT_TO_LIKE_RATE = 10
    const userService = new UserService()
    const users = await userService.findNoPendingLIKEUsers({
      limit: step,
      userIds
    })

    // normalize users for request body
    const normalizedUsers = users
      .filter(({ mat }) => mat > 0)
      .map(({ mat: MAT, likerId }) => ({
        likerId,
        pendingLIKE: parseInt(MAT || 0, 10) * MAT_TO_LIKE_RATE
      }))

    if (normalizedUsers.length <= 0) {
      return
    }

    const res = await this.request({
      baseURL: likecoinMigrationApiURL,
      endpoint: ENDPOINTS.transferPendingLIKE,
      withClientCredential: true,
      method: 'POST',
      data: {
        users: normalizedUsers
      }
    })
    const data = _.get(res, 'data')

    if (!data || data.length !== users.length) {
      throw res
    }

    // save
    await Promise.all(
      data.map(async ({ likerId, pendingLIKE }: any) => {
        await userService.updateLiker({
          likerId,
          pendingLike: pendingLIKE
        })
      })
    )
  }

  /**
   * Like a content.
   */
  like = async ({
    authorLikerId,
    liker,
    url,
    amount
  }: {
    authorLikerId: string
    liker: UserOAuthLikeCoin
    url: string
    amount: number
  }) => {
    try {
      const endpoint = `${ENDPOINTS.like}/${authorLikerId}/${amount}`
      const result = await this.request({
        endpoint,
        withClientCredential: true,
        method: 'POST',
        liker,
        data: {
          referrer: url
        }
      })
      const data = _.get(result, 'data')
      if (data === 'OK') {
        return true
      } else {
        throw result
      }
    } catch (error) {
      throw error
    }
  }
}

export const likecoin = new LikeCoin()
