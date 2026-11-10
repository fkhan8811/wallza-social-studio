# Wallza Social Studio — Product Integration Plan

## Product direction

Build one cohesive social-media operating system from this Postiz fork. The result must feel like one application with shared navigation, identity, workspace, social accounts, media, permissions and design language—not a collection of separately branded tools.

This repository is the standalone Social Studio product. WallzaOS integration is explicitly deferred until this product is stable and accepted.

## Existing Postiz capabilities to preserve

- Social account connections and publishing integrations
- Calendar, queues, scheduling, recurring posts and post composer
- Analytics
- Media library and uploads
- AI agent entry point and existing AI generation integrations
- Video clipping pipeline, transcription/caption-related services
- Tags, reusable content sets, signatures and post comments
- Organization/workspace model, roles, authentication and billing foundations

Do not create duplicate modules for capabilities already present. Extend the existing flows and reuse their data and permission model.

## Product modules to add or consolidate

### 1. Ideas & Content Pipeline
A visual Kanban workflow for ideas, briefs and drafts (e.g. Inbox, Idea, Brief, In production, Ready, Scheduled, Published, Archived). Each card should support owner, channel/platform targets, due date, labels, brief, attachments and conversion into a native Postiz draft. Persist data per organization; do not use browser-only storage as the source of truth.

### 2. Creative Studio
A unified workspace for creating and preparing social assets. Connect the existing media library, AI image/video generation and clipping pipeline. Add a consistent asset workflow and editor entry points. Do not claim full timeline editing until an actual editing engine and durable project format are implemented. Keep media processing asynchronous and store outputs through the configured storage provider.

### 3. Client Review & Approvals
A secure review workflow for agencies and teams: invite/reviewer access, shareable expiring review links, post preview, approve/request changes, comments, audit trail and status visibility. Reviewers must not receive workspace-wide access. Approval must be distinct from the existing publish state and must not publish automatically unless the owner explicitly enables that policy.

### 4. Campaigns & Content Operations
Group posts, assets and ideas into campaigns with goals, dates, owners and status. Reuse native post scheduling and analytics rather than creating parallel publishing or analytics systems.

### 5. Unified workspace experience
One sidebar, one workspace switcher, one account model, consistent page headers, shared media picker and coherent empty/loading/error states. New modules should look and behave like native Postiz pages.

## Engineering rules

- Preserve upstream Postiz functionality and existing provider integrations.
- Use the current authentication, organization scoping, roles, API conventions and Prisma patterns.
- Every new database entity must be organization-scoped and protected server-side.
- Never put secrets or provider tokens in the browser.
- Avoid fake metrics, placeholder integrations presented as working, or localStorage as persistent product data.
- Add migrations, DTO validation, API authorization and tests with each persisted feature.
- Keep expensive AI/media processing out of synchronous web requests; use the project's existing queue/worker infrastructure where suitable.
- Keep features modular so they can later be integrated into WallzaOS through explicit APIs and shared identity decisions.
- Check upstream license obligations before commercial distribution; do not remove required notices.

## Delivery sequence

1. **Foundation:** establish feature branch, map architecture, confirm CI/build commands and define shared UI conventions.
2. **Ideas & Content Pipeline:** database/API/UI, convert idea to native draft, tests.
3. **Creative Studio integration:** consolidate existing AI/media/clipping flows; add editor only after choosing a real editing engine.
4. **Client Review & Approvals:** secure external reviewer flow, audit trail and tests.
5. **Campaign operations and polish:** campaign grouping, cross-module navigation, responsive states, accessibility and regression testing.
6. **Release gate:** run migrations and full checks, document environment variables/deployment, verify existing Postiz flows, then plan WallzaOS integration.

## Feature implementation status — branch `wallza/social-studio-feature-upgrades`

### Implemented in the feature branch (not yet merged into `main`)

- Organization-scoped `ContentIdeaStage` and `ContentIdea` models, default pipeline stages, authenticated APIs, stage management, idea create/edit/delete, campaign assignment and ordered Kanban moves.
- Ideas Kanban UI with drag-and-drop between stages and positions, editable cards, platform targets, labels, owner, due date, campaign association and create-native-drafts action using existing connected social accounts.
- Organization-scoped `ContentCampaign` model and CRUD API with name, description, goal, status and start/end dates; Campaigns page added to the sidebar. Ideas can be assigned to a campaign. Campaigns are not yet attached to already scheduled/published posts or analytics.
- Organization-scoped `ContentReview` model and review-management API. Review links use 256-bit random tokens; only SHA-256 token hashes are stored. Links expire (1–30 days), can be revoked while pending, and return only the selected post data for the matching organization/post group.
- Public, token-only review page with approve/request-changes decisions and reviewer comments. Decisions do not publish posts automatically. Reviewers do not receive a Postiz user or workspace membership.
- Campaigns and Reviews navigation entries.

### Still not implemented or not production-ready

- Email invitations / automated reviewer notification. The review link is currently shown once in the UI and must be sent through an approved communication channel.
- A detailed immutable approval audit/event history, multi-reviewer workflow, per-post decisions, revision rounds, and approval policy enforcement in the publishing pipeline.
- Campaign-to-post linking, campaign calendars, campaign performance reporting and owner/member assignment.
- Advanced media library folders, collections, tags, favorites and asset usage tracking.
- Full carousel/image editor and durable multi-track video editor.
- Expanded queue rules, reusable queue templates and posting-slot controls.
- Attachments and a shared creative asset picker inside idea cards.
- Comprehensive API/controller tests and end-to-end tests for idea-to-draft, campaign workflows and public review decisions.

### Validation and release gates

- The Prisma schema changed. Run `pnpm run prisma-generate` and `pnpm run prisma-db-push` only against a disposable test database first. Do not run schema push against production.
- The repository's `.github/workflows/build.yml` runs dependency installation and the workspace build on pushes and pull requests. A green build is required on the final feature-branch commit before this branch can be marked code-complete.
- No live Postiz app build, database migration, browser test or end-to-end workflow has been run from a complete checkout in this session.
- Validate public review links with expiry, revoke, repeated submission, wrong-organization post groups, and safe preview rendering. The review URL is a bearer secret: never log or persist the raw token.
- No production database, Render service, external account credentials or upstream Postiz branch has been changed.

## Current repository facts verified

- Repository: `fkhan8811/wallza-social-studio`
- Fork parent: `gitroomhq/postiz-app`
- Default branch: `main`
- Working branch: `wallza/social-studio-feature-upgrades`
- Existing app shell: `apps/frontend/src/components/new-layout/layout.component.tsx`
- Existing sidebar: `apps/frontend/src/components/layout/top.menu.tsx`
- Existing route group: `apps/frontend/src/app/(app)/(site)/`
- Existing product routes include Launches/Calendar, Agents, Analytics and Media.

## Current integration boundary

Keep Social Studio as a customized Postiz fork while Meta approval is pending. Use its existing social account connections and organization model; do not create duplicate OAuth or inbox systems. WallzaOS integration remains a separate later step. The current draft PR must stay unmerged until CI, database validation and feature-level end-to-end checks pass.
