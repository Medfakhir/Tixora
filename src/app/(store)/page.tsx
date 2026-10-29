import Link from 'next/link'
import { CalendarCheck, Clock3, Mail, MapPin, ShieldCheck, Sparkles, Ticket } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BookingWidget } from '@/components/museum/booking-widget'
import { getMuseumSettings } from '@/lib/museum/settings'
import { getMonthAvailability } from '@/lib/museum/availability'
import { parseMonthKey } from '@/lib/museum/dates'
import { getTranslator } from '@/lib/i18n/server'
import { getPayPal, publicPayPalConfig } from '@/lib/settings/service'
import { demoPaymentsEnabled } from '@/lib/config/env'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Book your visit',
  description: 'Book digital entrance tickets for Badi Palace Museum in Marrakech. Adult €12.99, child €6.99.',
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export default async function MuseumBookingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const [settings, paypal, { locale, t }, params] = await Promise.all([
    getMuseumSettings(),
    getPayPal(),
    getTranslator(),
    searchParams,
  ])
  const { year, month } = parseMonthKey(first(params.month), settings.timezone)
  const initialMonth = await getMonthAvailability({ year, month }, settings)
  const publicPaypal = publicPayPalConfig(paypal)

  return (
    <div>
      <section className="relative overflow-hidden border-b bg-[linear-gradient(135deg,oklch(0.97_0.02_75),oklch(0.94_0.04_55))] dark:bg-[linear-gradient(135deg,oklch(0.24_0.03_55),oklch(0.2_0.04_40))]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.16] [background-image:radial-gradient(circle_at_1px_1px,currentColor_1px,transparent_0)] [background-size:22px_22px]"
        />
        <div className="relative mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:py-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-center">
          <div className="grid gap-5">
            <Badge variant="secondary" className="w-fit border-amber-300/50 bg-amber-100/70 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
              <Sparkles className="size-3.5" /> {t('hero.eyebrow')}
            </Badge>
            <div className="grid gap-3">
              <h1 className="max-w-2xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
                {t('hero.title')}
              </h1>
              <p className="max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">{t('hero.subtitle')}</p>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Clock3 className="size-4 text-primary" /> {t('hero.open')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Mail className="size-4 text-primary" /> {t('hero.instant')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="size-4 text-primary" /> {t('hero.secure')}
              </span>
            </div>
            <div className="flex flex-wrap gap-3 pt-1">
              <Button size="lg" render={<Link href="#book" />}>
                <Ticket data-icon="inline-start" /> {t('nav.book')}
              </Button>
              <Button size="lg" variant="outline" render={<Link href="/order" />}>
                {t('nav.myOrder')}
              </Button>
            </div>
            <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
              <MapPin className="mt-0.5 size-4 shrink-0" />
              {settings.museumAddress}
            </p>
          </div>

          <div className="relative overflow-hidden rounded-2xl bg-primary p-7 text-primary-foreground shadow-lg sm:p-9">
            <div className="pointer-events-none absolute -top-12 -right-10 size-44 rounded-full bg-amber-300/20" aria-hidden="true" />
            <div className="pointer-events-none absolute -bottom-16 -left-12 size-52 rounded-full bg-white/5" aria-hidden="true" />
            <p className="text-xs font-medium tracking-[0.18em] uppercase opacity-70">Badi Palace · Marrakech</p>
            <p className="mt-5 font-heading text-2xl leading-snug font-medium sm:text-3xl">
              “The palace of marvels.”
            </p>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-primary-foreground/75">
              Built by Sultan Ahmad al-Mansur in the 16th century, the Badi Palace is one of Morocco&apos;s great
              architectural treasures.
            </p>
            <ul className="mt-7 grid gap-3 text-sm text-primary-foreground/85">
              <li className="flex items-center gap-2">
                <CalendarCheck className="size-4 shrink-0" /> Choose any open date
              </li>
              <li className="flex items-center gap-2">
                <Ticket className="size-4 shrink-0" /> Adults €12.99 · Children €6.99
              </li>
              <li className="flex items-center gap-2">
                <Mail className="size-4 shrink-0" /> QR ticket by email
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:py-14">
        <div className="mb-6 grid gap-1">
          <h2 className="font-heading text-2xl font-semibold tracking-tight">{t('booking.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('booking.subtitle')}</p>
        </div>

        <BookingWidget
          settings={{
            museumName: settings.museumName,
            adultPriceCents: settings.adultPriceCents,
            childPriceCents: settings.childPriceCents,
            currency: settings.currency,
            maxAdultsPerOrder: settings.maxAdultsPerOrder,
            maxChildrenPerOrder: settings.maxChildrenPerOrder,
            bookingWindowDays: settings.bookingWindowDays,
            cutoffTime: settings.cutoffTime,
            timezone: settings.timezone,
            dailyCapacity: settings.dailyCapacity,
            officialPartner: settings.officialPartner,
            supportEmail: settings.supportEmail,
            supportPhone: settings.supportPhone,
          }}
          paypal={{ enabled: publicPaypal.enabled, clientId: publicPaypal.clientId, currency: settings.currency }}
          demo={{ enabled: demoPaymentsEnabled }}
          initialMonth={initialMonth}
          locale={locale}
        />
      </section>

      <section className="border-t bg-muted/30">
        <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-10 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <h3 className="text-sm font-semibold">Opening hours</h3>
            <p className="text-sm text-muted-foreground">Open daily, 09:00–17:00. Last entry 30 minutes before closing.</p>
          </div>
          <div className="grid gap-1.5">
            <h3 className="text-sm font-semibold">Getting here</h3>
            <p className="text-sm text-muted-foreground">{settings.museumAddress}</p>
          </div>
          <div className="grid gap-1.5">
            <h3 className="text-sm font-semibold">{t('footer.support')}</h3>
            <p className="text-sm text-muted-foreground">
              <a href={`mailto:${settings.supportEmail}`} className="underline underline-offset-4">
                {settings.supportEmail}
              </a>
              {settings.supportPhone ? ` · ${settings.supportPhone}` : ''}
            </p>
          </div>
        </div>
      </section>

      {!settings.officialPartner ? (
        <section className="border-t">
          <div className="mx-auto w-full max-w-6xl px-4 py-6">
            <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
              <strong>Independent booking service.</strong> {t('info.disclaimer')}
            </p>
          </div>
        </section>
      ) : null}
    </div>
  )
}
