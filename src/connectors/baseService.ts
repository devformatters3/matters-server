import DataLoader from 'dataloader'
import { environment } from '../common/environment'
import Knex from 'knex'
import { tables } from './mockData'

export type Item = { id: string; [key: string]: any }

export type TableName = 'article' | 'user' | 'comment' | 'action'

export class BaseService {
  knex: Knex

  items: Item[]

  loader: DataLoader<string, Item>

  table: TableName

  constructor(table: TableName) {
    this.knex = this.getKnexClient()
    this.table = table
    this.items = tables[table]
  }

  /**
   * Initialize a Knex client for PostgreSQL.
   */
  getKnexClient = (): Knex => {
    const { env, pgHost, pgUser, pgPassword, pgDatabase } = environment
    const host = env === 'dev' ? '0.0.0.0' : pgHost
    return Knex({
      client: 'pg',
      connection: {
        host,
        user: pgUser,
        password: pgPassword,
        database: pgDatabase
      }
    })
  }

  fakeFindByIds = (ids: string[]): Promise<Item[]> =>
    new Promise(resolve =>
      resolve(this.items.filter(({ id: itemId }) => ids.includes(itemId)))
    )

  /**
   * Find an item by a given id.
   */
  baseFindById = async (id: string): Promise<any | null> => {
    const result = await this.knex
      .select()
      .from(this.table)
      .where('id', id)
    if (result && result.length > 0) {
      return result[0]
    }
    return null
  }

  /**
   * Find items by given ids.
   */
  baseFindByIds = async (ids: string[]): Promise<any[]> => {
    return await this.knex
      .select()
      .from(this.table)
      .whereIn('id', ids)
  }
}
