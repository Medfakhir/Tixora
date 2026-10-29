export class InventoryError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'InventoryError'
    this.code = code
    this.status = status
  }
}

export class InsufficientInventoryError extends InventoryError {
  requested: number
  available: number
  constructor(requested: number, available: number) {
    super('INSUFFICIENT_INVENTORY', `Only ${available} ticket(s) are available for the selected session; ${requested} were requested`, 409)
    this.requested = requested
    this.available = available
  }
}

export class ReservationExpiredError extends InventoryError {
  constructor() {
    super('RESERVATION_EXPIRED', 'This booking hold has expired. Please start checkout again.', 410)
  }
}

export class ReservationMismatchError extends InventoryError {
  constructor() {
    super('RESERVATION_MISMATCH', 'The reservation does not match this order.', 400)
  }
}

export class ProductUnavailableError extends InventoryError {
  constructor(reason: string) {
    super('PRODUCT_UNAVAILABLE', reason, 409)
  }
}
