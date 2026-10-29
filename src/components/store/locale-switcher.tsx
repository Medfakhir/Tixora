'use client'

import { useRouter } from 'next/navigation'
import { Languages } from 'lucide-react'
import { LOCALE_COOKIE, LOCALE_LABELS, LOCALES, type Locale } from '@/lib/i18n/messages'

export function LocaleSwitcher({ locale }: { locale: Locale }) {
  const router = useRouter()

  function choose(next: Locale) {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
    router.refresh()
  }

  return (
    <label className="relative inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <Languages className="size-4" aria-hidden="true" />
      <span className="sr-only">{LOCALE_LABELS[locale]}</span>
      <select
        value={locale}
        onChange={(event) => choose(event.target.value as Locale)}
        className="cursor-pointer appearance-none rounded-md bg-transparent py-1 pr-4 pl-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Language"
      >
        {LOCALES.map((option) => (
          <option key={option} value={option}>
            {option.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  )
}
