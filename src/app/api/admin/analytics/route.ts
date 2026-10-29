import { withApi, ok } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { buildAnalytics, resolveRange, type RangeKey } from '@/lib/analytics/report'
import { getGeneral } from '@/lib/settings/service'

const KEYS: RangeKey[] = ['today', '7d', '30d', 'month', 'year', 'custom']

/** Same numbers the dashboard renders, exposed for the spec's analytics endpoint. */
export const GET = withApi(async (request: Request) => {
  await adminRequest(request, 'sensitive')
  const url = new URL(request.url)
  const requested = (url.searchParams.get('range') ?? '30d') as RangeKey
  const key = KEYS.includes(requested) ? requested : '30d'

  const general = await getGeneral()
  const custom =
    key === 'custom'
      ? {
          from: new Date(String(url.searchParams.get('from'))),
          to: new Date(String(url.searchParams.get('to'))),
        }
      : undefined

  const range = resolveRange(key, general.timezone, custom)
  const report = await buildAnalytics(range, general.defaultCurrency)
  return ok(report)
})
