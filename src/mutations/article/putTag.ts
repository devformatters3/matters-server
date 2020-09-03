import _replace from 'lodash/replace'
import _some from 'lodash/some'
import _trim from 'lodash/trim'
import _uniq from 'lodash/uniq'

import { USER_STATE } from 'common/enums'
import {
  AssetNotFoundError,
  AuthenticationError,
  DuplicateTagError,
  ForbiddenByStateError,
  ForbiddenError,
  TagNotFoundError,
  UserInputError,
} from 'common/errors'
import { fromGlobalId } from 'common/utils'
import { MutationToPutTagResolver } from 'definitions'

const resolver: MutationToPutTagResolver = async (
  root,
  { input: { id, content, cover, description } },
  { viewer, dataSources: { systemService, tagService, userService } }
) => {
  if (!viewer.id) {
    throw new AuthenticationError('visitor has no permission')
  }

  if (viewer.state === USER_STATE.frozen) {
    throw new ForbiddenByStateError(`${viewer.state} user has no permission`)
  }

  // check if cover exists when receving parameter cover
  let coverId
  if (cover) {
    const asset = await systemService.findAssetByUUID(cover)
    if (!asset || asset.type !== 'tagCover' || asset.authorId !== viewer.id) {
      throw new AssetNotFoundError('tag cover asset does not exists')
    }
    coverId = asset.id
  } else if (cover === null) {
    coverId = null
  }

  const tagContent = content ? _trim(content) : ''

  if (!id) {
    // create tag
    // check tag content
    if (!tagContent) {
      throw new UserInputError('"content" is required in creation')
    }

    // check if any same tag content exists
    const tags = await tagService.findByContent({ content: tagContent })
    if (tags.length > 0) {
      throw new DuplicateTagError(`dulpicate tag content: ${tagContent}`)
    }

    const matty = (
      await userService.baseFind({
        where: { email: 'hi@matters.news', role: 'admin', state: 'active' },
        limit: 1,
      })
    )[0]

    const newTag = await tagService.create({
      content: tagContent,
      creator: viewer.id,
      description,
      editors: _uniq([matty.id, viewer.id]),
      cover: coverId,
    })

    return newTag
  } else {
    // update tag
    const { id: dbId } = fromGlobalId(id)
    const tag = await tagService.baseFindById(dbId)
    if (!tag) {
      throw new TagNotFoundError('tag not found')
    }

    const admin = 'hi@matters.news'
    const normalEditors = (await userService.baseFindByIds(tag.editors)).filter(
      (user) => user.email !== admin
    )

    // update only allow: editor, creator, matty
    const isEditor = _some(tag.editors, (editor) => editor === viewer.id)
    const isCreator = tag.creator === viewer.id
    const isMatty = viewer.email === admin
    const isMaintainer =
      isEditor || (normalEditors.length === 0 && isCreator) || isMatty

    if (!isMaintainer) {
      throw new ForbiddenError('only editor, creator, and matty can manage tag')
    }

    // gather tag update params
    const updateParams: { [key: string]: any } = {}

    if (tagContent) {
      if (tagContent !== tag.content) {
        const tags = await tagService.findByContent({ content: tagContent })
        if (tags.length > 0) {
          throw new DuplicateTagError(`dulpicate tag content: ${tagContent}`)
        }
      }
      updateParams.content = tagContent
    }
    if (typeof description !== 'undefined' && description !== null) {
      updateParams.description = description
    }
    if (typeof coverId !== 'undefined') {
      updateParams.cover = coverId
    }
    if (Object.keys(updateParams).length === 0) {
      throw new UserInputError('bad request')
    }
    if (!isEditor && isCreator) {
      updateParams.editors = _uniq([...tag.editors, viewer.id])
    }

    const updateTag = await tagService.baseUpdate(dbId, updateParams)

    // update tag for search engine
    await tagService.updateSearch({
      id: updateTag.id,
      content: updateTag.content,
      description: updateTag.description,
    })

    // delete unused tag cover
    if (tag.cover && tag.cover !== updateTag.cover) {
      const coverAsset = await tagService.baseFindById(tag.cover, 'asset')
      if (coverAsset) {
        await systemService.deleteAssetAndAssetMap({
          [`${coverAsset.id}`]: coverAsset.path,
        })
      }
    }
    return updateTag
  }
}

export default resolver
