import { PAYMENT_CURRENCY, PAYMENT_PROVIDER } from 'common/enums'

interface ToAmountArgs {
  amount: number
  currency?: PAYMENT_CURRENCY
  provider?: PAYMENT_PROVIDER
}

const PROVIDER_CURRENCY_RATE = {
  stripe: {
    HKD: 100,
    LIKE: 1,
  },
}

/**
 * Convert DB amount to provider amount
 *
 * @see {@url https://stripe.com/docs/currencies#zero-decimal}
 */

export const toProviderAmount = ({
  amount,
  currency = PAYMENT_CURRENCY.HKD,
  provider = PAYMENT_PROVIDER.stripe,
}: ToAmountArgs) => {
  const rate = PROVIDER_CURRENCY_RATE[provider][currency]
  return amount * rate
}

/**
 * Convert provider amount to DB amount
 */
export const toDBAmount = ({
  amount,
  currency = PAYMENT_CURRENCY.HKD,
  provider = PAYMENT_PROVIDER.stripe,
}: ToAmountArgs) => {
  const rate = PROVIDER_CURRENCY_RATE[provider][currency]
  return amount / rate
}

/**
 * Calculate Stripe Fee by a given amount based on their pricing model:
 *
 * @see {@url https://stripe.com/en-hk/pricing}
 * @see {@url https://support.stripe.com/questions/passing-the-stripe-fee-on-to-customers}
 */
const FEE_FIXED = 2.35
const FEE_PERCENT = 0.034

export const calcStripeFee = (amount: number, decimal: number = 2) => {
  const charge = (amount + FEE_FIXED) / (1 - FEE_PERCENT)
  const fee = charge - amount
  return parseFloat(fee.toFixed(decimal))
}