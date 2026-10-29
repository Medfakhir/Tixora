import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Ticket } from 'lucide-react'
import { getSessionContext } from '@/lib/auth/session'
import { getGeneral } from '@/lib/settings/service'
import { AdminLoginForm } from '@/components/admin/login-form'

export const metadata = { title: 'Admin sign-in' }

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const session = await getSessionContext()
  if (session) redirect('/admin')

  const { next } = await searchParams
  const general = await getGeneral()

  // Only same-origin paths are honoured, so this field cannot become an open redirect.
  const safeNext = next && next.startsWith('/admin') ? next : '/admin'

  return (
    <div className="grid min-h-dvh place-items-center bg-sidebar px-4 py-10 text-sidebar-foreground">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2 text-lg font-semibold tracking-tight">
          <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <Ticket className="size-4" />
          </span>
          {general.storeName}
        </Link>
        <p className="mb-4 text-center text-sm text-sidebar-foreground/70">Admin sign-in</p>
        <div className="text-foreground">
          <AdminLoginForm next={safeNext} />
        </div>
        <p className="mt-4 text-center text-xs text-sidebar-foreground/50">
          Need a ticket? <Link href="/products" className="underline">Browse products</Link>
        </p>
      </div>
    </div>
  )
}
