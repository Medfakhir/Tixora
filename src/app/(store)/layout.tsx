import { getGeneral } from '@/lib/settings/service'
import { getLocale } from '@/lib/i18n/server'
import { StoreHeader } from '@/components/store/header'
import { StoreFooter } from '@/components/store/footer'

export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const [general, locale] = await Promise.all([getGeneral(), getLocale()])
  return (
    <div className="flex min-h-dvh flex-col">
      <StoreHeader general={general} locale={locale} />
      <main className="flex-1">{children}</main>
      <StoreFooter general={general} locale={locale} />
    </div>
  )
}
