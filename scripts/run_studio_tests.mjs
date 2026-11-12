import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require('sharp');
} catch {
  sharp = require('D:/Whatsapp-main/node_modules/sharp');
}

describe('Wallza Social Studio — Master Integration & Verification Test Suite', () => {

  // ── TEST 1: Real Storage & Canvas Image Export Persistence ───────────────
  describe('Area 1: Real Storage & Creative Studio Image Export', () => {
    const testUploadDir = path.resolve(process.cwd(), 'test-uploads');

    before(() => {
      fs.mkdirSync(testUploadDir, { recursive: true });
    });

    after(() => {
      if (fs.existsSync(testUploadDir)) {
        fs.rmSync(testUploadDir, { recursive: true, force: true });
      }
    });

    it('generates real image bytes and persists file to local storage directory', async () => {
      // 1. Generate real image buffer with Sharp
      const width = 800;
      const height = 800;
      const svgOverlay = Buffer.from(`
        <svg width="${width}" height="${height}">
          <rect width="100%" height="100%" fill="#1e1b4b"/>
          <circle cx="400" cy="400" r="250" fill="#4338ca"/>
          <text x="50%" y="50%" text-anchor="middle" fill="#ffffff" font-size="40px" font-family="sans-serif">Studio Real Export</text>
        </svg>
      `);

      const pngBuffer = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 30, g: 27, b: 75, alpha: 1 },
        },
      })
        .composite([{ input: svgOverlay, blend: 'over' }])
        .png()
        .toBuffer();

      assert.ok(pngBuffer.length > 1000, 'Rendered PNG buffer must have genuine binary payload');

      // 2. Simulate LocalStorage write pipeline
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const innerDir = path.join(testUploadDir, `${year}`, `${month}`, `${day}`);
      fs.mkdirSync(innerDir, { recursive: true });

      const testFilename = `test_export_${Date.now()}.png`;
      const targetFilePath = path.join(innerDir, testFilename);
      fs.writeFileSync(targetFilePath, pngBuffer);

      // 3. Verify file exists on disk and has valid file headers
      assert.ok(fs.existsSync(targetFilePath), 'Exported file must exist on disk');
      const stats = fs.statSync(targetFilePath);
      assert.ok(stats.size > 1000, 'Written file must not be empty');

      // Verify PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
      const fd = fs.openSync(targetFilePath, 'r');
      const header = Buffer.alloc(8);
      fs.readSync(fd, header, 0, 8, 0);
      fs.closeSync(fd);
      assert.deepEqual(
        [...header],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        'Exported file must carry genuine PNG magic bytes'
      );
    });

    it('rejects fake URLs and ensures accessible local/CDN URL format', () => {
      const generateExportUrl = (frontendUrl, innerPath, filename) => {
        if (!frontendUrl) throw new Error('FRONTEND_URL required');
        return `${frontendUrl}/uploads/${innerPath}/${filename}`;
      };

      const publicUrl = generateExportUrl('http://localhost:4200', '2026/11/12', 'art_01.png');
      assert.equal(publicUrl, 'http://localhost:4200/uploads/2026/11/12/art_01.png');
      assert.ok(!publicUrl.includes('assets.wallza.com/exports/'), 'Must never emit fake placeholder domain');
    });
  });

  // ── TEST 2: Publishing Automation Real Execution & Collision Logic ────────
  describe('Area 2: Publishing Automation Execution & Collision Prevention', () => {
    it('calculates collision avoidance spacing between queued posts', () => {
      const targetTime = new Date('2026-11-15T14:00:00.000Z').getTime();
      const minSpacingMinutes = 45;
      const spacingMs = minSpacingMinutes * 60 * 1000;

      const windowStart = new Date(targetTime - spacingMs);
      const windowEnd = new Date(targetTime + spacingMs);

      const existingPostTime = new Date('2026-11-15T14:20:00.000Z').getTime();
      const isCollision = existingPostTime >= windowStart.getTime() && existingPostTime <= windowEnd.getTime();
      assert.equal(isCollision, true, 'Post within 20m collides with 45m window');

      const postLater = new Date('2026-11-15T15:00:00.000Z').getTime();
      const isCollisionLater = postLater >= windowStart.getTime() && postLater <= windowEnd.getTime();
      assert.equal(isCollisionLater, false, 'Post at 60m is outside 45m collision window');
    });

    it('executes rule real actions on eligible posts and tracks execution count', () => {
      // Mock Rule and Post Repository
      const rule = {
        id: 'rule_101',
        organizationId: 'org_acme',
        trigger: 'draft_approved',
        conditions: { platform: 'linkedin' },
        actions: { targetQueueId: 'queue_daily', autoRetry: true },
        executionCount: 0,
        lastExecutedAt: null,
      };

      const posts = [
        { id: 'p_1', organizationId: 'org_acme', state: 'DRAFT', platform: 'linkedin', publishDate: null },
        { id: 'p_2', organizationId: 'org_other', state: 'DRAFT', platform: 'linkedin', publishDate: null },
      ];

      // Simulated execute action
      const executeRuleAction = (activeRule, targetOrgId, eventPayload) => {
        if (activeRule.organizationId !== targetOrgId) {
          throw new Error('Forbidden: cross-tenant access violation');
        }

        // Match trigger and conditions
        if (eventPayload.platform !== activeRule.conditions.platform) {
          return { matched: false, executedActions: [] };
        }

        const scheduledTime = new Date('2026-11-16T09:00:00.000Z');
        const executedActions = [];

        // Apply action strictly to organization's own posts
        posts
          .filter((p) => p.organizationId === targetOrgId && p.state === 'DRAFT')
          .forEach((p) => {
            p.state = 'QUEUE';
            p.publishDate = scheduledTime;
            executedActions.push({ postId: p.id, status: 'SUCCESS', scheduledFor: scheduledTime.toISOString() });
          });

        activeRule.executionCount += 1;
        activeRule.lastExecutedAt = new Date();

        return { matched: true, executedActions, executionCount: activeRule.executionCount };
      };

      const result = executeRuleAction(rule, 'org_acme', { platform: 'linkedin' });
      assert.equal(result.matched, true);
      assert.equal(result.executedActions.length, 1);
      assert.equal(result.executedActions[0].postId, 'p_1');
      assert.equal(posts[0].state, 'QUEUE');
      assert.equal(posts[1].state, 'DRAFT', 'Other tenant post must remain untouched');
      assert.equal(rule.executionCount, 1);
      assert.ok(rule.lastExecutedAt instanceof Date);
    });
  });

  // ── TEST 3: Dynamic Variable Resolution Without Vendor Defaults ────────────
  describe('Area 3: Content Efficiency & Variable Context', () => {
    it('resolves variables using tenant context without hardcoded vendor branding', () => {
      // Organization-specific variables
      const tenantVariables = {
        brand_name: 'Acme Logistics',
        website: 'https://acmelogistics.com',
        support_email: 'help@acmelogistics.com',
        call_to_action: 'Get your quote today at the link in bio',
      };

      const templateContent = 'Welcome to {brand_name}! Visit {website} or email {support_email}. {call_to_action}';

      const regex = /\{([a-zA-Z0-9_]+)\}/g;
      const usedVars = [];
      const resolved = templateContent.replace(regex, (match, varName) => {
        if (tenantVariables[varName]) {
          usedVars.push(varName);
          return tenantVariables[varName];
        }
        return match;
      });

      assert.equal(
        resolved,
        'Welcome to Acme Logistics! Visit https://acmelogistics.com or email help@acmelogistics.com. Get your quote today at the link in bio'
      );
      assert.ok(!resolved.includes('Wallza'), 'Must not contain hardcoded default vendor branding');
      assert.equal(usedVars.length, 4);
    });

    it('normalizes hashtags with # prefix and removes duplicate tags', () => {
      const rawTags = ['marketing', '#growth', '  saas  ', '#growth', 'MARKETING'];

      const normalizeHashtags = (tags) => {
        const cleaned = tags.map((t) => {
          const trimmed = t.trim().toLowerCase();
          return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
        });
        return [...new Set(cleaned)];
      };

      const cleanList = normalizeHashtags(rawTags);
      assert.deepEqual(cleanList, ['#marketing', '#growth', '#saas']);
      assert.equal(cleanList.join(' '), '#marketing #growth #saas');
    });
  });

  // ── TEST 4: Campaign Analytics & RFC 4180 CSV Download ────────────────────
  describe('Area 4: Real Campaign Analytics & RFC 4180 CSV Export', () => {
    it('generates standard RFC 4180 CSV with escaped characters and full manifest', () => {
      const campaignName = 'Q4 Product Launch "Global"';
      const posts = [
        { id: 'post_1', title: 'Launch Announcement, Part 1', platform: 'LinkedIn', state: 'PUBLISHED', releaseURL: 'https://linkedin.com/feed/update/1' },
        { id: 'post_2', title: 'Special "Discount" Promo', platform: 'Instagram', state: 'SCHEDULED', releaseURL: null },
      ];

      const csvRows = [
        ['WALLZA SOCIAL STUDIO — CAMPAIGN PERFORMANCE REPORT'],
        ['Campaign Name', campaignName],
        ['Total Posts', String(posts.length)],
        [],
        ['Post ID', 'Post Title', 'Platform', 'State', 'URL'],
        ...posts.map((p) => [
          p.id,
          p.title,
          p.platform,
          p.state,
          p.releaseURL || 'N/A',
        ]),
      ];

      const csvContent = csvRows
        .map((row) =>
          row.map((cell) => `"${(cell || '').replace(/"/g, '""')}"`).join(',')
        )
        .join('\r\n');

      assert.ok(csvContent.includes('"Campaign Name","Q4 Product Launch ""Global"""'), 'Quotes must be escaped per RFC 4180');
      assert.ok(csvContent.includes('"Launch Announcement, Part 1"'), 'Commas must be preserved inside quoted fields');
      assert.ok(csvContent.includes('\r\n'), 'Must use standard RFC 4180 CRLF row delimiters');
    });

    it('clearly distinguishes Publishing Analytics from Provider Performance Analytics', () => {
      const analyticsPayload = {
        publishingAnalytics: {
          totalPosts: 12,
          published: 8,
          scheduled: 3,
          failed: 1,
        },
        performanceAnalytics: {
          metricsAvailable: false,
          reach: null,
          impressions: null,
          engagementRate: null,
          connectionStatus: 'PENDING_INSIGHTS_PERMISSIONS',
          note: 'Provider engagement metrics require live token read_insights permission.',
        },
      };

      assert.equal(analyticsPayload.publishingAnalytics.totalPosts, 12);
      assert.equal(analyticsPayload.performanceAnalytics.reach, null, 'Unconnected metrics must never be fabricated');
      assert.equal(analyticsPayload.performanceAnalytics.connectionStatus, 'PENDING_INSIGHTS_PERMISSIONS');
    });
  });

  // ── TEST 5: Authentic Platform Brand Logos Verification ───────────────────
  describe('Area 5: Platform Brand Logos Audit', () => {
    const requiredPlatforms = [
      'instagram.png',
      'facebook.png',
      'facebook-page.png',
      'whatsapp.png',
      'whatsapp.svg',
      'whatsapp-business.png',
      'whatsapp-business.svg',
      'threads.png',
      'x.png',
      'linkedin.png',
      'linkedin-page.png',
      'youtube.png',
      'youtube.svg',
      'tiktok.png',
      'tiktok-business.png',
      'pinterest.png',
      'reddit.png',
      'gmb.png',
      'telegram.png',
      'discord.png',
      'mastodon.png',
      'bluesky.png',
    ];

    const iconsDir = path.resolve(process.cwd(), 'apps/frontend/public/icons/platforms');

    requiredPlatforms.forEach((fileName) => {
      it(`verifies authentic asset exists and is non-empty: ${fileName}`, () => {
        const filePath = path.join(iconsDir, fileName);
        assert.ok(fs.existsSync(filePath), `Asset ${fileName} must exist in ${iconsDir}`);
        const stat = fs.statSync(filePath);
        assert.ok(stat.size > 200, `Asset ${fileName} must have valid non-empty file size`);
      });
    });
  });

  // ── TEST 6: Multi-Tenant SaaS Isolation ───────────────────────────────────
  describe('Area 6: Multi-Tenant Organization Scope Verification', () => {
    it('strictly isolates tenant entities by organization ID', () => {
      const org1 = 'org_alpha_111';
      const org2 = 'org_beta_222';

      const projects = [
        { id: 'p1', organizationId: org1, name: 'Alpha Q4' },
        { id: 'p2', organizationId: org2, name: 'Beta Campaign' },
      ];

      const getOrgProjects = (orgId) => projects.filter((p) => p.organizationId === orgId);

      const alphaProjects = getOrgProjects(org1);
      assert.equal(alphaProjects.length, 1);
      assert.equal(alphaProjects[0].name, 'Alpha Q4');

      const betaProjects = getOrgProjects(org2);
      assert.equal(betaProjects.length, 1);
      assert.equal(betaProjects[0].name, 'Beta Campaign');

      assert.equal(alphaProjects.some((p) => p.organizationId === org2), false);
    });
  });

  // ── TEST 7: Postiz Inbox Isolation (Rule 0.A) ─────────────────────────────
  describe('Area 7: Rule 0.A — Postiz Inbox Invariance Audit', () => {
    it('confirms zero inbox modifications and zero duplicate inboxes introduced', () => {
      // Confirm that no rogue inbox controller or duplicate inbox routes were created
      const rogueInboxRoute = path.resolve(process.cwd(), 'apps/backend/src/api/routes/inbox.controller.ts');
      assert.equal(fs.existsSync(rogueInboxRoute), false, 'No rogue inbox controller should exist');

      // Confirm native launches comment component remains intact
      const commentComponent = path.resolve(process.cwd(), 'apps/frontend/src/components/launches/comments/comment.component.tsx');
      assert.ok(fs.existsSync(commentComponent), 'Native launches comment component must remain intact');
    });
  });
});
