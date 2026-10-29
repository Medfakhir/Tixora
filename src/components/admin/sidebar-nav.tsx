'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from 'cn'
import {
  LayoutDashboard,
  ChartLine,
  Receipt,
  Users,
  Package,
  FileUp,
  CreditCard,
  Mail,
  ScrollText,
  Settings,
  UserCog,
  QrCode,
  CalendarDays,
  CalendarOff,
} from 'lucide-react'
import type { AdminRole } from '@prisma/client'

type NavItem = { href: string; icon: typeof LayoutDashboard; label: string; superOnly?: boolean; exact?: boolean }

const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Museum',
    items: [
      { href: '/admin', icon: LayoutDashboard, label: 'Overview', exact: true },
      { href: '/admin/sales-calendar', icon: CalendarDays, label: 'Sales calendar' },
      { href: '/admin/check-in', icon: QrCode, label: 'Check-in' },
      { href: '/admin/closed-dates', icon: CalendarOff, label: 'Closures' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { href: '/admin/orders', icon: Receipt, label: 'Orders' },
      { href: '/admin/customers', icon: Users, label: 'Customers' },
      { href: '/admin/payments', icon: CreditCard, label: 'Payments' },
      { href: '/admin/analytics', icon: ChartLine, label: 'Analytics' },
      { href: '/admin/activity-logs', icon: ScrollText, label: 'Activity log' },
    ],
  },
  {
    label: 'Legacy catalogue',
    items: [
      { href: '/admin/products', icon: Package, label: 'Products' },
      { href: '/admin/inventory', icon: FileUp, label: 'Ticket inventory' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { href: '/admin/settings/museum', icon: Settings, label: 'Museum settings', superOnly: true },
      { href: '/admin/email-logs', icon: Mail, label: 'Email logs' },
      { href: '/admin/settings/email-templates', icon: Mail, label: 'Email templates' },
      { href: '/admin/settings/general', icon: Settings, label: 'General settings' },
      { href: '/admin/settings/paypal', icon: CreditCard, label: 'PayPal', superOnly: true },
      { href: '/admin/settings/smtp', icon: Mail, label: 'SMTP', superOnly: true },
      { href: '/admin/users', icon: UserCog, label: 'Administrators', superOnly: true },
    ],
  },
]

export function SidebarNav({ role }: { role: AdminRole }) {
  const pathname = usePathname()

  return (
    <nav className="flex flex-col gap-6 px-3 py-4">
      {GROUPS.map((group) => {
        const items = group.items.filter((item) => !item.superOnly || role === 'SUPER_ADMIN')
        if (items.length === 0) return null
        return (
          <div key={group.label} className="grid gap-1">
            <p className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-sidebar-foreground/50 uppercase">{group.label}</p>
            {items.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href)
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                    active
                      ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {item.label}
                </Link>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}
