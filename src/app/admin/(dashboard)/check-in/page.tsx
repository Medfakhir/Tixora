import type { Metadata } from 'next'
import { getMuseumSettings } from '@/lib/museum/settings'
import { formatVisitDate, todayKey } from '@/lib/museum/dates'
import { CheckInScanner } from '@/components/admin/checkin-scanner'

export const metadata: Metadata = { title: 'Check-in' }
export const dynamic = 'force-dynamic'

export default async function CheckInPage() {
  const settings = await getMuseumSettings()
  const today = todayKey(settings.timezone)
  return <CheckInScanner todayLabel={formatVisitDate(today, 'en')} />
}
