import { BaseService } from './baseService'
import logger from 'common/logger'
import { BATCH_SIZE } from 'common/enums'

export class SystemService extends BaseService {
  constructor() {
    super('noop')
  }

  /*********************************
   *                               *
   *           Search              *
   *                               *
   *********************************/
  frequentSearch = async ({
    key = '',
    first = 5
  }: {
    key?: string
    first?: number
  }) => {
    const result = await this.knex('search_history')
      .select('search_key')
      .count('id')
      .where('search_key', 'like', `%${key}%`)
      .whereNot({ searchKey: '' })
      .groupBy('search_key')
      .orderBy('count', 'desc')
      .limit(first)

    return result.map(({ searchKey }: { searchKey: string }) => searchKey)
  }

  /*********************************
   *                               *
   *              Asset            *
   *                               *
   *********************************/
  /**
   * Create asset and asset_map
   */
  createAssetAndAssetMap = async (
    asset: { [key: string]: any },
    entityTypeId: string,
    entityId: string
  ): Promise<any> =>
    await this.knex.transaction(async trx => {
      const [newAsset] = await trx
        .insert(asset)
        .into('asset')
        .returning('*')

      await trx
        .insert({
          assetId: newAsset.id,
          entityTypeId,
          entityId
        })
        .into('asset_map')

      return newAsset
    })

  /**
   * Find asset by a given uuid
   */
  findAssetByUUID = async (uuid: string) => this.baseFindByUUID(uuid, 'asset')

  /**
   * Find assets by given uuids
   */
  findAssetByUUIDs = async (uuids: string[]) =>
    this.baseFindByUUIDs(uuids, 'asset')

  /**
   * Find the url of an asset by a given id.
   */
  findAssetUrl = async (id: string): Promise<string | null> => {
    const result = await this.baseFindById(id, 'asset')
    return result && result.path
      ? `${this.aws.s3Endpoint}/${result.path}`
      : null
  }

  /**
   * Find assets by a given report id
   */
  findAssetsByReportId = async (reportId: string) => {
    const reportAssets = await this.knex('report_asset')
      .select()
      .where({ reportId })
    const assets = await this.baseFindByIds(
      reportAssets.map(({ assetId }: { assetId: string }) => assetId),
      'asset'
    )
    return assets.map(
      ({ path }: { path: string }) =>
        path ? `${this.aws.s3Endpoint}/${path}` : null
    )
  }

  /**
   * Find asset map by given entity type and id
   */
  findAssetMap = async (entityTypeId: string, entityId: string) =>
    this.knex('asset_map')
      .select('asset_id', 'uuid', 'path', 'entityId')
      .where({ entityTypeId, entityId })
      .rightJoin('asset', 'asset_map.asset_id', 'asset.id')

  /**
   * Update asset map by given entity type and id
   */
  replaceAssetMapEntityTypeAndId = async (
    oldEntityTypeId: string,
    oldEntityId: string,
    newEntityTypeId: string,
    newEntityId: string
  ) =>
    this.knex('asset_map')
      .where({
        entityTypeId: oldEntityTypeId,
        entityId: oldEntityId
      })
      .update({
        entityTypeId: newEntityTypeId,
        entityId: newEntityId
      })

  /**
   * Delete asset and asset map by a given id
   */
  deleteAssetAndAssetMap = async (ids: string[]) =>
    await this.knex.transaction(async trx => {
      await trx('asset_map')
        .whereIn('asset_id', ids)
        .del()

      await trx('asset')
        .whereIn('id', ids)
        .del()
    })

  /*********************************
   *                               *
   *             Report            *
   *                               *
   *********************************/
  findReportById = async (reportId: string) =>
    this.knex('report')
      .select()
      .where({ id: reportId })
      .first()

  findReports = async ({
    comment,
    article,
    offset = 0,
    limit = BATCH_SIZE
  }: {
    comment: boolean
    article: boolean
    offset?: number
    limit?: number
  }) => {
    let qs = this.knex('report')
      .select()
      .orderBy('id', 'desc')

    if (comment) {
      qs = qs.whereNotNull('comment_id')
    }
    if (article) {
      qs = qs.orWhereNotNull('article_id')
    }
    if (offset) {
      qs = qs.offset(offset)
    }
    if (limit) {
      qs = qs.limit(limit)
    }

    return qs
  }

  countReports = async ({
    comment,
    article
  }: {
    comment: boolean
    article: boolean
  }) => {
    let qs = this.knex('report')
      .count()
      .first()

    if (comment) {
      qs = qs.whereNotNull('comment_id')
    }
    if (article) {
      qs = qs.orWhereNotNull('article_id')
    }

    const result = await qs
    return parseInt(result.count, 10)
  }

  /*********************************
   *                               *
   *             Feedback          *
   *                               *
   *********************************/
  feedback = async ({
    userId,
    category,
    description,
    contact,
    assetIds
  }: {
    userId?: string | null
    category: string
    description?: string
    contact?: string
    assetIds?: string[]
  }): Promise<void> => {
    // create feedback
    const { id: feedbackId } = await this.baseCreate(
      {
        userId,
        category,
        description,
        contact
      },
      'feedback'
    )
    // create feedback assets
    if (!assetIds || assetIds.length <= 0) {
      return
    }
    const reportAssets = assetIds.map(assetId => ({
      feedbackId,
      assetId
    }))
    await this.baseBatchCreate(reportAssets, 'feedback_asset')
  }

  /*********************************
   *                               *
   *             Feedback          *
   *                               *
   *********************************/
}
