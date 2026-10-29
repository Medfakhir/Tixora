'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Info, Save } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api/client'
import { formatMoney } from '@/lib/money'
import { toMinorUnits } from '@/components/shared/money'
import { PageHeader, SectionCard } from '@/components/admin/page-primitives'
import { Field } from '@/components/shared/field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SUPPORTED_CURRENCIES } from '@/lib/money'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type MuseumSettingsFormState = {
  museumName: string
  museumTagline: string
  museumAddress: string
  supportEmail: string
  supportPhone: string
  timezone: string
  currency: string
  adultPrice: string
  childPrice: string
  dailyCapacity: string
  cutoffTime: string
  bookingWindowDays: string
  maxAdultsPerOrder: string
  maxChildrenPerOrder: string
  officialPartner: boolean
}

const CURRENCY_ITEMS = SUPPORTED_CURRENCIES.map((currency) => ({ value: currency, label: currency }))

export function MuseumSettingsForm({
  initial,
  timezones,
  canEdit,
}: {
  initial: MuseumSettingsFormState
  timezones: string[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [form, setForm] = useState(initial)
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  function update<K extends keyof MuseumSettingsFormState>(key: K, value: MuseumSettingsFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || pending) return

    setPending(true)
    setFormError(null)
    setFieldErrors({})

    const result = await api('/api/admin/settings/museum', {
      method: 'POST',
      body: {
        museumName: form.museumName,
        museumTagline: form.museumTagline,
        museumAddress: form.museumAddress,
        supportEmail: form.supportEmail,
        supportPhone: form.supportPhone,
        timezone: form.timezone,
        currency: form.currency,
        adultPriceCents: toMinorUnits(form.adultPrice, form.currency),
        childPriceCents: toMinorUnits(form.childPrice, form.currency),
        dailyCapacity: Number(form.dailyCapacity || '0'),
        cutoffTime: form.cutoffTime,
        bookingWindowDays: Number(form.bookingWindowDays || '180'),
        maxAdultsPerOrder: Number(form.maxAdultsPerOrder || '20'),
        maxChildrenPerOrder: Number(form.maxChildrenPerOrder || '20'),
        officialPartner: form.officialPartner,
      },
    })

    setPending(false)
    if (!result.ok) {
      setFormError(result.error)
      setFieldErrors(result.fields ?? {})
      toast.error(result.error)
      return
    }

    toast.success('Museum settings saved. New prices apply to the next booking.')
    router.refresh()
  }

  const adultPreview = formatMoney(toMinorUnits(form.adultPrice, form.currency), form.currency)
  const childPreview = formatMoney(toMinorUnits(form.childPrice, form.currency), form.currency)

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-6">
      <PageHeader
        title="Museum settings"
        description="Prices, capacity and sales rules. Changes are read from the database on every booking, so they apply immediately."
      />

      {!canEdit ? (
        <Alert>
          <AlertDescription>Only super admins can change museum settings.</AlertDescription>
        </Alert>
      ) : null}

      {formError ? (
        <Alert variant="destructive">
          <AlertTitle>Settings not saved</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <fieldset disabled={!canEdit || pending} className="grid gap-6">
        <SectionCard title="Museum identity" description="Used on the booking page, footer and confirmation email.">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Museum name" htmlFor="museumName" error={fieldErrors.museumName} required>
              <Input id="museumName" value={form.museumName} onChange={(event) => update('museumName', event.target.value)} />
            </Field>
            <Field label="Tagline" htmlFor="museumTagline" error={fieldErrors.museumTagline}>
              <Input id="museumTagline" value={form.museumTagline} onChange={(event) => update('museumTagline', event.target.value)} />
            </Field>
            <Field label="Address" htmlFor="museumAddress" error={fieldErrors.museumAddress} className="md:col-span-2">
              <Textarea
                id="museumAddress"
                rows={2}
                value={form.museumAddress}
                onChange={(event) => update('museumAddress', event.target.value)}
              />
            </Field>
            <Field label="Support email" htmlFor="supportEmail" error={fieldErrors.supportEmail} required>
              <Input
                id="supportEmail"
                type="email"
                value={form.supportEmail}
                onChange={(event) => update('supportEmail', event.target.value)}
              />
            </Field>
            <Field label="Support phone" htmlFor="supportPhone" error={fieldErrors.supportPhone}>
              <Input id="supportPhone" value={form.supportPhone} onChange={(event) => update('supportPhone', event.target.value)} />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="Ticket prices" description="Stored as integer minor units. The public page shows these amounts.">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Adult price" htmlFor="adultPrice" error={fieldErrors.adultPriceCents} hint={adultPreview} required>
              <Input
                id="adultPrice"
                inputMode="decimal"
                value={form.adultPrice}
                onChange={(event) => update('adultPrice', event.target.value)}
              />
            </Field>
            <Field label="Child price" htmlFor="childPrice" error={fieldErrors.childPriceCents} hint={childPreview} required>
              <Input
                id="childPrice"
                inputMode="decimal"
                value={form.childPrice}
                onChange={(event) => update('childPrice', event.target.value)}
              />
            </Field>
            <Field label="Currency" htmlFor="currency" error={fieldErrors.currency} required>
              <Select items={CURRENCY_ITEMS} value={form.currency} onValueChange={(value) => update('currency', value ?? 'EUR')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_CURRENCIES.map((currency) => (
                    <SelectItem key={currency} value={currency}>
                      {currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Timezone" htmlFor="timezone" error={fieldErrors.timezone} hint="IANA name, e.g. Africa/Casablanca" required>
              <Input
                id="timezone"
                value={form.timezone}
                list="museum-timezones"
                onChange={(event) => update('timezone', event.target.value)}
              />
              <datalist id="museum-timezones">
                {timezones.map((timezone) => (
                  <option key={timezone} value={timezone} />
                ))}
              </datalist>
            </Field>
          </div>
          <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            Prices apply to new bookings only. Existing orders keep the amount that was charged.
          </p>
        </SectionCard>

        <SectionCard title="Availability and cutoff" description="Controls the public calendar and server-side validation.">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Field
              label="Daily capacity"
              htmlFor="dailyCapacity"
              error={fieldErrors.dailyCapacity}
              hint="0 = unlimited. Counts adults and children."
              required
            >
              <Input
                id="dailyCapacity"
                type="number"
                min={0}
                step={1}
                value={form.dailyCapacity}
                onChange={(event) => update('dailyCapacity', event.target.value)}
              />
            </Field>
            <Field
              label="Same-day cutoff"
              htmlFor="cutoffTime"
              error={fieldErrors.cutoffTime}
              hint="Today becomes unavailable after this local time."
              required
            >
              <Input
                id="cutoffTime"
                type="time"
                value={form.cutoffTime}
                onChange={(event) => update('cutoffTime', event.target.value)}
              />
            </Field>
            <Field
              label="Booking window (days)"
              htmlFor="bookingWindowDays"
              error={fieldErrors.bookingWindowDays}
              hint="How far ahead visitors may book."
              required
            >
              <Input
                id="bookingWindowDays"
                type="number"
                min={1}
                max={730}
                step={1}
                value={form.bookingWindowDays}
                onChange={(event) => update('bookingWindowDays', event.target.value)}
              />
            </Field>
            <Field label="Max adults per order" htmlFor="maxAdultsPerOrder" error={fieldErrors.maxAdultsPerOrder} required>
              <Input
                id="maxAdultsPerOrder"
                type="number"
                min={1}
                max={50}
                step={1}
                value={form.maxAdultsPerOrder}
                onChange={(event) => update('maxAdultsPerOrder', event.target.value)}
              />
            </Field>
            <Field label="Max children per order" htmlFor="maxChildrenPerOrder" error={fieldErrors.maxChildrenPerOrder} required>
              <Input
                id="maxChildrenPerOrder"
                type="number"
                min={0}
                max={50}
                step={1}
                value={form.maxChildrenPerOrder}
                onChange={(event) => update('maxChildrenPerOrder', event.target.value)}
              />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="Official status" description="Controls the disclaimer shown on the booking page and confirmation.">
          <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <div className="grid gap-1">
              <Label htmlFor="officialPartner">Authorised official ticket office</Label>
              <p className="text-xs text-muted-foreground">
                Enable only if this site is operated or authorised by the museum. Otherwise the independent booking
                disclaimer stays visible.
              </p>
            </div>
            <Switch
              id="officialPartner"
              checked={form.officialPartner}
              onCheckedChange={(checked) => update('officialPartner', checked)}
            />
          </div>
        </SectionCard>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            <Save data-icon="inline-start" /> {pending ? 'Saving…' : 'Save museum settings'}
          </Button>
          <p className="text-xs text-muted-foreground">Changes are audited and applied immediately.</p>
        </div>
      </fieldset>
    </form>
  )
}
