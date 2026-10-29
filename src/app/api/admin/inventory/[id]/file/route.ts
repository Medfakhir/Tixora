import { withApi, ApiError } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { prisma } from '@/lib/db/prisma'
import { getStorage } from '@/lib/storage'
import { recordAudit } from '@/lib/auth/guards'

/**
 * Admin file access is authorised per ticket row: the caller must be an admin, and the
 * bytes are read from private storage by key rather than by any client-supplied path.
 */
export const GET = withApi(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { admin, ip } = await adminRequest(request, 'sensitive')

  const ticket = await prisma.ticketInventory.findUnique({
    where: { id },
    include: { product: { select: { name: true } }, order: { select: { reference: true } } },
  })
  if (!ticket) throw new ApiError('Ticket file not found.', 404, 'NOT_FOUND')

  const bytes = await getStorage().get(ticket.storageKey)
  const inline = new URL(request.url).searchParams.get('download') !== '1'

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'INVENTORY_FILE_READ',
    entityType: 'TicketInventory',
    entityId: id,
    summary: `${inline ? 'Previewed' : 'Downloaded'} ${ticket.originalFileName}`,
    ip,
  })

  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(bytes.byteLength),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ticket.originalFileName}"`,
      'cache-control': 'private, no-store, max-age=0, must-revalidate',
      'x-content-type-options': 'nosniff',
    },
  })
})
