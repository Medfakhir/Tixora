'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { CalendarDays, Check, CircleAlert, Minus, Plus, ShieldCheck, Ticket, Users } from 'lucide-react'
import { api } from '@/lib/api/client'
import { formatMoney } from '@/lib/money'
import { addDaysKey, formatVisitDate, shiftMonth } from '@/lib/museum/dates'
import { createTranslator, type Locale } from '@/lib/i18n/messages'
import type { MonthAvailability } from '@/lib/museum/availability'
import { BookingCalendar } from './booking-calendar'
import { PaypalCheckout } from './paypal-checkout'
import { DemoPayment } from './demo-payment'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Field, FieldRow } from '@/components/shared/field'
import { Separator } from '@/components/ui/separator'

export type BookingSettings = {
  museumName: string
  adultPriceCents: number
  childPriceCents: number
  currency: string
  maxAdultsPerOrder: number
  maxChildrenPerOrder: number
  bookingWindowDays: number
  cutoffTime: string
  timezone: string
  dailyCapacity: number
  officialPartner: boolean
  supportEmail: string
  supportPhone: string
}

type CheckoutResponse = {
  publicId: string
  reference: string
  totalMinor: number
  currency: string
  visitDate: string
  adultQty: number
  childQty: number
}

type FormValues = {
  fullName: string
  email: string
  phone: string
}

const COUNTRY_CODES = ['+212', '+33', '+34', '+44', '+1', '+49', '+39', '+31', '+32', '+41', '+351', '+971', '+966', '+7', '+86', '+91', '+61', '+55', '+27']

export function BookingWidget({
  settings,
  paypal,
  demo,
  initialMonth,
  locale,
}: {
  settings: BookingSettings
  paypal: { enabled: boolean; clientId: string | null; currency: string }
  demo: { enabled: boolean }
  initialMonth: MonthAvailability
  locale: Locale
}) {
  const t = createTranslator(locale)
  const router = useRouter()

  const [monthData, setMonthData] = useState(initialMonth)
  const [monthLoading, setMonthLoading] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [adults, setAdults] = useState(1)
  const [children, setChildren] = useState(0)
  const [phoneCode, setPhoneCode] = useState('+212')
  const [order, setOrder] = useState<CheckoutResponse | null>(null)
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const selectedDay = monthData.days.find((day) => day.date === selectedDate) ?? null
  const remaining = selectedDay?.remaining ?? null
  const maxAdults = Math.max(0, Math.min(settings.maxAdultsPerOrder, remaining ?? settings.maxAdultsPerOrder))
  const maxChildren = Math.max(0, Math.min(settings.maxChildrenPerOrder, remaining ?? settings.maxChildrenPerOrder))
  const quantity = adults + children
  const total = adults * settings.adultPriceCents + children * settings.childPriceCents
  const minMonth = monthData.today.slice(0, 7)
  const maxMonth = addDaysKey(monthData.today, settings.bookingWindowDays).slice(0, 7)

  const schema = useMemo(
    () =>
      z.object({
        fullName: z.string().trim().min(2, 'Enter your full name').max(120, 'Use 120 characters or fewer'),
        email: z.email('Enter a valid email address').max(200),
        phone: z
          .string()
          .trim()
          .min(5, 'Enter a phone number')
          .max(30, 'Use 30 characters or fewer')
          .regex(/^[0-9 ().-]+$/, 'Enter a valid phone number'),
      }),
    [],
  )

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { fullName: '', email: '', phone: '' },
    mode: 'onSubmit',
  })

  function resetOrder() {
    setOrder(null)
    setFormError(null)
  }

  function selectDate(date: string) {
    resetOrder()
    setSelectedDate(date)
    const day = monthData.days.find((candidate) => candidate.date === date)
    const left = day?.remaining ?? null
    if (left !== null) {
      setAdults((current) => Math.min(current, Math.max(0, left)))
      setChildren((current) => Math.min(current, Math.max(0, left)))
    }
  }

  function changeAdults(next: number) {
    resetOrder()
    setAdults(Math.min(Math.max(0, next), maxAdults))
  }

  function changeChildren(next: number) {
    resetOrder()
    setChildren(Math.min(Math.max(0, next), maxChildren))
  }

  async function changeMonth(delta: number) {
    const next = shiftMonth(monthData.year, monthData.monthNumber, delta)
    setMonthLoading(true)
    const result = await api<MonthAvailability>(`/api/museum/availability?month=${next.year}-${String(next.month).padStart(2, '0')}`)
    setMonthLoading(false)
    if (!result.ok) return

    setMonthData(result.data)
    // The previously selected day may no longer be visible, bookable or exist in
    // this month; keeping it would let the form post a stale date.
    const stillBookable =
      selectedDate !== null &&
      result.data.days.some((day) => day.date === selectedDate && day.available)
    if (!stillBookable) {
      setSelectedDate(null)
      resetOrder()
      setAdults(1)
      setChildren(0)
    }
  }

  const onSubmit = handleSubmit(async (values) => {
    if (pending || order) return
    if (!selectedDate) {
      setFormError(t('errors.selectDate'))
      return
    }
    if (quantity < 1) {
      setFormError(t('errors.minTickets'))
      return
    }
    setPending(true)
    setFormError(null)
    clearErrors()

    const result = await api<CheckoutResponse>('/api/museum/checkout', {
      method: 'POST',
      body: {
        date: selectedDate,
        adults,
        children,
        fullName: values.fullName,
        email: values.email,
        phone: `${phoneCode} ${values.phone.trim()}`,
      },
    })
    setPending(false)

    if (!result.ok) {
      if (result.code === 'CAPACITY' || result.code === 'DATE_CLOSED' || result.code === 'CUTOFF' || result.code === 'WEEKLY_CLOSED') {
        setFormError(t('errors.availability'))
      } else {
        setFormError(result.error)
      }
      if (result.fields?.fullName) setError('fullName', { type: 'server', message: result.fields.fullName })
      if (result.fields?.email) setError('email', { type: 'server', message: result.fields.email })
      if (result.fields?.phone) setError('phone', { type: 'server', message: result.fields.phone })
      return
    }

    setOrder(result.data)
    requestAnimationFrame(() => document.getElementById('payment')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  })

  return (
    <div id="book" className="grid scroll-mt-24 gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
      <div className="grid gap-6">
        <Card className="p-5 sm:p-6">
          <CardHeader className="px-0 pt-0">
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary">
                <CalendarDays className="size-4" />
              </span>
              <CardTitle>{t('calendar.selectDate')}</CardTitle>
            </div>
            {selectedDate ? (
              <CardDescription className="flex items-center gap-1.5 text-foreground">
                <Check className="size-3.5 text-emerald-600" />
                {formatVisitDate(selectedDate, locale)}
              </CardDescription>
            ) : (
              <CardDescription>{t('booking.subtitle')}</CardDescription>
            )}
          </CardHeader>
          <CardContent className="px-0">
            <BookingCalendar
              data={monthData}
              locale={locale}
              selected={selectedDate}
              onSelect={selectDate}
              onMonthChange={changeMonth}
              loading={monthLoading}
              minMonth={minMonth}
              maxMonth={maxMonth}
            />
          </CardContent>
        </Card>

        <Card className="p-5 sm:p-6">
          <CardHeader className="px-0 pt-0">
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Ticket className="size-4" />
              </span>
              <CardTitle>{t('tickets.title')}</CardTitle>
            </div>
            <CardDescription>
              {remaining !== null
                ? t('info.capacity', { remaining, capacity: settings.dailyCapacity })
                : t('info.cutoff', { time: settings.cutoffTime, timezone: settings.timezone })}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 px-0">
            <QuantityRow
              label={t('tickets.adult')}
              note={t('tickets.adultNote')}
              price={settings.adultPriceCents}
              currency={settings.currency}
              value={adults}
              max={maxAdults}
              onChange={changeAdults}
              labels={{ decrease: t('tickets.decrease'), increase: t('tickets.increase') }}
            />
            <QuantityRow
              label={t('tickets.child')}
              note={t('tickets.childNote')}
              price={settings.childPriceCents}
              currency={settings.currency}
              value={children}
              max={maxChildren}
              onChange={changeChildren}
              labels={{ decrease: t('tickets.decrease'), increase: t('tickets.increase') }}
            />
            {quantity < 1 ? (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <CircleAlert className="size-3.5" /> {t('errors.minTickets')}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card className="p-5 sm:p-6">
          <CardHeader className="px-0 pt-0">
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Users className="size-4" />
              </span>
              <CardTitle>{t('details.title')}</CardTitle>
            </div>
            <CardDescription>{t('details.emailHint')}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {order ? (
              <div className="grid gap-4">
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900/50 dark:bg-emerald-950/30">
                  <p className="flex items-center gap-2 font-medium text-emerald-900 dark:text-emerald-200">
                    <Check className="size-4" /> {order.reference}
                  </p>
                  <p className="mt-1 text-emerald-800/80 dark:text-emerald-300/80">
                    {formatMoney(order.totalMinor, order.currency)} · {order.visitDate}
                  </p>
                </div>

                <div id="payment" className="grid gap-3 rounded-xl border bg-card p-4">
                  <div className="grid gap-1">
                    <p className="text-sm font-medium">{t('actions.paypal')}</p>
                    <p className="text-xs text-muted-foreground">{t('info.email')}</p>
                  </div>

                  {demo.enabled ? (
                    <Alert>
                      <AlertTitle>{t('demo.bannerTitle')}</AlertTitle>
                      <AlertDescription>{t('demo.bannerBody')}</AlertDescription>
                    </Alert>
                  ) : null}

                  {paypal.enabled && paypal.clientId ? (
                    <PaypalCheckout
                      publicId={order.publicId}
                      clientId={paypal.clientId}
                      currency={paypal.currency}
                      locale={locale}
                      onSuccess={() => {
                        router.push(`/checkout/success?order=${encodeURIComponent(order.publicId)}`)
                      }}
                    />
                  ) : demo.enabled ? null : (
                    <Alert variant="destructive">
                      <AlertTitle>{t('errors.paypalUnavailable')}</AlertTitle>
                      <AlertDescription>
                        <a href={`mailto:${settings.supportEmail}`} className="underline underline-offset-4">
                          {settings.supportEmail}
                        </a>
                      </AlertDescription>
                    </Alert>
                  )}

                  {demo.enabled ? (
                    <DemoPayment
                      publicId={order.publicId}
                      locale={locale}
                      onSuccess={() => {
                        router.push(`/checkout/success?order=${encodeURIComponent(order.publicId)}`)
                      }}
                    />
                  ) : null}

                  <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={resetOrder}>
                    {t('actions.change')}
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={onSubmit} noValidate>
                <fieldset className="grid gap-4" disabled={pending}>
                  <Field label={t('details.fullName')} htmlFor="fullName" error={errors.fullName?.message} required>
                    <Input
                      id="fullName"
                      autoComplete="name"
                      aria-invalid={Boolean(errors.fullName)}
                      {...register('fullName')}
                    />
                  </Field>
                  <Field
                    label={t('details.email')}
                    htmlFor="email"
                    error={errors.email?.message}
                    hint={t('details.emailHint')}
                    required
                  >
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      aria-invalid={Boolean(errors.email)}
                      {...register('email')}
                    />
                  </Field>
                  <Field
                    label={t('details.phone')}
                    htmlFor="phone"
                    error={errors.phone?.message}
                    hint={t('details.phoneHint')}
                    required
                  >
                    <div className="flex gap-2">
                      <select
                        value={phoneCode}
                        onChange={(event) => setPhoneCode(event.target.value)}
                        aria-label={t('details.phoneCode')}
                        className="h-9 w-24 shrink-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                      >
                        {COUNTRY_CODES.map((code) => (
                          <option key={code} value={code}>
                            {code}
                          </option>
                        ))}
                      </select>
                      <Input
                        id="phone"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel-national"
                        placeholder="6 12 34 56 78"
                        aria-invalid={Boolean(errors.phone)}
                        {...register('phone')}
                      />
                    </div>
                  </Field>

                  {formError ? (
                    <Alert variant="destructive">
                      <AlertTitle>{t('errors.generic')}</AlertTitle>
                      <AlertDescription>{formError}</AlertDescription>
                    </Alert>
                  ) : null}

                  <Button type="submit" size="lg" className="mt-1 w-full" disabled={pending || quantity < 1}>
                    {pending ? t('actions.creating') : `${t('actions.continue')} · ${formatMoney(total, settings.currency)}`}
                  </Button>
                  <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0" /> {t('info.secure')}
                  </p>
                </fieldset>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      <aside className="lg:sticky lg:top-20">
        <Card className="overflow-hidden p-0">
          <div className="bg-primary px-5 py-4 text-primary-foreground">
            <p className="text-xs font-medium tracking-wider uppercase opacity-75">{t('summary.title')}</p>
            <p className="mt-1 font-heading text-lg font-semibold">{settings.museumName}</p>
          </div>
          <CardContent className="grid gap-4 p-5">
            <div className="flex items-start gap-3 rounded-lg bg-muted/60 p-3">
              <CalendarDays className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">
                  {selectedDate ? formatVisitDate(selectedDate, locale) : t('summary.noDate')}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {quantity > 0 ? `${quantity} ${quantity === 1 ? 'ticket' : 'tickets'}` : t('errors.minTickets')}
                </p>
              </div>
            </div>

            <div>
              <FieldRow label={`${t('summary.adults')} × ${adults}`} value={formatMoney(adults * settings.adultPriceCents, settings.currency)} />
              <FieldRow label={`${t('summary.children')} × ${children}`} value={formatMoney(children * settings.childPriceCents, settings.currency)} />
              <Separator className="my-2" />
              <FieldRow
                label={t('summary.total')}
                value={<span className="text-base font-semibold">{formatMoney(order?.totalMinor ?? total, order?.currency ?? settings.currency)}</span>}
              />
              <p className="text-right text-[11px] text-muted-foreground">{t('info.vat')}</p>
            </div>

            <div className="grid gap-1.5 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
              <p>{t('info.cutoff', { time: settings.cutoffTime, timezone: settings.timezone })}</p>
              <p>
                {settings.dailyCapacity > 0 && remaining !== null
                  ? t('info.capacity', { remaining, capacity: settings.dailyCapacity })
                  : t('info.unlimited')}
              </p>
              <p>{t('info.email')}</p>
            </div>

            {!settings.officialPartner ? (
              <p className="rounded-lg bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                {t('info.disclaimer')}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </aside>
    </div>
  )
}

function QuantityRow({
  label,
  note,
  price,
  currency,
  value,
  max,
  onChange,
  labels,
}: {
  label: string
  note: string
  price: number
  currency: string
  value: number
  max: number
  onChange: (next: number) => void
  labels: { decrease: string; increase: string }
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{note}</p>
        <p className="mt-0.5 text-xs font-medium tabular-nums">{formatMoney(price, currency)}</p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onChange(value - 1)}
          disabled={value <= 0}
          aria-label={labels.decrease}
          className="inline-flex size-8 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-35"
        >
          <Minus className="size-3.5" />
        </button>
        <span className="w-5 text-center text-sm font-semibold tabular-nums" aria-live="polite">
          {value}
        </span>
        <button
          type="button"
          onClick={() => onChange(value + 1)}
          disabled={value >= max}
          aria-label={labels.increase}
          className="inline-flex size-8 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-35"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
