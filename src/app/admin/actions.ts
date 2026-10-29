'use server'

import { redirect } from 'next/navigation'
import { destroySession } from '@/lib/auth/session'
import { getCurrentAdmin, recordAudit } from '@/lib/auth/guards'

export async function signOutAction() {
  const admin = await getCurrentAdmin()
  if (admin) {
    await recordAudit({
      actorType: 'ADMIN',
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'ADMIN_LOGOUT',
      entityType: 'AdminUser',
      entityId: admin.id,
      summary: `${admin.email} signed out`,
    })
  }
  await destroySession()
  redirect('/admin/login')
}
