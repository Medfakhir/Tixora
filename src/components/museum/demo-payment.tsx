'use client'

import { useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { api } from '@/lib/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { createTranslator, type Locale } from '@/lib/i18n/messages'

type DemoCompleteResponse = {
  status: string
  reference: string
  publicId: string
  alreadyPaid: boolean
  queued: boolean
}

/**
 * Rendered only when the deployment set DEMO_PAYMENTS=true. It calls our own endpoint
 * to mark the order paid so the rest of the flow (success page, QR email) runs for real.
 */
export function DemoPayment({
  publicId,
  locale,
  onSuccess,
}: {
  publicId: string
  locale: Locale
  onSuccess: () => void
}) {
  const t = createTranslator(locale)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  return (
    <div className="grid gap-3 rounded-xl border border-dashed border-amber-300 bg-amber-50/60 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t('errors.payment')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button
        type="button"
        size="lg"
        variant="secondary"
        className="w-full"
        disabled={working}
        onClick={async () => {
          setWorking(true)
          setError(null)
          const result = await api<DemoCompleteResponse>('/api/demo/complete-payment', {
            method: 'POST',
            body: { publicId },
          })
          setWorking(false)
          if (!result.ok) {
            setError(result.error)
            return
          }
          onSuccess()
        }}
      >
        <FlaskConical data-icon="inline-start" />
        {working ? t('demo.working') : t('actions.demoPay')}
      </Button>

      <p className="text-xs leading-relaxed text-muted-foreground">{t('demo.note')}</p>
    </div>
  )
}
