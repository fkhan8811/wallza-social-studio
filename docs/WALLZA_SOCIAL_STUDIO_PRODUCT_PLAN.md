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

### Implemented in this branch (not yet merged into main)

- Organization-scoped `ContentIdeaStage` and `ContentIdea` Prisma models.
- Authenticated, organization-scoped Ideas API for listing stages, creating/updating/deleting ideas, adding/updating/deleting empty stages, and moving ideas between stages.
- Default content pipeline stages: Inbox, Idea, Brief, In production, Ready, Scheduled, Published and Archived.
- Native Ideas Kanban page with drag-and-drop stage changes, idea creation, platform targets, labels, owner name and due date.
- Create-drafts action that uses the existing authenticated integrations and native `POST /posts` draft flow. When platform targets are specified, connected accounts are matched against those targets; otherwise drafts are created for all active connected accounts.

### Not yet implemented

- Rich card editing UI and reliable in-column ordering controls.
- Client-facing review portal, expiring reviewer links, approval/request-changes workflow and approval audit history.
- Advanced media library folders, collections, tags, favorites and asset usage tracking.
- Full carousel/image editor and durable multi-track video editor.
- Expanded queue rules, reusable queue templates and posting-slot controls.
- Campaign management.

### Validation and deployment notes

- The Prisma schema has changed. Run `pnpm run prisma-generate` and `pnpm run prisma-db-push` against the intended database before starting the updated application.
- Build and runtime checks have not yet been run from a complete local checkout. Do not treat this branch as production-ready until the schema update, backend build, frontend build and end-to-end idea-to-draft flow are verified.
- No changes have been made to `main`; no external repository has been added as a deployable service.

## Current repository facts verified

- Repository: `fkhan8811/wallza-social-studio`
- Default branch: `main`
- Working branch: `wallza/integrated-studio-foundation`
- Existing app shell: `apps/frontend/src/components/new-layout/layout.component.tsx`
- Existing sidebar: `apps/frontend/src/components/layout/top.menu.tsx`
- Existing route group: `apps/frontend/src/app/(app)/(site)/`
- Existing product routes include Launches/Calendar, Agents, Analytics and Media.

## First implementation boundary

The first feature to implement is Ideas & Content Pipeline, using the existing workspace and native post composer. The Creative Studio and approval portal follow as separate increments. No WallzaOS backend/frontend merge is part of this phase.
