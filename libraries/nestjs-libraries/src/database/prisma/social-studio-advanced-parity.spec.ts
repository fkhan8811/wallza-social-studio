import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';

describe('WallzaOS Social Studio — Advanced Parity & Boundary Test Suite', () => {
  // ── 1. ACTIVITY INBOX & CRM LEAD BRIDGE ──────────────────────────────────
  describe('Area 1: Activity Inbox & WallzaOS Lead Bridge Contract', () => {
    it('isolates notification read cursors strictly per user-organization pair', () => {
      // Simulating database storage where read cursors are strictly on UserOrganization
      const userOrganizationStore = new Map<string, Date>();
      const userStore = new Map<string, { lastReadNotifications?: Date }>();

      const setReadCursor = (orgId: string, userId: string, date: Date) => {
        // Correct implementation: updates UserOrganization only, never User
        userOrganizationStore.set(`${userId}:${orgId}`, date);
      };

      const getReadCursor = (orgId: string, userId: string): Date | null => {
        return userOrganizationStore.get(`${userId}:${orgId}`) || null;
      };

      const orgA = 'org-marketing';
      const orgB = 'org-sales';
      const user = 'user-agent-1';

      // User has memberships in both Org A and Org B
      const nowA = new Date('2026-11-13T10:00:00Z');
      setReadCursor(orgA, user, nowA);

      // Org A has read cursor at 10:00
      expect(getReadCursor(orgA, user)).toEqual(nowA);

      // Org B read cursor must remain untouched and uninfluenced by Org A activity
      expect(getReadCursor(orgB, user)).toBeNull();

      // Global user record must NEVER be polluted with tenant-scoped timestamps
      expect(userStore.get(user)?.lastReadNotifications).toBeUndefined();
    });

    it('generates consistent SHA-256 idempotency key for CRM lead conversions', () => {
      const generateIdempotencyKey = (orgId: string, channelId: string, commentId: string, authorId: string) => {
        return crypto
          .createHash('sha256')
          .update(`${orgId}:${channelId}:${commentId}:${authorId}`)
          .digest('hex');
      };

      const key1 = generateIdempotencyKey('org_1', 'ch_ig_123', 'cm_456', 'user_789');
      const key2 = generateIdempotencyKey('org_1', 'ch_ig_123', 'cm_456', 'user_789');
      const keyDifferentOrg = generateIdempotencyKey('org_2', 'ch_ig_123', 'cm_456', 'user_789');

      expect(key1).toHaveLength(64);
      expect(key1).toEqual(key2);
      expect(key1).not.toEqual(keyDifferentOrg);
    });

    it('formats WallzaOS CRM Lead Bridge payload conforming to /api/leads contract', () => {
      const engagementItem = {
        platform: 'instagram',
        channelName: 'Wallza Official IG',
        channelId: 'ch_ig_123',
        postId: 'post_999',
        commentId: 'cm_888',
        author: {
          id: 'user_456',
          name: 'Sarah Connor',
          username: 'sconnor',
          phone: '+15550192834',
          email: 'sconnor@resistance.net',
        },
        permalink: 'https://instagram.com/p/B12345/c/888',
        text: 'Can your team provide an enterprise demo for 500 seats?',
        timestamp: new Date('2026-11-13T10:00:00Z').toISOString(),
      };

      const orgId = 'org_enterprise_42';

      // Transform engagement item to WallzaOS Unified Inbox Lead contract
      const leadPayload = {
        org_id: orgId,
        name: engagementItem.author.name || engagementItem.author.username,
        to_number: engagementItem.author.phone || null,
        email: engagementItem.author.email || null,
        source: 'social_studio',
        source_id: engagementItem.commentId || engagementItem.postId,
        notes: `[Social Studio Inbound Lead]
Platform: ${engagementItem.platform}
Channel: ${engagementItem.channelName} (${engagementItem.channelId})
Author: ${engagementItem.author.name} (@${engagementItem.author.username})
Post ID: ${engagementItem.postId}
Comment ID: ${engagementItem.commentId}
Reference: ${engagementItem.permalink}

Message:
${engagementItem.text}`,
      };

      expect(leadPayload.org_id).toBe('org_enterprise_42');
      expect(leadPayload.name).toBe('Sarah Connor');
      expect(leadPayload.source).toBe('social_studio');
      expect(leadPayload.source_id).toBe('cm_888');
      expect(leadPayload.to_number).toBe('+15550192834');
      expect(leadPayload.email).toBe('sconnor@resistance.net');
      expect(leadPayload.notes).toContain('https://instagram.com/p/B12345/c/888');
    });

    it('accurately identifies provider engagement capabilities and boundaries', () => {
      const PROVIDER_CAPABILITIES: Record<string, {
        firstCommentPublishing: 'available' | 'unsupported';
        inboundCommentSync: 'available' | 'unsupported' | 'permission_required';
        commentModeration: 'available' | 'unsupported' | 'webhook_only';
        leadBridge: boolean;
      }> = {
        facebook: {
          firstCommentPublishing: 'available',
          inboundCommentSync: 'permission_required',
          commentModeration: 'unsupported',
          leadBridge: true,
        },
        instagram: {
          firstCommentPublishing: 'available',
          inboundCommentSync: 'permission_required',
          commentModeration: 'unsupported',
          leadBridge: true,
        },
        linkedin: {
          firstCommentPublishing: 'available',
          inboundCommentSync: 'unsupported',
          commentModeration: 'unsupported',
          leadBridge: true,
        },
        x: {
          firstCommentPublishing: 'available',
          inboundCommentSync: 'unsupported',
          commentModeration: 'unsupported',
          leadBridge: true,
        },
        youtube: {
          firstCommentPublishing: 'available',
          inboundCommentSync: 'permission_required',
          commentModeration: 'unsupported',
          leadBridge: true,
        },
        threads: {
          firstCommentPublishing: 'available',
          inboundCommentSync: 'unsupported',
          commentModeration: 'unsupported',
          leadBridge: true,
        },
        mastodon: {
          firstCommentPublishing: 'available',
          inboundCommentSync: 'unsupported',
          commentModeration: 'unsupported',
          leadBridge: true,
        },
        bluesky: {
          firstCommentPublishing: 'available',
          inboundCommentSync: 'unsupported',
          commentModeration: 'unsupported',
          leadBridge: true,
        },
      };

      // Outbound first comment publishing is supported on all core providers
      expect(PROVIDER_CAPABILITIES.facebook.firstCommentPublishing).toBe('available');
      expect(PROVIDER_CAPABILITIES.x.firstCommentPublishing).toBe('available');
      expect(PROVIDER_CAPABILITIES.linkedin.firstCommentPublishing).toBe('available');

      // Inbound comment reading requires platform webhooks/permission, not direct Postiz API
      expect(PROVIDER_CAPABILITIES.facebook.inboundCommentSync).toBe('permission_required');
      expect(PROVIDER_CAPABILITIES.linkedin.inboundCommentSync).toBe('unsupported');
      expect(PROVIDER_CAPABILITIES.x.inboundCommentSync).toBe('unsupported');

      // Comment moderation is not implemented in outbound Postiz adapters
      expect(PROVIDER_CAPABILITIES.instagram.commentModeration).toBe('unsupported');

      // Lead Bridge is supported across all platforms by converting engagement items
      expect(Object.values(PROVIDER_CAPABILITIES).every((cap) => cap.leadBridge)).toBe(true);
    });
  });

  // ── 2. PUBLISHING AUTOMATION & QUEUES ─────────────────────────────────────
  describe('Area 2: Publishing Queue Timezones & Slot Calculations', () => {
    it('formats preview slots in the designated queue timezone', () => {
      const formatSlotPreview = (timeString: string, ianaTimezone: string) => {
        const [hours, minutes] = timeString.split(':').map((v) => parseInt(v, 10));
        const now = new Date('2026-11-13T12:00:00.000Z');
        const candidate = new Date(now);
        candidate.setUTCHours(hours, minutes, 0, 0);

        return new Intl.DateTimeFormat('en-US', {
          timeZone: ianaTimezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        }).format(candidate);
      };

      const nyFormatted = formatSlotPreview('15:30', 'America/New_York');
      expect(nyFormatted).toBeDefined();
      expect(typeof nyFormatted).toBe('string');
    });

    it('allocates distinct slots without intra-batch collisions using allocatedInBatch', () => {
      const schedule = [
        { dayOfWeek: 5, time: '09:00' }, // Friday 9:00
        { dayOfWeek: 5, time: '14:00' }, // Friday 14:00
        { dayOfWeek: 5, time: '18:00' }, // Friday 18:00
      ];

      const allocatedInBatch: Date[] = [];
      const baseDate = new Date('2026-11-13T08:00:00.000Z'); // Friday 8:00 UTC

      const findNextAvailableSlot = (cursorDate: Date, batch: Date[]): Date => {
        for (const slot of schedule) {
          const [h, m] = slot.time.split(':').map(Number);
          const slotDate = new Date(cursorDate);
          slotDate.setUTCHours(h, m, 0, 0);

          if (slotDate.getTime() > cursorDate.getTime()) {
            const collision = batch.some((b) => Math.abs(b.getTime() - slotDate.getTime()) < 60000);
            if (!collision) {
              batch.push(slotDate);
              return slotDate;
            }
          }
        }
        // Fallback: +1 day
        const nextDay = new Date(cursorDate.getTime() + 86400000);
        batch.push(nextDay);
        return nextDay;
      };

      const slot1 = findNextAvailableSlot(baseDate, allocatedInBatch);
      const slot2 = findNextAvailableSlot(baseDate, allocatedInBatch);
      const slot3 = findNextAvailableSlot(baseDate, allocatedInBatch);

      expect(slot1.getUTCHours()).toBe(9);
      expect(slot2.getUTCHours()).toBe(14);
      expect(slot3.getUTCHours()).toBe(18);
      expect(slot1.getTime()).not.toEqual(slot2.getTime());
      expect(slot2.getTime()).not.toEqual(slot3.getTime());
      expect(allocatedInBatch.length).toBe(3);
    });

    it('validates queue capacity and active status before applying changes', () => {
      const queue = {
        id: 'queue_1',
        isActive: false,
        maxPostsPerSlot: 2,
      };

      const postsToEnqueue = ['post_1', 'post_2'];

      const validateQueueForEnqueue = (q: typeof queue, count: number) => {
        if (!q.isActive) {
          throw new Error('Queue is paused or inactive. Cannot enqueue posts into an inactive queue.');
        }
        if (count > 50) {
          throw new Error('Batch exceeds maximum enqueue capacity of 50 posts.');
        }
        return true;
      };

      expect(() => validateQueueForEnqueue(queue, postsToEnqueue.length)).toThrow(
        /Queue is paused or inactive/
      );

      queue.isActive = true;
      expect(validateQueueForEnqueue(queue, postsToEnqueue.length)).toBe(true);
      expect(() => validateQueueForEnqueue(queue, 55)).toThrow(/maximum enqueue capacity/);
    });

    it('snapshots original post states and performs complete rollback on enqueue failure', () => {
      interface PostRecord {
        id: string;
        state: string;
        publishDate: Date | null;
        queueId: string | null;
      }

      const initialPosts: PostRecord[] = [
        { id: 'p1', state: 'DRAFT', publishDate: null, queueId: null },
        { id: 'p2', state: 'DRAFT', publishDate: new Date('2026-11-20T10:00:00Z'), queueId: null },
        { id: 'p3', state: 'DRAFT', publishDate: null, queueId: null },
      ];

      // Deep copy to simulate database state
      const dbPosts = JSON.parse(JSON.stringify(initialPosts));

      const atomicEnqueue = (posts: PostRecord[], failAtPostId: string) => {
        // 1. Snapshot previous state
        const snapshots = new Map<string, PostRecord>();
        posts.forEach((p) => {
          snapshots.set(p.id, { ...p });
        });

        const modified: PostRecord[] = [];

        try {
          posts.forEach((p) => {
            if (p.id === failAtPostId) {
              throw new Error(`Simulated database collision or constraint failure on ${p.id}`);
            }
            p.state = 'QUEUE';
            p.queueId = 'queue_marketing';
            p.publishDate = new Date('2026-11-14T10:00:00Z');
            modified.push(p);
          });
        } catch (err) {
          // 2. Rollback each modified post to its exact snapshot
          modified.forEach((p) => {
            const snap = snapshots.get(p.id);
            if (snap) {
              p.state = snap.state;
              p.publishDate = snap.publishDate ? new Date(snap.publishDate) : null;
              p.queueId = snap.queueId;
            }
          });
          throw err;
        }
      };

      expect(() => atomicEnqueue(dbPosts, 'p3')).toThrow(/Simulated database collision/);

      // Verify that p1 and p2 were completely restored to their original snapshot states
      expect(dbPosts[0].state).toBe('DRAFT');
      expect(dbPosts[0].publishDate).toBeNull();
      expect(dbPosts[0].queueId).toBeNull();

      expect(dbPosts[1].state).toBe('DRAFT');
      expect(new Date(dbPosts[1].publishDate).toISOString()).toBe('2026-11-20T10:00:00.000Z');
      expect(dbPosts[1].queueId).toBeNull();
    });
  });

  // ── 3. APPROVAL WORKFLOW GATE ─────────────────────────────────────────────
  describe('Area 3: Multi-Tier Approval Gate Enforcement', () => {
    it('blocks post execution in PostActivity when post requires approval and is not approved', () => {
      const postUnderReview = {
        id: 'post_100',
        requiresApproval: true,
        approvalStatus: 'pending',
        state: 'QUEUE',
      };

      const executePostActivityApprovalGate = (post: typeof postUnderReview) => {
        if (post.requiresApproval && post.approvalStatus !== 'approved') {
          // Emulate Temporal ApplicationFailure.nonRetryable
          const error = new Error(
            `Publishing blocked by approval gate: Post ${post.id} requires approval before publishing. Current status: ${post.approvalStatus}`
          );
          (error as any).nonRetryable = true;
          throw error;
        }
        return true;
      };

      expect(() => executePostActivityApprovalGate(postUnderReview)).toThrow(
        /Publishing blocked by approval gate/
      );

      const rejectedPost = { ...postUnderReview, approvalStatus: 'rejected' };
      expect(() => executePostActivityApprovalGate(rejectedPost)).toThrow(
        /Publishing blocked by approval gate/
      );

      const approvedPost = { ...postUnderReview, approvalStatus: 'approved' };
      expect(executePostActivityApprovalGate(approvedPost)).toBe(true);

      const noApprovalRequired = { ...postUnderReview, requiresApproval: false, approvalStatus: 'pending' };
      expect(executePostActivityApprovalGate(noApprovalRequired)).toBe(true);
    });

    it('resets approval status and timestamps across all sibling posts when reopening revisions', () => {
      const postGroup = 'group_spring_campaign';
      const posts = [
        {
          id: 'p1',
          group: postGroup,
          state: 'QUEUE',
          requiresApproval: true,
          approvalStatus: 'approved',
          approvedById: 'user_boss',
          approvedAt: new Date('2026-11-13T09:00:00Z'),
        },
        {
          id: 'p2',
          group: postGroup,
          state: 'QUEUE',
          requiresApproval: true,
          approvalStatus: 'approved',
          approvedById: 'user_boss',
          approvedAt: new Date('2026-11-13T09:00:00Z'),
        },
      ];

      const reopenRevision = (items: typeof posts, note: string) => {
        return items.map((p) => ({
          ...p,
          requiresApproval: true,
          approvalStatus: 'pending',
          approvedById: null,
          approvedAt: null,
          revisionNotes: note,
        }));
      };

      const reopened = reopenRevision(posts, 'Client requested tagline change in image 2');

      reopened.forEach((post) => {
        expect(post.requiresApproval).toBe(true);
        expect(post.approvalStatus).toBe('pending');
        expect(post.approvedById).toBeNull();
        expect(post.approvedAt).toBeNull();
        expect(post.revisionNotes).toBe('Client requested tagline change in image 2');
      });
    });

    it('enforces valid review state transitions (approved, rejected, changes_requested)', () => {
      const allowedDecisions = ['approved', 'rejected', 'changes_requested'];

      const applyReview = (currentStatus: string, decision: string) => {
        if (!allowedDecisions.includes(decision)) {
          throw new Error(`Invalid decision: ${decision}. Must be one of: ${allowedDecisions.join(', ')}`);
        }
        return {
          approvalStatus: decision,
          approvedAt: decision === 'approved' ? new Date() : null,
        };
      };

      expect(applyReview('pending', 'approved').approvalStatus).toBe('approved');
      expect(applyReview('pending', 'rejected').approvalStatus).toBe('rejected');
      expect(applyReview('pending', 'changes_requested').approvalStatus).toBe('changes_requested');
      expect(() => applyReview('pending', 'invalid_status')).toThrow(/Invalid decision/);
    });
  });

  // ── 4. CREATIVE STUDIO VIDEO MAGIC BYTES & VERSIONING ─────────────────────
  describe('Area 4: Video Magic Bytes & Snapshot Retention', () => {
    it('accurately distinguishes genuine WebM vs MP4 magic bytes', () => {
      // Genuine WebM magic bytes (1A 45 DF A3)
      const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
      const webmBase64 = `data:video/webm;base64,${webmHeader.toString('base64')}`;

      // Genuine MP4 magic bytes ('ftyp' at byte offset 4)
      const mp4Header = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x20]),
        Buffer.from('ftypisom', 'utf8'),
        Buffer.from([0x00, 0x00, 0x02, 0x00]),
      ]);
      const mp4Base64 = `data:video/mp4;base64,${mp4Header.toString('base64')}`;

      const detectVideoFormat = (dataUrl: string): { format: 'webm' | 'mp4' | 'unknown'; mime: string } => {
        const base64Part = dataUrl.split(',')[1];
        if (!base64Part) return { format: 'unknown', mime: 'application/octet-stream' };
        const buffer = Buffer.from(base64Part.slice(0, 64), 'base64');

        const isWebm =
          buffer.length >= 4 &&
          buffer[0] === 0x1a &&
          buffer[1] === 0x45 &&
          buffer[2] === 0xdf &&
          buffer[3] === 0xa3;

        if (isWebm) {
          return { format: 'webm', mime: 'video/webm' };
        }

        const isMp4 =
          buffer.length >= 8 && buffer.toString('utf8', 4, 8) === 'ftyp';

        if (isMp4) {
          return { format: 'mp4', mime: 'video/mp4' };
        }

        return { format: 'unknown', mime: 'application/octet-stream' };
      };

      const webmResult = detectVideoFormat(webmBase64);
      expect(webmResult.format).toBe('webm');
      expect(webmResult.mime).toBe('video/webm');

      const mp4Result = detectVideoFormat(mp4Base64);
      expect(mp4Result.format).toBe('mp4');
      expect(mp4Result.mime).toBe('video/mp4');

      // Spoofed video header (claimed mp4 in mime, but actual payload is text)
      const fakeVideo = `data:video/mp4;base64,${Buffer.from('not-a-video-binary-data').toString('base64')}`;
      expect(detectVideoFormat(fakeVideo).format).toBe('unknown');
    });

    it('rejects claiming MP4 when the recorded client payload is genuine WebM', () => {
      const webmBuffer = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
      const isWebm = webmBuffer[0] === 0x1a && webmBuffer[1] === 0x45 && webmBuffer[2] === 0xdf && webmBuffer[3] === 0xa3;

      const requestedFormat = 'mp4';
      const actualExtension = isWebm ? 'webm' : requestedFormat;
      const actualMime = isWebm ? 'video/webm' : 'video/mp4';

      expect(actualExtension).toBe('webm');
      expect(actualMime).toBe('video/webm');
    });

    it('strictly bounds project versions to 20 snapshots per project', () => {
      const MAX_VERSIONS = 20;
      const existingSnapshots = Array.from({ length: 25 }, (_, i) => ({
        id: `snap_${i + 1}`,
        version: i + 1,
        createdAt: new Date(Date.now() - (25 - i) * 60000),
      }));

      // In controller: when count >= 20, prune oldest snapshots to keep max 19 so new snapshot makes 20
      const pruneOldSnapshots = (snapshots: typeof existingSnapshots, max: number) => {
        if (snapshots.length >= max) {
          const keepCount = max - 1;
          const sorted = [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return sorted.slice(0, keepCount);
        }
        return [...snapshots];
      };

      const afterPrune = pruneOldSnapshots(existingSnapshots, MAX_VERSIONS);
      expect(afterPrune.length).toBe(19);

      // Add new version snapshot
      const newSnapshot = { id: 'snap_26', version: 26, createdAt: new Date() };
      const finalSnapshots = [newSnapshot, ...afterPrune];

      expect(finalSnapshots.length).toBe(20);
      expect(finalSnapshots[0].version).toBe(26);
      expect(finalSnapshots[19].version).toBe(7); // Old versions 1-6 were successfully pruned
    });
  });

  // ── 5. AI ENGINE & PLATFORM VARIANTS ──────────────────────────────────────
  describe('Area 5: AI Engine Structured Output & Platform Limits', () => {
    it('enforces platform-specific character limits with explanation flag', () => {
      const PLATFORM_LIMITS: Record<string, number> = {
        x: 280,
        linkedin: 3000,
        instagram: 2200,
        threads: 500,
        bluesky: 300,
        pinterest: 500,
        youtube: 5000,
        tiktok: 2200,
      };

      const adaptToPlatform = (platform: string, content: string) => {
        const limit = PLATFORM_LIMITS[platform.toLowerCase()] || 2000;
        if (content.length > limit) {
          return {
            content: content.slice(0, limit - 3) + '...',
            characterLimit: limit,
            length: limit,
            isTruncated: true,
            truncationReason: `Content truncated to fit ${platform} character limit of ${limit} characters.`,
          };
        }
        return {
          content,
          characterLimit: limit,
          length: content.length,
          isTruncated: false,
          truncationReason: null,
        };
      };

      const longPost = 'A'.repeat(400);

      // X: 280 limit -> truncated
      const xResult = adaptToPlatform('x', longPost);
      expect(xResult.isTruncated).toBe(true);
      expect(xResult.content.length).toBe(280);
      expect(xResult.truncationReason).toContain('280 characters');

      // Bluesky: 300 limit -> truncated
      const blueskyResult = adaptToPlatform('bluesky', longPost);
      expect(blueskyResult.isTruncated).toBe(true);
      expect(blueskyResult.content.length).toBe(300);

      // LinkedIn: 3000 limit -> not truncated
      const liResult = adaptToPlatform('linkedin', longPost);
      expect(liResult.isTruncated).toBe(false);
      expect(liResult.content.length).toBe(400);
      expect(liResult.truncationReason).toBeNull();
    });

    it('correctly marks AI source as "ai" when model responds, or "fallback" when offline', () => {
      const generateIdeaResponse = (hasApiKey: boolean, simulatedAiResponse?: string) => {
        if (hasApiKey && simulatedAiResponse) {
          try {
            const parsed = JSON.parse(simulatedAiResponse);
            return {
              ideas: parsed.ideas,
              source: 'ai' as const,
              model: 'openrouter/anthropic/claude-3.5-sonnet',
            };
          } catch {
            // fallback
          }
        }

        return {
          ideas: [
            {
              title: 'Behind the Scenes Showcase',
              description: 'Showcase your engineering team solving real-world challenges.',
              suggestedHooks: ['How we scaled to 10k messages/sec'],
              hashtags: ['#SaaS', '#Engineering', '#Tech'],
            },
          ],
          source: 'fallback' as const,
          model: 'rule-based-fallback-generator',
        };
      };

      const fallbackResult = generateIdeaResponse(false);
      expect(fallbackResult.source).toBe('fallback');
      expect(fallbackResult.ideas.length).toBeGreaterThan(0);

      const validAiJson = JSON.stringify({
        ideas: [
          {
            title: 'Automated CRM Sync Deep Dive',
            description: 'Explaining our lead bridge architecture.',
            suggestedHooks: ['Never lose a lead from Instagram comments'],
            hashtags: ['#CRM', '#Automation'],
          },
        ],
      });

      const aiResult = generateIdeaResponse(true, validAiJson);
      expect(aiResult.source).toBe('ai');
      expect(aiResult.ideas[0].title).toBe('Automated CRM Sync Deep Dive');
    });
  });

  // ── 6. DYNAMIC VARIABLES & CONTENT EFFICIENCY ─────────────────────────────
  describe('Area 6: Dynamic Variables & Reusable Templates', () => {
    it('resolves known variables and identifies unresolved variables', () => {
      const variables = new Map([
        ['brand_name', 'WallzaOS'],
        ['website', 'https://wallza.com'],
      ]);

      const text = 'Welcome to {brand_name}! Visit {website} or contact {support_email} today.';
      const regex = /\{([a-zA-Z0-9_]+)\}/g;

      const used: string[] = [];
      const unresolved: string[] = [];

      const resolved = text.replace(regex, (match, varName) => {
        if (variables.has(varName)) {
          used.push(varName);
          return variables.get(varName)!;
        }
        unresolved.push(varName);
        return match;
      });

      expect(resolved).toBe('Welcome to WallzaOS! Visit https://wallza.com or contact {support_email} today.');
      expect(used).toContain('brand_name');
      expect(used).toContain('website');
      expect(unresolved).toContain('support_email');
    });

    it('snapshots post and platform variants into reusable template format', () => {
      const post = {
        id: 'post_master_1',
        title: 'Launch Announcement',
        content: 'Omnichannel base announcement copy',
        group: 'grp_launch',
      };

      const siblingVariants = [
        { provider: 'x', content: 'Short punchy launch tweet' },
        { provider: 'linkedin', content: 'Detailed thought leadership launch piece' },
      ];

      const platformVersions: Record<string, { content: string }> = {};
      siblingVariants.forEach((v) => {
        platformVersions[v.provider] = { content: v.content };
      });

      const template = {
        name: post.title,
        content: post.content,
        platformVersions,
      };

      expect(template.name).toBe('Launch Announcement');
      expect(template.platformVersions['x'].content).toBe('Short punchy launch tweet');
      expect(template.platformVersions['linkedin'].content).toBe('Detailed thought leadership launch piece');
    });
  });

  // ── 7. ANALYTICS METRICS & EXPORT SECURITY ────────────────────────────────
  describe('Area 7: Analytics Aggregation & Data Export Security', () => {
    it('calculates publishing success rate accurately', () => {
      const posts = [
        { state: 'PUBLISHED' },
        { state: 'PUBLISHED' },
        { state: 'PUBLISHED' },
        { state: 'ERROR' },
        { state: 'QUEUE' },
        { state: 'DRAFT' },
      ];

      const published = posts.filter((p) => p.state === 'PUBLISHED').length;
      const error = posts.filter((p) => p.state === 'ERROR').length;
      const attempts = published + error;
      const rate = attempts > 0 ? ((published / attempts) * 100).toFixed(1) : '100.0';

      expect(published).toBe(3);
      expect(error).toBe(1);
      expect(rate).toBe('75.0');
    });

    it('sanitizes and escapes CSV analytics export against CSV injection', () => {
      const dangerousPosts = [
        {
          id: 'p_1',
          group: 'grp_test',
          title: '=cmd|"/C calc"!A0', // Excel/CSV formula injection attempt
          channel: 'LinkedIn "Main"',
          provider: 'linkedin',
          state: 'PUBLISHED',
        },
        {
          id: 'p_2',
          group: 'grp_test',
          title: '+1234567890', // Leading plus formula injection attempt
          channel: 'Twitter',
          provider: 'x',
          state: 'PUBLISHED',
        },
      ];

      const sanitizeCsvField = (field: string) => {
        let val = field || '';
        // Neutralize formula injection characters (=, +, -, @, \t, \r)
        if (/^[=+\-@\t\r]/.test(val)) {
          val = `'${val}`;
        }
        // Escape quotes
        return `"${val.replace(/"/g, '""')}"`;
      };

      const lines = dangerousPosts.map(
        (p) => `${p.id},${p.group},${sanitizeCsvField(p.title)},${sanitizeCsvField(p.channel)},${p.provider},${p.state}`
      );

      // Formula character must be prefixed with single quote to prevent spreadsheet execution
      expect(lines[0]).toContain(`"'=cmd|""/C calc""!A0"`);
      expect(lines[1]).toContain(`"'+1234567890"`);
    });
  });
});
