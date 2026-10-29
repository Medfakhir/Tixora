'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { LockKeyhole } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/shared/field'
import { api } from '@/lib/api/client'

export function AdminLoginForm({ next }: { next: string }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    setFields({})

    const data = new FormData(event.currentTarget)
    const result = await api('/api/admin/session', {
      method: 'POST',
      body: { email: String(data.get('email') ?? ''), password: String(data.get('password') ?? '') },
    })

    if (!result.ok) {
      setError(result.error)
      setFields(result.fields ?? {})
      setPending(false)
      return
    }

    router.replace(next || '/admin')
    router.refresh()
  }

  return (
    <Card className="grid gap-4 p-6 shadow-sm">
      <form className="grid gap-4" onSubmit={onSubmit} noValidate>
        <Field label="Email address" htmlFor="email" error={fields.email} required>
          <Input id="email" name="email" type="email" autoComplete="username" required className="bg-background" />
        </Field>
        <Field label="Password" htmlFor="password" error={fields.password} required>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>

        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={pending} className="w-full">
          <LockKeyhole />
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Failed attempts are rate limited per IP address and lock the account after five invalid passwords.
      </p>
    </Card>
  )
}
