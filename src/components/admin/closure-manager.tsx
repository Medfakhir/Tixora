'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarOff, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api/client'
import { formatVisitDate } from '@/lib/museum/dates'
import { PageHeader, SectionCard, EmptyState } from '@/components/admin/page-primitives'
import { Field } from '@/components/shared/field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export type ClosureRow = { id: string; date: string; reason: string; createdBy: string | null }
export type WeeklyRow = { dayOfWeek: number; isActive: boolean; reason: string }

const DAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
]

export function ClosureManager({
  initialClosed,
  initialWeekly,
  today,
  capacity,
}: {
  initialClosed: ClosureRow[]
  initialWeekly: WeeklyRow[]
  today: string
  capacity: number
}) {
  const router = useRouter()
  const [closed, setClosed] = useState(initialClosed)
  const [weekly, setWeekly] = useState<WeeklyRow[]>(initialWeekly)
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [weeklyPending, setWeeklyPending] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function addClosure(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)

    const result = await api<{ added: number; from: string; to: string }>('/api/admin/closed-dates', {
      method: 'POST',
      body: { from, to: to || undefined, reason: reason.trim() || undefined },
    })
    setPending(false)

    if (!result.ok) {
      setError(result.error)
      toast.error(result.error)
      return
    }

    toast.success(`${result.data.added} date${result.data.added === 1 ? '' : 's'} closed.`)
    setReason('')
    setTo('')
    router.refresh()
  }

  async function removeClosure(row: ClosureRow) {
    const result = await api<{ removed: boolean }>('/api/admin/closed-dates', {
      method: 'DELETE',
      body: { id: row.id },
    })
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setClosed((current) => current.filter((item) => item.id !== row.id))
    toast.success(`Reopened ${formatVisitDate(row.date, 'en')}.`)
    router.refresh()
  }

  async function toggleWeekly(dayOfWeek: number, isActive: boolean) {
    setWeeklyPending(dayOfWeek)
    const result = await api<WeeklyRow>('/api/admin/weekly-closures', {
      method: 'POST',
      body: { dayOfWeek, isActive, reason: 'Weekly closure' },
    })
    setWeeklyPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setWeekly((current) => {
      const next = current.filter((row) => row.dayOfWeek !== dayOfWeek)
      next.push(result.data)
      return next
    })
    toast.success(`${DAYS.find((day) => day.value === dayOfWeek)?.label} closure ${isActive ? 'enabled' : 'disabled'}.`)
    router.refresh()
  }

  const isWeeklyActive = (dayOfWeek: number) => weekly.some((row) => row.dayOfWeek === dayOfWeek && row.isActive)

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Closures"
        description="Closed dates disappear from the public calendar immediately. Weekly closures repeat every week until disabled."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <SectionCard title="Close a date or range" description="Use this for holidays, private events and maintenance.">
          {error ? (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <form onSubmit={addClosure} className="grid gap-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="From" htmlFor="closure-from" required>
                <Input
                  id="closure-from"
                  type="date"
                  value={from}
                  min={today}
                  onChange={(event) => setFrom(event.target.value)}
                  required
                />
              </Field>
              <Field label="To (optional)" htmlFor="closure-to" hint="Leave empty to close a single day.">
                <Input
                  id="closure-to"
                  type="date"
                  value={to}
                  min={from || today}
                  onChange={(event) => setTo(event.target.value)}
                />
              </Field>
            </div>
            <Field label="Reason (optional)" htmlFor="closure-reason" hint="Shown internally and on the public tooltip.">
              <Input
                id="closure-reason"
                value={reason}
                maxLength={300}
                placeholder="Public holiday, private event…"
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={pending || !from} className="w-fit">
              <Plus data-icon="inline-start" /> {pending ? 'Saving…' : 'Close date(s)'}
            </Button>
          </form>
        </SectionCard>

        <SectionCard title="Recurring weekly closure" description="The museum is unavailable every week on enabled days.">
          <div className="grid gap-2">
            {DAYS.map((day) => (
              <div key={day.value} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <div>
                  <Label htmlFor={`weekly-${day.value}`}>{day.label}</Label>
                  <p className="text-xs text-muted-foreground">
                    {isWeeklyActive(day.value) ? 'Closed every week' : 'Open'}
                  </p>
                </div>
                <Switch
                  id={`weekly-${day.value}`}
                  checked={isWeeklyActive(day.value)}
                  disabled={weeklyPending === day.value}
                  onCheckedChange={(checked) => void toggleWeekly(day.value, checked)}
                />
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            {capacity > 0
              ? `Daily capacity is ${capacity} tickets. Closed days never consume capacity.`
              : 'Daily capacity is currently unlimited. Set one in museum settings.'}
          </p>
        </SectionCard>
      </div>

      <SectionCard
        title={`Closed dates (${closed.length})`}
        description="Includes past closures. Removing a date reopens it for booking."
        className="overflow-hidden"
      >
        {closed.length === 0 ? (
          <EmptyState
            title="No individual closures"
            description="Add a date range above, or enable a weekly closure."
            action={<CalendarOff className="size-5 text-muted-foreground" />}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Added by</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {closed.map((row) => {
                const past = row.date < today
                return (
                  <TableRow key={row.id} className={past ? 'text-muted-foreground' : undefined}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {formatVisitDate(row.date, 'en')}
                      {past ? <span className="ml-2 text-[11px]">(past)</span> : null}
                    </TableCell>
                    <TableCell className="max-w-xs truncate">{row.reason || '—'}</TableCell>
                    <TableCell className="text-xs">{row.createdBy || '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void removeClosure(row)}
                        aria-label={`Reopen ${formatVisitDate(row.date, 'en')}`}
                      >
                        <Trash2 data-icon="inline-start" /> Reopen
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  )
}
