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

### 1. Engage — reusable inbox integration
Add a dedicated engagement entry point without rebuilding a conversation engine. The committed first slice provisions Chatwoot accounts/users through its Platform API and SSO. Keep Chatwoot scoped to DMs/support conversations; it is not a substitute for native public comments, mentions or reviews. Do not duplicate Postiz publishing/account flows.

### 2. Social-native engagement
Use OpenPost and BrightBean Studio as technical references for comments, mentions, DMs, reviews, sentiment, reply receipts, idempotent retries and provider capability checks. The key architectural requirement is to reuse Postiz's existing encrypted OAuth grants rather than asking customers to authorize the same accounts again. Only implement providers where scopes and API terms permit it.

### 3. Visual social automation
Evaluate BrightBean Chat and OpenPost Workflows for comment-to-DM, keywords, delays, conditions, inbox handoff and webhook triggers. Reuse a mature workflow engine/API where licensing and tenancy allow it; do not duplicate the existing AI agent features.

### 4. Ideas & Content Pipeline
A visual Kanban workflow for ideas, briefs and drafts (e.g. Inbox, Idea, Brief, In production, Ready, Scheduled, Published, Archived). Each card should support owner, channel/platform targets, due date, labels, brief, attachments and conversion into a native Postiz draft. Persist data per organization; do not use browser-only storage as the source of truth.

### 5. Creative Studio
A unified workspace for creating and preparing social assets. Connect the existing media library, AI image/video generation and clipping pipeline. Add a consistent asset workflow and editor entry points. Do not claim full timeline editing until an actual editing engine and durable project format are implemented. Keep media processing asynchronous and store outputs through the configured storage provider.

### 6. Client Review & Approvals
A secure review workflow for agencies and teams: invite/reviewer access, shareable expiring review links, post preview, approve/request changes, comments, audit trail and status visibility. Reviewers must not receive workspace-wide access. Approval must be distinct from the existing publish state and must not publish automatically unless the owner explicitly enables that policy.

### 7. Campaigns & Content Operations
Group posts, assets and ideas into campaigns with goals, dates, owners and status. Reuse native post scheduling and analytics rather than creating parallel publishing or analytics systems.

### 8. Unified workspace experience
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

1. **Foundation + Engage connector:** preserve Postiz auth/org boundaries, add Chatwoot SSO mapping and setup docs. Build/deployment/E2E validation is still pending; Chatwoot needs a separate capacity decision.
2. **Social-native engagement:** prove reuse of existing Postiz OAuth grants; then add provider-backed comments, mentions, reviews and replies with durable receipts and capability gates. Use OpenPost/BrightBean as reference implementations, not as duplicate social-account stores.
3. **Visual social automation:** integrate a suitable BrightBean Chat/OpenPost workflow capability only after tenant isolation, provider permissions and licence review.
4. **Ideas & Content Pipeline:** reuse native Postiz drafts, media, composer and scheduling; compare BrightBean Studio's Kanban UX rather than importing its Django application.
5. **Creative Studio integration:** consolidate existing AI/media/clipping flows; add editor only after choosing a real editing engine.
6. **Client Review, campaigns and polish:** compare BrightBean's approval/client portal design, extend native preview/comment state, add campaign grouping and regression testing.
7. **Release gate:** run schema/build/tests, document deployment, verify existing Postiz workflows, then plan WallzaOS integration.

## Current repository facts verified

- Repository: `fkhan8811/wallza-social-studio`
- Default branch: `main`
- Working branch: `wallza/integrated-studio-foundation`
- Existing app shell: `apps/frontend/src/components/new-layout/layout.component.tsx`
- Existing sidebar: `apps/frontend/src/components/layout/top.menu.tsx`
- Existing route group: `apps/frontend/src/app/(app)/(site)/`
- Existing product routes include Launches/Calendar, Agents, Analytics and Media.

## First implementation boundary

The first committed implementation slice is the Engage/Chatwoot SSO connector. It is a thin integration, not a rebuilt inbox, and remains unvalidated until it is built against the real repo and a Chatwoot instance. The next critical engineering task is to determine how the social-native inbox can reuse Postiz's existing provider grants without duplicate account connections. Ideas, approvals and campaigns follow. No WallzaOS backend/frontend merge is part of this phase.
