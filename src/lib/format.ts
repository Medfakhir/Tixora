/** All display timestamps go through the store timezone so reports and receipts agree. */
export function formatDateTime(date: Date | null | undefined, timezone: string, withSeconds = false): string {
  if (!date) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: withSeconds ? 'medium' : 'short',
    timeZone: timezone,
  }).format(date)
}

export function formatDate(date: Date | string | null | undefined, timezone = 'UTC'): string {
  if (!date) return '—'
  const value = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(value.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: timezone }).format(value)
}

export function formatDayMonth(date: Date | null | undefined, timezone = 'UTC'): string {
  if (!date) return '—'
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: timezone }).format(date)
}

export function timeAgo(date: Date | null | undefined, now = new Date()): string {
  if (!date) return 'never'
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatDate(date)
}

/** A countdown target rendered from a timestamp, used for reservation expiry. */
export function isoOrEmpty(date: Date | null | undefined): string {
  return date ? date.toISOString() : ''
}
