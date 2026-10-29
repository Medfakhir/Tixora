'use client'

import { useState } from 'react'
import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js'
import { api } from '@/lib/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { Locale } from '@/lib/i18n/messages'
import { createTranslator } from '@/lib/i18n/messages'

type CreateOrderResponse = {
  alreadyPaid: boolean
  approvalUrl: string | null
  paypalOrderId: string | null
}

const PAYPAL_LOCALES: Record<Locale, string> = { en: 'en_US', fr: 'fr_FR', es: 'es_ES' }

export function PaypalCheckout({
  publicId,
  clientId,
  currency,
  locale,
  onSuccess,
}: {
  publicId: string
  clientId: string
  currency: string
  locale: Locale
  onSuccess: () => void
}) {
  const t = createTranslator(locale)
  const [error, setError] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)

  return (
    <div className="grid gap-3">
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t('errors.payment')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {capturing ? <p className="text-sm text-muted-foreground">{t('success.pendingSubtitle')}</p> : null}

      <PayPalScriptProvider
        options={{
          clientId,
          currency,
          intent: 'capture',
          components: 'buttons',
          locale: PAYPAL_LOCALES[locale],
        }}
      >
        <PayPalButtons
          style={{ layout: 'vertical', shape: 'rect', label: 'paypal', height: 48 }}
          forceReRender={[publicId, currency]}
          createOrder={async () => {
            setError(null)
            const result = await api<CreateOrderResponse>('/api/paypal/create-order', {
              method: 'POST',
              body: { publicId },
            })
            if (!result.ok) {
              setError(result.error)
              throw new Error(result.error)
            }
            if (result.data.alreadyPaid) {
              onSuccess()
              throw new Error('ALREADY_PAID')
            }
            if (!result.data.paypalOrderId) {
              setError(t('errors.generic'))
              throw new Error('NO_PAYPAL_ORDER')
            }
            return result.data.paypalOrderId
          }}
          onApprove={async (data) => {
            if (!data.orderID) return
            setCapturing(true)
            setError(null)
            const result = await api('/api/paypal/capture-order', {
              method: 'POST',
              body: { publicId, paypalOrderId: data.orderID },
            })
            setCapturing(false)
            if (!result.ok) {
              setError(result.error)
              return
            }
            onSuccess()
          }}
          onCancel={() => setError(t('errors.payment'))}
          onError={(cause) => setError(cause instanceof Error ? cause.message : t('errors.payment'))}
        />
      </PayPalScriptProvider>

      <p className="text-xs leading-relaxed text-muted-foreground">{t('info.secure')}</p>
    </div>
  )
}
