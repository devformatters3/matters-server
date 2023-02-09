import { environment } from 'common/environment'

export const QUEUE_URL = {
  ipfsArticles: environment?.awsIpfsArticlesQueueUrl,
  mail: environment?.awsMailQueueUrl,
  // likecoin
  likecoinLike: environment?.awsLikecoinLikeUrl,
  likecoinSendPV: environment?.awsLikecoinSendPVUrl,
  likecoinUpdateCivicLikerCache: environment?.awsLikecoinUpdateCivicLikerCache,
} as const