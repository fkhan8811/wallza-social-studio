# WallzaOS ↔ Postiz Social Studio: Auth and Sync Runbook

This runbook covers the Postiz-side bridge added for WallzaOS tenant sign-in, provider connection handoff, account synchronization and retry recovery.

## Required environment

Configure these variables on the **Postiz backend**:

| Variable | Required | Purpose |
| --- | --- | --- |
| `FRONTEND_URL` | Yes | Exact public Postiz frontend origin. SSO accepts only this origin with the `/auth/sso` callback path. |
| `WALLZAOS_INTERNAL_SECRET` | Yes in production | Shared HMAC secret used by Postiz and WallzaOS. Use a unique random value of at least 32 characters. `WALLZA_INTERNAL_SECRET` is accepted as a compatibility alias. |
| `WALLZAOS_INTERNAL_API_URL` | Yes in production | Private base URL for the WallzaOS backend. Used for SSO ticket verification and OAuth callback sync. |
| `WALLZAOS_API_URL` | Optional fallback | SSO verification fallback when `WALLZAOS_INTERNAL_API_URL` is not set. |
| `WALLZA_BACKEND_URL` | Optional fallback | OAuth callback retry fallback when `WALLZAOS_INTERNAL_API_URL` is not set. |
| `WALLZAOS_DEFAULT_SUBSCRIPTION_TIER` | Optional | Tier assigned to newly provisioned Postiz tenants: `STANDARD`, `PRO`, `TEAM`, or `ULTIMATE`. Defaults to `PRO`. |
| `WALLZAOS_DEFAULT_CHANNELS` | Optional | Default channel allowance for newly provisioned tenants. Defaults to `50`. |
 
On the **WallzaOS backend**, also configure `SOCIAL_STUDIO_FRONTEND_URL` (or `POSTIZ_FRONTEND_URL`) to the exact public Postiz frontend base URL. This is used by `POST /api/social-studio/sso/start` to build the fixed `/auth/sso` callback. WallzaOS provides `POST /api/social-studio/sso/verify` (HMAC audience `wallzaos-api`) and `POST /api/social/accounts/sync-internal` (HMAC audience `wallzaos`). See `Whatsapp/docs/POSTIZ_SOCIAL_STUDIO_SSO_SYNC.md` for the WallzaOS deployment and migration steps.

The HMAC secret must be identical on both backend services. Do not use the development fallback or expose the value to browser/frontend variables. Redis and PostgreSQL must be available to the Postiz backend; Redis is used for HMAC nonce replay protection, OAuth state and the short-lived tenant lookup cache.

## Endpoints and flow

1. **SSO handoff** — WallzaOS redirects the browser to Postiz `/auth/sso` with a short-lived `code` and `state`. The browser calls Postiz `POST /auth/sso/exchange`; Postiz validates the exact callback URI and verifies the ticket server-to-server against WallzaOS `POST /api/social-studio/sso/verify` using HMAC audience `wallzaos-api`. Postiz resolves the tenant, finds or creates the local user, links the user to the tenant and sets the Postiz session cookies.
2. **Start provider connection** — After SSO, WallzaOS can return the user to `/launches?connect=<provider>`. Postiz consumes that one-shot parameter and starts the normal Postiz OAuth flow. Custom-field providers open their credential form. Custom credentials and state are placed in the URL fragment and removed from browser history before exchange.
3. **OAuth callback sync** — When the provider callback completes for a WallzaOS-mapped tenant, Postiz sends account metadata to WallzaOS `POST /api/social/accounts/sync-internal` using HMAC audience `wallzaos`.
4. **WallzaOS-initiated account sync** — WallzaOS can call Postiz `POST /integrations/sync-from-wallza` using HMAC audience `social-studio`. Each account mutation is guarded by a PostgreSQL generation fence. The generation decision and actual integration upsert/disconnect execute in the same serializable transaction.
5. **Retry recovery** — If the callback-to-WallzaOS request fails, Postiz queues account metadata in `OAuthCallbackRetry`. The queue deliberately does not store provider access tokens, refresh tokens or raw credentials. A backend worker polls every 15 seconds, claims rows using PostgreSQL `FOR UPDATE SKIP LOCKED`, applies bounded exponential backoff (maximum five attempts) and marks exhausted rows `dead`.

## Database change

The additive migration is:

`libraries/nestjs-libraries/src/database/prisma/migrations/20261115160000_wallza_oauth_bridge/migration.sql`

It adds the unique `Organization.wallzaOrgId` mapping, `SocialSyncGeneration`, and `OAuthCallbackRetry`. The existing Ideas, Campaigns, Reviews, Creative Studio, Activity Inbox, publishing queue, media-retention and social-lead-outbox schema/migrations are retained.

Before applying to a production database, take a backup and review the migration against the target schema. Apply it through the deployment's established Prisma migration process; do not run a schema-reset command against production. The Postiz development/CI schema validation uses Prisma `validate` and a disposable PostgreSQL database.

## Verification checklist

- [ ] Both services have the same strong HMAC secret configured.
- [ ] Postiz backend can reach the private WallzaOS backend URL.
- [ ] Postiz `FRONTEND_URL` exactly matches the browser origin used for the SSO callback.
- [ ] The additive migration is applied and Prisma Client is regenerated.
- [ ] WallzaOS SSO creates or reuses the expected tenant and links the authenticated user.
- [ ] `/launches?connect=facebook` (or another enabled provider identifier) starts the expected provider flow.
- [ ] A successful OAuth callback creates/updates the WallzaOS account record.
- [ ] A deliberately unavailable WallzaOS sync endpoint produces a pending retry; restoring the endpoint lets the worker complete it.
- [ ] Older generation upserts cannot overwrite newer disconnects/reconnects, and one-time tokens do not propagate across organizations.
- [ ] Review GitHub Actions for the `Build` workflow: Prisma validation, PostgreSQL release tests and the monorepo build must all complete successfully before deployment.

## Operational notes

- The tenant mapping cache is only a hint; Postiz validates cached organization IDs against PostgreSQL before using them.
- OAuth state and callback markers are short-lived in Redis; the durable retry queue is in PostgreSQL.
- Retry failure records are sanitized. Do not add provider credentials or raw provider responses to retry rows or logs.
- Provider publishing credentials remain owned by Postiz's existing encrypted Integration storage. The bridge transfers account metadata between products, not raw provider secrets.
