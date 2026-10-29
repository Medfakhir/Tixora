import { cookies } from 'next/headers'
import { LOCALE_COOKIE, createTranslator, isLocale, type Locale, type Translate } from './messages'

/** Locale is a cookie so /book, /checkout and the success page always agree. */
export async function getLocale(): Promise<Locale> {
  const store = await cookies()
  const value = store.get(LOCALE_COOKIE)?.value
  return isLocale(value) ? value : 'en'
}

export async function getTranslator(): Promise<{ locale: Locale; t: Translate }> {
  const locale = await getLocale()
  return { locale, t: createTranslator(locale) }
}
