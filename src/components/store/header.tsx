import Link from 'next/link'
import { Ticket } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { LocaleSwitcher } from './locale-switcher'
import type { General } from '@/lib/settings/service'
import type { Locale } from '@/lib/i18n/messages'
import { createTranslator } from '@/lib/i18n/messages'

export function StoreHeader({ general, locale }: { general: General; locale: Locale }) {
  const t = createTranslator(locale)
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4">
        <Link href="/" className="flex min-w-0 items-center gap-2 font-semibold tracking-tight">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Ticket className="size-4" />
          </span>
          <span className="truncate">{general.storeName}</span>
        </Link>
        <nav className="flex items-center gap-0.5 text-sm sm:gap-1">
          <Button variant="ghost" size="sm" render={<Link href="/#book" />} className="hidden sm:inline-flex">
            {t('nav.book')}
          </Button>
          <Button variant="ghost" size="sm" render={<Link href="/order" />}>
            {t('nav.myOrder')}
          </Button>
          <LocaleSwitcher locale={locale} />
          {general.maintenanceMode ? <Badge variant="secondary">Maintenance</Badge> : null}
        </nav>
      </div>
    </header>
  )
}
