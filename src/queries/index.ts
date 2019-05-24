import { merge } from 'lodash'
// local
import scalars from './scalars'
import user from './user'
import article from './article'
import comment from './comment'
import draft from './draft'
import notice from './notice'
import system from './system'
import response from './response'

export default merge(
  scalars,
  article,
  comment,
  user,
  draft,
  notice,
  system,
  response
)
