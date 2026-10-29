'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { LockKeyhole } from 'lucide-react'
import { api } from '@/lib/api/client'
import { formatMoney } from '@/lib/money'
import { Field } from '@/components/shared/field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type CheckoutResponse = {
  publicId: string | null
  reference: string | null
  totalMinor: number
  currency: string
  productName: string
  reservationExpiresAt: string
}

type CreateOrderResponse = {
  alreadyPaid: boolean
  approvalUrl: string | null
  paypalOrderId: string | null
}

type FormValues = {
  fullName: string
  email: string
  phone: string
}

const FIELD_KEYS = ['fullName', 'email', 'phone'] as const

export function CheckoutForm({
  slug,
  eventSessionId,
  quantity,
  requirePhone,
  totalMinor,
  currency,
}: {
  slug: string
  eventSessionId: string | null
  quantity: number
  requirePhone: boolean
  totalMinor: number
  currency: string
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const schema = useMemo(
    () =>
      z
        .object({
          fullName: z.string().trim().min(2, 'Enter your full name').max(120, 'Use 120 characters or fewer'),
          email: z.email('Enter a valid email address').max(200),
          phone: z.string().trim().max(40, 'Use 40 characters or fewer'),
        })
        .superRefine((values, context) => {
          if (requirePhone && values.phone.length < 5) {
            context.addIssue({
              code: 'custom',
              path: ['phone'],
              message: 'A phone number is required for this purchase.',
            })
          }
        }),
    [requirePhone],
  )

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { fullName: '', email: '', phone: '' },
    mode: 'onSubmit',
  })

  const onSubmit = handleSubmit(async (values) => {
    if (pending) return
    setPending(true)
    setFormError(null)
    clearErrors()

    const checkout = await api<CheckoutResponse>('/api/checkout', {
      method: 'POST',
      body: {
        slug,
        eventSessionId,
        quantity,
        fullName: values.fullName,
        email: values.email,
        phone: values.phone.trim() || undefined,
      },
    })

    if (!checkout.ok) {
      setFormError(checkout.error)
      for (const key of FIELD_KEYS) {
        const message = checkout.fields?.[key]
        if (message) setError(key, { type: 'server', message })
      }
      setPending(false)
      return
    }

    const publicId = checkout.data.publicId
    if (!publicId) {
      setFormError('The order could not be created. Please try again.')
      setPending(false)
      return
    }

    const payment = await api<CreateOrderResponse>('/api/paypal/create-order', {
      method: 'POST',
      body: { publicId },
    })

    if (!payment.ok) {
      setFormError(payment.error)
      setPending(false)
      return
    }

    if (payment.data.alreadyPaid) {
      router.push(`/checkout/success?order=${encodeURIComponent(publicId)}`)
      return
    }

    if (!payment.data.approvalUrl) {
      setFormError('PayPal did not return an approval link. Please try again.')
      setPending(false)
      return
    }

    window.location.assign(payment.data.approvalUrl)
  })

  return (
    <Card className="p-6">
      <CardHeader className="px-0 pt-0">
        <CardTitle>Your details</CardTitle>
        <CardDescription>These details are used to deliver your tickets.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <form onSubmit={onSubmit} noValidate>
          <fieldset className="grid gap-4" disabled={pending}>
            <Field label="Full name" htmlFor="fullName" error={errors.fullName?.message} required>
              <Input
                id="fullName"
                autoComplete="name"
                aria-invalid={Boolean(errors.fullName)}
                {...register('fullName')}
              />
            </Field>
            <Field
              label="Email address"
              htmlFor="email"
              error={errors.email?.message}
              hint="We email your tickets to this address."
              required
            >
              <Input
                id="email"
                type="email"
                autoComplete="email"
                aria-invalid={Boolean(errors.email)}
                {...register('email')}
              />
            </Field>
            <Field
              label="Phone"
              htmlFor="phone"
              error={errors.phone?.message}
              hint={requirePhone ? undefined : 'Optional, used only if we need to reach you about this order.'}
              required={requirePhone}
            >
              <Input
                id="phone"
                type="tel"
                autoComplete="tel"
                aria-invalid={Boolean(errors.phone)}
                {...register('phone')}
              />
            </Field>

            {formError ? (
              <Alert variant="destructive">
                <AlertTitle>We could not start your payment</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}

            <Button type="submit" size="lg" className="mt-2 w-full" disabled={pending}>
              <LockKeyhole />
              {pending ? 'Redirecting to PayPal…' : `Pay ${formatMoney(totalMinor, currency)} with PayPal`}
            </Button>
          </fieldset>
        </form>
        <p className="mt-3 text-xs text-muted-foreground">
          You will be redirected to PayPal to complete payment. Your tickets are emailed only after PayPal confirms the
          payment.
        </p>
      </CardContent>
    </Card>
  )
}
