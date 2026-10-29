'use client'

import { useRef, useState } from 'react'
import { Camera, CameraOff, CheckCircle2, QrCode, Search, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api/client'
import { PageHeader, SectionCard } from '@/components/admin/page-primitives'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

type CheckInOrder = {
  reference: string
  customerName: string
  customerEmail: string
  visitDateLabel: string
  adultQty: number
  childQty: number
  tickets: number
  checkedInAt: string | null
  checkedInBy: string | null
}

type CheckInResponse = { alreadyCheckedIn: boolean; order: CheckInOrder }

type ScanEntry = { code: string; reference: string; name: string; tickets: number; at: string; already: boolean }

type ScannerHandle = { stop: () => Promise<void>; clear: () => void }

export function CheckInScanner({ todayLabel }: { todayLabel: string }) {
  const [code, setCode] = useState('')
  const [allowAnyDate, setAllowAnyDate] = useState(false)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<CheckInResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [history, setHistory] = useState<ScanEntry[]>([])
  const scannerRef = useRef<ScannerHandle | null>(null)
  const handlingRef = useRef(false)

  async function submit(rawCode: string) {
    const value = rawCode.trim()
    if (!value || pending) return
    setPending(true)
    setError(null)
    setResult(null)

    const response = await api<CheckInResponse>('/api/admin/check-in', {
      method: 'POST',
      body: { code: value, allowAnyDate },
    })
    setPending(false)

    if (!response.ok) {
      setError(response.error)
      return
    }

    setResult(response.data)
    setCode('')
    setHistory((current) =>
      [
        {
          code: value,
          reference: response.data.order.reference,
          name: response.data.order.customerName,
          tickets: response.data.order.tickets,
          at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
          already: response.data.alreadyCheckedIn,
        },
        ...current,
      ].slice(0, 10),
    )
    toast.success(
      response.data.alreadyCheckedIn
        ? `${response.data.order.reference} was already checked in.`
        : `Checked in ${response.data.order.reference} · ${response.data.order.tickets} ticket(s).`,
    )
  }

  async function startScanner() {
    setScanError(null)
    if (scanning) return
    try {
      const { Html5Qrcode } = await import('html5-qrcode')
      const scanner = new Html5Qrcode('museum-qr-reader')
      scannerRef.current = scanner
      setScanning(true)
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText) => {
          if (handlingRef.current) return
          handlingRef.current = true
          void (async () => {
            await stopScanner()
            await submit(decodedText)
            handlingRef.current = false
          })()
        },
        () => {
          // Per-frame decode failures are normal while the camera focuses.
        },
      )
    } catch (cause) {
      setScanning(false)
      scannerRef.current = null
      setScanError(
        cause instanceof Error
          ? `Camera unavailable: ${cause.message}. Enter the booking reference manually instead.`
          : 'Camera unavailable. Enter the booking reference manually instead.',
      )
    }
  }

  async function stopScanner() {
    const scanner = scannerRef.current
    scannerRef.current = null
    setScanning(false)
    if (!scanner) return
    try {
      await scanner.stop()
      scanner.clear()
    } catch {
      // The camera may already be stopped by the browser.
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Gate check-in"
        description={`Scan the visitor's QR code or type their booking reference. Today is ${todayLabel}.`}
        actions={
          <Button variant="outline" size="sm" onClick={() => void (scanning ? stopScanner() : startScanner())}>
            {scanning ? <CameraOff data-icon="inline-start" /> : <Camera data-icon="inline-start" />}
            {scanning ? 'Stop camera' : 'Scan QR code'}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SectionCard title="Scan or enter a booking" description="One QR code covers the whole party.">
          <div className="grid gap-4">
            <div id="museum-qr-reader" className={scanning ? 'overflow-hidden rounded-xl border bg-black' : 'hidden'} />

            {scanning ? (
              <p className="text-xs text-muted-foreground">
                Point the camera at the QR code. The scan stops automatically after a successful read.
              </p>
            ) : null}

            {scanError ? (
              <Alert variant="destructive">
                <AlertDescription>{scanError}</AlertDescription>
              </Alert>
            ) : null}

            <form
              onSubmit={(event) => {
                event.preventDefault()
                void submit(code)
              }}
              className="grid gap-3"
            >
              <div className="grid gap-1.5">
                <Label htmlFor="checkin-code">Booking reference or QR value</Label>
                <div className="flex gap-2">
                  <Input
                    id="checkin-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="BVP-2026-ABC123"
                    autoComplete="off"
                    autoCapitalize="characters"
                    autoFocus
                  />
                  <Button type="submit" disabled={pending || code.trim().length < 4}>
                    <Search data-icon="inline-start" /> {pending ? 'Checking…' : 'Check in'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  The reference is printed on the confirmation email and shown under the QR code.
                </p>
              </div>

              <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                <div className="grid gap-0.5">
                  <Label htmlFor="allow-any-date">Accept any visit date</Label>
                  <p className="text-xs text-muted-foreground">
                    Off by default: only bookings for today can be checked in.
                  </p>
                </div>
                <Switch id="allow-any-date" checked={allowAnyDate} onCheckedChange={setAllowAnyDate} />
              </div>
            </form>
          </div>
        </SectionCard>

        <SectionCard title="Result" description="The latest scan appears here.">
          {error ? (
            <Alert variant="destructive">
              <TriangleAlert className="size-4" />
              <AlertTitle>Check-in refused</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : result ? (
            <div className="grid gap-4">
              <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/30">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div className="min-w-0">
                  <p className="font-medium text-emerald-900 dark:text-emerald-100">
                    {result.alreadyCheckedIn ? 'Already checked in' : 'Checked in successfully'}
                  </p>
                  <p className="text-sm text-emerald-800/80 dark:text-emerald-300/80">
                    {result.order.reference} · {result.order.customerName}
                  </p>
                  {result.alreadyCheckedIn && result.order.checkedInAt ? (
                    <p className="mt-1 text-xs text-emerald-800/70 dark:text-emerald-300/70">
                      First scanned {new Date(result.order.checkedInAt).toLocaleString('en-GB')}
                      {result.order.checkedInBy ? ` by ${result.order.checkedInBy}` : ''}
                    </p>
                  ) : null}
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Visit date</dt>
                  <dd className="font-medium">{result.order.visitDateLabel}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Party</dt>
                  <dd className="font-medium">
                    {result.order.tickets} ticket{result.order.tickets === 1 ? '' : 's'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Adults</dt>
                  <dd className="font-medium tabular-nums">{result.order.adultQty}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Children</dt>
                  <dd className="font-medium tabular-nums">{result.order.childQty}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">Email</dt>
                  <dd className="truncate font-medium">{result.order.customerEmail}</dd>
                </div>
              </dl>
            </div>
          ) : (
            <div className="grid place-items-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center">
              <QrCode className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium">Waiting for a scan</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Scan the visitor&apos;s QR code or enter the reference from their confirmation email.
              </p>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="This session" description="Scans performed on this device since the page opened.">
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No scans yet.</p>
        ) : (
          <ul className="grid gap-2">
            {history.map((entry, index) => (
              <li
                key={`${entry.code}-${entry.at}-${index}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-emerald-600" />
                  <span className="font-mono text-xs">{entry.reference}</span>
                  <span className="text-muted-foreground">{entry.name}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {entry.tickets} ticket{entry.tickets === 1 ? '' : 's'} · {entry.at}
                  {entry.already ? ' · duplicate' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  )
}
