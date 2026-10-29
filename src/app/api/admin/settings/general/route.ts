import { withApi, ok, readJson } from '@/lib/api/http'
import { adminRequest } from '@/lib/api/admin'
import { generalSettingsSchema } from '@/lib/validation'
import { getGeneral, saveGeneral } from '@/lib/settings/service'
import { recordAudit } from '@/lib/auth/guards'

export const GET = withApi(async (request: Request) => ok(await getGeneral()))

export const POST = withApi(async (request: Request) => {
  const { admin, ip } = await adminRequest(request, 'sensitive', 'SUPER_ADMIN')
  const payload = generalSettingsSchema.parse(await readJson(request))

  const before = await getGeneral()
  const saved = await saveGeneral({ ...payload, updatedBy: admin.id })

  await recordAudit({
    actorType: 'ADMIN',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'SETTINGS_GENERAL_SAVE',
    entityType: 'GeneralSettings',
    entityId: saved.id,
    summary: describeChange(before, saved),
    metadata: { maintenanceMode: saved.maintenanceMode, timezone: saved.timezone },
    ip,
  })

  return ok(saved)
})

function describeChange(before: { maintenanceMode: boolean }, after: { maintenanceMode: boolean }): string {
  if (before.maintenanceMode !== after.maintenanceMode) {
    return `General settings saved; maintenance mode ${after.maintenanceMode ? 'ENABLED' : 'disabled'}`
  }
  return 'General settings saved'
}
