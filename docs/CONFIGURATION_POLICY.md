# Configuration policy

Tixora resolves runtime configuration from two places, in this order:

1. **Database settings** saved through `/admin/settings/*`. These win.
2. **Environment variables** (see `.env.example`). These are bootstrap defaults and
   fallbacks used only when the corresponding database value is unset.

## Why both

The store owner must be able to rotate a PayPal secret or an SMTP password without a
redeploy or a shell session on the server. Environment variables remain useful for
first boot, for staging where the UI should not be touched, and as a recovery path if a
stored secret becomes unreadable (for example after the encryption key changed).

## Secrets

- Credentials written through the admin UI (PayPal client secrets, webhook ids are not
  secret but SMTP passwords are) are encrypted with AES-256-GCM before they are stored.
  The key is `SMTP_ENCRYPTION_KEY` (32 bytes, hex). Ciphertext carries a `v1:` version
  prefix so a future key rotation can support two keys at once.
- A secret is **never** returned by any API. The admin UI receives booleans such as
  `hasSandboxSecret` / `hasPassword` and a fixed mask (`••••••••`).
- An empty secret field in a form means "leave the stored value unchanged". Clearing a
  stored secret requires the explicit `clearSandboxSecret` / `clearLiveSecret` /
  `clearPassword` flag, so clearing can never happen by accident.
- Secrets are never written to logs or audit metadata. Audit entries record only whether
  a secret was updated (`secretUpdated: true`).
- If `SMTP_ENCRYPTION_KEY` is rotated without re-entering the secrets, decryption fails
  safely and the resolver falls back to the environment variables.

## Precedence table

| Setting                | Database field                        | Environment fallback                       |
| ---------------------- | ------------------------------------- | ------------------------------------------ |
| PayPal sandbox         | `PayPalSettings.sandboxClientId/Secret` | `PAYPAL_SANDBOX_CLIENT_ID/SECRET`        |
| PayPal live            | `PayPalSettings.liveClientId/Secret`    | `PAYPAL_LIVE_CLIENT_ID/SECRET`           |
| PayPal webhook id      | `PayPalSettings.webhookIdSandbox/Live`  | `PAYPAL_WEBHOOK_ID_SANDBOX/LIVE`         |
| SMTP transport         | `SmtpSettings.*`                        | none — SMTP is configured in the UI only |
| Store identity, taxes  | `GeneralSettings.*`                     | none                                       |
| Storage location       | n/a (not editable in the UI)            | `STORAGE_*`                                |

Storage is deliberately environment-only: relocating ticket files is an infrastructure
change that should go through deployment review, not a form.

## Boot-time validation

`src/lib/config/env.ts` validates the environment once at startup and refuses to boot on
a missing or malformed value, so a misconfigured deployment fails immediately instead of
at the first payment. `DATABASE_URL`, `AUTH_SECRET`, `SMTP_ENCRYPTION_KEY` and
`CRON_SECRET` are required in every environment.

## Changing the encryption key

1. Keep the old key available and re-enter both PayPal secrets and the SMTP password in
   the admin UI (saving re-encrypts with the new key).
2. Only then remove the old key from the environment.
3. Record the rotation in `AuditLog` by updating each setting — the save itself is audited.
