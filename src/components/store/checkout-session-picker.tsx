'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { SessionSelector, type SessionChoice } from '@/components/store/session-selector'

export type CheckoutSessionOption = SessionChoice

export function CheckoutSessionPicker({
  slug,
  sessions,
  selectedId,
  quantity,
  minTickets,
}: {
  slug: string
  sessions: CheckoutSessionOption[]
  selectedId: string | null
  quantity: number
  minTickets: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function choose(sessionId: string) {
    if (sessionId === selectedId) return
    const session = sessions.find((candidate) => candidate.id === sessionId)
    if (!session) return
    const nextQuantity = Math.max(minTickets, Math.min(quantity, session.available))
    const params = new URLSearchParams({ slug, session: session.id, qty: String(nextQuantity) })
    startTransition(() => router.replace(`/checkout?${params.toString()}`, { scroll: false }))
  }

  return (
    <div className={pending ? 'pointer-events-none opacity-60' : undefined}>
      <SessionSelector
        sessions={sessions}
        value={selectedId}
        onChange={choose}
        minTickets={minTickets}
        disabled={pending}
      />
    </div>
  )
}
