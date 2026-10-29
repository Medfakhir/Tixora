'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SessionSelector, type SessionChoice } from '@/components/store/session-selector'
import { cn } from 'cn'

export type PurchaseSession = SessionChoice

type ProductPurchaseProps = {
  slug: string
  requiresSession: boolean
  sessions: PurchaseSession[]
  minTickets: number
  maxTickets: number
  available: number
}

export function ProductPurchase({
  slug,
  requiresSession,
  sessions,
  minTickets,
  maxTickets,
  available,
}: ProductPurchaseProps) {
  const [sessionId, setSessionId] = useState(() => sessions.find((session) => session.available >= minTickets)?.id ?? '')
  const [quantity, setQuantity] = useState(minTickets)

  const selectedSession = requiresSession ? (sessions.find((session) => session.id === sessionId) ?? null) : null
  const remaining = requiresSession ? (selectedSession?.available ?? 0) : available
  const configured = maxTickets >= minTickets
  const canBuy = configured && remaining >= minTickets && (!requiresSession || selectedSession !== null)
  const quantityMax = canBuy ? Math.min(maxTickets, remaining) : minTickets
  const quantityValue = Math.min(Math.max(quantity, minTickets), quantityMax)

  function setClamped(next: number) {
    if (!Number.isFinite(next)) return
    setQuantity(Math.min(Math.max(Math.trunc(next), minTickets), quantityMax))
  }

  function chooseSession(id: string) {
    setSessionId(id)
    setQuantity(minTickets)
  }

  const params = new URLSearchParams({ slug, qty: String(quantityValue) })
  if (requiresSession && selectedSession) params.set('session', selectedSession.id)
  const checkoutHref = `/checkout?${params.toString()}`

  const availabilityMessage = !configured
    ? 'This ticket cannot be purchased online right now.'
    : requiresSession && sessions.length === 0
      ? 'No dates are currently on sale.'
      : !requiresSession || selectedSession
        ? remaining < minTickets
          ? `Only ${remaining} ${remaining === 1 ? 'ticket' : 'tickets'} left, but the minimum order is ${minTickets}.`
          : `${remaining} ${remaining === 1 ? 'ticket' : 'tickets'} left`
        : 'Select a date to check availability.'

  return (
    <div className="grid gap-5">
      {requiresSession && sessions.length > 0 ? (
        <SessionSelector
          sessions={sessions}
          value={selectedSession?.id ?? null}
          onChange={chooseSession}
          minTickets={minTickets}
        />
      ) : null}

      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Quantity</span>
          {canBuy ? (
            <span className="text-xs text-muted-foreground">
              {minTickets}–{quantityMax}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setClamped(quantityValue - 1)}
            disabled={!canBuy || quantityValue <= minTickets}
            aria-label="Decrease quantity"
          >
            <Minus aria-hidden="true" />
          </Button>
          <Input
            type="number"
            inputMode="numeric"
            min={minTickets}
            max={quantityMax}
            value={quantityValue}
            onChange={(event) => {
              const next = event.currentTarget.valueAsNumber
              if (Number.isFinite(next)) setClamped(next)
            }}
            disabled={!canBuy}
            aria-label="Quantity"
            className="w-16 text-center tabular-nums"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setClamped(quantityValue + 1)}
            disabled={!canBuy || quantityValue >= quantityMax}
            aria-label="Increase quantity"
          >
            <Plus aria-hidden="true" />
          </Button>
        </div>
        <p className={cn('text-sm', remaining < minTickets && configured ? 'text-destructive' : 'text-muted-foreground')}>
          {availabilityMessage}
        </p>
      </div>

      {canBuy ? (
        <Button size="lg" className="w-full" render={<Link href={checkoutHref} />}>
          Continue to checkout
        </Button>
      ) : (
        <Button size="lg" className="w-full" disabled>
          Unavailable
        </Button>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Pay securely with PayPal. A PayPal account is not required. Your PDF tickets are sent to your email after
        payment.
      </p>
    </div>
  )
}
