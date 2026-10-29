'use client'

import { useState } from 'react'
import { Copy, KeyRound, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field } from '@/components/shared/field'
import { SectionCard } from '@/components/admin/page-primitives'
import { api } from '@/lib/api/client'

type AdminRole = 'SUPER_ADMIN' | 'ADMIN'

export type AdminRow = {
  id: string
  email: string
  name: string
  role: AdminRole
  isActive: boolean
  lastLoginAt: string | null
  passwordChanged: string
  createdAt: string
  updatedAt: string
}

type OneTimePassword = {
  email: string
  password: string
  context: 'created' | 'reset'
}

const ROLE_ITEMS = [
  { value: 'SUPER_ADMIN', label: 'Super admin' },
  { value: 'ADMIN', label: 'Admin' },
]

function formatStamp(value: string | null): string {
  if (!value) return 'Never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function RoleControl({
  row,
  pending,
  lockDemote,
  onSave,
}: {
  row: AdminRow
  pending: boolean
  lockDemote: boolean
  onSave: (role: AdminRole) => void
}) {
  const [role, setRole] = useState<AdminRole>(row.role)

  const demoteBlocked = lockDemote && row.role === 'SUPER_ADMIN' && role === 'ADMIN'

  return (
    <div className="flex items-center gap-2">
      <Select
        items={ROLE_ITEMS}
        value={role}
        onValueChange={(value) => setRole((value ?? 'ADMIN') as AdminRole)}
        disabled={pending}
      >
        <SelectTrigger size="sm" className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLE_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending || role === row.role || demoteBlocked}
        title={demoteBlocked ? 'At least one active super admin must remain.' : undefined}
        onClick={() => onSave(role)}
      >
        Save
      </Button>
    </div>
  )
}

export function UserManager({ initialAdmins, currentAdminId }: { initialAdmins: AdminRow[]; currentAdminId: string }) {
  const [admins, setAdmins] = useState(initialAdmins)
  const [createForm, setCreateForm] = useState<{ email: string; name: string; role: AdminRole; password: string }>({
    email: '',
    name: '',
    role: 'ADMIN',
    password: '',
  })
  const [createFields, setCreateFields] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)
  const [rowPending, setRowPending] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [oneTime, setOneTime] = useState<OneTimePassword | null>(null)

  const activeSuperAdmins = admins.filter((admin) => admin.role === 'SUPER_ADMIN' && admin.isActive)

  function isLastActiveSuperAdmin(row: AdminRow): boolean {
    return row.role === 'SUPER_ADMIN' && row.isActive && activeSuperAdmins.length <= 1
  }

  async function createAdmin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (creating) return

    setCreating(true)
    setCreateFields({})
    setActionError(null)

    const body: Record<string, unknown> = {
      email: createForm.email,
      name: createForm.name,
      role: createForm.role,
    }
    if (createForm.password) body.password = createForm.password

    const result = await api<{ admin: AdminRow; temporaryPassword: string }>('/api/admin/users', {
      method: 'POST',
      body,
    })

    if (!result.ok) {
      setActionError(result.error)
      setCreateFields(result.fields ?? {})
      toast.error(result.error)
      setCreating(false)
      return
    }

    setAdmins((current) => [...current, result.data.admin])
    setOneTime({ email: result.data.admin.email, password: result.data.temporaryPassword, context: 'created' })
    setCreateForm({ email: '', name: '', role: 'ADMIN', password: '' })
    toast.success('Administrator created.')
    setCreating(false)
  }

  async function patchAdmin(id: string, body: Record<string, unknown>, successMessage: string) {
    if (rowPending) return
    setRowPending(id)
    setActionError(null)

    const result = await api<{ admin: AdminRow; temporaryPassword?: string }>(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body,
    })

    if (!result.ok) {
      setActionError(result.error)
      toast.error(result.error)
      setRowPending(null)
      return
    }

    setAdmins((current) => current.map((admin) => (admin.id === result.data.admin.id ? result.data.admin : admin)))
    if (result.data.temporaryPassword) {
      setOneTime({ email: result.data.admin.email, password: result.data.temporaryPassword, context: 'reset' })
    }
    toast.success(successMessage)
    setRowPending(null)
  }

  async function copyPassword() {
    if (!oneTime) return
    try {
      await navigator.clipboard.writeText(oneTime.password)
      toast.success('Temporary password copied.')
    } catch {
      toast.error('Could not copy the password. Select it manually.')
    }
  }

  return (
    <div className="grid gap-6">
      {oneTime ? (
        <Alert>
          <KeyRound />
          <AlertTitle>
            {oneTime.context === 'created' ? 'Administrator created' : 'Password reset'} for {oneTime.email}
          </AlertTitle>
          <AlertDescription>
            <p>This temporary password is shown once and cannot be retrieved later. Share it over a secure channel.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="rounded-md border bg-muted px-2 py-1 font-mono text-sm text-foreground">{oneTime.password}</code>
              <Button type="button" size="sm" variant="outline" onClick={copyPassword}>
                <Copy />
                Copy
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setOneTime(null)}>
                Dismiss
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <SectionCard title="Add an administrator" description="A temporary password is generated when the field is left blank.">
        <form onSubmit={createAdmin} noValidate className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name" htmlFor="adminName" error={createFields.name} required>
              <Input
                id="adminName"
                value={createForm.name}
                onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                autoComplete="off"
              />
            </Field>
            <Field label="Email" htmlFor="adminEmail" error={createFields.email} required>
              <Input
                id="adminEmail"
                type="email"
                value={createForm.email}
                onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))}
                autoComplete="off"
              />
            </Field>
            <Field label="Role" error={createFields.role} required>
              <Select
                items={ROLE_ITEMS}
                value={createForm.role}
                onValueChange={(value) =>
                  setCreateForm((current) => ({ ...current, role: (value ?? 'ADMIN') as AdminRole }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Temporary password"
              htmlFor="adminPassword"
              error={createFields.password}
              hint="Minimum 12 characters. Leave blank to generate a 16-character password."
            >
              <Input
                id="adminPassword"
                type="password"
                autoComplete="new-password"
                value={createForm.password}
                onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))}
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={creating}>
              <UserPlus />
              {creating ? 'Creating...' : 'Create administrator'}
            </Button>
          </div>
        </form>
      </SectionCard>

      <SectionCard title="Administrators" description={`${admins.length} account${admins.length === 1 ? '' : 's'}`}>
        <div className="grid gap-3">
          {actionError ? (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Administrator</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {admins.map((row) => {
                const pending = rowPending === row.id
                const isSelf = row.id === currentAdminId
                const lastSuperAdmin = isLastActiveSuperAdmin(row)
                const cannotDeactivate = row.isActive && (isSelf || lastSuperAdmin)

                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="grid gap-0.5">
                        <span className="font-medium">
                          {row.name}
                          {isSelf ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
                        </span>
                        <span className="text-xs text-muted-foreground">{row.email}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <RoleControl
                        key={`${row.id}-${row.role}`}
                        row={row}
                        pending={pending}
                        lockDemote={lastSuperAdmin}
                        onSave={(role) => patchAdmin(row.id, { action: 'role', role }, 'Role updated.')}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.isActive ? 'default' : 'outline'}>
                        {row.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatStamp(row.lastLoginAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending || cannotDeactivate}
                          title={
                            cannotDeactivate
                              ? isSelf
                                ? 'You cannot deactivate your own account.'
                                : 'At least one active super admin must remain.'
                              : undefined
                          }
                          onClick={() =>
                            patchAdmin(
                              row.id,
                              { action: 'toggle', isActive: !row.isActive },
                              row.isActive ? 'Administrator deactivated.' : 'Administrator activated.',
                            )
                          }
                        >
                          {row.isActive ? 'Deactivate' : 'Activate'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending || isSelf}
                          title={isSelf ? 'Change your own password from your profile.' : undefined}
                          onClick={() => patchAdmin(row.id, { action: 'reset-password' }, 'Password reset.')}
                        >
                          Reset password
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  )
}
