# Wallza Social Studio — Complete Fork Stabilization, Feature Completion, Brand Identity & WallzaOS Integration Master Task

**Repository:** `fkhan8811/wallza-social-studio`  
**Working branch:** `wallza/social-studio-feature-upgrades`  
**Parent:** `gitroomhq/postiz-app`  
**Primary objective:** finish and stabilize the complete customized Postiz fork as Wallza Social Studio, preserve every working upstream and fork-specific capability, correct every platform logo/icon, and prepare it for full integration into WallzaOS. Work in this repository and branch. Do not build a separate replacement application.

---

## 0. Non-negotiable rules

1. **Preserve the complete fork.** Do not reduce it to a basic scheduler, rebuild selected pages, remove providers, or replace the Postiz engine with a lightweight custom implementation.
2. Keep all working upstream Postiz capabilities and all fork-specific additions. Do not overwrite our 72-ahead feature work or discard custom commits while reconciling the two commits behind upstream. Review each upstream change and resolve conflicts intentionally.
3. Do not silently remove, rename, disable, or fake a social provider or feature. If something is broken, fix it; if it is blocked by provider API access, show an honest disabled/needs-credentials state with the real reason.
4. Do not use AI-generated logos, generic AI artwork, emoji, initials in colored circles, generic social-network glyphs, or invented brand marks as platform identities.
5. No fake analytics, demo data presented as live, fake connected accounts, fake successful publishing, dead buttons, or placeholder integrations described as working.
6. Preserve provider keys, OAuth scopes, callback URLs, publishing APIs, account identifiers, existing database records and integration credentials unless a separately reviewed migration explicitly requires a change.
7. Keep secrets server-side. Never expose provider tokens, OAuth client secrets, review bearer-token hashes, internal filesystem paths, or service-role credentials to the browser or logs.
8. Enforce organization/tenant authorization on every server-side read/write. Client-side hiding is not authorization. Add cross-organization tests for every new endpoint.
9. Do not run Prisma schema pushes or destructive migrations against production. Use a disposable PostgreSQL database for schema validation and migrations.
10. Do not change production Render services, production database, DNS, secrets, billing, Meta App Review configuration or live customer accounts. Do not deploy until staging checks pass and the user explicitly approves production deployment.
11. Keep license notices and comply with the fork's AGPL-3.0 obligations. Do not assume private deployment or code modifications remove obligations. Record third-party asset/package licenses.
12. Do not mark work complete based on code inspection alone. Report exact checks, commands, results, skipped tests and remaining blockers honestly.

---

## 1. First: repository and feature inventory

Before changing code:

- Confirm current branch, HEAD SHA, working tree status, remotes, default branch and upstream parent.
- Inspect the full branch diff against fork `main` and upstream Postiz at the relevant merge base. Preserve custom commits and inspect the two upstream commits missing from the feature branch before integrating them.
- Build a feature inventory from actual code, routes, controllers, provider registries, Prisma schema, workers, environment templates and UI routes. Do not rely only on README claims or old product-plan text.
- Produce a matrix with: feature/provider, backend implementation, frontend surface, persistence, background worker, credentials/config required, test coverage, status (working/partial/broken/not implemented), evidence/file paths and action required.
- Specifically audit every social platform added or modified in our fork. Compare provider registry and implementation with upstream so we can distinguish truly fork-added providers from inherited Postiz providers. Do not claim a provider was added by our fork unless the diff proves it.
- Identify all feature flags and environment variables. Document defaults and required production configuration without exposing secret values.

### Known fork-specific work that must be retained and completed

The feature branch product plan records these custom modules. Verify each against the live code and preserve them:

**Ideas & Content Pipeline**
- Organization-scoped stages and ideas, default stages, stage management, create/edit/delete, ordered Kanban moves and drag/drop.
- Cards support platform targets, labels, owner, due date, campaign association and brief.
- Attach existing Media Library assets through organization-scoped relations; do not duplicate files.
- Convert an idea to native Postiz drafts using connected accounts.
- Validate ownership and organization scope in APIs and database relations.

**Campaigns & Content Operations**
- Organization-scoped campaign CRUD, description, goal, status, start/end dates.
- Link existing Postiz post groups to campaigns without republishing or rescheduling.
- Display linked channels, post counts, planned dates and native publishing states.
- Clearly distinguish operational status from aggregated campaign reach/engagement analytics. Do not invent aggregated analytics.
- Complete missing campaign calendar, member/owner assignment and analytics only by reusing real Postiz publishing/analytics data.

**Client Reviews & Approvals**
- Retain expiring reviewer links (currently planned for 1–30 days), independent reviewer decisions, comments, revocation and audit events.
- Store only token hashes; never log or return raw token hashes. Raw bearer links should be displayed once only when created and sent only through an approved secure channel.
- Anonymous reviewer page must not grant workspace access. Reviewer access remains limited to the specific review.
- Add email invitations/notifications through a secure configured mail provider; handle delivery failures, retries, expiration and revocation.
- Add per-post decisions, revision rounds, consolidated reviewer status and optional quorum/policy settings where product requirements allow.
- Add an explicit publishing approval gate. Approval must not auto-publish by default. If an organization enables auto-publish-after-approval, require clear configuration, permission checks, audit logs and tests.
- Test wrong-org resources, expired/revoked/replayed tokens, repeated submissions, token brute force/rate limiting, XSS in reviewer comments and media URL validation.

**Media Library & Creative Studio**
- Preserve uploads, object storage, thumbnails, processing, collections, favorites, tags, server-side filtering and idea attachments.
- Complete hierarchical folders, bulk tagging, richer metadata, asset usage tracking and safe deletion/retention where appropriate.
- Reuse existing storage and asynchronous processing. Do not store large media blobs in the application database.
- Consolidate existing AI image/video generation, video clipping and transcription/caption services into a coherent Creative Studio entry point without pretending a full timeline editor exists.
- A full image/carousel editor or multi-track video editor may only be called complete when there is a real editing engine, durable project format, save/reopen workflow, export pipeline and tests. Otherwise label it accurately as a planned capability.

**Other existing Postiz features to preserve**
- Social account connections and OAuth integrations.
- Native post composer and per-platform previews.
- Scheduling, calendar, queues, recurring posts and publishing workers.
- Analytics and platform breakdowns.
- Media library, uploads and media processing.
- AI agent entry point and existing AI integrations.
- Video clipping and transcription/caption-related services.
- Tags, reusable content sets, signatures and post comments.
- Workspace/organization model, authentication, roles, team collaboration and billing foundations.
- Existing APIs, webhooks, MCP/agent support and all other actually implemented modules found during inventory.

Do not assume the above list is exhaustive. The source code is authoritative: preserve every additional implemented capability discovered.

---

## 2. Platform logos and brand icons — mandatory global fix

### Required outcome
Every supported provider/platform must show its real, recognizable official brand mark consistently throughout the product. This includes inherited providers and all genuinely supported fork-specific providers.

### Provider inventory
- Derive the exact provider list from the actual integration/provider registry, OAuth modules, backend publishing implementations and frontend integration definitions.
- Include every provider the application can actually connect to or publish to. Include platforms such as Instagram, Facebook, Threads, X/Twitter, LinkedIn, TikTok, YouTube, Pinterest, Reddit, Slack, Discord, Mastodon, Bluesky, Telegram, Dribbble and any other provider only where the branch contains a real implementation.
- Explicitly inspect fork additions such as Bluesky, Telegram, Farcaster/Neynar and any other provider dependencies or modules. A package dependency alone does not prove an integration is supported; verify a working provider implementation.
- Create a committed provider-to-logo inventory table: canonical provider key, display name, asset/component path, source, license, brand-color handling and all UI surfaces where used.

### Asset source and quality
1. First reuse authentic official assets already in the repository.
2. Where missing, use official brand/developer resources or a maintained, license-compatible brand icon package such as Simple Icons when the exact official glyph exists and its license/usage terms are suitable.
3. Verify the exact logo and wordmark variant for each provider. Never draw a lookalike or use an unrelated generic icon.
4. Bundle SVG/vector assets or package components locally. Do not depend on arbitrary external image URLs at runtime.
5. Preserve the original SVG viewBox, aspect ratio, recognizable silhouette and correct brand color. No stretching, clipping, blurry raster substitutes or incorrect recoloring.
6. Use monochrome variants only where the design system explicitly requires them and the logo remains recognizable. Standard provider selection and identity surfaces should use recognizable brand assets.
7. Keep asset attribution and licenses in a central documentation file.
8. If no verified asset can be found, use a deliberate neutral fallback with the real provider name and accessible label; record it as a release blocker for that provider. Never invent a logo.

### One shared implementation
- Build one typed, canonical platform-brand registry keyed by the exact provider key used by the backend/frontend integration model.
- Registry entries should contain canonical key, display name, local icon component/asset, official color (where applicable), accessible name, optional approved compact/monochrome variant and source/license metadata.
- Replace scattered icon maps and inconsistent ad-hoc conditionals with the shared registry.
- Add development/test-time detection for missing provider mappings. New providers must fail a registry completeness test until an approved logo or explicit neutral fallback is registered.
- Ensure icons are never confused with account avatars. Show the provider logo as a small identity badge alongside the actual account avatar/name where appropriate.
- All SVGs must be accessible: decorative SVGs hidden from screen readers; parent controls have provider-specific accessible names and tooltips. Maintain keyboard focus, sufficient contrast and touch targets.

### Surfaces to audit and fix
- Integration directory and connect/OAuth cards.
- Connected social account cards, account lists, account switchers and account badges.
- Composer provider selector and per-platform previews.
- Post destination chips and publishing status.
- Calendar, scheduled/queued/published post cards and post detail.
- Analytics filters, charts, legends and platform breakdowns.
- Ideas, campaigns, review requests and content target selectors.
- Media/Creative Studio platform-specific actions.
- Workspace settings, integrations settings, onboarding and help/empty states.
- Notifications, activity feeds, mobile navigation, compact controls and responsive layouts.
- Any remaining page, modal, dropdown, tooltip or table that renders a provider.

Acceptance: same provider key always resolves to the same official identity everywhere. No AI-generated/generic/emoji/initials platform marks remain in provider identity UI.

---

## 3. UI/UX consistency and functional completeness

- Make Social Studio feel like one cohesive application, not separate modules pasted together.
- Preserve the existing Postiz design system and working interactions while making new modules visually consistent.
- Unify navigation, workspace switcher, page headers, breadcrumbs, loading/skeleton, empty, error and success states.
- Check desktop, tablet and mobile layouts. No clipped menus, inaccessible dialogs, broken overflow, hidden primary actions or tiny tap targets.
- Ensure all visible buttons, menu items and controls have real actions and permission-aware states. Remove dead links and inert controls.
- Add search, sorting, filters and pagination where the data volume and existing patterns require them.
- Keep optimistic UI updates consistent with server truth and roll back on errors.
- Ensure date/time displays use the organization's timezone and respect platform-specific publishing constraints.
- Ensure composer previews accurately reflect per-platform text limits, media constraints, aspect ratios and validation based on current provider implementation.
- Keep provider connection errors understandable and actionable without exposing secrets.

---

## 4. Backend, database, tenancy and security

- Follow the existing NestJS/backend architecture, DTO validation, Prisma conventions, queues and API patterns.
- Every new entity must be tenant/organization-scoped. Enforce it in API authorization and database constraints where possible.
- Use least-privilege roles and explicit authorization for read, create, update, delete, publish, approve, invite and manage integrations.
- Do not return provider tokens or secret-bearing credential objects to the frontend.
- Encrypt sensitive provider credentials at rest using the existing supported mechanism; verify key rotation and recovery behavior.
- Validate webhook signatures, OAuth state/PKCE where supported, callback origin and replay protection.
- Add rate limits and abuse controls for public review endpoints and token-only routes.
- Validate uploaded media type, size, filename, storage key and public URL. Prevent path traversal, SSRF and unsafe content rendering.
- Use transactions for multi-record state changes. Make background jobs idempotent and safe to retry.
- Add audit events for security-sensitive actions and important content lifecycle changes.
- Avoid breaking schema changes. Create reviewed migrations and test upgrade from a copy of the current schema.
- Do not use localStorage as the source of truth for persisted product data.

---

## 5. WallzaOS integration — full customized Social Studio, not a partial feature copy

The target is to integrate the complete customized fork as WallzaOS's Social Studio module. Do not copy only the Ideas/Campaigns/Reviews pages or rebuild Postiz publishing in the WallzaOS backend.

### Architecture direction
- Keep the customized Postiz engine (frontend, backend, provider integrations, workers and its data model) as a dedicated service/module initially.
- WallzaOS should provide the unified customer entry point, navigation, tenant/subscription context and shared identity experience.
- Use a secure SSO/identity bridge and explicit mapping between WallzaOS organization/user IDs and Social Studio organization/user IDs.
- Reuse the existing WallzaOS authentication/organization model only after auditing its current implementation. Do not assume Mautic SSO code is reusable without security review.
- Never rely on a client-supplied org ID alone to establish tenant access.
- Keep Social Studio database/schema and migrations isolated from WallzaOS Supabase/Postgres initially. Do not merge Postiz Prisma tables blindly into the WallzaOS schema.
- Define server-to-server APIs for tenant provisioning, user provisioning/deprovisioning, permissions, subscription entitlements and audit events.
- Do not duplicate OAuth connections, publishing, social analytics, media processing or inbox features already owned by Postiz/Wallza Connect.
- Keep Wallza Connect responsible for WhatsApp. Avoid creating a second WhatsApp integration inside Social Studio unless a deliberate product decision and shared-account design require it.
- Add the complete Social Studio UI into the real WallzaOS sidebar and navigation. It must open the actual integrated service and not the previously created separate Lovable prototype.
- Use secure reverse proxy/subdomain or a supported embedded navigation approach only after evaluating cookies, CSP, CSRF, OAuth callbacks, websocket/worker needs and same-site behavior. Do not choose an iframe as a shortcut.
- Design for Oracle Always Free target (2 OCPU, 12GB RAM) but measure real idle and peak memory/CPU before deciding service consolidation. Do not assume the full stack fits. Identify required services (web, API, workers, Temporal, Redis, PostgreSQL, object storage) and test realistic concurrency. Prefer resource-efficient process sizing and shared infrastructure only where isolation/security are preserved.
- Document backup/restore, migrations, monitoring, queue recovery, logs, health checks, retention and disaster recovery.
- Keep Meta App Review and existing production integrations untouched.

### Integration acceptance
A WallzaOS user can enter Social Studio using WallzaOS identity, land in the correct tenant, see the full customized Postiz feature set and their own authorized accounts/data, and cannot access another tenant by manipulating URLs, IDs or API requests. Disconnecting/revoking a user or subscription must follow a documented secure policy.

---

## 6. Tests and release gates

### Automated tests
- Provider registry completeness and exact provider-key mapping.
- Logo accessibility and consistent rendering on every major platform surface.
- Unknown provider fallback and missing-logo detection.
- Ideas CRUD, ordering, stage changes, media attachments and idea-to-draft conversion.
- Campaign CRUD, campaign/post-group links and organization isolation.
- Reviewer link creation, one-time display, expiry, revocation, replay, comments, independent decisions, notifications and optional approval gates.
- Media upload, processing, collection/tag/favorite operations and tenant isolation.
- OAuth state/callback validation, credential secrecy, account connection/disconnection and provider publishing paths.
- Queue retries/idempotency, recurring schedules, timezone handling and provider rate limits.
- WallzaOS SSO, organization mapping, role/entitlement checks and cross-tenant denial.
- Regression tests for all inherited Postiz modules.

### Commands / validation
- Inspect package scripts first and use the repository's actual package manager and scripts.
- Run formatting, lint, typecheck, unit tests, backend tests, frontend tests, Prisma generation and production build.
- Run Prisma DB push/migrations only against a disposable PostgreSQL test database.
- Run browser E2E for connect/account display, compose, schedule, publish simulation or test provider, analytics, media, Ideas, Campaigns, Reviews and WallzaOS SSO.
- Do not report a test as passing unless its command ran and returned success. Include exact command and result.
- Check GitHub Actions and fix workflow configuration if needed; report actual check-run status.
- Provide desktop and mobile screenshots of key screens, including provider logos, with no real user secrets visible.

### Required release artifacts
1. Feature/provider inventory and implementation status.
2. Provider-to-logo mapping with asset provenance/license.
3. Architecture diagram and WallzaOS integration boundary.
4. Environment variable reference with names/descriptions only; no secret values.
5. Database migration and rollback plan.
6. Test report with exact commands and outcomes.
7. Known limitations and blockers.
8. Before/after desktop and mobile screenshots.
9. Commit list and final branch SHA.
10. Staging deployment/runbook and resource measurements for Oracle target.

---

## 7. Execution order

Work in small reviewable commits on the specified feature branch:

**Phase A — Baseline and safety**
- Confirm branch and working tree; create a backup/safety ref if needed.
- Inventory all fork and upstream differences; inspect the two missing upstream commits.
- Establish current build/test baseline and record failures before changes.

**Phase B — Provider identity and logo system**
- Build the provider inventory and shared brand registry.
- Bundle verified logos, replace all inconsistent provider icon usage and fix every listed surface.
- Add registry completeness/accessibility tests and screenshots.

**Phase C — Complete fork-specific modules**
- Finish Ideas, Campaigns, Reviews, Media Library and Creative Studio gaps listed above.
- Implement email notifications, campaign calendar/reporting and review policies safely.
- Do not pretend advanced editing features exist before the actual editing pipeline is implemented.

**Phase D — Preserve and regression-test core Postiz**
- Validate every existing provider, account connection, composer, preview, calendar, queue, scheduling, recurring post, analytics, media, AI, clipping, comments, reusable content sets, teams/roles, API/webhooks and other inventoried feature.
- Fix regressions without deleting functionality.

**Phase E — WallzaOS integration**
- Audit the actual WallzaOS repository and current authentication/tenant model.
- Design and implement SSO and tenant mapping; connect the full Social Studio service and navigation.
- Keep data/migrations isolated and test cross-tenant boundaries.
- Measure Oracle resource use before choosing deployment topology.

**Phase F — Release readiness**
- Run all tests, disposable DB validation, production builds and browser E2E.
- Fix failures; document any provider requiring external approval or credentials.
- Prepare staging deployment only. Do not deploy production without explicit approval.

---

## 8. Definition of done

This task is complete only when:

- Every existing upstream Postiz feature and every implemented fork-specific feature is retained and passes regression tests.
- Every supported provider is listed and mapped to an authentic verified brand logo, with no generic/AI/emoji/initial-based platform marks.
- Logos appear consistently across every relevant UI surface.
- Ideas, Campaigns, Reviews, Media Library and Creative Studio are functional, secure and organization-scoped; remaining intentionally deferred editor capabilities are clearly labeled.
- WallzaOS integrates the full Social Studio service through secure identity and tenant mapping, not a partial rewrite or mockup.
- Disposable database migration checks, automated tests, typecheck, lint and production builds pass, or remaining failures are explicitly documented as blockers.
- No production service, production database, credentials or Meta review configuration was changed without approval.
- The final report contains evidence, exact commit SHA and no unsupported claims.

**Start by producing the actual inventory and baseline results. Then implement the work in this order. Do not stop after writing a plan, and do not claim completion until the definition of done is met.**
