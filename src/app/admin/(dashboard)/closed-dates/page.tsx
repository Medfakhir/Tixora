import { prisma } from '@/lib/db/prisma'
import { getMuseumSettings } from '@/lib/museum/settings'
import { dateKeyFromDate, todayKey } from '@/lib/museum/dates'
import { ClosureManager, type ClosureRow, type WeeklyRow } from '@/components/admin/closure-manager'

export const metadata = { title: 'Closures' }
export const dynamic = 'force-dynamic'

export default async function ClosedDatesPage() {
  const settings = await getMuseumSettings()
  const [closed, weekly] = await Promise.all([
    prisma.closedDate.findMany({ orderBy: { date: 'asc' }, take: 1000 }),
    prisma.weeklyClosure.findMany({ orderBy: { dayOfWeek: 'asc' } }),
  ])

  const initialClosed: ClosureRow[] = closed.map((row) => ({
    id: row.id,
    date: dateKeyFromDate(row.date),
    reason: row.reason,
    createdBy: row.createdBy,
  }))

  // Ensure every weekday exists in the UI, defaulting to open.
  const initialWeekly: WeeklyRow[] = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => {
    const row = weekly.find((candidate) => candidate.dayOfWeek === dayOfWeek)
    return { dayOfWeek, isActive: row?.isActive ?? false, reason: row?.reason ?? '' }
  })

  return (
    <ClosureManager
      initialClosed={initialClosed}
      initialWeekly={initialWeekly}
      today={todayKey(settings.timezone)}
      capacity={settings.dailyCapacity}
    />
  )
}
