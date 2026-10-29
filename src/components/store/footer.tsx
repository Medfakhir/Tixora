import Link from 'next/link'
import type { General } from '@/lib/settings/service'
import type { Locale } from '@/lib/i18n/messages'
import { createTranslator } from '@/lib/i18n/messages'

export function StoreFooter({ general, locale }: { general: General; locale: Locale }) {
  const year = new Date().getFullYear()
  const t = createTranslator(locale)
  return (
    <footer className="mt-auto border-t bg-card">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 text-sm sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <p className="font-semibold">{general.storeName}</p>
          {general.storeAddress ? <p className="text-muted-foreground">{general.storeAddress}</p> : null}
          <p className="text-muted-foreground">
            {t('footer.support')}{' '}
            <a href={`mailto:${general.supportEmail}`} className="underline">
              {general.supportEmail}
            </a>
            {general.supportPhone ? ` · ${general.supportPhone}` : ''}
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-5 gap-y-2 sm:flex-col sm:items-end">
          <Link href="/#book" className="text-muted-foreground hover:text-foreground hover:underline">
            {t('nav.book')}
          </Link>
          <Link href="/order" className="text-muted-foreground hover:text-foreground hover:underline">
            {t('nav.myOrder')}
          </Link>
          <Link href="/privacy" className="text-muted-foreground hover:text-foreground hover:underline">
            {t('footer.privacy')}
          </Link>
          <Link href="/terms" className="text-muted-foreground hover:text-foreground hover:underline">
            {t('footer.terms')}
          </Link>
        </nav>
      </div>
      <div className="border-t py-4 text-center text-xs text-muted-foreground">
        © {year} {general.storeName}. {t('footer.notOfficial')}. Payments processed by PayPal.
      </div>
    </footer>
  )
}
