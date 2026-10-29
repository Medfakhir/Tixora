import QRCode from 'qrcode'

/**
 * The QR payload is the order's random public id. It contains no personal data and
 * cannot be used to reach any page other than the holder's own booking status.
 */
export function qrPayload(order: { publicId: string }): string {
  return order.publicId
}

export async function qrDataUrl(order: { publicId: string }): Promise<string> {
  return QRCode.toDataURL(qrPayload(order), {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 480,
    color: { dark: '#1c1917', light: '#ffffff' },
  })
}

export async function qrPng(order: { publicId: string }): Promise<Buffer> {
  return QRCode.toBuffer(qrPayload(order), {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 640,
    color: { dark: '#1c1917', light: '#ffffff' },
  })
}
