import { GQLCommentsInput } from 'definitions'
import DataLoader from 'dataloader'
import { v4 } from 'uuid'

import { BATCH_SIZE, USER_ACTION } from 'common/enums'
import { BaseService } from './baseService'

export class CommentService extends BaseService {
  constructor() {
    super('comment')
    this.idLoader = new DataLoader(this.baseFindByIds)
    this.uuidLoader = new DataLoader(this.baseFindByUUIDs)
  }

  create = async ({
    authorId,
    articleId,
    parentCommentId,
    mentionedUserIds,
    content
  }: {
    [key: string]: any
  }) => {
    const comemnt = await this.baseCreate({
      uuid: v4(),
      authorId,
      articleId,
      parentCommentId,
      content
    })
    await Promise.all(
      mentionedUserIds.map(async (userId: string) => {
        await this.baseCreate(
          {
            commentId: comemnt.id,
            userId
          },
          'comment_mentioned_user'
        )
      })
    )
    return comemnt
  }

  /**
   * Count comments by a given author id (user).
   */
  countByAuthor = async (authorId: string): Promise<number> => {
    const result = await this.knex(this.table)
      .countDistinct('id')
      .where({ authorId })
      .first()
    return parseInt(result.count, 10)
  }

  /**
   * Count comments by a given article id.
   */
  countByArticle = async (articleId: string): Promise<number> => {
    const result = await this.knex(this.table)
      .countDistinct('id')
      .where({ articleId })
      .first()
    return parseInt(result.count, 10)
  }

  /**
   * Count comments by a given comment id.
   */
  countByParent = async (commentId: string): Promise<number> => {
    const result = await this.knex(this.table)
      .countDistinct('id')
      .where('parent_comment_id', commentId)
      .first()
    return parseInt(result.count, 10)
  }

  /**
   * Count a comment's up votes by a given target id (comment).
   */
  countUpVote = async (targetId: string): Promise<number> => {
    const result = await this.knex('action_comment')
      .countDistinct('id')
      .where({
        targetId,
        action: USER_ACTION.upVote
      })
      .first()
    return parseInt(result.count, 10)
  }

  /**
   * Count a comment's down votes by a given target id (comment).
   */
  countDownVote = async (targetId: string): Promise<number> => {
    const result = await this.knex('action_comment')
      .countDistinct('id')
      .where({
        target_id: targetId,
        action: USER_ACTION.downVote
      })
      .first()
    return parseInt(result.count, 10)
  }

  /**
   * Find comments by a given author id (user).
   */
  findByAuthor = async (authorId: string): Promise<any[]> =>
    await this.knex
      .select()
      .from(this.table)
      .where({ authorId })

  /**
   * Find comments by a given author id (user) in batches.
   */
  findByAuthorInBatch = async (
    authorId: string,
    offset: number,
    limit = BATCH_SIZE
  ): Promise<any[]> =>
    await this.knex
      .select()
      .from(this.table)
      .where({ authorId })
      .orderBy('id', 'desc')
      .offset(offset)
      .limit(limit)

  /**
   * Find articles ids by comment author id (user) in batches.
   */
  findArticleByAuthorInBatch = async (
    authorId: string,
    offset = 0,
    limit = BATCH_SIZE
  ): Promise<string[]> =>
    await this.knex
      .select()
      .from(this.table)
      .where({ authorId })
      .distinct()
      .pluck('article_id')
      .offset(offset)
      .limit(limit)

  /**
   * Find comments by a given article id in batches.
   */
  findByArticle = async ({
    id,
    author,
    quoted,
    sort,
    offset = 0,
    limit = BATCH_SIZE
  }: GQLCommentsInput & { id: string }) => {
    let where: { [key: string]: string | boolean } = { articleId: id }
    if (author) {
      where = { ...where, authorId: author }
    }
    if (quoted) {
      where = { ...where, quoted }
    }

    // TODO: add sort for oldest, newest and most upvotes
    // let order: { [key: string]: string }
    // if (sort === 'oldest') {
    //   order = {createdAt: 'desc'}
    // }

    return this.knex
      .select()
      .from(this.table)
      .where(where)
      .orderBy('id', 'desc')
      .offset(offset)
      .limit(limit)
  }

  /**
   * Find pinned comments by a given article id.
   */
  findPinnedByArticle = async (articleId: string): Promise<any[]> =>
    await this.knex
      .select()
      .from(this.table)
      .where({ articleId, pinned: true })

  /**
   * Find comments by a given comment id.
   */
  findByParent = async (commentId: string): Promise<any[]> =>
    await this.knex
      .select()
      .from(this.table)
      .where('parent_comment_id', commentId)

  /**
   * Find a comment's up votes by a given target id (comment).
   */
  findUpVotes = async (targetId: string): Promise<any[]> =>
    await this.knex
      .select()
      .from('action_comment')
      .where({
        targetId,
        action: USER_ACTION.upVote
      })

  /**
   * Find a comment's down votes by a given target id (comment).
   */
  findDownVotes = async (targetId: string): Promise<any[]> => {
    return await this.knex
      .select()
      .from('action_comment')
      .where({
        targetId,
        action: USER_ACTION.downVote
      })
  }

  /**
   * Find a comment's vote by a given target id (comment).
   */
  findVotesByUserId = async ({
    userId,
    targetId
  }: {
    userId: string
    targetId: string
  }): Promise<any[]> =>
    await this.knex
      .select()
      .from('action_comment')
      .where({
        userId,
        targetId
      })
      .whereIn('action', [USER_ACTION.upVote, USER_ACTION.downVote])

  /**
   * Find a comment's mentioned users by a given comment id.
   */
  findMentionedUsers = async (commentId: string): Promise<any[]> => {
    return await this.knex
      .select()
      .from('comment_mentioned_user')
      .where({
        commentId
      })
  }
}
