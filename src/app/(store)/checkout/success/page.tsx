import { getLocale } from '@/lib/i18n/server'
import { CheckoutSuccessClient } from '@/components/store/checkout-success'

export const metadata = { title: 'Booking confirmation' }
export const dynamic = 'force-dynamic'

export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const [params, locale] = await Promise.all([searchParams, getLocale()])
  return <CheckoutSuccessClient locale={locale} params={params} />
}
