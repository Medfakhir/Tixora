import { cn } from 'cn'
import type {
  OrderStatus,
  DeliveryStatus,
  TicketInventoryStatus,
  ReservationStatus,
  InventoryModel,
  PaymentEnvironment,
  ProductStatus,
} from '@prisma/client'

const TONES = {
  neutral: 'bg-muted text-muted-foreground',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300',
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  orange: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-300',
} as const

const ORDER_TONES: Record<OrderStatus, keyof typeof TONES> = {
  PENDING: 'neutral',
  AWAITING_PAYMENT: 'amber',
  PAID: 'blue',
  PROCESSING: 'blue',
  COMPLETED: 'green',
  PAYMENT_FAILED: 'red',
  CANCELLED: 'neutral',
  REFUNDED: 'purple',
  PARTIALLY_REFUNDED: 'purple',
  DELIVERY_FAILED: 'orange',
}

const DELIVERY_TONES: Record<DeliveryStatus, keyof typeof TONES> = {
  NOT_REQUIRED: 'neutral',
  PENDING: 'neutral',
  QUEUED: 'blue',
  SENT: 'green',
  PARTIALLY_SENT: 'orange',
  FAILED: 'red',
}

const TICKET_TONES: Record<TicketInventoryStatus, keyof typeof TONES> = {
  AVAILABLE: 'green',
  RESERVED: 'amber',
  SOLD: 'blue',
  DELIVERED: 'neutral',
  FAILED_DELIVERY: 'red',
  RETIRED: 'neutral',
}

const RESERVATION_TONES: Record<ReservationStatus, keyof typeof TONES> = {
  ACTIVE: 'amber',
  CONVERTED: 'green',
  RELEASED: 'neutral',
  EXPIRED: 'neutral',
}

const PRODUCT_TONES: Record<ProductStatus, keyof typeof TONES> = {
  DRAFT: 'neutral',
  PUBLISHED: 'green',
  UNPUBLISHED: 'amber',
  ARCHIVED: 'neutral',
}

const BASE = 'inline-flex h-5 items-center rounded-full border border-transparent px-2 text-xs font-medium whitespace-nowrap'

/** Status enums carry their meaning in the database; colour is only ever derived here. */
function Badge({ tone, text, className }: { tone: keyof typeof TONES; text: string; className?: string }) {
  return <span className={cn(BASE, TONES[tone], className)}>{text}</span>
}

export function OrderStatusBadge({ status, className }: { status: OrderStatus; className?: string }) {
  return <Badge tone={ORDER_TONES[status]} text={humanize(status)} className={className} />
}

export function DeliveryStatusBadge({ status, className }: { status: DeliveryStatus; className?: string }) {
  return <Badge tone={DELIVERY_TONES[status]} text={humanize(status)} className={className} />
}

export function TicketStatusBadge({ status, className }: { status: TicketInventoryStatus; className?: string }) {
  return <Badge tone={TICKET_TONES[status]} text={humanize(status)} className={className} />
}

export function ReservationStatusBadge({ status, className }: { status: ReservationStatus; className?: string }) {
  return <Badge tone={RESERVATION_TONES[status]} text={humanize(status)} className={className} />
}

export function ProductStatusBadge({ status, className }: { status: ProductStatus; className?: string }) {
  return <Badge tone={PRODUCT_TONES[status]} text={humanize(status)} className={className} />
}

export function EnvironmentBadge({ environment, className }: { environment: PaymentEnvironment; className?: string }) {
  return <Badge tone={environment === 'LIVE' ? 'purple' : 'neutral'} text={environment} className={className} />
}

export function InventoryModelBadge({ model, className }: { model: InventoryModel; className?: string }) {
  return (
    <Badge
      tone="neutral"
      text={model === 'ONE_PDF_PER_TICKET' ? 'Model A · one PDF per ticket' : 'Model B · one PDF per group'}
      className={className}
    />
  )
}

/** UPPER_SNAKE enum values read as words in the UI. */
export function humanize(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
