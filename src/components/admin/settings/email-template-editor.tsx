'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Field } from '@/components/shared/field'
import { EmptyState, SectionCard } from '@/components/admin/page-primitives'
import { api } from '@/lib/api/client'
import { cn } from 'cn'

export type EmailTemplateRow = {
  id: string
  key: string
  name: string
  subject: string
  htmlBody: string
  textBody: string
  isActive: boolean
  updatedAt: string
}

const PLACEHOLDERS = [
  'storeName',
  'customerName',
  'orderReference',
  'productName',
  'sessionSummary',
  'quantity',
  'totalPaid',
  'supportEmail',
  'supportPhone',
  'orderUrl',
  'ticketLinks',
  'reason',
]

function draftFrom(template: EmailTemplateRow | undefined) {
  return {
    subject: template?.subject ?? '',
    htmlBody: template?.htmlBody ?? '',
    textBody: template?.textBody ?? '',
    isActive: template?.isActive ?? true,
  }
}

function formatStamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function EmailTemplateEditor({ initialTemplates }: { initialTemplates: EmailTemplateRow[] }) {
  const router = useRouter()
  const [templates, setTemplates] = useState(initialTemplates)
  const [selectedId, setSelectedId] = useState(initialTemplates[0]?.id ?? '')
  const [draft, setDraft] = useState(() => draftFrom(initialTemplates[0]))
  const [pending, setPending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const selected = templates.find((template) => template.id === selectedId) ?? null

  function selectTemplate(template: EmailTemplateRow) {
    setSelectedId(template.id)
    setDraft(draftFrom(template))
    setFormError(null)
    setFieldErrors({})
  }

  function update<K extends keyof ReturnType<typeof draftFrom>>(key: K, value: ReturnType<typeof draftFrom>[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  async function refreshTemplates() {
    if (refreshing) return
    setRefreshing(true)
    const result = await api<{ templates: EmailTemplateRow[] }>('/api/admin/email-templates')
    if (!result.ok) {
      toast.error(result.error)
      setRefreshing(false)
      return
    }

    setTemplates(result.data.templates)
    const next = result.data.templates.find((template) => template.id === selectedId) ?? result.data.templates[0]
    if (next) {
      setSelectedId(next.id)
      setDraft(draftFrom(next))
    }
    toast.success('Templates refreshed.')
    setRefreshing(false)
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || pending) return

    setPending(true)
    setFormError(null)
    setFieldErrors({})

    const result = await api<EmailTemplateRow>(`/api/admin/email-templates/${selected.id}`, {
      method: 'PATCH',
      body: draft,
    })

    if (!result.ok) {
      setFormError(result.error)
      setFieldErrors(result.fields ?? {})
      toast.error(result.error)
      setPending(false)
      return
    }

    setTemplates((current) => current.map((template) => (template.id === result.data.id ? result.data : template)))
    setDraft(draftFrom(result.data))
    toast.success('Email template saved.')
    setPending(false)
    router.refresh()
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <SectionCard
        title="Templates"
        description="Order and delivery messages."
        className="h-fit"
      >
        <div className="grid gap-2">
          <Button type="button" variant="outline" size="sm" onClick={refreshTemplates} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </Button>
          {templates.length === 0 ? (
            <EmptyState title="No templates" description="Templates are seeded automatically on first use." />
          ) : (
            templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => selectTemplate(template)}
                className={cn(
                  'grid gap-1 rounded-lg border px-3 py-2 text-left transition-colors',
                  template.id === selectedId ? 'border-primary bg-muted' : 'hover:bg-muted/60',
                )}
              >
                <span className="flex items-center justify-between gap-2 text-sm font-medium">
                  {template.name}
                  <Badge variant={template.isActive ? 'default' : 'outline'}>{template.isActive ? 'Active' : 'Off'}</Badge>
                </span>
                <span className="font-mono text-xs text-muted-foreground">{template.key}</span>
              </button>
            ))
          )}
        </div>
      </SectionCard>

      {selected ? (
        <SectionCard
          title={selected.name}
          description={
            <span className="font-mono text-xs">
              {selected.key} · updated {formatStamp(selected.updatedAt)}
            </span>
          }
        >
          <form onSubmit={save} noValidate className="grid gap-4">
            {formError ? (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-wrap gap-1.5">
              {PLACEHOLDERS.map((placeholder) => (
                <Badge key={placeholder} variant="outline" className="font-mono">
                  {`{{${placeholder}}}`}
                </Badge>
              ))}
            </div>

            <Field label="Subject" htmlFor="templateSubject" error={fieldErrors.subject} required>
              <Input
                id="templateSubject"
                value={draft.subject}
                onChange={(event) => update('subject', event.target.value)}
                maxLength={255}
              />
            </Field>

            <Field
              label="HTML body"
              htmlFor="templateHtml"
              hint="Placeholders are replaced and customer values are escaped when the email is rendered."
              error={fieldErrors.htmlBody}
              required
            >
              <Textarea
                id="templateHtml"
                rows={14}
                value={draft.htmlBody}
                onChange={(event) => update('htmlBody', event.target.value)}
                className="font-mono text-xs"
              />
            </Field>

            <Field label="Plain-text body" htmlFor="templateText" error={fieldErrors.textBody} required>
              <Textarea
                id="templateText"
                rows={9}
                value={draft.textBody}
                onChange={(event) => update('textBody', event.target.value)}
                className="font-mono text-xs"
              />
            </Field>

            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div>
                <Label htmlFor="templateActive">Template active</Label>
                <p className="text-xs text-muted-foreground">
                  Inactive templates fall back to the built-in default wording.
                </p>
              </div>
              <Switch id="templateActive" checked={draft.isActive} onCheckedChange={(checked) => update('isActive', checked)} />
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={pending}>
                <Save />
                {pending ? 'Saving...' : 'Save template'}
              </Button>
            </div>
          </form>
        </SectionCard>
      ) : (
        <EmptyState title="Select a template" description="Choose a template from the list to edit its wording." />
      )}
    </div>
  )
}
