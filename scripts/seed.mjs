#!/usr/bin/env node
/**
 * Idempotent bootstrap for a fresh Badi Palace Museum database.
 *
 * What it does
 *   - creates the singleton settings rows (general / PayPal / SMTP)
 *   - writes the museum defaults (prices, capacity, cutoff, booking window)
 *   - creates the first administrator from INITIAL_ADMIN_EMAIL + INITIAL_ADMIN_PASSWORD
 *   - optionally creates a few clearly-labelled demo bookings when SEED_DEMO=1
 *
 * Demo bookings exist only to exercise the dashboard, calendar and check-in screens
 * before PayPal is connected. They are never created in production by default.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import process from 'node:process'
import dotenv from 'dotenv'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const root = process.cwd()
for (const file of ['.env', '.env.local']) {
  const full = path.join(root, file)
  if (fs.existsSync(full)) dotenv.config({ path: full, override: file === '.env.local', quiet: true })
}

const BCRYPT_ROUNDS = 12
const MIN_PASSWORD_LENGTH = 12
const REFUSED_PASSWORDS = new Set([
  'password',
  'password123',
  'changeme',
  'changeme123',
  'admin',
  'admin123',
  'letmein123',
  'qwertyuiop',
  '123456789012',
])

const MUSEUM_DEFAULTS = {
  museum_name: 'Badi Palace Museum',
  museum_tagline: 'A Saadian masterpiece in the heart of Marrakech.',
  museum_address: 'Kssibat Nohas, Marrakech 40000, Morocco',
  museum_support_email: 'tickets@visitbadipalace.com',
  museum_support_phone: '+212 5 24 38 95 64',
  museum_timezone: 'Africa/Casablanca',
  museum_currency: 'EUR',
  adult_price_cents: '1299',
  child_price_cents: '699',
  daily_capacity: '0',
  same_day_cutoff: '14:00',
  booking_window_days: '180',
  max_adults_per_order: '20',
  max_children_per_order: '20',
  official_partner: 'false',
}

function bail(message) {
  console.error(`\n  ✖ ${message}\n`)
  process.exit(1)
}

function log(message) {
  console.log(`  • ${message}`)
}

if (!process.env.DATABASE_URL) bail('DATABASE_URL is not set. Copy .env.example to .env first.')
if (!process.env.DATABASE_URL.startsWith('postgres://') && !process.env.DATABASE_URL.startsWith('postgresql://')) {
  bail('DATABASE_URL must be a PostgreSQL connection string (postgresql://user:pass@host:5432/database).')
}

const prisma = new PrismaClient({ log: ['error'] })

async function seedSettings() {
  await prisma.generalSettings.upsert({
    where: { key: 'singleton' },
    create: {
      key: 'singleton',
      storeName: 'Badi Palace Museum',
      supportEmail: 'tickets@visitbadipalace.com',
      supportPhone: '+212 5 24 38 95 64',
      storeAddress: 'Kssibat Nohas, Marrakech 40000, Morocco',
      timezone: 'Africa/Casablanca',
      defaultCurrency: 'EUR',
      taxRateBps: 0,
      taxLabel: 'VAT',
      receiptPrefix: 'BVP',
      requirePhone: true,
      emailBrandingName: 'Badi Palace Museum',
    },
    update: {},
  })
  await prisma.payPalSettings.upsert({ where: { key: 'singleton' }, create: { key: 'singleton' }, update: {} })
  await prisma.smtpSettings.upsert({ where: { key: 'singleton' }, create: { key: 'singleton' }, update: {} })

  for (const [key, value] of Object.entries(MUSEUM_DEFAULTS)) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value, updatedBy: 'seed' },
      update: {},
    })
  }
  log('Settings ready (general / PayPal / SMTP / museum defaults).')
}

async function seedAdmin() {
  const existing = await prisma.adminUser.count()
  if (existing > 0) {
    log(`Skipping administrator bootstrap — ${existing} account(s) already exist.`)
    return
  }

  const email = (process.env.INITIAL_ADMIN_EMAIL ?? '').trim().toLowerCase()
  const password = process.env.INITIAL_ADMIN_PASSWORD ?? ''

  if (!email || !password) {
    bail(
      'No administrator exists. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD in .env and run the seed again.\n' +
        '    The platform deliberately ships without default production credentials.',
    )
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bail('INITIAL_ADMIN_EMAIL is not a valid email address.')
  if (password.length < MIN_PASSWORD_LENGTH) bail(`INITIAL_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  if (REFUSED_PASSWORDS.has(password.toLowerCase())) bail('INITIAL_ADMIN_PASSWORD is a well-known weak password.')

  const name = (process.env.INITIAL_ADMIN_NAME ?? '').trim() || 'Administrator'
  await prisma.adminUser.create({
    data: {
      email,
      name,
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      role: 'SUPER_ADMIN',
      isActive: true,
    },
  })
  log(`Created administrator ${email}. Sign in at /admin/login and change the password from Profile.`)
}

function utcMidnight(daysFromNow) {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysFromNow))
}

/**
 * Optional sample bookings. They are marked DEMO in the internal notes and are only
 * generated on an empty database when SEED_DEMO=1, so real revenue is never mixed in.
 */
async function seedDemoBookings() {
  if (process.env.SEED_DEMO !== '1') {
    log('Demo bookings skipped (set SEED_DEMO=1 to create sample bookings).')
    return
  }
  if ((await prisma.order.count({ where: { kind: 'MUSEUM' } })) > 0) {
    log('Demo bookings skipped — museum orders already exist.')
    return
  }

  const adult = Number.parseInt(MUSEUM_DEFAULTS.adult_price_cents, 10)
  const child = Number.parseInt(MUSEUM_DEFAULTS.child_price_cents, 10)
  const customer = await prisma.customer.upsert({
    where: { emailNormalized: 'demo@visitbadipalace.com' },
    create: {
      emailNormalized: 'demo@visitbadipalace.com',
      emailOriginal: 'demo@visitbadipalace.com',
      fullName: 'Demo Visitor',
      phone: '+212 600 000000',
    },
    update: {},
  })

  const samples = [
    { days: 0, adults: 2, children: 1, name: 'Demo Visitor' },
    { days: 1, adults: 1, children: 0, name: 'Demo Visitor' },
    { days: 4, adults: 2, children: 2, name: 'Demo Family' },
  ]

  for (const [index, sample] of samples.entries()) {
    const visitDate = utcMidnight(sample.days)
    const total = sample.adults * adult + sample.children * child
    await prisma.order.create({
      data: {
        publicId: crypto.randomBytes(16).toString('hex'),
        reference: `BVP-DEMO-${String(index + 1).padStart(4, '0')}`,
        kind: 'MUSEUM',
        customerId: customer.id,
        customerEmail: 'demo@visitbadipalace.com',
        customerName: sample.name,
        customerPhone: '+212 600 000000',
        currency: 'EUR',
        subtotalMinor: total,
        taxMinor: 0,
        totalMinor: total,
        status: 'PAID',
        deliveryStatus: 'NOT_REQUIRED',
        paymentEnvironment: 'SANDBOX',
        visitDate,
        adultQty: sample.adults,
        childQty: sample.children,
        paidAt: new Date(),
        sessionSummary: `Demo booking · ${sample.adults} adult · ${sample.children} child`,
        internalNotes: 'DEMO booking created by the seed script. Safe to delete.',
      },
    })
  }

  log(`Demo bookings created: ${samples.length} paid museum orders for ${samples.reduce((sum, s) => sum + s.adults + s.children, 0)} tickets.`)
}

async function main() {
  await seedSettings()
  await seedAdmin()
  await seedDemoBookings()
  console.log('\n  Seed complete.\n')
}

main()
  .catch((error) => {
    console.error('\n  ✖ Seed failed:', error instanceof Error ? error.message : error, '\n')
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
