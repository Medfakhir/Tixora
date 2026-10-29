import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeEach } from 'vitest'

// Tests never run against the development database.
const url = process.env.DATABASE_URL_TEST
if (!url) {
  throw new Error('DATABASE_URL_TEST is not set. Point it at a disposable PostgreSQL database (e.g. kibir_test).')
}
if (!/test/i.test(url)) {
  throw new Error(`DATABASE_URL_TEST must reference a test database, got: ${url}`)
}
process.env.DATABASE_URL = url

export const testPrisma = new PrismaClient()

/** Removes every row a test could have created, children before the rows they reference. */
async function truncate() {
  await testPrisma.emailAttachment.deleteMany({})
  await testPrisma.emailDelivery.deleteMany({})
  await testPrisma.ticketInventory.deleteMany({})
  await testPrisma.reservation.deleteMany({})
  await testPrisma.orderLine.deleteMany({})
  await testPrisma.payment.deleteMany({})
  await testPrisma.refund.deleteMany({})
  await testPrisma.paymentWebhookEvent.deleteMany({})
  await testPrisma.order.deleteMany({})
  await testPrisma.closedDate.deleteMany({})
  await testPrisma.weeklyClosure.deleteMany({})
  await testPrisma.setting.deleteMany({})
  await testPrisma.customer.deleteMany({})
  await testPrisma.eventSession.deleteMany({})
  await testPrisma.productImage.deleteMany({})
  await testPrisma.product.deleteMany({})
  await testPrisma.category.deleteMany({})
  await testPrisma.auditLog.deleteMany({})
  await testPrisma.adminSession.deleteMany({})
  await testPrisma.adminUser.deleteMany({})
  await testPrisma.emailTemplate.deleteMany({})
  await testPrisma.deliveryJob.deleteMany({})
  await testPrisma.rateLimitBucket.deleteMany({})
}

beforeEach(async () => {
  await truncate()
})

afterAll(async () => {
  await truncate()
  await testPrisma.$disconnect()
})
