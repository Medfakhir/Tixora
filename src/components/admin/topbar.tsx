import Link from 'next/link'
import { LogOut, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MobileNav } from './mobile-nav'
import { signOutAction } from '@/app/admin/actions'
import type { AdminSessionUser } from '@/lib/auth/session'

export function AdminTopbar({ admin, maintenance }: { admin: AdminSessionUser; maintenance: boolean }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b bg-background/85 px-4 backdrop-blur">
      <div className="flex items-center gap-2">
        <MobileNav role={admin.role} />
        <span className="text-sm font-semibold tracking-tight">Tixora admin</span>
        {maintenance ? <Badge variant="secondary">Store in maintenance mode</Badge> : null}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" render={<Link href="/" target="_blank" />}>
          <ExternalLink />
          <span className="hidden sm:inline">Storefront</span>
        </Button>
        <span className="hidden text-sm text-muted-foreground md:inline">
          {admin.name} · {admin.role === 'SUPER_ADMIN' ? 'Super admin' : 'Admin'}
        </span>
        <form action={signOutAction}>
          <Button type="submit" variant="outline" size="sm" aria-label="Sign out">
            <LogOut />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </form>
      </div>
    </header>
  )
}
