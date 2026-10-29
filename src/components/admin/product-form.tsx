'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Trash2, Upload, X } from 'lucide-react'
import type { InventoryModel, ProductStatus } from '@prisma/client'
import { api } from '@/lib/api/client'
import { SUPPORTED_CURRENCIES } from '@/lib/money'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field } from '@/components/shared/field'
import { toMajorString, toMinorUnits } from '@/components/shared/money'
import { ProductStatusBadge } from '@/components/shared/status-badges'
import { SectionCard } from '@/components/admin/page-primitives'

export type ProductPayload = {
  name: string
  slug: string
  shortDescription: string
  description: string
  categoryId: string | null
  status: ProductStatus
  priceMinor: number
  currency: string
  taxRateBps: number
  taxIncluded: boolean
  inventoryModel: InventoryModel
  minTickets: number
  maxTickets: number
  requiresSession: boolean
  salesStartAt: string
  salesEndAt: string
  lowInventoryThreshold: number
}

export type ProductFormSession = {
  id: string
  date: string
  startTime: string
  endTime: string
  label: string
  isActive: boolean
}

export type ProductFormImage = { id: string; alt: string }

type CategoryOption = { id: string; name: string }

type SessionRow = {
  key: string
  id?: string
  date: string
  startTime: string
  endTime: string
  label: string
  isActive: boolean
  persisted: boolean
}

type PendingImage = { key: string; file: File; url: string }

type ImageUploadResult = {
  accepted: { id: string; fileName: string; width: number | null; height: number | null }[]
  rejected: { fileName: string; reason: string }[]
}

type Props = {
  categories: CategoryOption[]
  defaultCurrency?: string
  product?: { id: string; status: ProductStatus; initial: ProductPayload }
  sessions?: ProductFormSession[]
  images?: ProductFormImage[]
  onDeleteImage?: (imageId: string) => Promise<{ ok: true } | { ok: false; error: string }>
}

const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const SELECT_CLASS =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30'

const INVENTORY_MODELS: { value: InventoryModel; label: string; explanation: string }[] = [
  {
    value: 'ONE_PDF_PER_TICKET',
    label: 'Model A · one PDF per ticket',
    explanation: 'Each uploaded PDF is sold as exactly one ticket.',
  },
  {
    value: 'ONE_PDF_PER_GROUP',
    label: 'Model B · one PDF per group',
    explanation: 'One PDF admits a group; its ticket count is set when the file is uploaded.',
  },
]

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140)
}

function toLocalInput(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toIso(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2).replace(/\.?0+$/, '')
}

function intValue(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function sessionDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

export function ProductForm({ categories, defaultCurrency = 'USD', product, sessions = [], images = [], onDeleteImage }: Props) {
  const router = useRouter()
  const initial = product?.initial
  const isEdit = Boolean(product)

  const [status, setStatus] = useState<ProductStatus>(product?.status ?? 'DRAFT')
  const [name, setName] = useState(initial?.name ?? '')
  const [slug, setSlug] = useState(initial?.slug ?? '')
  const [slugLocked, setSlugLocked] = useState(Boolean(initial))
  const [shortDescription, setShortDescription] = useState(initial?.shortDescription ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? '')
  const [price, setPrice] = useState(initial ? toMajorString(initial.priceMinor, initial.currency) : '')
  const [currency, setCurrency] = useState(initial?.currency ?? defaultCurrency)
  const [taxPercent, setTaxPercent] = useState(initial ? bpsToPercent(initial.taxRateBps) : '0')
  const [taxIncluded, setTaxIncluded] = useState(initial?.taxIncluded ?? false)
  const [inventoryModel, setInventoryModel] = useState<InventoryModel>(initial?.inventoryModel ?? 'ONE_PDF_PER_TICKET')
  const [minTickets, setMinTickets] = useState(String(initial?.minTickets ?? 1))
  const [maxTickets, setMaxTickets] = useState(String(initial?.maxTickets ?? 10))
  const [requiresSession, setRequiresSession] = useState(initial?.requiresSession ?? true)
  const [salesStartAt, setSalesStartAt] = useState('')
  const [salesEndAt, setSalesEndAt] = useState('')
  const [lowInventoryThreshold, setLowInventoryThreshold] = useState(String(initial?.lowInventoryThreshold ?? 10))

  const [sessionRows, setSessionRows] = useState<SessionRow[]>(() =>
    sessions.map((session) => ({
      key: session.id,
      id: session.id,
      date: session.date,
      startTime: session.startTime,
      endTime: session.endTime,
      label: session.label,
      isActive: session.isActive,
      persisted: true,
    })),
  )
  const [removedSessionIds, setRemovedSessionIds] = useState<string[]>([])
  const [sessionErrors, setSessionErrors] = useState<Record<string, string>>({})

  const [existingImages, setExistingImages] = useState<ProductFormImage[]>(images)
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const [uploadResults, setUploadResults] = useState<ImageUploadResult | null>(null)
  const [deletingImageId, setDeletingImageId] = useState<string | null>(null)

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [statusPending, setStatusPending] = useState<ProductStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archivePending, setArchivePending] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  const sessionKeyRef = useRef(0)
  const imageKeyRef = useRef(0)
  const pendingImagesRef = useRef<PendingImage[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    pendingImagesRef.current = pendingImages
  }, [pendingImages])

  useEffect(() => {
    // The browser timezone is only known after mount, so the date inputs are filled then.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSalesStartAt(toLocalInput(initial?.salesStartAt ?? ''))
    setSalesEndAt(toLocalInput(initial?.salesEndAt ?? ''))
  }, [initial?.salesStartAt, initial?.salesEndAt])

  useEffect(() => {
    return () => {
      pendingImagesRef.current.forEach((item) => URL.revokeObjectURL(item.url))
    }
  }, [])

  function onNameChange(value: string) {
    setName(value)
    if (!slugLocked) setSlug(slugify(value))
  }

  function onSlugChange(value: string) {
    setSlug(value)
    setSlugLocked(true)
  }

  function addSession() {
    sessionKeyRef.current += 1
    setSessionRows((rows) => [
      ...rows,
      {
        key: `new-${sessionKeyRef.current}`,
        date: '',
        startTime: '',
        endTime: '',
        label: '',
        isActive: true,
        persisted: false,
      },
    ])
  }

  function updateSession(key: string, patch: Partial<SessionRow>) {
    setSessionRows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
    setSessionErrors((errors) => {
      if (!errors[key]) return errors
      const next = { ...errors }
      delete next[key]
      return next
    })
  }

  function removeSession(row: SessionRow) {
    if (row.id) setRemovedSessionIds((ids) => [...ids, row.id as string])
    setSessionRows((rows) => rows.filter((candidate) => candidate.key !== row.key))
    setSessionErrors((errors) => {
      if (!errors[row.key]) return errors
      const next = { ...errors }
      delete next[row.key]
      return next
    })
  }

  function addImages(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploadResults(null)
    const remaining = MAX_IMAGES - existingImages.length - pendingImages.length
    if (remaining <= 0) {
      setImageError(`A product carries at most ${MAX_IMAGES} images.`)
      return
    }

    const accepted: PendingImage[] = []
    const rejected: string[] = []
    for (const file of Array.from(files).slice(0, remaining)) {
      if (!IMAGE_TYPES.includes(file.type)) {
        rejected.push(`${file.name}: only PNG, JPEG and WebP are accepted.`)
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        rejected.push(`${file.name}: larger than 4 MB.`)
        continue
      }
      if (file.size === 0) {
        rejected.push(`${file.name}: the file is empty.`)
        continue
      }
      imageKeyRef.current += 1
      accepted.push({ key: `image-${imageKeyRef.current}`, file, url: URL.createObjectURL(file) })
    }
    if (files.length > remaining) rejected.push(`Only ${remaining} more image(s) fit in the six-image limit.`)

    if (accepted.length > 0) setPendingImages((items) => [...items, ...accepted])
    setImageError(rejected.length ? rejected.join(' ') : null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function removePendingImage(key: string) {
    setPendingImages((items) => {
      const target = items.find((item) => item.key === key)
      if (target) URL.revokeObjectURL(target.url)
      return items.filter((item) => item.key !== key)
    })
  }

  async function deleteExistingImage(imageId: string) {
    if (!onDeleteImage) return
    setDeletingImageId(imageId)
    setImageError(null)
    const result = await onDeleteImage(imageId)
    setDeletingImageId(null)
    if (!result.ok) {
      setImageError(result.error)
      toast.error(result.error)
      return
    }
    setExistingImages((items) => items.filter((item) => item.id !== imageId))
    toast.success('Image removed.')
    router.refresh()
  }

  function validate(): { fields: Record<string, string>; sessions: Record<string, string> } {
    const errors: Record<string, string> = {}
    const sessionIssues: Record<string, string> = {}
    if (name.trim().length < 2 || name.trim().length > 140) errors.name = 'Use between 2 and 140 characters.'
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim()) || slug.trim().length > 140) {
      errors.slug = 'Lowercase letters, numbers and hyphens only.'
    }
    if (shortDescription.trim().length < 2 || shortDescription.trim().length > 240) {
      errors.shortDescription = 'Use between 2 and 240 characters.'
    }
    if (description.trim().length < 2 || description.trim().length > 20_000) {
      errors.description = 'Use between 2 and 20,000 characters.'
    }

    const major = Number.parseFloat(price)
    if (!Number.isFinite(major) || major < 0) errors.price = 'Enter a price of zero or more.'
    const tax = Number.parseFloat(taxPercent)
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) errors.tax = 'Tax must be between 0 and 100 percent.'

    const min = Number(minTickets)
    const max = Number(maxTickets)
    if (!Number.isInteger(min) || min < 1 || min > 500) errors.minTickets = 'Minimum tickets must be a whole number from 1 to 500.'
    if (!Number.isInteger(max) || max < 1 || max > 500) errors.maxTickets = 'Maximum tickets must be a whole number from 1 to 500.'
    if (Number.isInteger(min) && Number.isInteger(max) && min > max) errors.minTickets = 'Minimum cannot exceed maximum.'

    const low = Number(lowInventoryThreshold)
    if (!Number.isInteger(low) || low < 0 || low > 100_000) {
      errors.lowInventoryThreshold = 'Use a whole number from 0 to 100,000.'
    }

    if (salesStartAt && salesEndAt && new Date(salesStartAt).getTime() >= new Date(salesEndAt).getTime()) {
      errors.salesEndAt = 'Sales must end after they start.'
    }

    if (requiresSession) {
      for (const row of sessionRows) {
        const prefix = row.persisted ? 'Existing session' : 'New session'
        if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
          sessionIssues[row.key] = `${prefix}: choose a date.`
        } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.startTime)) {
          sessionIssues[row.key] = `${prefix}: start time must use HH:MM.`
        } else if (row.endTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.endTime)) {
          sessionIssues[row.key] = `${prefix}: end time must use HH:MM.`
        } else if (row.label.length > 80) {
          sessionIssues[row.key] = `${prefix}: label is limited to 80 characters.`
        }
      }
    }

    return { fields: errors, sessions: sessionIssues }
  }

  function buildPayload(nextStatus: ProductStatus = status): ProductPayload {
    return {
      name: name.trim(),
      slug: slug.trim(),
      shortDescription: shortDescription.trim(),
      description: description.trim(),
      categoryId: categoryId || null,
      status: nextStatus,
      priceMinor: toMinorUnits(price, currency),
      currency,
      taxRateBps: Math.round((Number.parseFloat(taxPercent) || 0) * 100),
      taxIncluded,
      inventoryModel,
      minTickets: intValue(minTickets, 1),
      maxTickets: intValue(maxTickets, 10),
      requiresSession,
      salesStartAt: toIso(salesStartAt),
      salesEndAt: toIso(salesEndAt),
      lowInventoryThreshold: intValue(lowInventoryThreshold, 0),
    }
  }

  async function syncSessions(productId: string): Promise<string | null> {
    let firstError: string | null = null
    const removed: string[] = []

    for (const id of removedSessionIds) {
      const result = await api(`/api/admin/sessions/${id}`, { method: 'DELETE' })
      if (result.ok) {
        removed.push(id)
      } else {
        firstError ??= result.error
      }
    }
    if (removed.length > 0) setRemovedSessionIds((ids) => ids.filter((id) => !removed.includes(id)))

    if (!requiresSession) return firstError

    const unsaved = sessionRows.filter((row) => !row.persisted)
    for (const row of unsaved) {
      const result = await api<{
        id: string
        date: string
        startTime: string
        endTime: string | null
        label: string | null
      }>(`/api/admin/products/${productId}/sessions`, {
        method: 'POST',
        body: { date: row.date, startTime: row.startTime, endTime: row.endTime, label: row.label },
      })

      if (!result.ok) {
        const message = result.fields?.date ?? result.fields?.startTime ?? result.error
        setSessionErrors((errors) => ({ ...errors, [row.key]: message }))
        firstError ??= message
        continue
      }

      setSessionRows((rows) =>
        rows.map((candidate) =>
          candidate.key === row.key
            ? {
                ...candidate,
                id: result.data.id,
                date: sessionDate(new Date(result.data.date)),
                startTime: result.data.startTime,
                endTime: result.data.endTime ?? '',
                label: result.data.label ?? '',
                persisted: true,
              }
            : candidate,
        ),
      )
    }

    return firstError
  }

  async function uploadPendingImages(productId: string): Promise<string | null> {
    if (pendingImages.length === 0) return null

    const form = new FormData()
    form.set('productId', productId)
    pendingImages.forEach((item) => form.append('files', item.file, item.file.name))

    const result = await api<ImageUploadResult>(`/api/admin/products/${productId}/images`, {
      method: 'POST',
      body: form,
    })

    if (!result.ok) {
      const message =
        result.status === 422
          ? 'No image was accepted. Use PNG, JPEG or WebP files under 4 MB.'
          : result.error
      setImageError(message)
      return message
    }

    setExistingImages((items) => [
      ...items,
      ...result.data.accepted.map((image) => ({ id: image.id, alt: image.fileName })),
    ])
    setPendingImages((items) => {
      items.forEach((item) => URL.revokeObjectURL(item.url))
      return []
    })
    setUploadResults(result.data)
    setImageError(
      result.data.rejected.length > 0
        ? `${result.data.rejected.length} image(s) were rejected: ${result.data.rejected
            .map((entry) => `${entry.fileName} — ${entry.reason}`)
            .join('; ')}`
        : null,
    )
    return null
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setFormError(null)
    setFieldErrors({})
    setSessionErrors({})
    setUploadResults(null)

    const validation = validate()
    setFieldErrors(validation.fields)
    setSessionErrors(validation.sessions)
    if (Object.keys(validation.fields).length > 0 || Object.keys(validation.sessions).length > 0) {
      setFormError('Please correct the highlighted fields.')
      return
    }

    setPending(true)
    const payload = buildPayload()
    const result = product
      ? await api(`/api/admin/products/${product.id}`, { method: 'PATCH', body: payload })
      : await api<{ id: string }>('/api/admin/products', { method: 'POST', body: payload })

    if (!result.ok) {
      setPending(false)
      setFieldErrors(result.fields ?? {})
      setFormError(result.error)
      toast.error(result.error)
      return
    }

    const productId = product?.id ?? (result.data as { id: string }).id
    const created = !product

    const sessionFailure = await syncSessions(productId)
    const imageFailure = await uploadPendingImages(productId)

    setPending(false)

    if (created) {
      toast.success('Product created.')
      if (sessionFailure) toast.error(`Some sessions were not saved: ${sessionFailure}`)
      if (imageFailure) toast.error(imageFailure)
      router.push(`/admin/products/${productId}`)
      router.refresh()
      return
    }

    if (sessionFailure) {
      setFormError(`Product saved, but a session could not be updated: ${sessionFailure}`)
      toast.error(`Product saved. A session failed: ${sessionFailure}`)
    } else {
      toast.success('Product saved.')
    }
    router.refresh()
  }

  async function changeStatus(nextStatus: ProductStatus) {
    if (!product) return
    setStatusPending(nextStatus)
    setStatusError(null)
    const result = await api(`/api/admin/products/${product.id}`, {
      method: 'PATCH',
      body: { ...product.initial, status: nextStatus },
    })
    setStatusPending(null)
    if (!result.ok) {
      setStatusError(result.error)
      toast.error(result.error)
      return
    }
    setStatus(nextStatus)
    toast.success(nextStatus === 'PUBLISHED' ? 'Product published.' : 'Product unpublished.')
    router.refresh()
  }

  async function archiveProduct() {
    if (!product) return
    setArchivePending(true)
    setArchiveError(null)
    const result = await api<{ archived: boolean }>(`/api/admin/products/${product.id}`, { method: 'DELETE' })
    setArchivePending(false)
    if (!result.ok) {
      setArchiveError(result.error)
      toast.error(result.error)
      return
    }

    setArchiveOpen(false)
    if (result.data.archived) {
      setStatus('ARCHIVED')
      toast.success('Product archived. Order history and ticket files were retained.')
      router.refresh()
      return
    }
    toast.success('Product deleted because it had no orders or inventory.')
    router.replace('/admin/products')
    router.refresh()
  }

  const totalImages = existingImages.length + pendingImages.length
  const canAddImages = totalImages < MAX_IMAGES
  const model = INVENTORY_MODELS.find((option) => option.value === inventoryModel) ?? INVENTORY_MODELS[0]

  return (
    <div className="grid gap-6">
      {product ? (
        <SectionCard title="Status" description="Publishing makes the product purchasable on the storefront.">
          <div className="flex flex-wrap items-center gap-2">
            <ProductStatusBadge status={status} />
            {status === 'DRAFT' || status === 'UNPUBLISHED' ? (
              <Button size="sm" onClick={() => changeStatus('PUBLISHED')} disabled={statusPending !== null}>
                {statusPending === 'PUBLISHED' ? 'Publishing...' : 'Publish'}
              </Button>
            ) : null}
            {status === 'PUBLISHED' ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => changeStatus('UNPUBLISHED')}
                disabled={statusPending !== null}
              >
                {statusPending === 'UNPUBLISHED' ? 'Unpublishing...' : 'Unpublish'}
              </Button>
            ) : null}
            {status !== 'ARCHIVED' ? (
              <Dialog
                open={archiveOpen}
                onOpenChange={(open) => {
                  setArchiveOpen(open)
                  if (open) setArchiveError(null)
                }}
              >
                <DialogTrigger render={<Button variant="destructive" size="sm" />}>Archive</DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Archive {product.initial.name}?</DialogTitle>
                    <DialogDescription>
                      The product leaves the storefront immediately. Products with orders or ticket files are kept and
                      archived; a product with neither is deleted permanently. This cannot be undone.
                    </DialogDescription>
                  </DialogHeader>
                  {archiveError ? <p className="text-sm text-destructive">{archiveError}</p> : null}
                  <DialogFooter>
                    <DialogClose render={<Button variant="outline" disabled={archivePending} />}>Keep product</DialogClose>
                    <Button variant="destructive" onClick={archiveProduct} disabled={archivePending}>
                      {archivePending ? 'Archiving...' : 'Archive product'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            ) : null}
          </div>
          {statusError ? <p className="mt-2 text-sm text-destructive">{statusError}</p> : null}
          {status === 'ARCHIVED' ? (
            <p className="mt-2 text-xs text-muted-foreground">Archived products stay readable for order history but are hidden from the storefront.</p>
          ) : null}
        </SectionCard>
      ) : null}

      <form onSubmit={handleSubmit} noValidate>
        <fieldset disabled={pending} className="m-0 grid min-w-0 gap-6 border-0 p-0">
          {formError ? (
            <Alert variant="destructive">
              <AlertTitle>Product not saved</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <SectionCard title="Basics" description="The public name, URL and copy shown on the storefront.">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Name" htmlFor="name" error={fieldErrors.name} required>
                <Input id="name" value={name} maxLength={140} onChange={(event) => onNameChange(event.target.value)} />
              </Field>
              <Field
                label="URL slug"
                htmlFor="slug"
                error={fieldErrors.slug}
                hint="Lowercase letters, numbers and hyphens. Used in the storefront URL."
                required
              >
                <Input id="slug" value={slug} maxLength={140} onChange={(event) => onSlugChange(event.target.value)} />
              </Field>
              <Field label="Category" htmlFor="categoryId" error={fieldErrors.categoryId} className="md:col-span-1">
                <select
                  id="categoryId"
                  className={SELECT_CLASS}
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.target.value)}
                >
                  <option value="">No category</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Currency" htmlFor="currency" error={fieldErrors.currency}>
                <select
                  id="currency"
                  className={SELECT_CLASS}
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value)}
                >
                  {SUPPORTED_CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Short description"
                htmlFor="shortDescription"
                error={fieldErrors.shortDescription}
                hint={`${shortDescription.length}/240 characters`}
                required
                className="md:col-span-2"
              >
                <Textarea
                  id="shortDescription"
                  value={shortDescription}
                  maxLength={240}
                  rows={2}
                  onChange={(event) => setShortDescription(event.target.value)}
                />
              </Field>
              <Field
                label="Description"
                htmlFor="description"
                error={fieldErrors.description}
                hint="Full storefront copy for this product."
                required
                className="md:col-span-2"
              >
                <Textarea
                  id="description"
                  value={description}
                  maxLength={20_000}
                  rows={8}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
            </div>
          </SectionCard>

          <SectionCard title="Pricing and tax" description="Prices are entered in major units and stored as integer minor units.">
            <div className="grid gap-4 md:grid-cols-3">
              <Field label={`Price (${currency})`} htmlFor="price" error={fieldErrors.priceMinor ?? fieldErrors.price} required>
                <Input
                  id="price"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step={currency === 'JPY' || currency === 'KRW' ? '1' : '0.01'}
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                />
              </Field>
              <Field label="Tax rate (%)" htmlFor="taxPercent" error={fieldErrors.taxRateBps ?? fieldErrors.tax} hint="Converted to basis points on save.">
                <Input
                  id="taxPercent"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="100"
                  step="0.01"
                  value={taxPercent}
                  onChange={(event) => setTaxPercent(event.target.value)}
                />
              </Field>
              <div className="grid content-start gap-2 pt-1">
                <Label htmlFor="taxIncluded">Tax included in price</Label>
                <div className="flex items-center gap-2">
                  <Switch id="taxIncluded" checked={taxIncluded} onCheckedChange={setTaxIncluded} />
                  <span className="text-sm text-muted-foreground">{taxIncluded ? 'Yes' : 'No'}</span>
                </div>
                {fieldErrors.taxIncluded ? <p className="text-xs text-destructive">{fieldErrors.taxIncluded}</p> : null}
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Inventory" description="How ticket PDFs are counted and how many tickets one order may hold.">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Inventory model" htmlFor="inventoryModel" error={fieldErrors.inventoryModel} required>
                <select
                  id="inventoryModel"
                  className={SELECT_CLASS}
                  value={inventoryModel}
                  onChange={(event) => setInventoryModel(event.target.value as InventoryModel)}
                >
                  {INVENTORY_MODELS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="flex items-start pt-6">
                <p className="text-sm text-muted-foreground">{model.explanation}</p>
              </div>
              <Field label="Minimum tickets per order" htmlFor="minTickets" error={fieldErrors.minTickets} required>
                <Input
                  id="minTickets"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="500"
                  step="1"
                  value={minTickets}
                  onChange={(event) => setMinTickets(event.target.value)}
                />
              </Field>
              <Field label="Maximum tickets per order" htmlFor="maxTickets" error={fieldErrors.maxTickets} required>
                <Input
                  id="maxTickets"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="500"
                  step="1"
                  value={maxTickets}
                  onChange={(event) => setMaxTickets(event.target.value)}
                />
              </Field>
              <Field
                label="Low inventory threshold"
                htmlFor="lowInventoryThreshold"
                error={fieldErrors.lowInventoryThreshold}
                hint="Available tickets at or below this number show a low-stock warning."
              >
                <Input
                  id="lowInventoryThreshold"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="100000"
                  step="1"
                  value={lowInventoryThreshold}
                  onChange={(event) => setLowInventoryThreshold(event.target.value)}
                />
              </Field>
              <div className="grid content-start gap-2 pt-1">
                <Label htmlFor="requiresSession">Requires an event session</Label>
                <div className="flex items-center gap-2">
                  <Switch
                    id="requiresSession"
                    checked={requiresSession}
                    onCheckedChange={(checked) => {
                      setRequiresSession(checked)
                      if (!checked) setSessionErrors({})
                    }}
                  />
                  <span className="text-sm text-muted-foreground">{requiresSession ? 'Yes' : 'No, sold from a product-wide pool'}</span>
                </div>
                {fieldErrors.requiresSession ? <p className="text-xs text-destructive">{fieldErrors.requiresSession}</p> : null}
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Sales window" description="Leave blank to sell without a date limit. Times use your browser's local timezone.">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Sales start" htmlFor="salesStartAt" error={fieldErrors.salesStartAt}>
                <Input
                  id="salesStartAt"
                  type="datetime-local"
                  value={salesStartAt}
                  onChange={(event) => setSalesStartAt(event.target.value)}
                />
              </Field>
              <Field label="Sales end" htmlFor="salesEndAt" error={fieldErrors.salesEndAt}>
                <Input
                  id="salesEndAt"
                  type="datetime-local"
                  value={salesEndAt}
                  onChange={(event) => setSalesEndAt(event.target.value)}
                />
              </Field>
            </div>
          </SectionCard>

          {requiresSession ? (
            <SectionCard
              title="Event sessions"
              description="Each session is a bookable date and time with its own ticket pool."
            >
              <div className="grid gap-3">
                {sessionRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sessions yet. Add at least one before uploading inventory.</p>
                ) : null}

                {sessionRows.map((row) =>
                  row.persisted ? (
                    <div
                      key={row.key}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2"
                    >
                      <div className="grid gap-0.5">
                        <span className="text-sm font-medium">
                          {row.date} · {row.startTime}
                          {row.endTime ? `–${row.endTime}` : ''}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {row.label || 'No label'}
                          {row.isActive ? '' : ' · inactive'}
                        </span>
                        {sessionErrors[row.key] ? (
                          <span className="text-xs text-destructive">{sessionErrors[row.key]}</span>
                        ) : null}
                      </div>
                      <Button type="button" variant="ghost" size="sm" onClick={() => removeSession(row)}>
                        <Trash2 />
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <div key={row.key} className="grid gap-2 rounded-lg border p-3">
                      <div className="grid gap-3 md:grid-cols-[1fr_110px_110px_1fr_auto] md:items-end">
                        <Field label="Date" htmlFor={`session-date-${row.key}`}>
                          <Input
                            id={`session-date-${row.key}`}
                            type="date"
                            value={row.date}
                            onChange={(event) => updateSession(row.key, { date: event.target.value })}
                          />
                        </Field>
                        <Field label="Start" htmlFor={`session-start-${row.key}`}>
                          <Input
                            id={`session-start-${row.key}`}
                            type="time"
                            value={row.startTime}
                            onChange={(event) => updateSession(row.key, { startTime: event.target.value })}
                          />
                        </Field>
                        <Field label="End" htmlFor={`session-end-${row.key}`}>
                          <Input
                            id={`session-end-${row.key}`}
                            type="time"
                            value={row.endTime}
                            onChange={(event) => updateSession(row.key, { endTime: event.target.value })}
                          />
                        </Field>
                        <Field label="Label" htmlFor={`session-label-${row.key}`}>
                          <Input
                            id={`session-label-${row.key}`}
                            value={row.label}
                            maxLength={80}
                            placeholder="Evening show"
                            onChange={(event) => updateSession(row.key, { label: event.target.value })}
                          />
                        </Field>
                        <Button type="button" variant="ghost" size="icon" aria-label="Remove session" onClick={() => removeSession(row)}>
                          <X />
                        </Button>
                      </div>
                      {sessionErrors[row.key] ? <p className="text-xs text-destructive">{sessionErrors[row.key]}</p> : null}
                    </div>
                  ),
                )}

                <div>
                  <Button type="button" variant="outline" size="sm" onClick={addSession}>
                    <Plus />
                    Add session
                  </Button>
                </div>
              </div>
            </SectionCard>
          ) : null}

          <SectionCard title="Images" description={`PNG, JPEG or WebP, up to 4 MB each and ${MAX_IMAGES} per product. SVG is rejected.`}>
            <div className="grid gap-4">
              {existingImages.length === 0 && pendingImages.length === 0 ? (
                <p className="text-sm text-muted-foreground">No images yet.</p>
              ) : null}

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {existingImages.map((image) => (
                  <div key={image.id} className="group relative overflow-hidden rounded-lg border">
                    <img
                      src={`/api/products/image/${image.id}`}
                      alt={image.alt || 'Product image'}
                      className="h-24 w-full object-cover"
                    />
                    <Button
                      type="button"
                      variant="destructive"
                      size="icon-xs"
                      className="absolute top-1 right-1"
                      aria-label="Delete image"
                      disabled={deletingImageId === image.id}
                      onClick={() => deleteExistingImage(image.id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}

                {pendingImages.map((item) => (
                  <div key={item.key} className="group relative overflow-hidden rounded-lg border">
                    <img src={item.url} alt={item.file.name} className="h-24 w-full object-cover" />
                    <Button
                      type="button"
                      variant="destructive"
                      size="icon-xs"
                      className="absolute top-1 right-1"
                      aria-label="Remove selected image"
                      onClick={() => removePendingImage(item.key)}
                    >
                      <Trash2 />
                    </Button>
                    <span className="absolute inset-x-0 bottom-0 truncate bg-background/85 px-1 py-0.5 text-[11px]">
                      {item.file.name}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={fileInputRef}
                  id="product-images"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  className="hidden"
                  onChange={(event) => addImages(event.target.files)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canAddImages}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload />
                  Select images
                </Button>
                <span className="text-xs text-muted-foreground">
                  {totalImages}/{MAX_IMAGES} selected
                  {pendingImages.length > 0 ? ' · uploaded when you save' : ''}
                </span>
              </div>

              {imageError ? <p className="text-sm text-destructive">{imageError}</p> : null}

              {uploadResults ? (
                <div className="grid gap-2 text-sm">
                  {uploadResults.accepted.length > 0 ? (
                    <div>
                      <p className="font-medium text-emerald-600 dark:text-emerald-400">
                        {uploadResults.accepted.length} image(s) uploaded
                      </p>
                      <ul className="list-inside list-disc text-muted-foreground">
                        {uploadResults.accepted.map((image) => (
                          <li key={image.id}>{image.fileName}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {uploadResults.rejected.length > 0 ? (
                    <div>
                      <p className="font-medium text-destructive">{uploadResults.rejected.length} image(s) rejected</p>
                      <ul className="list-inside list-disc text-muted-foreground">
                        {uploadResults.rejected.map((image) => (
                          <li key={`${image.fileName}-${image.reason}`}>
                            {image.fileName} — {image.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {!product ? (
                <p className="text-xs text-muted-foreground">Selected images are uploaded after the product is created.</p>
              ) : null}
            </div>
          </SectionCard>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <Link href="/admin/products" className={buttonVariants({ variant: 'ghost' })}>
              Back to products
            </Link>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving...' : isEdit ? 'Save changes' : 'Create product'}
            </Button>
          </div>
        </fieldset>
      </form>
    </div>
  )
}

export function ProductStatusActions({
  productId,
  name,
  status,
  payload,
}: {
  productId: string
  name: string
  status: ProductStatus
  payload: ProductPayload
}) {
  const router = useRouter()
  const [pending, setPending] = useState<ProductStatus | 'ARCHIVE' | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  async function changeStatus(nextStatus: ProductStatus) {
    setPending(nextStatus)
    const result = await api(`/api/admin/products/${productId}`, {
      method: 'PATCH',
      body: { ...payload, status: nextStatus },
    })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(nextStatus === 'PUBLISHED' ? 'Product published.' : 'Product unpublished.')
    router.refresh()
  }

  async function archiveProduct() {
    setPending('ARCHIVE')
    setArchiveError(null)
    const result = await api<{ archived: boolean }>(`/api/admin/products/${productId}`, { method: 'DELETE' })
    setPending(null)
    if (!result.ok) {
      setArchiveError(result.error)
      toast.error(result.error)
      return
    }
    setArchiveOpen(false)
    toast.success(
      result.data.archived
        ? 'Product archived. Order history and ticket files were retained.'
        : 'Product deleted because it had no orders or inventory.',
    )
    router.refresh()
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {status === 'DRAFT' || status === 'UNPUBLISHED' ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => changeStatus('PUBLISHED')}
          disabled={pending !== null}
        >
          {pending === 'PUBLISHED' ? 'Publishing...' : 'Publish'}
        </Button>
      ) : null}
      {status === 'PUBLISHED' ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => changeStatus('UNPUBLISHED')}
          disabled={pending !== null}
        >
          {pending === 'UNPUBLISHED' ? 'Unpublishing...' : 'Unpublish'}
        </Button>
      ) : null}
      {status !== 'ARCHIVED' ? (
        <Dialog
          open={archiveOpen}
          onOpenChange={(open) => {
            setArchiveOpen(open)
            if (open) setArchiveError(null)
          }}
        >
          <DialogTrigger render={<Button variant="destructive" size="xs" />}>Archive</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Archive {name}?</DialogTitle>
              <DialogDescription>
                The product leaves the storefront immediately. Products with orders or ticket files are kept and archived; a
                product with neither is deleted permanently. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {archiveError ? <p className="text-sm text-destructive">{archiveError}</p> : null}
            <DialogFooter>
              <DialogClose render={<Button variant="outline" disabled={pending === 'ARCHIVE'} />}>Keep product</DialogClose>
              <Button variant="destructive" onClick={archiveProduct} disabled={pending === 'ARCHIVE'}>
                {pending === 'ARCHIVE' ? 'Archiving...' : 'Archive product'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}
