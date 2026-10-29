'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PlugZap, Save, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Field } from '@/components/shared/field'
import { SectionCard } from '@/components/admin/page-primitives'
import { api } from '@/lib/api/client'
import { SUPPORTED_CURRENCIES } from '@/lib/money'

type PaymentEnvironment = 'SANDBOX' | 'LIVE'

export type PayPalFormInitial = {
  enabled: boolean
  environment: PaymentEnvironment
  sandboxClientId: string
  hasSandboxSecret: boolean
  liveClientId: string
  hasLiveSecret: boolean
  webhookIdSandbox: string
  webhookIdLive: string
  currency: string
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestError: string | null
  ready: boolean
}

type PayPalState = PayPalFormInitial & {
  sandboxClientSecret: string
  liveClientSecret: string
  replaceSandboxSecret: boolean
  replaceLiveSecret: boolean
  clearSandboxSecret: boolean
  clearLiveSecret: boolean
}

type PayPalResponse = {
  enabled: boolean
  environment: PaymentEnvironment
  sandboxClientId: string | null
  hasSandboxSecret: boolean
  liveClientId: string | null
  hasLiveSecret: boolean
  webhookIdSandbox: string | null
  webhookIdLive: string | null
  currency: string
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestError: string | null
  ready: boolean
}

const ENVIRONMENT_ITEMS = [
  { value: 'SANDBOX', label: 'Sandbox' },
  { value: 'LIVE', label: 'Live' },
]

const CURRENCY_ITEMS = SUPPORTED_CURRENCIES.map((currency) => ({ value: currency, label: currency }))

function formatStamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function fromResponse(current: PayPalState, data: PayPalResponse): PayPalState {
  return {
    ...current,
    enabled: data.enabled,
    environment: data.environment,
    sandboxClientId: data.sandboxClientId ?? '',
    hasSandboxSecret: data.hasSandboxSecret,
    liveClientId: data.liveClientId ?? '',
    hasLiveSecret: data.hasLiveSecret,
    webhookIdSandbox: data.webhookIdSandbox ?? '',
    webhookIdLive: data.webhookIdLive ?? '',
    currency: data.currency,
    lastTestAt: data.lastTestAt,
    lastTestOk: data.lastTestOk,
    lastTestError: data.lastTestError,
    ready: data.ready,
    sandboxClientSecret: '',
    liveClientSecret: '',
    replaceSandboxSecret: false,
    replaceLiveSecret: false,
    clearSandboxSecret: false,
    clearLiveSecret: false,
  }
}

function SecretField({
  label,
  id,
  stored,
  replacing,
  cleared,
  value,
  error,
  onChange,
  onReplace,
  onCancelReplace,
  onClear,
  onUndoClear,
}: {
  label: string
  id: string
  stored: boolean
  replacing: boolean
  cleared: boolean
  value: string
  error?: string
  onChange: (value: string) => void
  onReplace: () => void
  onCancelReplace: () => void
  onClear: () => void
  onUndoClear: () => void
}) {
  return (
    <Field
      label={label}
      htmlFor={id}
      error={error}
      hint={
        cleared
          ? 'The stored secret is removed when you save.'
          : stored
            ? 'A secret is configured. Leave the replacement blank to keep it.'
            : 'No secret is configured for this environment.'
      }
    >
      {cleared ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>Stored secret will be cleared on save.</span>
          <Button type="button" size="sm" variant="outline" onClick={onUndoClear}>
            Undo
          </Button>
        </div>
      ) : stored && !replacing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={id}
            value="••••••••"
            readOnly
            aria-label={`${label} configured`}
            className="w-40 font-mono tracking-widest"
          />
          <Button type="button" size="sm" variant="outline" onClick={onReplace}>
            Replace secret
          </Button>
          <Button type="button" size="sm" variant="destructive" onClick={onClear}>
            Clear stored secret
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            maxLength={400}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={stored ? 'Enter a replacement secret' : 'Enter the secret'}
          />
          {replacing ? (
            <div>
              <Button type="button" size="sm" variant="ghost" onClick={onCancelReplace}>
                Cancel replacement
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Field>
  )
}

export function PayPalForm({ initial }: { initial: PayPalFormInitial }) {
  const router = useRouter()
  const [form, setForm] = useState<PayPalState>({
    ...initial,
    sandboxClientSecret: '',
    liveClientSecret: '',
    replaceSandboxSecret: false,
    replaceLiveSecret: false,
    clearSandboxSecret: false,
    clearLiveSecret: false,
  })
  const [pending, setPending] = useState(false)
  const [testing, setTesting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  function update<K extends keyof PayPalState>(key: K, value: PayPalState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return

    setPending(true)
    setFormError(null)
    setFieldErrors({})

    const payload: Record<string, unknown> = {
      enabled: form.enabled,
      environment: form.environment,
      sandboxClientId: form.sandboxClientId,
      liveClientId: form.liveClientId,
      webhookIdSandbox: form.webhookIdSandbox,
      webhookIdLive: form.webhookIdLive,
      currency: form.currency,
      clearSandboxSecret: form.clearSandboxSecret,
      clearLiveSecret: form.clearLiveSecret,
    }
    if (!form.clearSandboxSecret && form.sandboxClientSecret) payload.sandboxClientSecret = form.sandboxClientSecret
    if (!form.clearLiveSecret && form.liveClientSecret) payload.liveClientSecret = form.liveClientSecret

    const result = await api<PayPalResponse>('/api/admin/settings/paypal', { method: 'POST', body: payload })

    if (!result.ok) {
      setFormError(result.error)
      setFieldErrors(result.fields ?? {})
      toast.error(result.error)
      setPending(false)
      return
    }

    setForm((current) => fromResponse(current, result.data))
    toast.success('PayPal settings saved.')
    setPending(false)
    router.refresh()
  }

  async function testConnection() {
    if (testing) return
    setTesting(true)
    setFormError(null)

    const result = await api<{ ok: boolean; environment: PaymentEnvironment; message: string }>(
      '/api/admin/settings/paypal/test',
      { method: 'POST', body: { environment: form.environment } },
    )

    const checkedAt = new Date().toISOString()
    if (!result.ok) {
      setForm((current) => ({
        ...current,
        lastTestAt: checkedAt,
        lastTestOk: false,
        lastTestError: result.error,
      }))
      toast.error(result.error)
      setTesting(false)
      return
    }

    setForm((current) => ({
      ...current,
      lastTestAt: checkedAt,
      lastTestOk: result.data.ok,
      lastTestError: result.data.ok ? null : result.data.message,
    }))
    if (result.data.ok) toast.success(result.data.message)
    else toast.error(result.data.message)
    setTesting(false)
    router.refresh()
  }

  return (
    <form onSubmit={save} noValidate>
      <fieldset disabled={pending} className="grid gap-6">
        <Alert>
          <ShieldCheck />
          <AlertTitle>Secrets are encrypted at rest</AlertTitle>
          <AlertDescription>
            Client secrets are encrypted with AES-256-GCM and are never returned by the API. A blank replacement leaves
            the stored secret unchanged; only the explicit clear action removes it. Environment-variable fallbacks are
            not affected by clearing.
          </AlertDescription>
        </Alert>

        {formError ? (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <SectionCard title="Payment account" description="Only one environment is used for new checkout payments.">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Environment" error={fieldErrors.environment} required>
              <Select
                items={ENVIRONMENT_ITEMS}
                value={form.environment}
                onValueChange={(value) => update('environment', (value ?? 'SANDBOX') as PaymentEnvironment)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENVIRONMENT_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Checkout currency" error={fieldErrors.currency} required>
              <Select
                items={CURRENCY_ITEMS}
                value={form.currency}
                onValueChange={(value) => update('currency', value ?? '')}
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
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 md:col-span-2">
              <div>
                <Label htmlFor="paypalEnabled">Enable PayPal checkout</Label>
                <p className="text-xs text-muted-foreground">
                  {form.ready ? 'Credentials are complete for the selected environment.' : 'Credentials are incomplete for the selected environment.'}
                </p>
              </div>
              <Switch id="paypalEnabled" checked={form.enabled} onCheckedChange={(checked) => update('enabled', checked)} />
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Sandbox credentials">
          <div className="grid gap-4">
            <Field label="Sandbox client ID" htmlFor="sandboxClientId" error={fieldErrors.sandboxClientId}>
              <Input
                id="sandboxClientId"
                value={form.sandboxClientId}
                onChange={(event) => update('sandboxClientId', event.target.value)}
                maxLength={200}
                autoComplete="off"
              />
            </Field>
            <SecretField
              label="Sandbox client secret"
              id="sandboxClientSecret"
              stored={form.hasSandboxSecret}
              replacing={form.replaceSandboxSecret}
              cleared={form.clearSandboxSecret}
              value={form.sandboxClientSecret}
              error={fieldErrors.sandboxClientSecret}
              onChange={(value) => update('sandboxClientSecret', value)}
              onReplace={() => update('replaceSandboxSecret', true)}
              onCancelReplace={() => {
                update('replaceSandboxSecret', false)
                update('sandboxClientSecret', '')
              }}
              onClear={() => {
                update('clearSandboxSecret', true)
                update('replaceSandboxSecret', false)
                update('sandboxClientSecret', '')
              }}
              onUndoClear={() => update('clearSandboxSecret', false)}
            />
            <Field
              label="Sandbox webhook ID"
              htmlFor="webhookIdSandbox"
              hint="Used to verify sandbox webhook signatures."
              error={fieldErrors.webhookIdSandbox}
            >
              <Input
                id="webhookIdSandbox"
                value={form.webhookIdSandbox}
                onChange={(event) => update('webhookIdSandbox', event.target.value)}
                maxLength={200}
              />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="Live credentials">
          <div className="grid gap-4">
            <Field label="Live client ID" htmlFor="liveClientId" error={fieldErrors.liveClientId}>
              <Input
                id="liveClientId"
                value={form.liveClientId}
                onChange={(event) => update('liveClientId', event.target.value)}
                maxLength={200}
                autoComplete="off"
              />
            </Field>
            <SecretField
              label="Live client secret"
              id="liveClientSecret"
              stored={form.hasLiveSecret}
              replacing={form.replaceLiveSecret}
              cleared={form.clearLiveSecret}
              value={form.liveClientSecret}
              error={fieldErrors.liveClientSecret}
              onChange={(value) => update('liveClientSecret', value)}
              onReplace={() => update('replaceLiveSecret', true)}
              onCancelReplace={() => {
                update('replaceLiveSecret', false)
                update('liveClientSecret', '')
              }}
              onClear={() => {
                update('clearLiveSecret', true)
                update('replaceLiveSecret', false)
                update('liveClientSecret', '')
              }}
              onUndoClear={() => update('clearLiveSecret', false)}
            />
            <Field
              label="Live webhook ID"
              htmlFor="webhookIdLive"
              hint="Used to verify live webhook signatures."
              error={fieldErrors.webhookIdLive}
            >
              <Input
                id="webhookIdLive"
                value={form.webhookIdLive}
                onChange={(event) => update('webhookIdLive', event.target.value)}
                maxLength={200}
              />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="Connection check" description="The test uses the stored credentials, so save changes before testing.">
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" onClick={testConnection} disabled={testing || pending}>
                <PlugZap />
                {testing ? 'Testing...' : 'Test connection'}
              </Button>
              {form.lastTestAt ? (
                <span className="text-xs text-muted-foreground">Last checked {formatStamp(form.lastTestAt)}</span>
              ) : (
                <span className="text-xs text-muted-foreground">Not tested yet</span>
              )}
            </div>
            {form.lastTestAt ? (
              <Alert variant={form.lastTestOk ? 'default' : 'destructive'}>
                <AlertTitle>{form.lastTestOk ? 'Connection verified' : 'Connection failed'}</AlertTitle>
                <AlertDescription>{form.lastTestError ?? 'The stored credentials were accepted.'}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </SectionCard>

        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>
            <Save />
            {pending ? 'Saving...' : 'Save PayPal settings'}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
