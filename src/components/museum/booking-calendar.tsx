'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from 'cn'
import { formatVisitDateShort, monthLabel } from '@/lib/museum/dates'
import { createTranslator, type Locale } from '@/lib/i18n/messages'
import type { MonthAvailability } from '@/lib/museum/availability'

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

export function BookingCalendar({
  data,
  locale,
  selected,
  onSelect,
  onMonthChange,
  loading,
  minMonth,
  maxMonth,
}: {
  data: MonthAvailability
  locale: Locale
  selected: string | null
  onSelect: (date: string) => void
  onMonthChange: (delta: number) => void
  loading: boolean
  minMonth: string
  maxMonth: string
}) {
  const t = createTranslator(locale)
  const firstWeekday = (new Date(Date.UTC(data.year, data.monthNumber - 1, 1)).getUTCDay() + 6) % 7
  const currentMonth = data.month
  const canGoPrevious = currentMonth > minMonth
  const canGoNext = currentMonth < maxMonth

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => canGoPrevious && onMonthChange(-1)}
          disabled={!canGoPrevious || loading}
          className="inline-flex size-9 items-center justify-center rounded-full border bg-background text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35"
          aria-label={t('calendar.previous')}
        >
          <ChevronLeft className="size-4" />
        </button>
        <p className="text-sm font-medium tracking-tight capitalize">{monthLabel(data.year, data.monthNumber, locale)}</p>
        <button
          type="button"
          onClick={() => canGoNext && onMonthChange(1)}
          disabled={!canGoNext || loading}
          className="inline-flex size-9 items-center justify-center rounded-full border bg-background text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35"
          aria-label={t('calendar.next')}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div className="relative">
        <div className="grid grid-cols-7 gap-1 text-center">
          {WEEK_ORDER.map((weekday) => (
            <span key={weekday} className="pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {t(`weekday.${weekday}`)}
            </span>
          ))}
          {Array.from({ length: firstWeekday }, (_, index) => (
            <span key={`blank-${index}`} aria-hidden="true" />
          ))}
          {data.days.map((day) => {
            const isSelected = day.date === selected
            const isToday = day.date === data.today
            const reason = day.reason ? t(day.reason) : ''
            return (
              <button
                key={day.date}
                type="button"
                disabled={!day.available || loading}
                onClick={() => onSelect(day.date)}
                title={day.available ? formatVisitDateShort(day.date, locale) : `${formatVisitDateShort(day.date, locale)} — ${reason}`}
                aria-label={`${formatVisitDateShort(day.date, locale)} — ${
                  day.available ? t('calendar.available') : reason || t('calendar.unavailable')
                }`}
                aria-pressed={isSelected}
                className={cn(
                  'relative mx-auto flex aspect-square w-full max-w-11 items-center justify-center rounded-lg text-sm tabular-nums transition-all',
                  day.available
                    ? 'bg-muted/60 text-foreground hover:bg-primary hover:text-primary-foreground'
                    : 'cursor-not-allowed text-muted-foreground/45 line-through decoration-muted-foreground/30',
                  isToday && day.available && 'ring-1 ring-primary/40',
                  isSelected && 'bg-primary font-semibold text-primary-foreground shadow-sm hover:bg-primary',
                  loading && 'pointer-events-none opacity-60',
                )}
              >
                {day.day}
                {day.available && !isSelected ? (
                  <span className="absolute bottom-1 size-1 rounded-full bg-emerald-500/70" aria-hidden="true" />
                ) : null}
              </button>
            )
          })}
        </div>

        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/70 text-xs text-muted-foreground backdrop-blur-[1px]">
            {t('calendar.loading')}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-primary" /> {t('calendar.available')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-muted-foreground/30" /> {t('calendar.unavailable')}
        </span>
      </div>
    </div>
  )
}
