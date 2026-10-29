import { getGeneral } from './service'
import { ApiError } from '@/lib/api/http'

/**
 * Maintenance mode blocks the public storefront only. Admins keep access so they can
 * turn it back on, and order-status lookups stay reachable because a customer who has
 * already paid must still be able to see their tickets.
 */
export async function isMaintenanceActive(): Promise<boolean> {
  const general = await getGeneral()
  return general.maintenanceMode
}

export async function assertStoreOpen(): Promise<void> {
  if (await isMaintenanceActive()) {
    throw new ApiError('The store is temporarily closed for maintenance. Please try again shortly.', 503, 'MAINTENANCE')
  }
}
