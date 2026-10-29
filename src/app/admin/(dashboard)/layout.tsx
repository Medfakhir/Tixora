import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/guards'
import { getGeneral } from '@/lib/settings/service'
import { SidebarNav } from '@/components/admin/sidebar-nav'
import { AdminTopbar } from '@/components/admin/topbar'
import { Landmark } from 'lucide-react'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdminPage()
  const general = await getGeneral()

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto flex w-full">
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground lg:flex">
          <Link href="/admin" className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4 text-sm font-semibold">
            <span className="flex size-6 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <Landmark className="size-3.5" />
            </span>
            Badi Palace
          </Link>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SidebarNav role={admin.role} />
          </div>
          <div className="border-t border-sidebar-border px-4 py-3 text-xs text-sidebar-foreground/60">{general.storeName}</div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <AdminTopbar admin={admin} maintenance={general.maintenanceMode} />
          <main className="min-w-0 flex-1 px-4 py-6 lg:px-6">{children}</main>
        </div>
      </div>
    </div>
  )
}
