'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { api } from '@/lib/api/client'
import { Button } from '@/components/ui/button'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SectionCard } from '@/components/admin/page-primitives'
import { Money, toMajorString, toMinorUnits } from '@/components/shared/money'
import { minorUnitsFor } from '@/lib/money'

type OrderActionsProps = {
  orderId: string
  reference: string
  currency: string
  totalMinor: number
  refundedMinor: number
  canCancel: boolean
  canRefund: boolean
  canRetryDelivery: boolean
}

export function OrderActions({
  orderId,
  reference,
  currency,
  totalMinor,
  refundedMinor,
  canCancel,
  canRefund,
  canRetryDelivery,
}: OrderActionsProps) {
  const router = useRouter()
  const refundable = Math.max(0, totalMinor - refundedMinor)

  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelPending, setCancelPending] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  const [refundOpen, setRefundOpen] = useState(false)
  const [refundPending, setRefundPending] = useState(false)
  const [refundError, setRefundError] = useState<string | null>(null)
  const [amount, setAmount] = useState(() => toMajorString(refundable, currency))
  const [reason, setReason] = useState('')

  const [retryPending, setRetryPending] = useState(false)

  async function cancelOrder() {
    setCancelPending(true)
    setCancelError(null)
    const result = await api<{ status: string; ticketsReleased: number }>(`/api/admin/orders/${orderId}/cancel`, { method: 'POST' })
    setCancelPending(false)
    if (!result.ok) {
      setCancelError(result.error)
      toast.error(result.error)
      return
    }
    toast.success(`Order cancelled. ${result.data.ticketsReleased} held ticket(s) released.`)
    setCancelOpen(false)
    router.refresh()
  }

  async function issueRefund() {
    const amountMinor = toMinorUnits(amount, currency)
    const trimmedReason = reason.trim()
    if (amountMinor < 1) {
      setRefundError('Enter a refund amount greater than zero.')
      return
    }
    if (amountMinor > refundable) {
      setRefundError(`The refund cannot exceed ${toMajorString(refundable, currency)} ${currency}.`)
      return
    }
    if (!trimmedReason) {
      setRefundError('A reason is required for every refund.')
      return
    }

    setRefundPending(true)
    setRefundError(null)
    const result = await api<{ refundId: string; fullyRefunded: boolean; status: string }>(`/api/admin/orders/${orderId}/refund`, {
      method: 'POST',
      body: { amountMinor, reason: trimmedReason },
    })
    setRefundPending(false)
    if (!result.ok) {
      setRefundError(result.error)
      toast.error(result.error)
      return
    }
    toast.success(result.data.fullyRefunded ? 'Order fully refunded.' : 'Partial refund issued.')
    setRefundOpen(false)
    router.refresh()
  }

  async function retryDelivery() {
    setRetryPending(true)
    const result = await api<{ message: string }>(`/api/admin/orders/${orderId}/retry-delivery`, { method: 'POST' })
    setRetryPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(result.data.message)
    router.refresh()
  }

  function onRefundOpenChange(open: boolean) {
    setRefundOpen(open)
    if (open) {
      setAmount(toMajorString(refundable, currency))
      setReason('')
      setRefundError(null)
    }
  }

  const hasAction = canCancel || canRefund || canRetryDelivery
  const step = minorUnitsFor(currency) === 0 ? '1' : 'any'

  return (
    <SectionCard title="Actions" description={`Manage ${reference}`}>
      {hasAction ? (
        <div className="flex flex-wrap gap-2">
          {canCancel ? (
            <Dialog
              open={cancelOpen}
              onOpenChange={(open) => {
                setCancelOpen(open)
                if (open) setCancelError(null)
              }}
            >
              <DialogTrigger render={<Button variant="destructive" size="sm" />}>Cancel order</DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Cancel {reference}?</DialogTitle>
                  <DialogDescription>
                    This cancels the unpaid order and releases the tickets held for it. It cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                {cancelError ? <p className="text-sm text-destructive">{cancelError}</p> : null}
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" disabled={cancelPending} />}>Keep order</DialogClose>
                  <Button variant="destructive" onClick={cancelOrder} disabled={cancelPending}>
                    {cancelPending ? 'Cancelling...' : 'Cancel order'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null}

          {canRefund ? (
            <Dialog open={refundOpen} onOpenChange={onRefundOpenChange}>
              <DialogTrigger render={<Button variant="outline" size="sm" />}>Issue refund</DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Refund {reference}</DialogTitle>
                  <DialogDescription>
                    Refundable balance: <Money minor={refundable} currency={currency} />. The amount is sent to PayPal immediately.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="refund-amount">Amount ({currency})</Label>
                    <Input
                      id="refund-amount"
                      type="number"
                      inputMode="decimal"
                      min={step === '1' ? '1' : '0.01'}
                      max={toMajorString(refundable, currency)}
                      step={step}
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      disabled={refundPending}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="refund-reason">Reason</Label>
                    <Textarea
                      id="refund-reason"
                      value={reason}
                      maxLength={300}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Why is this order being refunded?"
                      disabled={refundPending}
                    />
                  </div>
                  {refundError ? <p className="text-sm text-destructive">{refundError}</p> : null}
                </div>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" disabled={refundPending} />}>Cancel</DialogClose>
                  <Button variant="destructive" onClick={issueRefund} disabled={refundPending}>
                    {refundPending ? 'Refunding...' : 'Refund'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null}

          {canRetryDelivery ? (
            <Button variant="outline" size="sm" onClick={retryDelivery} disabled={retryPending}>
              {retryPending ? 'Retrying...' : 'Retry delivery'}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No actions are available for this order in its current state.</p>
      )}
    </SectionCard>
  )
}

export function OrderNotes({ orderId, initialNotes }: { orderId: string; initialNotes: string }) {
  const router = useRouter()
  const [notes, setNotes] = useState(initialNotes)
  const [saved, setSaved] = useState(initialNotes)
  const [pending, setPending] = useState(false)

  async function saveNotes() {
    setPending(true)
    const result = await api<{ internalNotes: string }>(`/api/admin/orders/${orderId}/notes`, {
      method: 'POST',
      body: { notes },
    })
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setNotes(result.data.internalNotes)
    setSaved(result.data.internalNotes)
    toast.success('Internal notes saved.')
    router.refresh()
  }

  return (
    <SectionCard title="Internal notes" description="Visible to admins only. Never sent to the customer.">
      <div className="grid gap-3">
        <Textarea
          value={notes}
          maxLength={4000}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Add context for other admins"
          disabled={pending}
          className="min-h-28"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{notes.length}/4000</span>
          <Button size="sm" onClick={saveNotes} disabled={pending || notes === saved}>
            {pending ? 'Saving...' : 'Save notes'}
          </Button>
        </div>
      </div>
    </SectionCard>
  )
}
