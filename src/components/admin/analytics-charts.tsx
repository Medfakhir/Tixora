'use client'

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { SectionCard } from '@/components/admin/page-primitives'
import { humanize } from '@/components/shared/status-badges'
import { formatMoney, minorUnitsFor } from '@/lib/money'

export type RevenueDayPoint = { date: string; grossMinor: number; netMinor: number }
export type RevenueProductPoint = { productName: string; revenueMinor: number; tickets: number }
export type EnvironmentPoint = { environment: string; grossMinor: number; orders: number }
export type StatusCountPoint = { status: string; count: number }

export type AnalyticsChartsProps = {
  revenueByDay: RevenueDayPoint[]
  revenueByProduct: RevenueProductPoint[]
  byEnvironment: EnvironmentPoint[]
  orderStatus: StatusCountPoint[]
  ticketsByStatus: StatusCountPoint[]
  currency: string
}

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

const TOOLTIP_STYLE = {
  backgroundColor: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--popover-foreground)',
} as const

function dayLabel(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(date)
}

function compactMoney(minor: number, currency: string): string {
  const amount = minor / 10 ** minorUnitsFor(currency)
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(amount)
  } catch {
    return `${amount} ${currency.toUpperCase()}`
  }
}

function EmptyChart({ message = 'No data in this range.' }: { message?: string }) {
  return <div className="grid h-[220px] place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">{message}</div>
}

export function RevenueTrendChart({
  data,
  currency,
  height = 260,
}: {
  data: RevenueDayPoint[]
  currency: string
  height?: number
}) {
  if (data.length === 0) return <EmptyChart message="No revenue recorded in this period." />

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="tixora-gross-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.35} />
            <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11 }}
          tickFormatter={dayLabel}
          minTickGap={24}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11 }}
          width={64}
          tickFormatter={(value) => compactMoney(Number(value), currency)}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value) => formatMoney(Number(value), currency)}
          labelFormatter={(label) => (typeof label === 'string' ? dayLabel(label) : String(label ?? ''))}
        />
        <Area
          type="monotone"
          dataKey="grossMinor"
          name="Gross"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#tixora-gross-fill)"
        />
        <Area
          type="monotone"
          dataKey="netMinor"
          name="Net"
          stroke="var(--chart-4)"
          strokeWidth={2}
          fill="transparent"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function CountBars({ data, label }: { data: StatusCountPoint[]; label: string }) {
  if (data.length === 0) return <EmptyChart />

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis
          dataKey="status"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, textAnchor: 'end' }}
          tickFormatter={(value) => humanize(String(value))}
          interval={0}
          angle={-25}
          height={64}
        />
        <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} allowDecimals={false} width={36} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: 'var(--muted)' }}
          formatter={(value) => [Number(value), label]}
          labelFormatter={(value) => humanize(String(value ?? ''))}
        />
        <Bar dataKey="count" name={label} radius={[4, 4, 0, 0]}>
          {data.map((entry, index) => (
            <Cell key={entry.status} fill={COLORS[index % COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function ProductBars({ data, currency }: { data: RevenueProductPoint[]; currency: string }) {
  if (data.length === 0) return <EmptyChart />

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis
          type="number"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11 }}
          tickFormatter={(value) => compactMoney(Number(value), currency)}
        />
        <YAxis
          type="category"
          dataKey="productName"
          width={150}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11 }}
          tickFormatter={(value) => {
            const text = String(value)
            return text.length > 20 ? `${text.slice(0, 20)}…` : text
          }}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: 'var(--muted)' }}
          formatter={(value) => formatMoney(Number(value), currency)}
        />
        <Bar dataKey="revenueMinor" name="Revenue" fill="var(--chart-2)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function EnvironmentBars({ data, currency }: { data: EnvironmentPoint[]; currency: string }) {
  if (data.length === 0) return <EmptyChart />

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis
          dataKey="environment"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11 }}
          tickFormatter={(value) => humanize(String(value))}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11 }}
          width={64}
          tickFormatter={(value) => compactMoney(Number(value), currency)}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: 'var(--muted)' }}
          formatter={(value) => formatMoney(Number(value), currency)}
          labelFormatter={(value) => humanize(String(value ?? ''))}
        />
        <Bar dataKey="grossMinor" name="Gross revenue" radius={[4, 4, 0, 0]}>
          {data.map((entry, index) => (
            <Cell key={entry.environment} fill={COLORS[index % COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export function AnalyticsCharts({
  revenueByDay,
  revenueByProduct,
  byEnvironment,
  orderStatus,
  ticketsByStatus,
  currency,
}: AnalyticsChartsProps) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <SectionCard className="xl:col-span-2" title="Revenue by day" description="Gross collected and net of refunds">
        <RevenueTrendChart data={revenueByDay} currency={currency} height={300} />
      </SectionCard>

      <SectionCard title="Revenue by product" description="Top products in the selected range">
        <ProductBars data={revenueByProduct} currency={currency} />
      </SectionCard>

      <SectionCard title="Payments by environment" description="Captured revenue split across PayPal environments">
        <EnvironmentBars data={byEnvironment} currency={currency} />
      </SectionCard>

      <SectionCard title="Order status breakdown" description="Every order created in the selected range">
        <CountBars data={orderStatus} label="Orders" />
      </SectionCard>

      <SectionCard title="Tickets by status" description="Current inventory state">
        <CountBars data={ticketsByStatus} label="Tickets" />
      </SectionCard>
    </div>
  )
}
