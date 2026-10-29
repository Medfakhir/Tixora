import { z } from 'zod'
import { withApi, ok, readJson } from '@/lib/api/http'
import { anonymousRequest } from '@/lib/api/admin'
import { assertStoreOpen } from '@/lib/settings/maintenance'
import { startMuseumCheckout } from '@/lib/museum/orders'
import { formatVisitDate } from '@/lib/museum/dates'

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a visit date'),
  adults: z.coerce.number().int().min(0).max(20),
  children: z.coerce.number().int().min(0).max(20),
  fullName: z.string().trim().min(2, 'Enter your full name').max(120, 'Use 120 characters or fewer'),
  email: z.email('Enter a valid email address').max(200),
  phone: z
    .string()
    .trim()
    .min(6, 'Enter a phone number with its country code')
    .max(40, 'Use 40 characters or fewer')
    .regex(/^\+?[0-9 ().-]+$/, 'Enter a valid phone number'),
})

export const POST = withApi(async (request: Request) => {
  const { ip, userAgent } = await anonymousRequest(request, 'checkout')
  await assertStoreOpen()

  const payload = schema.parse(await readJson(request))
  const result = await startMuseumCheckout(
    {
      date: payload.date,
      adults: payload.adults,
      children: payload.children,
      fullName: payload.fullName,
      email: payload.email,
      phone: payload.phone,
    },
    { ip, userAgent: userAgent ?? undefined },
  )

  return ok(
    {
      publicId: result.publicId,
      reference: result.reference,
      totalMinor: result.priced.totalCents,
      currency: result.priced.currency,
      visitDate: formatVisitDate(result.priced.dateKey, 'en'),
      date: result.priced.dateKey,
      adultQty: result.priced.adultQty,
      childQty: result.priced.childQty,
    },
    201,
  )
})
