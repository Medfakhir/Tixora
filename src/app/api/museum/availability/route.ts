import { withApi, ok } from '@/lib/api/http'
import { getMuseumSettings } from '@/lib/museum/settings'
import { getMonthAvailability } from '@/lib/museum/availability'
import { parseMonthKey } from '@/lib/museum/dates'

/**
 * Calendar endpoint. It returns only availability and prices, never customer data,
 * and is safe to cache for a short time at the edge.
 */
export const GET = withApi(async (request: Request) => {
  const settings = await getMuseumSettings()
  const url = new URL(request.url)
  const { year, month } = parseMonthKey(url.searchParams.get('month'), settings.timezone)
  const availability = await getMonthAvailability({ year, month }, settings)

  return ok({
    ...availability,
    prices: {
      adult: settings.adultPriceCents,
      child: settings.childPriceCents,
      currency: settings.currency,
    },
    maxAdults: settings.maxAdultsPerOrder,
    maxChildren: settings.maxChildrenPerOrder,
  })
})
