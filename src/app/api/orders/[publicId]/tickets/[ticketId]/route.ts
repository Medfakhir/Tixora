import { withApi, ApiError } from '@/lib/api/http'
import { prisma } from '@/lib/db/prisma'
import { getStorage } from '@/lib/storage'
import { checkRateLimit, RATE_LIMIT_RULES } from '@/lib/security/rate-limit'
import { clientIp } from '@/lib/auth/guards'
import { sanitiseFileName } from '@/lib/storage/pdf'

const DELIVERED_STATES = ['PAID', 'PROCESSING', 'COMPLETED', 'DELIVERY_FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED']

/**
 * Private file access is authorised by possession of an unguessable order publicId *and*
 * the ticket id belonging to that same order. Knowing one of the two is not enough.
 */
export const GET = withApi(async (request: Request, { params }: { params: Promise<{ publicId: string; ticketId: string }> }) => {
  const { publicId, ticketId } = await params

  const ip = clientIp(request.headers) ?? 'unknown'
  const allowed = await checkRateLimit(`tickets:${ip}`, RATE_LIMIT_RULES.sensitive)
  if (!allowed.allowed) throw new ApiError('Too many downloads. Please wait a moment.', 429, 'RATE_LIMITED')

  const ticket = await prisma.ticketInventory.findUnique({
    where: { id: ticketId },
    include: { order: { select: { publicId: true, status: true, reference: true } } },
  })
  if (!ticket || ticket.order?.publicId !== publicId) throw new ApiError('Ticket not found.', 404, 'TICKET_NOT_FOUND')
  if (!DELIVERED_STATES.includes(ticket.order?.status ?? '')) {
    throw new ApiError('These tickets are not available for download yet.', 409, 'NOT_DELIVERED')
  }

  const bytes = await getStorage().get(ticket.storageKey)
  const filename = `${ticket.order?.reference ?? 'ticket'}-${ticket.id.slice(-6)}.pdf`

  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(bytes.byteLength),
      'content-disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(sanitiseFileName(ticket.originalFileName) || filename)}`,
      'cache-control': 'private, no-store, max-age=0, must-revalidate',
      'x-content-type-options': 'nosniff',
    },
  })
})
