import { z } from 'zod'

/**
 * Boot-time environment. Values here are *defaults and fallbacks*; the admin
 * settings screens can override payment/SMTP credentials at runtime. See
 * docs/CONFIGURATION_POLICY.md.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  SMTP_ENCRYPTION_KEY: z
    .string()
    .min(64, 'SMTP_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
    .regex(/^[0-9a-fA-F]+$/, 'SMTP_ENCRYPTION_KEY must be hex'),
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters'),
  STORAGE_PROVIDER: z.enum(['LOCAL', 'S3']).default('LOCAL'),
  STORAGE_LOCAL_DIR: z.string().default('./storage/private'),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_REGION: z.string().optional(),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),
  STORAGE_ENDPOINT: z.string().optional(),
  PAYPAL_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_SANDBOX_CLIENT_ID: z.string().optional(),
  PAYPAL_SANDBOX_CLIENT_SECRET: z.string().optional(),
  PAYPAL_LIVE_CLIENT_ID: z.string().optional(),
  PAYPAL_LIVE_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID_SANDBOX: z.string().optional(),
  PAYPAL_WEBHOOK_ID_LIVE: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional(),
  MUSEUM_TIMEZONE: z.string().default('Africa/Casablanca'),
  MUSEUM_CURRENCY: z.string().default('EUR'),
  NEXTAUTH_SECRET: z.string().optional(),
  INITIAL_ADMIN_EMAIL: z.string().email().optional(),
  INITIAL_ADMIN_PASSWORD: z.string().min(12).optional(),
})

const source = { ...process.env }
// The app uses its own session layer, but deployments that already provision
// NEXTAUTH_SECRET can reuse the same random secret instead of inventing AUTH_SECRET.
if (!source.AUTH_SECRET && source.NEXTAUTH_SECRET) source.AUTH_SECRET = source.NEXTAUTH_SECRET

const parsed = schema.safeParse(source)

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n')
  throw new Error(`Invalid environment configuration:\n${details}\nCopy .env.example to .env and fill in the values.`)
}

export const env = parsed.data
export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
