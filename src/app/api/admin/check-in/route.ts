import { z } from 'zod'
import { withApi, ok, readJson } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { checkInOrder } from '@/lib/museum/checkin'

const schema = z.object({
  code: z.string().trim().min(4, 'Scan a QR code or enter a booking reference').max(80),
  allowAnyDate: z.boolean().optional().default(false),
  note: z.string().trim().max(300).optional(),
})

/** Used by the gate scanner and by manual reference entry. */
export const POST = withApi(async (request: Request) => {
  const { admin } = await adminRequest(request, 'sensitive')
  const payload = schema.parse(await readJson(request))
  const result = await checkInOrder(payload, admin)
  return ok(result)
})
