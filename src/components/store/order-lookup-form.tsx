'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Search } from 'lucide-react'
import { api } from '@/lib/api/client'
import { Field } from '@/components/shared/field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

const lookupSchema = z.object({
  reference: z.string().trim().min(4, 'Enter your order reference').max(40, 'Use 40 characters or fewer'),
  email: z.email('Enter a valid email address').max(200),
})

type FormValues = {
  reference: string
  email: string
}

export function OrderLookupForm() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(lookupSchema),
    defaultValues: { reference: '', email: '' },
    mode: 'onSubmit',
  })

  const onSubmit = handleSubmit(async (values) => {
    if (pending) return
    setPending(true)
    setFormError(null)
    clearErrors()

    const result = await api<{ publicId: string }>('/api/orders/lookup', {
      method: 'POST',
      body: { reference: values.reference, email: values.email },
    })

    if (!result.ok) {
      setFormError(
        result.status === 429
          ? 'Too many lookup attempts. Please wait a few minutes before trying again.'
          : result.error,
      )
      const fields = result.fields ?? {}
      if (fields.reference) setError('reference', { type: 'server', message: fields.reference })
      if (fields.email) setError('email', { type: 'server', message: fields.email })
      setPending(false)
      return
    }

    router.push(`/order/${encodeURIComponent(result.data.publicId)}`)
  })

  return (
    <Card className="p-6">
      <CardHeader className="px-0 pt-0">
        <CardTitle>Find your order</CardTitle>
        <CardDescription>
          Enter the order reference from your receipt and the email address you used at checkout.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <form onSubmit={onSubmit} noValidate>
          <fieldset className="grid gap-4" disabled={pending}>
            <Field label="Order reference" htmlFor="reference" error={errors.reference?.message} required>
              <Input
                id="reference"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="font-mono"
                aria-invalid={Boolean(errors.reference)}
                {...register('reference')}
              />
            </Field>
            <Field label="Email address" htmlFor="email" error={errors.email?.message} required>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                aria-invalid={Boolean(errors.email)}
                {...register('email')}
              />
            </Field>

            {formError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not look up the order</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}

            <Button type="submit" className="mt-2 w-full" disabled={pending}>
              <Search />
              {pending ? 'Searching…' : 'Find my order'}
            </Button>
          </fieldset>
        </form>
        <p className="mt-3 text-xs text-muted-foreground">
          The reference and email must match the order exactly. For privacy, we do not reveal which of the two was
          incorrect.
        </p>
      </CardContent>
    </Card>
  )
}
