'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import type { InventoryModel, ProductStatus, TicketInventoryStatus } from '@prisma/client'
import { api } from '@/lib/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { SectionCard } from '@/components/admin/page-primitives'

export type InventoryUploadProduct = {
  id: string
  name: string
  status: ProductStatus
  requiresSession: boolean
  inventoryModel: InventoryModel
}

export type InventoryUploadSession = {
  id: string
  productId: string
  date: string
  startTime: string
  endTime: string
  label: string
  isActive: boolean
}

type UploadResult = {
  accepted: { id: string; fileName: string; storageKey: string; ticketCount: number }[]
  rejected: { fileName: string; reason: string }[]
}

const SELECT_CLASS =
  'h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30'

export function InventoryUploadPanel({
  products,
  sessions,
  defaultProductId = '',
}: {
  products: InventoryUploadProduct[]
  sessions: InventoryUploadSession[]
  defaultProductId?: string
}) {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [productId, setProductId] = useState(() => {
    const candidate = products.find((product) => product.id === defaultProductId)
    return candidate && candidate.status !== 'ARCHIVED' ? candidate.id : ''
  })
  const [sessionId, setSessionId] = useState('')
  const [groupTicketCount, setGroupTicketCount] = useState('1')
  const [files, setFiles] = useState<File[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [results, setResults] = useState<UploadResult | null>(null)

  const selectedProduct = products.find((product) => product.id === productId)
  const productSessions = useMemo(
    () => sessions.filter((session) => session.productId === productId && session.isActive),
    [sessions, productId],
  )
  const modelB = selectedProduct?.inventoryModel === 'ONE_PDF_PER_GROUP'

  function onProductChange(value: string) {
    setProductId(value)
    setSessionId('')
    setFieldErrors({})
    setError(null)
  }

  function onFilesChange(selected: FileList | null) {
    setFiles(selected ? Array.from(selected) : [])
    setResults(null)
    setError(null)
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setFieldErrors({})

    if (!productId) {
      setError('Choose the product these tickets belong to.')
      return
    }
    if (selectedProduct?.requiresSession && !sessionId) {
      setFieldErrors({ eventSessionId: 'Choose a session before uploading.' })
      return
    }
    if (files.length === 0) {
      setError('Choose at least one PDF file.')
      return
    }

    const groupCount = Number.parseInt(groupTicketCount, 10)
    if (modelB && (!Number.isFinite(groupCount) || groupCount < 1 || groupCount > 1000)) {
      setError('Tickets per file must be between 1 and 1,000.')
      return
    }

    setPending(true)
    const form = new FormData()
    form.set('productId', productId)
    if (sessionId) form.set('eventSessionId', sessionId)
    if (modelB) form.set('groupTicketCount', String(groupCount))
    files.forEach((file) => form.append('files', file, file.name))

    const result = await api<UploadResult>('/api/admin/inventory/upload', { method: 'POST', body: form })
    setPending(false)

    if (!result.ok) {
      setFieldErrors(result.fields ?? {})
      setResults(null)
      setError(
        result.status === 422
          ? 'No file was accepted. Each PDF must be under 8 MB, structurally valid, contain no active content, and not duplicate an existing file for this product.'
          : result.error,
      )
      toast.error(result.status === 422 ? 'No file was accepted.' : result.error)
      return
    }

    setResults(result.data)
    setFiles([])
    if (fileInputRef.current) fileInputRef.current.value = ''

    if (result.data.rejected.length > 0) {
      toast.warning(
        `${result.data.accepted.length} file(s) added, ${result.data.rejected.length} rejected.`,
      )
    } else {
      toast.success(`${result.data.accepted.length} ticket file(s) added to inventory.`)
    }
    router.refresh()
  }

  return (
    <SectionCard
      title="Upload ticket PDFs"
      description="Files are stored privately and only ever served through the inventory API."
      className="border-primary/40"
    >
      <form onSubmit={submit} className="grid gap-4">
        <Alert>
          <Upload />
          <AlertTitle>One PDF equals one ticket in Model A</AlertTitle>
          <AlertDescription>
            Upload exactly as many files as you want to sell. Model B products are the exception: one PDF can cover a
            group, and the ticket count is set below.
          </AlertDescription>
        </Alert>

        {products.length === 0 ? (
          <p className="text-sm text-muted-foreground">Create a product before uploading ticket PDFs.</p>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="grid gap-1.5">
                <Label htmlFor="upload-product">Product</Label>
                <select
                  id="upload-product"
                  className={SELECT_CLASS}
                  value={productId}
                  onChange={(event) => onProductChange(event.target.value)}
                  disabled={pending}
                >
                  <option value="">Choose a product</option>
                  {products
                    .filter((product) => product.status !== 'ARCHIVED')
                    .map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                </select>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="upload-session">
                  Session{selectedProduct?.requiresSession ? <span className="text-destructive"> *</span> : null}
                </Label>
                <select
                  id="upload-session"
                  className={SELECT_CLASS}
                  value={sessionId}
                  onChange={(event) => {
                    setSessionId(event.target.value)
                    setFieldErrors({})
                  }}
                  disabled={pending || !productId || !selectedProduct?.requiresSession}
                >
                  <option value="">
                    {selectedProduct?.requiresSession ? 'Choose a session' : 'Product-wide pool'}
                  </option>
                  {productSessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.date} {session.startTime}
                      {session.endTime ? `–${session.endTime}` : ''}
                      {session.label ? ` · ${session.label}` : ''}
                    </option>
                  ))}
                </select>
                {fieldErrors.eventSessionId ? (
                  <p className="text-xs text-destructive">{fieldErrors.eventSessionId}</p>
                ) : selectedProduct?.requiresSession && productSessions.length === 0 ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    This product has no active sessions. Add one in the product editor first.
                  </p>
                ) : null}
              </div>

              {modelB ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="upload-group-count">Tickets per file</Label>
                  <Input
                    id="upload-group-count"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="1000"
                    step="1"
                    value={groupTicketCount}
                    onChange={(event) => setGroupTicketCount(event.target.value)}
                    disabled={pending}
                  />
                  <p className="text-xs text-muted-foreground">Each PDF will represent this many tickets.</p>
                </div>
              ) : (
                <div className="grid content-start gap-1.5 pt-5">
                  <p className="text-xs text-muted-foreground">Model A: each PDF counts as one ticket.</p>
                </div>
              )}

              <div className="grid gap-1.5">
                <Label htmlFor="upload-files">PDF files</Label>
                <input
                  ref={fileInputRef}
                  id="upload-files"
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  className="block w-full text-sm text-muted-foreground file:mr-2 file:rounded-md file:border file:border-input file:bg-transparent file:px-2 file:py-1 file:text-sm file:font-medium"
                  onChange={(event) => onFilesChange(event.target.files)}
                  disabled={pending}
                />
                <p className="text-xs text-muted-foreground">
                  {files.length === 0 ? 'Select one or more PDFs (max 8 MB each).' : `${files.length} file(s) selected`}
                </p>
              </div>
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={pending || !productId || files.length === 0}>
                <Upload />
                {pending ? 'Uploading...' : 'Upload to inventory'}
              </Button>
              {files.length > 0 ? (
                <span className="text-xs text-muted-foreground">
                  {files.reduce((sum, file) => sum + file.size, 0) > 40 * 1024 * 1024
                    ? 'Batch exceeds the 40 MB limit.'
                    : `${(files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1)} MB total`}
                </span>
              ) : null}
            </div>
          </>
        )}

        {results ? (
          <div className="grid gap-3 rounded-lg border p-3">
            <p className="text-sm font-medium">
              {results.accepted.length} accepted · {results.rejected.length} rejected
            </p>
            {results.accepted.length > 0 ? (
              <div>
                <p className="text-xs font-semibold tracking-wide text-emerald-600 uppercase dark:text-emerald-400">
                  Accepted
                </p>
                <ul className="mt-1 grid gap-0.5 text-sm">
                  {results.accepted.map((entry) => (
                    <li key={entry.id} className="flex flex-wrap justify-between gap-2">
                      <span className="truncate">{entry.fileName}</span>
                      <span className="text-xs text-muted-foreground">
                        {entry.ticketCount} ticket{entry.ticketCount === 1 ? '' : 's'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {results.rejected.length > 0 ? (
              <div>
                <p className="text-xs font-semibold tracking-wide text-destructive uppercase">Rejected</p>
                <ul className="mt-1 grid gap-0.5 text-sm">
                  {results.rejected.map((entry) => (
                    <li key={`${entry.fileName}-${entry.reason}`}>
                      <span className="font-medium">{entry.fileName}</span>{' '}
                      <span className="text-muted-foreground">— {entry.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </form>
    </SectionCard>
  )
}

export function InventoryRetireAction({
  id,
  fileName,
  status,
}: {
  id: string
  fileName: string
  status: TicketInventoryStatus
}) {
  if (status !== 'AVAILABLE') {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  return <RetireDialog id={id} fileName={fileName} />
}

function RetireDialog({ id, fileName }: { id: string; fileName: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function retire() {
    setPending(true)
    setError(null)
    const result = await api<{ id: string; status: string }>(`/api/admin/inventory/${id}`, { method: 'DELETE' })
    setPending(false)
    if (!result.ok) {
      setError(result.error)
      toast.error(result.error)
      return
    }
    setOpen(false)
    toast.success(`Retired ${fileName}. It can no longer be sold.`)
    router.refresh()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setError(null)
      }}
    >
      <DialogTrigger render={<Button variant="destructive" size="xs" />}>Retire</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Retire {fileName}?</DialogTitle>
          <DialogDescription>
            The PDF bytes are deleted and the file is removed from the available pool. The inventory row is kept for the
            audit trail. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Keep file</DialogClose>
          <Button variant="destructive" onClick={retire} disabled={pending}>
            {pending ? 'Retiring...' : 'Retire file'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
