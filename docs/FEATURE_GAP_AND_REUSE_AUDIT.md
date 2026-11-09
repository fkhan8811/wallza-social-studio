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
| Social engagement inbox | No dedicated conversation inbox or DM management route; existing comments are post-review comments | Shared inbox, assignment, teams, labels, priorities, private notes, saved replies, macros and automation | **Chatwoot Community Edition** |
| Social listening | No dedicated brand/keyword monitoring, sentiment feed or topic clustering | Brand/product keywords, mentions, sentiment, themes, source filters and alerts | **Harken** (after tenant isolation) |
| Content idea pipeline | Calendar and drafts exist, but no dedicated pre-production Kanban pipeline | Idea → brief → production → approval → scheduled → published, with conversion into native drafts | Reuse native Postiz composer, media and scheduling |
| External client approvals | Internal post comments/preview exist, but not a proper expiring client review workspace with reviewer-only access and approval audit | Secure review links, approve/request changes, comments and audit trail | Extend native preview/comment primitives |
| Campaign operations | Posts and tags/content sets exist; no first-class campaign workspace found in the inspected route tree | Group content, assets, channels, owners, dates and results as campaigns | Native posts, tags, sets and analytics |
| Competitive/performance intelligence | Analytics are based on connected accounts and published posts | Later add competitive/keyword context without fabricating inaccessible competitor metrics | Harken or an API-backed listening provider |

## Repositories evaluated

### 1. Chatwoot — selected for the first integration

- Repository: https://github.com/chatwoot/chatwoot
- Documentation: https://developers.chatwoot.com/api-reference/introduction
- Community/core licensing: MIT Expat outside the `enterprise/` directory; Enterprise code has separate licensing. Use Community Edition only unless separately licensed.
- Reuse model: run Chatwoot as a companion service and use its documented Platform API + SSO. Do not copy its Rails application or duplicate its inbox UI inside Postiz.
- Chatwoot provides the mature conversation layer: multi-channel inboxes, agents/teams, assignment, labels, private notes, priorities, canned replies and automation. Supported channels depend on Chatwoot's channel/API availability and configuration.
- SaaS tenancy mapping: one Chatwoot account per Postiz Organization; one Chatwoot identity per Postiz User; add the user to the corresponding Chatwoot account on launch. Postiz remains the identity and organization source of truth.
- Important API constraint: Chatwoot's Platform App token can access only accounts/users provisioned/authorized for that Platform App. Do not assume it can take over objects created manually or by a different Platform App.

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

## First integration delivered in this branch

The first slice adds an **Engage** entry to the Postiz navigation and a secure Chatwoot SSO bridge:
1. Backend-only Chatwoot Platform API configuration.
2. One persistent Chatwoot account mapping per Postiz organization.
3. One persistent Chatwoot identity mapping per Postiz user.
4. Organization membership is checked on each launch and mapped to an agent/administrator role.
5. Chatwoot issues the SSO URL; Postiz verifies the redirect stays on the configured Chatwoot origin.
6. The inbox, realtime conversations, teams, automations and social channel connections remain upstream Chatwoot features.

This is a companion integration, not a forked or rewritten inbox implementation.

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

1. **Complete Engage:** verify live Chatwoot provisioning against the deployed Community Edition; add admin connection diagnostics and a clear first-run setup guide.
2. **Native social comment moderation:** connect supported official social APIs through existing Postiz integration credentials for platform-native comments/replies that are not handled by the Chatwoot channel connector. Do not promise every network supports the same actions.
3. **Social Listening:** evaluate Harken's ingestion/sentiment pipeline; first add strict organizationId to tracked projects, queries, mentions, API lookups, alerts and authorization before customer exposure.
4. **Ideas & Production Pipeline:** reuse existing native drafts, posts, media, tags and composer to avoid duplicate publishing objects.
5. **Client Approval Portal:** build on the existing preview and comments rather than a new media/post engine.
6. **Campaigns:** group native content objects and reuse Postiz analytics.

## Guardrails

- Do not merge this work into WallzaOS yet; finish and validate standalone Social Studio first.
- Keep `main` unchanged; all changes remain on `wallza/integrated-studio-foundation`.
- Do not clone or reimplement Postiz publishing, scheduling, media or analytics features.
- Keep provider secrets server-side; scope every stored mapping and request by the active Postiz organization/user.
- Respect the upstream license of every dependency and avoid Chatwoot's separately licensed Enterprise directory.
