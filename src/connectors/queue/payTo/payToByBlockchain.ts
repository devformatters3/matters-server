import type { Log } from '@ethersproject/abstract-provider'
import { invalidateFQC } from '@matters/apollo-response-cache'
import Queue from 'bull'
import { ethers, Event, providers } from 'ethers'
import _capitalize from 'lodash/capitalize'

import {
  BLOCKCHAIN_CHAINID,
  BLOCKCHAIN_SAFE_CONFIRMS,
  BLOCKCHAIN_TRANSACTION_STATE,
  DB_NOTICE_TYPE,
  MINUTE,
  NODE_TYPES,
  PAYMENT_CURRENCY,
  PAYMENT_PROVIDER,
  QUEUE_CONCURRENCY,
  QUEUE_JOB,
  QUEUE_NAME,
  QUEUE_PRIORITY,
  TRANSACTION_PURPOSE,
  TRANSACTION_REMARK,
  TRANSACTION_STATE,
} from 'common/enums'
import {
  environment,
  isProd,
  USDTContractAddress,
  USDTContractDecimals,
} from 'common/environment'
import { PaymentQueueJobDataError } from 'common/errors'
import {
  fromTokenBaseUnit,
  getAlchemyProvider,
  getQueueNameForEnv,
  numRound,
  toTokenBaseUnit,
} from 'common/utils'
import { PaymentService } from 'connectors'
import { GQLChain } from 'definitions'

import { BaseQueue } from '../baseQueue'

interface PaymentParams {
  txId: string
}

const abi = [
  'event Curation(address indexed curator, address indexed creator, address indexed token, string uri, uint256 amount)',
]
const chainId = isProd
  ? BLOCKCHAIN_CHAINID.Polygon.PolygonMainnet
  : BLOCKCHAIN_CHAINID.Polygon.PolygonMumbai
const contractAddress = environment.curationContractAddress.toLowerCase()
const syncRecordTable = 'blockchain_sync_record'

class PayToByBlockchainQueue extends BaseQueue {
  paymentService: InstanceType<typeof PaymentService>
  delay: number
  provider: providers.Provider

  constructor() {
    super(getQueueNameForEnv(QUEUE_NAME.payToByBlockchain))
    this.paymentService = new PaymentService()
    this.addConsumers()
    this.delay = 5000 // 5s
    this.provider = getAlchemyProvider(parseInt(chainId, 10))
  }

  /**
   * Producer for payTo.
   *
   */
  payTo = ({ txId }: PaymentParams) => {
    return this.q.add(
      QUEUE_JOB.payTo,
      { txId },
      {
        delay: this.delay,
        attempts: 8, // roughly total 20 min before giving up
        backoff: {
          type: 'exponential',
          delay: this.delay,
        },
        priority: QUEUE_PRIORITY.NORMAL,
      }
    )
  }

  addRepeatJobs = async () => {
    this.q.add(
      QUEUE_JOB.syncCurationEvents,
      {},
      {
        priority: QUEUE_PRIORITY.NORMAL,
        repeat: { every: MINUTE * 30 },
      }
    )
  }

  _handleSyncCurationEvents = async () => {
    const curation = new ethers.Contract(contractAddress, abi, this.provider)
    const safeBlockNum =
      (await this.provider.getBlockNumber()) - BLOCKCHAIN_SAFE_CONFIRMS.Polygon
    let fromBlockNum
    let toBlockNum
    const record = await this.atomService.findFirst({
      table: syncRecordTable,
      where: { chainId, contractAddress },
    })
    if (record) {
      fromBlockNum = record.blockNumber + 1
    }
    let events
    if (!fromBlockNum) {
      // no sync record in db , request getLog without block range
      events = await curation.queryFilter(curation.filters.Curation())
      const filtered = events.filter((e) => e.blockNumber <= safeBlockNum)
      await this.syncCurationEvents(filtered)
      toBlockNum =
        events.length === filtered.length
          ? safeBlockNum
          : filtered[filtered.length - 1].blockNumber
    } else {
      // sync record in db , request getLog with block range
      // provider only accept 2000 blocks range
      toBlockNum = Math.min(safeBlockNum, fromBlockNum + 1999)
      events = await curation.queryFilter(
        curation.filters.Curation(),
        fromBlockNum,
        toBlockNum
      )
      await this.syncCurationEvents(events)
    }

    await this.paymentService.baseUpdateOrCreate({
      table: syncRecordTable,
      where: { chainId, contractAddress },
      data: { chainId, contractAddress, blockNumber: toBlockNum },
    })
  }

  syncCurationEvents = async (events: Event[]) => {
    const eventsToBatchCreate = []
    for (const event of events) {
      if (!event.removed) {
        const data: any = {}
        const blockchainTx =
          await this.paymentService.findOrCreateBlockchainTransaction(
            { chain: GQLChain.Polygon, txHash: event.transactionHash },
            { state: BLOCKCHAIN_TRANSACTION_STATE.succeeded }
          )
        data.blockchainTransactionId = blockchainTx.id
        data.contractAddress = contractAddress
        data.curatorAddress = event.args!.curator!.toLowerCase()
        data.creatorAddress = event.args!.creator!.toLowerCase()
        data.tokenAddress = event.args!.token!.toLowerCase()
        data.amount = event.args!.amount!.toString()
        data.uri = event.args!.uri

        eventsToBatchCreate.push(data)

        // related tx record has resolved
        if (
          blockchainTx.transactionId &&
          blockchainTx.state === BLOCKCHAIN_TRANSACTION_STATE.succeeded
        ) {
          continue
        }

        // check if donation is from Matters

        if (data.tokenAddress !== USDTContractAddress) {
          continue
        }

        if (!isValidUri(data.uri)) {
          continue
        }

        const curatorUser = await this.userService.findByEthAddress(
          data.curatorAddress
        )
        if (!curatorUser) {
          continue
        }

        const creatorUser = await this.userService.findByEthAddress(
          data.creatorAddress
        )
        if (!creatorUser) {
          continue
        }

        const cid = extractCid(data.uri)
        const articles = await this.articleService.baseFind({
          where: { author_id: creatorUser.id, data_hash: cid },
        })
        if (articles.length === 0) {
          continue
        }
        const article = articles[0]

        // donation is from Matters
        const amount = parseFloat(
          fromTokenBaseUnit(event.args!.amount, USDTContractDecimals)
        )

        if (blockchainTx.transactionId) {
          // this blackchain tx record, related tx record, validate it
          const tx = await this.paymentService.baseFindById(
            blockchainTx.transactionId
          )
          if (
            tx.senderId === curatorUser.id &&
            tx.recipientId === creatorUser.id &&
            tx.targetId === article.id &&
            toTokenBaseUnit(tx.amount, USDTContractDecimals) === data.amount
          ) {
            // related tx record is valid, update its state
            await this.paymentService.markTransactionStateAs({
              id: tx.id,
              state: TRANSACTION_STATE.succeeded,
            })
          } else {
            // related tx record is valid, update its state
            // cancel it and add new one
            const trx = await this.knex.transaction()
            try {
              await this.paymentService.markTransactionStateAs(
                {
                  id: tx.id,
                  state: TRANSACTION_STATE.canceled,
                  remark: TRANSACTION_REMARK.INVALID,
                },
                trx
              )
              const newTx = await this.paymentService.createTransaction(
                {
                  amount,
                  state: TRANSACTION_STATE.succeeded,
                  purpose: TRANSACTION_PURPOSE.donation,
                  currency: PAYMENT_CURRENCY.USDT,
                  provider: PAYMENT_PROVIDER.blockchain,
                  providerTxId: blockchainTx.id,
                  recipientId: creatorUser.id,
                  senderId: curatorUser.id,
                  targetId: article.id,
                },
                trx
              )
              await this.paymentService.baseUpdate(
                blockchainTx.id,
                { transactionId: newTx.id },
                'blockchain_transaction',
                trx
              )
              await trx.commit()
            } catch (error) {
              await trx.rollback()
              throw error
            }
          }
        } else {
          // no related tx record, create one
          const trx = await this.knex.transaction()
          try {
            const tx = await this.paymentService.createTransaction(
              {
                amount,
                state: TRANSACTION_STATE.succeeded,
                purpose: TRANSACTION_PURPOSE.donation,
                currency: PAYMENT_CURRENCY.USDT,
                provider: PAYMENT_PROVIDER.blockchain,
                providerTxId: blockchainTx.id,
                recipientId: creatorUser.id,
                senderId: curatorUser.id,
                targetId: article.id,
              },
              trx
            )
            await this.paymentService.baseUpdate(
              blockchainTx.id,
              { transactionId: tx.id },
              'blockchain_transaction',
              trx
            )
            await trx.commit()
          } catch (error) {
            await trx.rollback()
            throw error
          }
        }
      } else {
        // reorg happens
        const blockchainTx =
          await this.paymentService.findOrCreateBlockchainTransaction({
            chain: GQLChain.Polygon,
            txHash: event.transactionHash,
          })
        if (!blockchainTx.transactionId) {
          // no relatived tx record, do nothing
          continue
        }
        const tx = await this.paymentService.baseFindById(
          blockchainTx.transactionId
        )
        const receipt = await this.provider.getTransactionReceipt(
          event.transactionHash
        )

        if (tx.state === TRANSACTION_STATE.succeeded) {
          if (!receipt) {
            // blochchain tx not mined after reorg, update tx to pending
            await this.resetBothTxAndBlockchainTx(
              blockchainTx.transactionId,
              blockchainTx.id
            )
          }
          if (receipt && receipt.status === 0) {
            // blochchain tx failed after reorg, update tx to failed
            await this.failBothTxAndBlockchainTx(
              blockchainTx.transactionId,
              blockchainTx.id
            )
          }
        }

        if (tx.state === TRANSACTION_STATE.failed) {
          if (receipt && receipt.status === 1) {
            // blochchain tx succeeded after reorg, update tx to failed
            await this.succeedBothTxAndBlockchainTx(
              blockchainTx.transactionId,
              blockchainTx.id
            )
          }
        }
      }
    }
    if (eventsToBatchCreate.length >= 0) {
      const trx = await this.knex.transaction()
      try {
        await this.paymentService.baseBatchCreate(
          eventsToBatchCreate,
          'blockchain_curation_event',
          trx
        )
        await trx.commit()
      } catch (error) {
        await trx.rollback()
        throw error
      }
    }

    return events.length
  }

  private addConsumers = () => {
    this.q.process(
      QUEUE_JOB.payTo,
      QUEUE_CONCURRENCY.payToByBlockchain,
      this.handlePayTo
    )
    this.q.process(
      QUEUE_JOB.syncCurationEvents,
      1,
      this.handleSyncCurationEvents
    )
  }

  /**
   * Pay-to handler.
   *
   */
  private handlePayTo: Queue.ProcessCallbackFunction<unknown> = async (job) => {
    const data = job.data as PaymentParams
    const txId = data.txId

    const tx = await this.paymentService.baseFindById(txId)
    if (!tx) {
      job.discard()
      throw new PaymentQueueJobDataError('pay-to pending tx not found')
    }

    if (tx.provider !== PAYMENT_PROVIDER.blockchain) {
      job.discard()
      throw new PaymentQueueJobDataError('wrong pay-to queue')
    }

    const blockchainTx =
      await this.paymentService.findBlockchainTransactionById(tx.providerTxId)

    if (!blockchainTx) {
      job.discard()
      throw new PaymentQueueJobDataError('blockchain transaction not found')
    }

    const txReceipt = await this.provider.getTransactionReceipt(
      blockchainTx.txHash
    )

    if (!txReceipt) {
      throw new PaymentQueueJobDataError('blockchain transaction not mined')
    }

    if (txReceipt.status === 0) {
      await this.failBothTxAndBlockchainTx(txId, blockchainTx.id)
      return data
    }
    const [recipient, sender, articleDb] = await Promise.all([
      this.userService.baseFindById(tx.recipientId),
      this.userService.baseFindById(tx.senderId),
      this.atomService.findFirst({
        table: 'article',
        where: { id: tx.targetId },
      }),
    ])

    const creatorAddress = recipient.ethAddress
    const curatorAddress = sender.ethAddress
    const cid = articleDb.dataHash
    const tokenAddress = USDTContractAddress
    const amount = tx.amount
    const decimals = USDTContractDecimals

    // txReceipt does not match with tx record in database
    if (
      !(await this.containMatchedEvent(txReceipt.logs, {
        creatorAddress,
        curatorAddress,
        cid,
        tokenAddress,
        amount,
        decimals,
      }))
    ) {
      await this.updateTxAndBlockchainTxState(
        {
          txId,
          txState: TRANSACTION_STATE.canceled,
          txRemark: TRANSACTION_REMARK.INVALID,
        },
        {
          blockchainTxId: blockchainTx.id,
          blockchainTxState: BLOCKCHAIN_TRANSACTION_STATE.succeeded,
        }
      )
      return data
    }

    // update pending tx
    await this.succeedBothTxAndBlockchainTx(txId, blockchainTx.id)

    // send email to sender
    const author = await this.atomService.findFirst({
      table: 'user',
      where: { id: articleDb.authorId },
    })
    const article = {
      id: tx.targetId,
      title: articleDb.title,
      slug: articleDb.slug,
      mediaHash: articleDb.mediaHash,
      author: {
        displayName: author.displayName,
        userName: author.userName,
      },
    }

    this.notificationService.mail.sendPayment({
      to: sender.email,
      recipient: {
        displayName: sender.displayName,
        userName: sender.userName,
      },
      type: 'donated',
      article,
      tx: {
        recipient,
        sender,
        amount: numRound(tx.amount),
        currency: tx.currency,
      },
    })

    // send email to recipient
    this.notificationService.trigger({
      event: DB_NOTICE_TYPE.payment_received_donation,
      actorId: sender.id,
      recipientId: recipient.id,
      entities: [{ type: 'target', entityTable: 'transaction', entity: tx }],
    })

    this.notificationService.mail.sendPayment({
      to: recipient.email,
      recipient: {
        displayName: recipient.displayName,
        userName: recipient.userName,
      },
      type: 'receivedDonation',
      tx: {
        recipient,
        sender,
        amount: numRound(tx.amount),
        currency: tx.currency,
      },
      article,
    })

    // manaully invalidate cache
    if (tx.targetType) {
      const entity = await this.userService.baseFindEntityTypeTable(
        tx.targetType
      )
      const entityType =
        NODE_TYPES[
          (_capitalize(entity?.table) as keyof typeof NODE_TYPES) || ''
        ]
      if (entityType && this.cacheService) {
        invalidateFQC({
          node: { type: entityType, id: tx.targetId },
          redis: this.cacheService.redis,
        })
      }
    }

    job.progress(100)
    return data
  }

  /**
   * syncCurationEvents handler.
   *
   */
  private handleSyncCurationEvents: Queue.ProcessCallbackFunction<unknown> =
    async (job) => {
      return this._handleSyncCurationEvents()
    }

  /**
   * helpers
   *
   */

  private updateTxAndBlockchainTxState = async (
    {
      txId,
      txState,
      txRemark,
    }: {
      txId: string
      txState: TRANSACTION_STATE
      txRemark?: TRANSACTION_REMARK
    },
    {
      blockchainTxId,
      blockchainTxState,
    }: {
      blockchainTxId: string
      blockchainTxState: BLOCKCHAIN_TRANSACTION_STATE
    }
  ) => {
    const trx = await this.knex.transaction()
    try {
      await this.paymentService.markTransactionStateAs(
        {
          id: txId,
          state: txState,
          remark: txRemark,
        },
        trx
      )
      await this.paymentService.markBlockchainTransactionStateAs(
        {
          id: blockchainTxId,
          state: blockchainTxState,
        },
        trx
      )
      await trx.commit()
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }

  private failBothTxAndBlockchainTx = async (
    txId: string,
    blockchainTxId: string
  ) => {
    await this.updateTxAndBlockchainTxState(
      { txId, txState: TRANSACTION_STATE.failed },
      {
        blockchainTxId,
        blockchainTxState: BLOCKCHAIN_TRANSACTION_STATE.reverted,
      }
    )
  }
  private succeedBothTxAndBlockchainTx = async (
    txId: string,
    blockchainTxId: string
  ) => {
    await this.updateTxAndBlockchainTxState(
      { txId, txState: TRANSACTION_STATE.succeeded },
      {
        blockchainTxId,
        blockchainTxState: BLOCKCHAIN_TRANSACTION_STATE.succeeded,
      }
    )
  }
  private resetBothTxAndBlockchainTx = async (
    txId: string,
    blockchainTxId: string
  ) => {
    await this.updateTxAndBlockchainTxState(
      { txId, txState: TRANSACTION_STATE.pending },
      {
        blockchainTxId,
        blockchainTxState: BLOCKCHAIN_TRANSACTION_STATE.pending,
      }
    )
  }

  private containMatchedEvent = async (
    logs: Log[],
    {
      curatorAddress,
      creatorAddress,
      cid,
      tokenAddress,
      amount,
      decimals,
    }: {
      curatorAddress?: string
      creatorAddress?: string
      cid: string
      tokenAddress: string
      amount: string
      decimals: number
    }
  ) => {
    const topic =
      '0xc2e41b3d49bbccbac6ceb142bad6119608adf4f1ee1ca5cc6fc332e0ca2fc602'
    if (logs.length === 0) {
      return false
    } else {
      if (!curatorAddress || !creatorAddress) {
        return false
      }
      for (const log of logs) {
        if (
          log.address.toLowerCase() === contractAddress &&
          log.topics[0] === topic
        ) {
          const iface = new ethers.utils.Interface(abi)
          const event = iface.parseLog(log)
          const uri = event.args.uri
          if (
            ignoreCaseMatch(event.args.curator, curatorAddress) &&
            ignoreCaseMatch(event.args.creator, creatorAddress) &&
            ignoreCaseMatch(event.args.token, tokenAddress) &&
            event.args.amount!.toString() ===
              toTokenBaseUnit(amount, decimals) &&
            isValidUri(uri) &&
            extractCid(uri) === cid
          ) {
            return true
          }
        }
      }
    }
    return false
  }
}

const ignoreCaseMatch = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase()

const isValidUri = (uri: string): boolean => /^ipfs:\/\//.test(uri)

const extractCid = (uri: string): string => uri.replace('ipfs://', '')

export const payToByBlockchainQueue = new PayToByBlockchainQueue()
