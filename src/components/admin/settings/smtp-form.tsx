'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Mail, PlugZap, Save, ShieldCheck } from 'lucide-react'
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

type EncryptionMode = 'NONE' | 'TLS' | 'STARTTLS'

export type SmtpFormInitial = {
  enabled: boolean
  host: string
  port: string
  encryption: EncryptionMode
  username: string
  hasPassword: boolean
  senderName: string
  senderEmail: string
  replyToEmail: string
  allowSelfSigned: boolean
  pool: boolean
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestError: string | null
  ready: boolean
}

type SmtpState = SmtpFormInitial & {
  password: string
  replacePassword: boolean
  clearPassword: boolean
}

type SmtpResponse = {
  enabled: boolean
  host: string | null
  port: number
  encryption: EncryptionMode
  username: string | null
  hasPassword: boolean
  senderName: string | null
  senderEmail: string | null
  replyToEmail: string | null
  allowSelfSigned: boolean
  pool: boolean
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestError: string | null
  ready: boolean
}

const ENCRYPTION_ITEMS = [
  { value: 'NONE', label: 'None' },
  { value: 'TLS', label: 'TLS' },
  { value: 'STARTTLS', label: 'STARTTLS' },
]

function formatStamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function fromResponse(current: SmtpState, data: SmtpResponse): SmtpState {
  return {
    ...current,
    enabled: data.enabled,
    host: data.host ?? '',
    port: String(data.port),
    encryption: data.encryption,
    username: data.username ?? '',
    hasPassword: data.hasPassword,
    senderName: data.senderName ?? '',
    senderEmail: data.senderEmail ?? '',
    replyToEmail: data.replyToEmail ?? '',
    allowSelfSigned: data.allowSelfSigned,
    pool: data.pool,
    lastTestAt: data.lastTestAt,
    lastTestOk: data.lastTestOk,
    lastTestError: data.lastTestError,
    ready: data.ready,
    password: '',
    replacePassword: false,
    clearPassword: false,
  }
}

export function SmtpForm({ initial }: { initial: SmtpFormInitial }) {
  const router = useRouter()
  const [form, setForm] = useState<SmtpState>({
    ...initial,
    password: '',
    replacePassword: false,
    clearPassword: false,
  })
  const [pending, setPending] = useState(false)
  const [testing, setTesting] = useState(false)
  const [sending, setSending] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  function update<K extends keyof SmtpState>(key: K, value: SmtpState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return

    const port = Number(form.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setFieldErrors({ port: 'Enter a port between 1 and 65535.' })
      return
    }

    setPending(true)
    setFormError(null)
    setTestError(null)
    setFieldErrors({})

    const payload: Record<string, unknown> = {
      enabled: form.enabled,
      host: form.host,
      port,
      encryption: form.encryption,
      username: form.username,
      senderName: form.senderName,
      senderEmail: form.senderEmail,
      replyToEmail: form.replyToEmail,
      allowSelfSigned: form.allowSelfSigned,
      pool: form.pool,
      clearPassword: form.clearPassword,
    }
    if (!form.clearPassword && form.password) payload.password = form.password

    const result = await api<SmtpResponse>('/api/admin/settings/smtp', { method: 'POST', body: payload })

    if (!result.ok) {
      setFormError(result.error)
      setFieldErrors(result.fields ?? {})
      toast.error(result.error)
      setPending(false)
      return
    }

    setForm((current) => fromResponse(current, result.data))
    toast.success('SMTP settings saved.')
    setPending(false)
    router.refresh()
  }

  async function verifyConnection() {
    if (testing) return
    setTesting(true)
    setTestError(null)

    const result = await api<{ ok: boolean; message: string }>('/api/admin/settings/smtp/test', { method: 'POST' })
    const checkedAt = new Date().toISOString()

    if (!result.ok) {
      setForm((current) => ({ ...current, lastTestAt: checkedAt, lastTestOk: false, lastTestError: result.error }))
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

  async function sendTest() {
    if (sending) return
    setSending(true)
    setTestError(null)

    const result = await api<{ sent: boolean; to: string }>('/api/admin/settings/smtp/send-test', {
      method: 'POST',
      body: recipient.trim() ? { to: recipient.trim() } : {},
    })

    if (!result.ok) {
      const message = result.fields?.to ?? result.error
      setTestError(message)
      toast.error(message)
      setSending(false)
      return
    }

    toast.success(`Test email sent to ${result.data.to}.`)
    setSending(false)
  }

  return (
    <form onSubmit={save} noValidate>
      <fieldset disabled={pending} className="grid gap-6">
        <Alert>
          <ShieldCheck />
          <AlertTitle>The SMTP password is encrypted at rest</AlertTitle>
          <AlertDescription>
            The password is encrypted with AES-256-GCM and is never returned by the API. Leave the replacement blank to
            keep the stored password; use the explicit clear action to remove it.
          </AlertDescription>
        </Alert>

        {formError ? (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <SectionCard title="Mail server">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 md:col-span-2">
              <div>
                <Label htmlFor="smtpEnabled">Enable email delivery</Label>
                <p className="text-xs text-muted-foreground">
                  {form.ready ? 'Host and sender email are configured.' : 'Host and sender email are required when enabled.'}
                </p>
              </div>
              <Switch id="smtpEnabled" checked={form.enabled} onCheckedChange={(checked) => update('enabled', checked)} />
            </div>
            <Field label="Host" htmlFor="smtpHost" error={fieldErrors.host}>
              <Input id="smtpHost" value={form.host} onChange={(event) => update('host', event.target.value)} />
            </Field>
            <Field label="Port" htmlFor="smtpPort" error={fieldErrors.port} required>
              <Input
                id="smtpPort"
                type="number"
                min={1}
                max={65_535}
                value={form.port}
                onChange={(event) => update('port', event.target.value)}
              />
            </Field>
            <Field label="Encryption" error={fieldErrors.encryption} required>
              <Select
                items={ENCRYPTION_ITEMS}
                value={form.encryption}
                onValueChange={(value) => update('encryption', (value ?? 'STARTTLS') as EncryptionMode)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENCRYPTION_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Username" htmlFor="smtpUsername" error={fieldErrors.username}>
              <Input
                id="smtpUsername"
                value={form.username}
                onChange={(event) => update('username', event.target.value)}
                autoComplete="off"
              />
            </Field>

            <div className="md:col-span-2">
              <Field
                label="Password"
                htmlFor="smtpPassword"
                error={fieldErrors.password}
                hint={
                  form.clearPassword
                    ? 'The stored password is removed when you save.'
                    : form.hasPassword
                      ? 'A password is stored. Leave the replacement blank to keep it.'
                      : 'No password is stored.'
                }
              >
                {form.clearPassword ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    <span>Stored password will be cleared on save.</span>
                    <Button type="button" size="sm" variant="outline" onClick={() => update('clearPassword', false)}>
                      Undo
                    </Button>
                  </div>
                ) : form.hasPassword && !form.replacePassword ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="smtpPassword"
                      value="••••••••"
                      readOnly
                      aria-label="Stored SMTP password"
                      className="w-40 font-mono tracking-widest"
                    />
                    <Button type="button" size="sm" variant="outline" onClick={() => update('replacePassword', true)}>
                      Replace password
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        update('clearPassword', true)
                        update('replacePassword', false)
                        update('password', '')
                      }}
                    >
                      Clear stored password
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <Input
                      id="smtpPassword"
                      type="password"
                      autoComplete="new-password"
                      maxLength={400}
                      value={form.password}
                      onChange={(event) => update('password', event.target.value)}
                      placeholder={form.hasPassword ? 'Enter a replacement password' : 'Enter the password'}
                    />
                    {form.replacePassword ? (
                      <div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            update('replacePassword', false)
                            update('password', '')
                          }}
                        >
                          Cancel replacement
                        </Button>
                      </div>
                    ) : null}
                  </div>
                )}
              </Field>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Sender identity">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Sender name" htmlFor="senderName" error={fieldErrors.senderName}>
              <Input id="senderName" value={form.senderName} onChange={(event) => update('senderName', event.target.value)} />
            </Field>
            <Field label="Sender email" htmlFor="senderEmail" error={fieldErrors.senderEmail}>
              <Input
                id="senderEmail"
                type="email"
                value={form.senderEmail}
                onChange={(event) => update('senderEmail', event.target.value)}
              />
            </Field>
            <Field label="Reply-to email" htmlFor="replyToEmail" error={fieldErrors.replyToEmail}>
              <Input
                id="replyToEmail"
                type="email"
                value={form.replyToEmail}
                onChange={(event) => update('replyToEmail', event.target.value)}
              />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="Transport options">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <Label htmlFor="allowSelfSigned">Allow self-signed certificates</Label>
              <Switch
                id="allowSelfSigned"
                checked={form.allowSelfSigned}
                onCheckedChange={(checked) => update('allowSelfSigned', checked)}
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <Label htmlFor="smtpPool">Reuse pooled connections</Label>
              <Switch id="smtpPool" checked={form.pool} onCheckedChange={(checked) => update('pool', checked)} />
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Connection check" description="Tests use the stored configuration, so save changes before testing.">
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" onClick={verifyConnection} disabled={testing || pending}>
                <PlugZap />
                {testing ? 'Verifying...' : 'Verify connection'}
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
                <AlertDescription>{form.lastTestError ?? 'The mail server accepted the connection.'}</AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-2 border-t pt-3 md:grid-cols-[1fr_auto] md:items-end">
              <Field
                label="Send a test email"
                htmlFor="testRecipient"
                error={fieldErrors.to ?? testError ?? undefined}
                hint="Leave blank to send to your own administrator address."
              >
                <Input
                  id="testRecipient"
                  type="email"
                  value={recipient}
                  onChange={(event) => setRecipient(event.target.value)}
                  placeholder="recipient@example.com"
                />
              </Field>
              <Button type="button" variant="outline" onClick={sendTest} disabled={sending || pending}>
                <Mail />
                {sending ? 'Sending...' : 'Send test email'}
              </Button>
            </div>
          </div>
        </SectionCard>

        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>
            <Save />
            {pending ? 'Saving...' : 'Save SMTP settings'}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
