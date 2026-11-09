# Wallza Social Studio — Postiz Feature Gap & Open-Source Reuse Audit

**Audit target:** `fkhan8811/wallza-social-studio`  
**Working branch:** `wallza/integrated-studio-foundation`  
**Approach:** extend the existing Postiz product and reuse mature projects; do not reimplement infrastructure that another maintained project already provides.

## What Postiz already does well — keep it

The inspected fork already has a substantial foundation:
- Social account connections and multi-network publishing.
- Calendar, scheduling, queues, recurring posts and the native composer.
- Connected-account and post analytics.
- Media uploads and a media library.
- AI agent workflows and AI-assisted image/video generation.
- Video clipping/transcription/caption workflows.
- Drafts, tags, content sets, post signatures and internal post comments.
- Organization membership, roles, authentication and billing.

These are not new build targets. New modules should call or extend the native Postiz services and preserve its organization scoping.

## Confirmed gaps and areas that are basic

| Area | Current Postiz fork | Upgrade direction | Reuse candidate |
|---|---|---|---|
| Social engagement inbox | No dedicated conversation inbox or DM management route; existing comments are post-review comments | Shared inbox for customer DMs/support; separately, a social-native feed for comments, mentions, reviews, assignments and replies | **Chatwoot** for DM/support; **OpenPost / BrightBean Studio** as social-native references |
| Social listening | No dedicated brand/keyword monitoring, sentiment feed or topic clustering | Brand/product keywords, mentions, sentiment, themes, source filters and alerts | **Harken** (after tenant isolation) |
| Content idea pipeline | Calendar and drafts exist, but no dedicated pre-production Kanban pipeline | Idea → brief → production → approval → scheduled → published, with conversion into native drafts | Reuse native Postiz composer, media and scheduling |
| External client approvals | Internal post comments/preview exist, but not a proper expiring client review workspace with reviewer-only access and approval audit | Secure review links, approve/request changes, comments and audit trail | Extend native preview/comment primitives |
| Campaign operations | Posts and tags/content sets exist; no first-class campaign workspace found in the inspected route tree | Group content, assets, channels, owners, dates, workflow steps and results as campaigns | Reuse native posts/tags/analytics; use BrightBean Studio's approval-stage ideas and campaign-oriented UX as a reference |
| Competitive/performance intelligence | Analytics are based on connected accounts and published posts | Later add competitive/keyword context without fabricating inaccessible competitor metrics | Harken or an API-backed listening provider |
| Visual social automation | AI agents exist, but there is no confirmed general-purpose visual trigger/condition/delay graph with comment-to-DM, keyword triggers and drip sequences | Trigger flows from comments, keywords, incoming DMs, schedules and webhooks; add conditions, delays, human hand-off and delivery analytics | **BrightBean Chat** for chat-marketing flows; **OpenPost Workflows** as a reference |

## Repositories evaluated

### 1. Chatwoot — selected for the first integration

- Repository: https://github.com/chatwoot/chatwoot
- Documentation: https://developers.chatwoot.com/api-reference/introduction
- Community/core licensing: MIT Expat outside the `enterprise/` directory; Enterprise code has separate licensing. Use Community Edition only unless separately licensed.
- Reuse model: run Chatwoot as a companion service and use its documented Platform API + SSO. Do not copy its Rails application or duplicate its inbox UI inside Postiz.
- Chatwoot provides the mature conversation layer: multi-channel inboxes, agents/teams, assignment, labels, private notes, priorities, canned replies and automation. Supported channels depend on Chatwoot's channel/API availability and configuration.
- SaaS tenancy mapping: one Chatwoot account per Postiz Organization; one Chatwoot identity per Postiz User; add the user to the corresponding Chatwoot account on launch. Postiz remains the identity and organization source of truth.
- Important API constraint: Chatwoot's Platform App token can access only accounts/users provisioned/authorized for that Platform App. Do not assume it can take over objects created manually or by a different Platform App.

### 2. OpenPost — strongest social-native inbox benchmark; not a drop-in module

- Repository: https://github.com/getopenpost/openpost
- License: AGPL-3.0-only.
- Current self-hosted default: one container, SQLite and local media storage; provider capabilities vary by platform.
- Its inbox is materially more social-specific than a generic support desk: comments, mentions, business reviews and direct messages, with durable reply receipts and retry handling. Its docs also describe moderation and provider-specific restrictions.
- Its adapter seams and tests are useful references for safe comment/engagement synchronization.
- **Not a direct drop-in for this Postiz fork:** it has its own OAuth connections, account model, workspace/authentication system and Go/SvelteKit/Expo stack. The trusted-proxy login option provisions an OpenPost identity/workspace; it does not automatically map Postiz organizations, users or encrypted provider tokens. A direct deployment would require a deliberate account/token migration or a maintained bridge.
- Because it is AGPL-3.0-only, treat source modifications and network-service obligations as a release/legal review item before adopting code.

### 3. BrightBean Studio — strongest feature reference and API candidate

- Repository: https://github.com/brightbeanxyz/brightbean-studio
- License: AGPL-3.0.
- It demonstrates the breadth we should aim for: an ideas Kanban, team/client approvals, threaded external comments, a unified inbox for comments/mentions/DMs/reviews, sentiment, assignments, media library, and per-workspace RBAC.
- It exposes a REST/MCP API. The documented inbox API supports listing messages, reading threads, creating/updating/discarding reply drafts and sending replies; API keys are workspace-scoped and can be allowlisted to social accounts.
- **Not a drop-in UI:** it is a separate Django/HTMX app and requires its own OAuth-connected accounts. A native Postiz UI could call its API only after we provision a matching workspace and API key, and customers would still need their accounts connected there. Avoid importing its Django application into the NestJS/Next.js monorepo.
- AGPL-3.0 obligations need review before any code is copied or modified.

### 2. Harken — shortlisted for a later Social Listening module

- Repository: https://github.com/VladUZH/harken
- License: MIT.
- Sources include Hacker News, Reddit, Mastodon, Bluesky, Stack Overflow, RSS, X and YouTube (provider credentials/API limits may apply).
- Reusable capabilities: mention normalization/deduplication, sentiment scoring, theme clustering, keyword projects, backfill cursors, webhook/email alerts and a self-hosted dashboard.
- **Not safe to expose as multi-tenant SaaS unchanged:** Harken documents that its users/roles are global to one instance and intentionally does not provide project-level tenant isolation. Do not share one instance between customer organizations until its data model, API and authorization are made tenant-aware.

### 3. OpenMagpie — optional listening ingestion engine

- Repository: https://github.com/obris-dev/openmagpie
- License: Apache-2.0.
- Useful for natural-language relevance filtering over sources such as X, YouTube, Reddit and Hacker News, with webhook delivery.
- The current project is CLI-first and does not provide a complete customer-facing dashboard. Consider it as a private ingestion worker, not as the Engage UI.

### 4. PostZen — feature reference only, not a reuse source

- PostZen documents an inbox-oriented workflow covering supported Meta comments and DMs plus comment-to-DM automation.
- It is a product reference, not an open-source codebase we should copy. Actual available actions depend on platform permissions, API scopes and Meta's messaging windows.

## First integration slice committed in this branch (validation pending)

The first slice adds an **Engage** entry to the Postiz navigation and a secure Chatwoot SSO bridge:
1. Backend-only Chatwoot Platform API configuration.
2. One persistent Chatwoot account mapping per Postiz organization.
3. One persistent Chatwoot identity mapping per Postiz user.
4. Organization membership is checked on each launch and mapped to an agent/administrator role.
5. Chatwoot issues the SSO URL; Postiz verifies the redirect stays on the configured Chatwoot origin.
6. The inbox, realtime conversations, teams, automations and social channel connections remain upstream Chatwoot features.

This is a companion integration, not a forked or rewritten inbox implementation. It is the first-stage support/DM inbox, **not** a complete social-native comments/mentions/reviews inbox. The connected social channels must also be authorized/configured in Chatwoot; Postiz account connections are not automatically imported. The code is committed but has not yet been built, deployed or end-to-end tested.

## Runtime configuration

Set these variables on the Postiz backend only:

```env
CHATWOOT_BASE_URL=https://inbox.example.com
CHATWOOT_PLATFORM_API_TOKEN=<platform-app-access-token>
```

The Chatwoot server must be reachable by the Postiz backend and have a Platform App token configured. Use HTTPS outside localhost. Keep the platform token out of `NEXT_PUBLIC_*` variables and browser bundles.

After pulling this branch, generate the Prisma client and apply the schema using the repository's normal workflow:

```bash
pnpm run prisma-generate
pnpm run prisma-db-push
```

Then rebuild/restart Postiz. Configure the Chatwoot Platform App token and verify:
- a new Postiz organization provisions a matching Chatwoot account;
- a Postiz user provisions a Chatwoot user and account membership;
- repeated launches reuse the same mappings;
- switching organizations opens the corresponding Chatwoot account;
- an inactive Postiz organization membership cannot launch the inbox.

## Next upgrades — in order

1. **Complete Engage:** verify live Chatwoot provisioning against the deployed Community Edition; add admin connection diagnostics and a clear first-run setup guide. Keep its scope to support channels and DMs unless a supported provider adapter can safely reuse Postiz authorizations. Chatwoot's current self-hosted deployment guide recommends 4 CPU cores and 8 GB RAM, so it should not be installed on the existing 2-core Oracle VM without a new capacity plan.
2. **Social-native inbox:** use OpenPost/BrightBean as implementation references for comments, mentions, reviews, per-provider permission gates, durable reply receipts and idempotent retry. First prove we can reuse Postiz's existing encrypted OAuth grants; do not make every customer connect the same account twice.
3. **Social Listening:** evaluate Harken's ingestion/sentiment pipeline; first add strict organizationId to tracked projects, queries, mentions, API lookups, alerts and authorization before customer exposure.
4. **Ideas & Production Pipeline:** reuse existing native drafts, posts, media, tags and composer to avoid duplicate publishing objects.
5. **Client Approval Portal:** compare BrightBean Studio's client portal, two-stage approvals and magic-link workflow; extend Postiz's existing preview/comments and native post states instead of adding a duplicate publishing system.
6. **Campaigns:** group native content objects and reuse Postiz analytics.

## Guardrails

- Do not merge this work into WallzaOS yet; finish and validate standalone Social Studio first.
- Keep `main` unchanged; all changes remain on `wallza/integrated-studio-foundation`.
- Do not clone or reimplement Postiz publishing, scheduling, media or analytics features.
- Keep provider secrets server-side; scope every stored mapping and request by the active Postiz organization/user.
- Respect the upstream license of every dependency and avoid Chatwoot's separately licensed Enterprise directory.
