import type { GQLMutationResolvers, Article, Circle } from 'definitions'

import { COMMENT_TYPE, USER_STATE, VOTE, NOTICE_TYPE } from 'common/enums'
import { ForbiddenByStateError, ForbiddenError } from 'common/errors'
import { fromGlobalId } from 'common/utils'

const resolver: GQLMutationResolvers['voteComment'] = async (
  _,
  { input: { id, vote } },
  {
    viewer,
    dataSources: {
      atomService,
      paymentService,
      commentService,
      notificationService,
    },
  }
) => {
  if (!viewer.userName) {
    throw new ForbiddenError('user has no username')
  }

  const { id: dbId } = fromGlobalId(id)
  const comment = await atomService.commentIdLoader.load(dbId)

  // check target
  let article: Article
  let circle: Circle | undefined = undefined
  let targetAuthor: string
  if (comment.type === COMMENT_TYPE.article) {
    article = await atomService.articleIdLoader.load(comment.targetId)
    targetAuthor = article.authorId
  } else if (comment.type === COMMENT_TYPE.moment) {
    const moment = await atomService.momentIdLoader.load(comment.targetId)
    targetAuthor = moment.authorId
  } else {
    circle = await atomService.circleIdLoader.load(comment.targetId)
    targetAuthor = circle.owner
  }

  // check permission
  const isTargetAuthor = targetAuthor === viewer.id
  const isInactive = [
    USER_STATE.banned,
    USER_STATE.archived,
    USER_STATE.frozen,
  ].includes(viewer.state)

  if (isInactive) {
    throw new ForbiddenByStateError(`${viewer.state} user has no permission`)
  }

  if (circle && !isTargetAuthor) {
    const isCircleMember = await paymentService.isCircleMember({
      userId: viewer.id,
      circleId: circle.id,
    })

    if (!isCircleMember) {
      throw new ForbiddenError('only circle members have the permission')
    }
  }

  // check is voted before
  const voted = await commentService.findVotesByUserId({
    userId: viewer.id,
    commentId: dbId,
  })
  if (voted && voted.length > 0) {
    await commentService.removeVotesByUserId({
      userId: viewer.id,
      commentId: dbId,
    })
  }

  await commentService.vote({ commentId: dbId, vote, userId: viewer.id })

  if (
    vote === VOTE.up &&
    [COMMENT_TYPE.article as string, COMMENT_TYPE.moment as string].includes(
      comment.type
    )
  ) {
    notificationService.trigger({
      event:
        comment.type === COMMENT_TYPE.moment
          ? NOTICE_TYPE.moment_comment_liked
          : NOTICE_TYPE.article_comment_liked,
      actorId: viewer.id,
      recipientId: comment.authorId,
      entities: [{ type: 'target', entityTable: 'comment', entity: comment }],
    })
  }

  return comment
}

export default resolver
