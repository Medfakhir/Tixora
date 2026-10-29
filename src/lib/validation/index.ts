import { z } from 'zod'
import { SUPPORTED_CURRENCIES } from '@/lib/money'

export const loginSchema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

export const checkoutCustomerSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name is required').max(120),
  email: z.email('Enter a valid email address').max(200),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
})

export const checkoutSelectionSchema = z.object({
  slug: z.string().min(1),
  eventSessionId: z.string().min(1).nullable().optional(),
  // Quantities arrive from the browser but are only a request; the server re-prices.
  quantity: z.coerce.number().int().min(1).max(500),
})

export const checkoutRequestSchema = checkoutCustomerSchema.merge(checkoutSelectionSchema)

export const productSchema = z.object({
  name: z.string().trim().min(2).max(140),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, numbers and hyphens only')
    .max(140),
  shortDescription: z.string().trim().min(2).max(240),
  description: z.string().trim().min(2).max(20_000),
  categoryId: z.string().nullable().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED']),
  priceMinor: z.coerce.number().int().min(0),
  currency: z.enum(SUPPORTED_CURRENCIES as unknown as [string, ...string[]]),
  taxRateBps: z.coerce.number().int().min(0).max(10_000),
  taxIncluded: z.boolean(),
  inventoryModel: z.enum(['ONE_PDF_PER_TICKET', 'ONE_PDF_PER_GROUP']),
  minTickets: z.coerce.number().int().min(1).max(500),
  maxTickets: z.coerce.number().int().min(1).max(500),
  requiresSession: z.boolean(),
  salesStartAt: z.string().datetime({ offset: true }).nullable().optional().or(z.literal('')),
  salesEndAt: z.string().datetime({ offset: true }).nullable().optional().or(z.literal('')),
  lowInventoryThreshold: z.coerce.number().int().min(0).max(100_000),
  groupTicketCount: z.coerce.number().int().min(1).max(1000).default(1),
}).refine((data) => data.minTickets <= data.maxTickets, {
  message: 'Minimum tickets cannot exceed maximum tickets',
  path: ['minTickets'],
})

export const eventSessionSchema = z.object({
  // A calendar day plus a text time keeps sessions correct across DST changes.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM').optional().or(z.literal('')),
  label: z.string().trim().max(80).optional().or(z.literal('')),
})

export const paypalSettingsSchema = z.object({
  enabled: z.boolean(),
  environment: z.enum(['SANDBOX', 'LIVE']),
  sandboxClientId: z.string().trim().max(200).optional().or(z.literal('')),
  sandboxClientSecret: z.string().max(400).optional(),
  liveClientId: z.string().trim().max(200).optional().or(z.literal('')),
  liveClientSecret: z.string().max(400).optional(),
  webhookIdSandbox: z.string().trim().max(200).optional().or(z.literal('')),
  webhookIdLive: z.string().trim().max(200).optional().or(z.literal('')),
  currency: z.enum(SUPPORTED_CURRENCIES as unknown as [string, ...string[]]),
})

export const smtpSettingsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().max(200).optional().or(z.literal('')),
  port: z.coerce.number().int().min(1).max(65_535),
  encryption: z.enum(['NONE', 'TLS', 'STARTTLS']),
  username: z.string().trim().max(200).optional().or(z.literal('')),
  password: z.string().max(400).optional(),
  senderName: z.string().trim().max(120).optional().or(z.literal('')),
  senderEmail: z.string().trim().max(200).optional().or(z.literal('')),
  replyToEmail: z.string().trim().max(200).optional().or(z.literal('')),
  allowSelfSigned: z.boolean(),
  pool: z.boolean(),
}).refine((data) => !data.enabled || (data.host && data.senderEmail), {
  message: 'Host and sender email are required when email delivery is enabled',
  path: ['host'],
})

export const generalSettingsSchema = z.object({
  storeName: z.string().trim().min(1).max(120),
  supportEmail: z.email('Enter a valid support email'),
  supportPhone: z.string().trim().max(60).optional().or(z.literal('')),
  storeAddress: z.string().trim().max(400).optional().or(z.literal('')),
  timezone: z.string().trim().min(1).max(60),
  defaultCurrency: z.enum(SUPPORTED_CURRENCIES as unknown as [string, ...string[]]),
  taxRateBps: z.coerce.number().int().min(0).max(10_000),
  taxLabel: z.string().trim().max(40),
  receiptPrefix: z.string().trim().regex(/^[A-Z0-9]{1,8}$/i, '1-8 letters or digits'),
  reservationMinutes: z.coerce.number().int().min(1).max(720),
  maxTicketsPerOrder: z.coerce.number().int().min(1).max(500),
  requirePhone: z.boolean(),
  billingRequired: z.boolean(),
  maintenanceMode: z.boolean(),
  emailBrandingName: z.string().trim().max(120).optional().or(z.literal('')),
  privacyUrl: z.string().trim().max(191).optional().or(z.literal('')),
  termsUrl: z.string().trim().max(191).optional().or(z.literal('')),
  privacyPolicy: z.string().max(50_000).optional().or(z.literal('')),
  termsAndConditions: z.string().max(50_000).optional().or(z.literal('')),
})

export const refundSchema = z.object({
  amountMinor: z.coerce.number().int().min(1),
  reason: z.string().trim().max(300).optional().or(z.literal('')),
})

export const orderNoteSchema = z.object({
  notes: z.string().max(4000),
})

export const adminUserSchema = z.object({
  email: z.email(),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(12, 'Use at least 12 characters').max(200),
  role: z.enum(['ADMIN', 'SUPER_ADMIN']),
})

export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>
export type ProductInput = z.infer<typeof productSchema>
export type GeneralSettingsInput = z.infer<typeof generalSettingsSchema>

/** Flattens a Zod error into field -> message for form rendering. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'form'
    if (!out[key]) out[key] = issue.message
  }
  return out
}
