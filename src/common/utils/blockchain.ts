import { ethers } from 'ethers'

import { isProd } from 'common/environment'

export const getProvider = () =>
  new ethers.providers.JsonRpcProvider(
    isProd ? 'https://polygon-rpc.com/' : 'https://rpc-mumbai.matic.today'
  )

export const toTokenBaseUnit = (amount: string, decimals: number): string =>
  ethers.utils.parseUnits(amount, decimals).toString()
