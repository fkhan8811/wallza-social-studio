# Platform Brand Logo Fix — Implementation Prompt

You are working in `fkhan8811/wallza-social-studio`, branch `wallza/social-studio-feature-upgrades`. Implement this in the actual Postiz-derived application. Do not create a separate demo, mockup, or replacement app.

## Goal
Every supported social platform/provider must display its authentic, recognizable brand mark wherever a platform is represented. Never use AI-generated logos, generic social-network glyphs, emoji, text-only initials, colored circles, or invented brand artwork as a substitute.

## Required implementation
1. Audit the complete platform/provider registry and every UI surface that renders a platform:
   - connect/integration directory and OAuth connection cards
   - connected account lists, account switchers and account badges
   - composer platform picker and per-platform post previews
   - calendar, scheduled/queued/published post cards and post details
   - analytics filters, charts legends and platform breakdowns
   - settings, onboarding, empty states, campaign/idea/review platform targets
   - any mobile/responsive navigation and compact icon-only controls.
2. Build one shared, typed platform-brand registry keyed by the application's canonical provider identifier. Each entry should define the provider name, authentic logo asset/component, official brand color where appropriate, accessible label, and a deliberate monochrome/compact variant only where the design requires it.
3. Reuse official brand assets already present in the repository first. If missing, use a maintained, license-compatible brand icon package (for example Simple Icons where the exact brand glyph exists) or official SVG assets from the provider's brand/developer resources. Verify each asset corresponds to the real provider. Do not fetch arbitrary third-party logo images at runtime.
4. Prefer bundled SVG/vector assets or package components over remote image URLs. Keep assets local, crisp at 16/20/24/32px, preserve viewBox/aspect ratio, and avoid stretching/cropping. Use `currentColor` only for approved monochrome variants; preserve recognizable brand colors in standard platform lists.
5. Cover every provider actually supported by this fork, including fork-specific additions. Do not assume the upstream Postiz provider list is complete. Derive the authoritative list from the fork's provider registry, OAuth/integration modules, and package integrations. Include newer/fork-added providers (such as Bluesky, Telegram, Farcaster/Neynar, X/Twitter, Facebook/Instagram and any others found) only if they are genuinely implemented in this branch.
6. Replace duplicated ad-hoc icon maps and generic fallback glyphs with the shared registry. Keep provider identity consistent across all surfaces.
7. For a genuinely unavailable/unknown logo, show a neutral, accessible fallback with the provider's real name; never fabricate a logo. Log/report missing registry entries during development so they cannot silently ship.
8. Ensure the provider label remains available to screen readers and tooltips; decorative SVGs should be hidden from assistive technology. Maintain keyboard focus, contrast, and touch targets.
9. Do not alter OAuth identifiers, provider keys, publishing behavior, API contracts, account data, or integration availability while changing presentation.
10. Preserve Wallza Social Studio's existing features and visual design. Do not replace real provider logos with generated assets from an image model.

## Acceptance criteria
- A complete inventory lists every provider key found in the codebase and the exact logo source/component used.
- No supported provider is rendered with a generic AI-generated icon, emoji, initials, or generic social icon.
- The same provider uses the same brand identity across connect, accounts, composer, calendar, analytics and all other surfaces.
- Unknown providers use the explicit neutral fallback and are reported during development.
- No remote logo dependency is introduced at runtime.
- Add unit/component tests for registry completeness, unknown-provider fallback, accessible names, and representative rendering on each surface.
- Run formatter, lint, typecheck, relevant tests, and production build. Report exact commands and pass/fail output. Do not claim success for checks that were not run.
- Provide before/after screenshots for desktop and mobile, and a provider-by-provider checklist.
- Do not deploy to production or modify production databases/secrets. Commit changes only to `wallza/social-studio-feature-upgrades`.

## Required final report
List: provider inventory, files changed, logo source/license, surfaces fixed, tests/build actually run, remaining missing logos, and commit SHA. If any platform lacks a verified official/maintained brand asset, name it explicitly rather than inventing one.
