import type { Metadata } from 'next'
import { requireAdminPage } from '@/lib/auth/guards'
import { PageHeader } from '@/components/admin/page-primitives'
import { ProfileForm } from '@/components/admin/profile-form'

export const metadata: Metadata = { title: 'Profile' }

export default async function ProfilePage() {
  const admin = await requireAdminPage()

  return (
    <div className="grid gap-6">
      <PageHeader title="Profile" description="Your administrator account and password." />
      <ProfileForm name={admin.name} email={admin.email} role={admin.role} />
    </div>
  )
}
