'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Field, FieldRow } from '@/components/shared/field'
import { SectionCard } from '@/components/admin/page-primitives'
import { api } from '@/lib/api/client'

export function ProfileForm({
  name,
  email,
  role,
}: {
  name: string
  email: string
  role: 'SUPER_ADMIN' | 'ADMIN'
}) {
  const router = useRouter()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return

    if (newPassword.length < 12) {
      setFieldErrors({ newPassword: 'Use at least 12 characters.' })
      return
    }
    if (newPassword !== confirmPassword) {
      setFieldErrors({ confirmPassword: 'The passwords do not match.' })
      return
    }
    if (newPassword === currentPassword) {
      setFieldErrors({ newPassword: 'Choose a password you have not used before.' })
      return
    }

    setPending(true)
    setFormError(null)
    setFieldErrors({})

    const result = await api('/api/admin/profile/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    })

    if (!result.ok) {
      setFormError(result.error)
      setFieldErrors(result.fields ?? {})
      toast.error(result.error)
      setPending(false)
      return
    }

    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    toast.success('Password changed. Other devices have been signed out.')
    setPending(false)
    router.refresh()
  }

  return (
    <div className="grid gap-6 lg:max-w-2xl">
      <SectionCard title="Account">
        <FieldRow label="Name" value={name} />
        <FieldRow label="Email" value={email} />
        <FieldRow label="Role" value={role === 'SUPER_ADMIN' ? 'Super admin' : 'Admin'} />
      </SectionCard>

      <SectionCard title="Change password" description="At least 12 characters. Other devices will be signed out.">
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          {formError ? (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <Field label="Current password" htmlFor="currentPassword" error={fieldErrors.currentPassword} required>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>
          <Field label="New password" htmlFor="newPassword" error={fieldErrors.newPassword} required>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          <Field label="Confirm new password" htmlFor="confirmPassword" error={fieldErrors.confirmPassword} required>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </Field>

          <div className="flex justify-end">
            <Button type="submit" disabled={pending}>
              <KeyRound />
              {pending ? 'Changing...' : 'Change password'}
            </Button>
          </div>
        </form>
      </SectionCard>
    </div>
  )
}
