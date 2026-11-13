# WallzaOS Social Studio — Parity Audit and Inbox Boundary

**Audit date:** 2026-11-13  
**Repository:** `fkhan8811/wallza-social-studio`  
**Work branch:** `feat/social-studio-activity-inbox-parity`  
**Base branch:** `feature/wallzaos-master-social-studio-upgrades`  
**Production/main branch:** Not changed by this work

## Executive recommendation

Keep Postiz as the Social Studio publishing engine. Do not replace it with TryPost, BrightBean Studio or OpenPost, and do not deploy those products as extra services beside Postiz.

Use the other repositories as capability references and bring selected features into this fork:

- **TryPost:** agent-first operations, queue APIs, channel-aware scheduling and approval actions.
- **BrightBean Studio:** agency approvals, client collaboration, per-platform content controls and reporting.
- **OpenPost:** durable creative projects, recovery/version history, video editing and production workflow.

WallzaOS already has a separate Unified Inbox. Social Studio must not become a second customer inbox. It owns publishing operations and content collaboration; WallzaOS Unified Inbox remains the system of record for customer conversations and leads.

## 1. Inbox architecture — avoid duplicate conversations

### WallzaOS Unified Inbox — customer communication

Owns customer-facing conversations and their CRM lifecycle:

- WhatsApp and other connected customer messaging channels.
- Instagram/Facebook DMs where the WallzaOS integration supports them.
- Email, website chat and customer enquiries.
- Contact identity, lead creation, lead stages and CRM history.
- Sales/support assignment, follow-ups and customer automation.

### Social Studio Activity Inbox — publishing activity

The new Activity Inbox aggregates existing Postiz-native activity:

- Postiz publishing notifications.
- Comments on scheduled/published content that belong to the Postiz post collaboration model.
- Client review events: requested, approved, changes requested and revoked.
- Links back to the appropriate publishing, calendar or review page.
- Resolve action for internal post discussion comments.

**It is not a customer DM inbox.** It does not import WhatsApp chats, email threads or CRM leads. The current Postiz provider contract does not provide a single generic inbound-DM or social-comment API, so the Activity Inbox does not claim to show all public comments/mentions from every network.

### Cross-linking rule

When a supported public social comment becomes a sales lead, create/link the lead in the WallzaOS Unified Inbox through an explicit integration event. Keep the original platform, account, post and comment identifiers as source metadata. Do not copy the entire conversation into both products or create two independently assigned threads.

A future social-comment adapter may bring public comments/mentions into a separate Social Engagement surface, but only for providers whose official APIs, scopes and account types support reading and replying. Customer DMs remain with WallzaOS.

## 2. Current feature inventory

### Postiz capabilities to preserve

The fork already contains the Postiz foundations for provider OAuth/integrations, publishing, calendar, post composition, media uploads, analytics, organization/workspace access control, public API, webhooks and AI/MCP entry points. Keep these as the single implementation of channel credentials and publishing.

Do not recreate provider authentication or a second publishing worker in WallzaOS-specific modules.

### Wallza-specific modules on the base working branch

The base branch `feature/wallzaos-master-social-studio-upgrades` contains three commits beyond `main` and adds:

- Ideas pipeline and conversion of ideas into native Postiz drafts.
- Campaign CRUD and links to existing native Postiz post groups.
- Client review links with separate reviewer tokens, token hashes, expiry and audit events.
- Media collections, favorites, tags and idea attachments.
- Creative Studio project hub with image, carousel and video project editors.
- Built-in creative templates and organization-scoped creative projects.
- Content templates, dynamic variables and hashtag groups.
- Publishing queues and automation-rule management.

The old product plan section describing some of these features as unimplemented is a historical status snapshot. The sections below supersede it for the current work branch.

## 3. Changes made in this work branch

### A. Publishing Activity Inbox

Added:

- `GET /activity-inbox` to merge notifications, post collaboration comments and client review audit events.
- `POST /activity-inbox/mark-read` to update the current user's existing Postiz notification read marker.
- Authenticated controller registration and an Activity Inbox route/navigation item.
- Filters for alerts, post comments and review events.
- A resolve action for internal Postiz post comments.

The feed uses organization-scoped queries and explicit field projections. It does not call the legacy notification list endpoint that automatically updates the last-read timestamp during retrieval.

### B. Creative Studio project version history

Added version snapshots for image, carousel and video projects:

- Initial project state is captured as version 1.
- Meaningful saved changes create a new version.
- The latest 20 versions are retained per project.
- Version records are scoped to both project and organization in the database.
- Restore applies an earlier snapshot and records the restored state as a new version, so the restore is reversible.
- Browser data-URL thumbnails are not copied into every version snapshot.

This adds recovery/version-history capability inspired by OpenPost's persistent creative-project workflow. It does not add OpenPost's transcript-driven Quick Cut, background-removal pipeline or a production-grade multitrack video renderer.

### C. Queue engine and scheduling

Improved the publishing queue foundation:

- Added a tenant-scoped `Post.queueId` relationship so a post can belong to a specific queue.
- Queue pending counts now count posts assigned to that queue in `QUEUE` state.
- Slot calculation uses each queue's IANA timezone rather than UTC weekday/time.
- Daylight-saving clock times that do not exist are skipped.
- Collision detection is scoped to the queue and can be narrowed by the integration IDs listed on a schedule slot.
- Queue capacity is checked against posts assigned to that queue.
- Added `POST /automation/queues/:id/enqueue` for 1–50 organization-owned draft posts, protected by the existing post-creation permission.
- Added an Automation UI flow on each queue card to load upcoming drafts, select up to 50 and enqueue them into the selected queue.
- Slot assignment is matched to each draft's connected account, and enqueue/retry actions use the existing Postiz `PostsService.changeDate(..., 'schedule')` workflow path rather than only changing database state.
- Deleting a queue detaches its posts but preserves their current publish dates.

This borrows the operational direction of TryPost/BrightBean queues without introducing another scheduler service.

### D. Existing per-platform template foundation

The working branch already has `PostTemplate.platformVersions` for per-platform content/media/first-comment variants, along with dynamic variables and hashtag groups. The next integration check is to confirm those saved variants are available as a one-click composer operation and survive a real publish for every supported platform. This audit does not count storage/UI alone as proof of a complete publishing workflow.

## 4. Gap analysis against the three reference projects

| Capability | Reference strength | Current Wallza Social Studio | Remaining work |
|---|---|---|---|
| AI-agent operations | TryPost's broad MCP/REST control surface | Postiz already has MCP/agent foundations | Add tools for Wallza Ideas, Campaigns, Reviews, queue operations and Creative Studio versions; do not duplicate existing Postiz post tools |
| Timezone-aware queues | TryPost/BrightBean scheduling workflows | Queue timezone, persistent queue assignment, capacity logic and draft-selection/enqueue UI added in this branch | Add editing for existing queue schedules; test DST, capacity and provider-specific constraints |
| Per-platform content | BrightBean platform overrides | Template variants are stored | Verify one-click application in the native composer and provider-level output |
| Internal/client approval | BrightBean configurable stages and comments; TryPost approval actions | External reviewer links, independent decisions and audit events | Add publish-pipeline approval enforcement, internal approvers, revision rounds, consolidated policies, reminders and email delivery |
| Client portal | BrightBean external client workflow | Token-only review page | Improve branding, post-level decisions and client feedback rounds without granting workspace access |
| Social engagement | BrightBean unified social inbox | Postiz internal post comments + activity feed | Provider-specific public comments/mentions/replies only where official APIs and granted scopes permit |
| Customer DMs and leads | BrightBean has a social inbox | WallzaOS already owns Unified Inbox | Do not import a second DM/lead system; integrate identities/events across the boundary |
| Creative project recovery | OpenPost saved-project workflow | Versioned snapshots and restore added | Test large project snapshots and add explicit project history/restore UX polish |
| Advanced image/carousel tools | OpenPost editor and reusable creative operations | Native image/carousel editor and templates exist | Improve font/asset support, background removal and asset variant rendering |
| Advanced video workflow | OpenPost Quick Cut, transcript tools and multitrack editing | Timeline UI stores video/audio/text tracks; export currently requires a client-rendered video data URL | Add a real asynchronous render/transcode worker, audio mixing, captions/transcript editing, preview and MP4 validation |
| Native analytics | BrightBean channel/post reporting | Postiz provider analytics and post analytics foundation | Add campaign and client report aggregation, trends and export; validate each platform's returned metric definitions |

## 5. Priority backlog

### P0 — release and data safety

1. Run Prisma client generation and validate both new migrations against a disposable PostgreSQL database.
2. Run the full monorepo build and the existing test suite.
3. Test Activity Inbox organization isolation, mark-read behavior, deleted posts, comment resolution and review-event projection.
4. Test version snapshots, project restore, cross-organization access, 20-version retention and large creative projects.
5. Test queue assignment, queue deletion, queue capacity, integration-specific slots, timezone conversion and DST transitions.
6. Verify scheduled posts really publish after queue assignment; a successful database update alone is not a publishing test.

### P1 — complete agency operations

1. Enforce approval policy before a post enters the publishing workflow.
2. Add internal approval stages and client approval as separate decisions.
3. Add revision rounds, threaded feedback, reminders and email invitations.
4. Wire platform-specific template variants into the native composer and previews.
5. Add queue selection/assignment UI and clear per-account next-slot previews.
6. Add campaign-level analytics and shareable client performance reports.

### P2 — deepen AI and creative operations

1. Extend the existing MCP/API surface with tools for ideas, campaigns, reviews, queue management, template selection and creative project version restore.
2. Add provider-specific public comment/mention adapters where official API permissions allow.
3. Add transcript-based video cutting, audio mixing and asynchronous rendering.
4. Add asset variants, bulk tagging, usage tracking and richer media metadata.

## 6. Oracle deployment boundary

Keep this as one customized Postiz application with the existing Postiz backend, database, storage and worker architecture. Do not deploy TryPost, BrightBean or OpenPost as separate production services just to gain their features.

New work should reuse existing PostgreSQL, configured object storage and worker infrastructure. The version-history implementation is bounded to 20 versions per project. The queue implementation adds data to the existing Post model rather than a new scheduler database.

No Render service, production database, Meta application or external platform credential was changed as part of this branch work.

## 7. Validation status and release warning

This branch contains code and migration changes, but this session did not run a full checkout build, Prisma generate, disposable-database migration, browser test or live provider publish. Treat the new features as implemented but **not yet verified for production** until the P0 checks pass.

The new migrations are:

- `20261113174500_creative_project_versions`
- `20261113181500_queue_assignment`

Do not apply them to production until they have been validated against a disposable database and the application build has passed.

The repository README declares AGPL-3.0. Continue to preserve upstream notices and review license obligations before commercial distribution; using a feature as a benchmark is different from copying another repository's implementation.
