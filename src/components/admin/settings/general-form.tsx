'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Field } from '@/components/shared/field'
import { SectionCard } from '@/components/admin/page-primitives'
import { api } from '@/lib/api/client'
import { SUPPORTED_CURRENCIES } from '@/lib/money'

export type GeneralFormState = {
  storeName: string
  supportEmail: string
  supportPhone: string
  storeAddress: string
  timezone: string
  defaultCurrency: string
  taxLabel: string
  taxRatePercent: string
  receiptPrefix: string
  reservationMinutes: string
  maxTicketsPerOrder: string
  requirePhone: boolean
  billingRequired: boolean
  maintenanceMode: boolean
  privacyUrl: string
  termsUrl: string
  privacyPolicy: string
  termsAndConditions: string
}

const CURRENCY_ITEMS = SUPPORTED_CURRENCIES.map((currency) => ({ value: currency, label: currency }))

export function GeneralForm({
  initial,
  timezones,
  canEdit,
}: {
  initial: GeneralFormState
  timezones: string[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [form, setForm] = useState(initial)
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  function update<K extends keyof GeneralFormState>(key: K, value: GeneralFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || pending) return

    const taxPercent = Number.parseFloat(form.taxRatePercent.replace(',', '.'))
    if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) {
      setFieldErrors({ taxRateBps: 'Enter a tax rate between 0 and 100 percent.' })
      return
    }

    setPending(true)
    setFormError(null)
    setFieldErrors({})

    const result = await api('/api/admin/settings/general', {
      method: 'POST',
      body: {
        storeName: form.storeName,
        supportEmail: form.supportEmail,
        supportPhone: form.supportPhone,
        storeAddress: form.storeAddress,
        timezone: form.timezone,
        defaultCurrency: form.defaultCurrency,
        taxRateBps: Math.round(taxPercent * 100),
        taxLabel: form.taxLabel,
        receiptPrefix: form.receiptPrefix,
        reservationMinutes: Number(form.reservationMinutes),
        maxTicketsPerOrder: Number(form.maxTicketsPerOrder),
        requirePhone: form.requirePhone,
        billingRequired: form.billingRequired,
        maintenanceMode: form.maintenanceMode,
        privacyUrl: form.privacyUrl,
        termsUrl: form.termsUrl,
        privacyPolicy: form.privacyPolicy,
        termsAndConditions: form.termsAndConditions,
      },
    })

    if (!result.ok) {
      setFormError(result.error)
      setFieldErrors(result.fields ?? {})
      toast.error(result.error)
      setPending(false)
      return
    }

    toast.success('General settings saved.')
    setPending(false)
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <fieldset disabled={!canEdit || pending} className="grid gap-6">
        {!canEdit ? (
          <Alert>
            <AlertDescription>Only super admins can change general settings.</AlertDescription>
          </Alert>
        ) : null}

        {formError ? (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <SectionCard title="Store details" description="Shown on the storefront, receipts and customer emails.">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Store name" htmlFor="storeName" error={fieldErrors.storeName} required>
              <Input id="storeName" value={form.storeName} onChange={(event) => update('storeName', event.target.value)} />
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
            <Field label="Store address" htmlFor="storeAddress" error={fieldErrors.storeAddress}>
              <Textarea
                id="storeAddress"
                rows={2}
                value={form.storeAddress}
                onChange={(event) => update('storeAddress', event.target.value)}
              />
            </Field>
            <Field
              label="Timezone"
              htmlFor="timezone"
              hint="IANA timezone used for reports, sessions and receipts."
              error={fieldErrors.timezone}
              required
            >
              <Input
                id="timezone"
                list="timezone-options"
                value={form.timezone}
                onChange={(event) => update('timezone', event.target.value)}
              />
              <datalist id="timezone-options">
                {timezones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </Field>
            <Field label="Default currency" error={fieldErrors.defaultCurrency} required>
              <Select
                items={CURRENCY_ITEMS}
                value={form.defaultCurrency}
                onValueChange={(value) => update('defaultCurrency', value ?? '')}
              >
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
          </div>
        </SectionCard>

        <SectionCard title="Tax and receipts" description="Tax is stored as basis points; enter the rate as a percentage.">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Tax label" htmlFor="taxLabel" error={fieldErrors.taxLabel}>
              <Input id="taxLabel" value={form.taxLabel} onChange={(event) => update('taxLabel', event.target.value)} />
            </Field>
            <Field
              label="Tax rate (%)"
              htmlFor="taxRatePercent"
              hint="For example 7.5 for 7.5 percent."
              error={fieldErrors.taxRateBps}
              required
            >
              <Input
                id="taxRatePercent"
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step="0.01"
                value={form.taxRatePercent}
                onChange={(event) => update('taxRatePercent', event.target.value)}
              />
            </Field>
            <Field label="Receipt prefix" htmlFor="receiptPrefix" hint="1-8 letters or digits." error={fieldErrors.receiptPrefix} required>
              <Input
                id="receiptPrefix"
                maxLength={8}
                value={form.receiptPrefix}
                onChange={(event) => update('receiptPrefix', event.target.value)}
              />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="Checkout rules">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Reservation window (minutes)" htmlFor="reservationMinutes" error={fieldErrors.reservationMinutes} required>
              <Input
                id="reservationMinutes"
                type="number"
                min={1}
                max={720}
                value={form.reservationMinutes}
                onChange={(event) => update('reservationMinutes', event.target.value)}
              />
            </Field>
            <Field label="Maximum tickets per order" htmlFor="maxTicketsPerOrder" error={fieldErrors.maxTicketsPerOrder} required>
              <Input
                id="maxTicketsPerOrder"
                type="number"
                min={1}
                max={500}
                value={form.maxTicketsPerOrder}
                onChange={(event) => update('maxTicketsPerOrder', event.target.value)}
              />
            </Field>

            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <Label htmlFor="requirePhone">Require a phone number</Label>
              <Switch id="requirePhone" checked={form.requirePhone} onCheckedChange={(checked) => update('requirePhone', checked)} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <Label htmlFor="billingRequired">Require billing address</Label>
              <Switch
                id="billingRequired"
                checked={form.billingRequired}
                onCheckedChange={(checked) => update('billingRequired', checked)}
              />
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Maintenance mode"
          description="While enabled, the storefront is unavailable to customers. Administrators can still sign in."
        >
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <Label htmlFor="maintenanceMode">Enable maintenance mode</Label>
            <Switch
              id="maintenanceMode"
              checked={form.maintenanceMode}
              onCheckedChange={(checked) => update('maintenanceMode', checked)}
            />
          </div>
        </SectionCard>

        <SectionCard title="Legal pages" description="The URLs are linked from checkout; the text is rendered on your own pages.">
          <div className="grid gap-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Privacy policy URL" htmlFor="privacyUrl" hint="A path such as /privacy or a full URL." error={fieldErrors.privacyUrl}>
                <Input id="privacyUrl" value={form.privacyUrl} onChange={(event) => update('privacyUrl', event.target.value)} />
              </Field>
              <Field label="Terms URL" htmlFor="termsUrl" hint="A path such as /terms or a full URL." error={fieldErrors.termsUrl}>
                <Input id="termsUrl" value={form.termsUrl} onChange={(event) => update('termsUrl', event.target.value)} />
              </Field>
            </div>
            <Field label="Privacy policy text" htmlFor="privacyPolicy" error={fieldErrors.privacyPolicy}>
              <Textarea
                id="privacyPolicy"
                rows={8}
                value={form.privacyPolicy}
                onChange={(event) => update('privacyPolicy', event.target.value)}
              />
            </Field>
            <Field label="Terms and conditions text" htmlFor="termsAndConditions" error={fieldErrors.termsAndConditions}>
              <Textarea
                id="termsAndConditions"
                rows={8}
                value={form.termsAndConditions}
                onChange={(event) => update('termsAndConditions', event.target.value)}
              />
            </Field>
          </div>
        </SectionCard>

        <div className="flex justify-end">
          <Button type="submit" disabled={!canEdit || pending}>
            <Save />
            {pending ? 'Saving...' : 'Save settings'}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
