'use client'

import { useState } from 'react'
import { CalendarDays, Clock } from 'lucide-react'
import { Input } from '@/components/ui/input'

export type SessionChoice = {
  id: string
  dateKey: string
  dateLabel: string
  startTime: string
  timeLabel: string
  name: string | null
  available: number
}

export function SessionSelector({
  sessions,
  value,
  onChange,
  minTickets,
  disabled,
}: {
  sessions: SessionChoice[]
  value: string | null
  onChange: (sessionId: string) => void
  minTickets: number
  disabled?: boolean
}) {
  const [timeError, setTimeError] = useState<string | null>(null)
  const selected = sessions.find((session) => session.id === value) ?? null
  const activeDate = selected?.dateKey ?? null
  const dateKeys = Array.from(new Set(sessions.map((session) => session.dateKey))).sort()
  const times = activeDate ? sessions.filter((session) => session.dateKey === activeDate) : []

  function chooseDate(dateKey: string) {
    setTimeError(null)
    const options = sessions.filter((session) => session.dateKey === dateKey)
    const next = options.find((session) => session.available >= minTickets) ?? options[0]
    if (next) onChange(next.id)
  }

  function chooseTime(time: string) {
    const match = times.find((session) => session.startTime === time)
    if (!match) {
      setTimeError(`No tickets at ${time}. Choose one of the available times below.`)
      return
    }
    if (match.available < minTickets) {
      setTimeError('That time is sold out. Choose another time.')
      return
    }
    setTimeError(null)
    onChange(match.id)
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <label className="flex items-center gap-1.5 text-sm font-medium">
            <CalendarDays className="size-4 text-muted-foreground" aria-hidden="true" />
            Date
          </label>
          <Input
            type="date"
            value={activeDate ?? ''}
            min={dateKeys[0]}
            max={dateKeys[dateKeys.length - 1]}
            onChange={(event) => chooseDate(event.currentTarget.value)}
            disabled={disabled}
            aria-label="Date"
            className="h-10"
          />
        </div>

        <div className="grid gap-1.5">
          <label className="flex items-center gap-1.5 text-sm font-medium">
            <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
            Time
          </label>
          <Input
            type="time"
            value={selected?.startTime ?? ''}
            onChange={(event) => chooseTime(event.currentTarget.value)}
            disabled={disabled || !activeDate || times.length === 0}
            aria-label="Time"
            className="h-10"
          />
          {timeError ? (
            <p className="text-xs text-destructive">{timeError}</p>
          ) : activeDate && times.length === 0 ? (
            <p className="text-xs text-destructive">No times are available on this date.</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
