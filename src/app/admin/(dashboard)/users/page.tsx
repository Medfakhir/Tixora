import type { Metadata } from 'next'
import { requireAdminPage } from '@/lib/auth/guards'
import { prisma } from '@/lib/db/prisma'
import { PageHeader } from '@/components/admin/page-primitives'
import { UserManager, type AdminRow } from '@/components/admin/users/user-manager'

export const metadata: Metadata = { title: 'Users' }

export default async function UsersPage() {
  const currentAdmin = await requireAdminPage('SUPER_ADMIN')

  const rows = await prisma.adminUser.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      passwordChanged: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  const admins: AdminRow[] = rows.map((row) => ({
    ...row,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    passwordChanged: row.passwordChanged.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }))

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Administrator accounts"
        description="Create accounts, change roles and reset passwords. Only super admins can manage access."
      />
      <UserManager initialAdmins={admins} currentAdminId={currentAdmin.id} />
    </div>
  )
}
