# Engage — Chatwoot Community Edition Setup

Engage is an SSO integration to an upstream Chatwoot Community Edition instance. Chatwoot owns inbox storage, channels, conversations, realtime updates and agent operations; Postiz owns the user's login and active organization.

## 1. Deploy Chatwoot separately

Follow the current Chatwoot self-hosted deployment guide:
https://developers.chatwoot.com/self-hosted/deployment/docker

Use a public HTTPS origin, persistent storage, Postgres and Redis. Do not expose its database or Redis ports to the public internet. The Chatwoot app's configured public URL must match `CHATWOOT_BASE_URL`.

This is intentionally a separate service. Do not add a second Postgres/Redis stack inside Postiz's database or reuse Postiz's database for Chatwoot.

## 2. Create a Chatwoot Platform App

Create a Platform App in the self-hosted Chatwoot installation and copy its Platform API access token. This is not a regular account user's access token.

The Platform API uses the `api_access_token` request header for:
- `POST /platform/api/v1/accounts`
- `POST /platform/api/v1/users`
- `POST /platform/api/v1/accounts/{account_id}/account_users`
- `GET /platform/api/v1/users/{user_id}/login`

Chatwoot restricts Platform App access to resources provisioned/authorized for that Platform App. The Postiz integration creates and stores its own account/user mappings.

## 3. Configure Postiz backend

Add these variables to the Postiz backend environment:

```env
CHATWOOT_BASE_URL=https://inbox.example.com
CHATWOOT_PLATFORM_API_TOKEN=<your-platform-app-token>
```

Restart the backend after setting them. Never use a `NEXT_PUBLIC_` prefix for the token.

## 4. Apply schema and deploy the Postiz branch

```bash
pnpm run prisma-generate
pnpm run prisma-db-push
pnpm run build:backend
pnpm run build:frontend
```

The new Prisma mappings are:
- `ChatwootAccountMapping`: one Chatwoot account per Postiz organization.
- `ChatwootUserMapping`: one Chatwoot user per Postiz user.

## 5. Verify the first launch

Open **Engage** from the Postiz sidebar:
- Without environment variables, the page should show setup guidance and disable the launch button.
- With a working Chatwoot Platform App token, the first launch provisions account/user/membership and redirects via Chatwoot SSO.
- Subsequent launches reuse the mappings.
- Each organization gets a separate Chatwoot account; users are added only to the account for the active Postiz organization.
- Chatwoot user identities are global within the Chatwoot instance, consistent with Chatwoot's own account membership model.

A Chatwoot user email already provisioned outside this Platform App may not be claimable by it. Resolve that identity with the Chatwoot administrator instead of silently attaching an unrelated user.

## Current limitations

- The first slice launches the Chatwoot inbox; it does not yet mirror Chatwoot conversations inside a native Postiz React inbox.
- Native post comments and replies still depend on each social network's API scopes and are not automatically imported into Chatwoot.
- Channel connections (WhatsApp, Instagram, Facebook Messenger, etc.) must be configured in Chatwoot and remain subject to each network's provider rules.
