'use client';

import { FC, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';

type ActivityKind = 'notification' | 'comment' | 'review';

type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  message: string;
  createdAt: string;
  href: string;
  unread: boolean;
  resolved?: boolean;
  channel?: string | null;
  platform?: string | null;
  postGroup?: string | null;
  actor?: string | null;
  leadEligible?: boolean;
  metadata?: Record<string, any>;
};

type ActivityResponse = {
  items: ActivityItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  lastReadAt: string;
  counts: {
    totalItems: number;
    notifications: number;
    comments: number;
    reviews: number;
    unreadNotifications: number;
  };
  scope: 'publishing_activity';
};

interface EngagementCapability {
  integrationId: string;
  channelName: string;
  provider: string;
  name: string;
  readComments: boolean;
  replyComments: boolean;
  moderation: boolean;
  mentions: boolean;
  authTier: string;
  notes: string;
}

const FILTERS: Array<{ id: 'all' | ActivityKind; label: string }> = [
  { id: 'all', label: 'All activity' },
  { id: 'notification', label: 'Publishing Alerts' },
  { id: 'comment', label: 'Post Comments & Moderation' },
  { id: 'review', label: 'Client Reviews' },
];

const dateLabel = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export const ActivityInboxComponent: FC = () => {
  const fetch = useFetch();
  const [filter, setFilter] = useState<'all' | ActivityKind>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unread' | 'resolved'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Convert to lead modal state
  const [leadModalItem, setLeadModalItem] = useState<ActivityItem | null>(null);
  const [leadNotes, setLeadNotes] = useState('');
  const [isConvertingLead, setIsConvertingLead] = useState(false);

  // Capabilities drawer toggle
  const [showCapabilities, setShowCapabilities] = useState(false);

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('kind', filter);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (searchQuery.trim()) params.set('search', searchQuery.trim());
    params.set('page', String(page));
    params.set('limit', '30');
    return `/activity-inbox?${params.toString()}`;
  }, [filter, statusFilter, searchQuery, page]);

  const load = useCallback(
    async (path: string): Promise<ActivityResponse> => {
      const response = await fetch(path);
      if (!response.ok) throw new Error('Could not load publishing activity.');
      return response.json();
    },
    [fetch]
  );

  const { data, error, isLoading, mutate } = useSWR<ActivityResponse>(queryUrl, load, {
    refreshInterval: 30000, // Poll every 30s for real-time notifications
  });

  const { data: capData } = useSWR<{ connectedChannels: EngagementCapability[] }>(
    '/activity-inbox/capabilities',
    useCallback(async (p: string) => (await fetch(p)).json(), [fetch])
  );

  const markRead = async () => {
    setMessage(null);
    try {
      const response = await fetch('/activity-inbox/mark-read', { method: 'POST' });
      if (!response.ok) throw new Error('Could not mark alerts as read.');
      await mutate();
      setMessage({ text: 'All recent publishing alerts marked as read for this organization.', type: 'success' });
    } catch (cause) {
      setMessage({
        text: cause instanceof Error ? cause.message : 'Could not mark alerts as read.',
        type: 'error',
      });
    }
  };

  const resolveComment = async (commentId: string, currentResolved = false) => {
    setBusyId(commentId);
    setMessage(null);
    try {
      const response = await fetch(`/activity-inbox/comments/${commentId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: !currentResolved }),
      });
      if (!response.ok) throw new Error('Could not update comment status.');
      await mutate();
      setMessage({
        text: currentResolved ? 'Comment unmarked as resolved.' : 'Post discussion comment marked as resolved.',
        type: 'success',
      });
    } catch (cause) {
      setMessage({
        text: cause instanceof Error ? cause.message : 'Could not resolve this comment.',
        type: 'error',
      });
    } finally {
      setBusyId(null);
    }
  };

  const submitConvertToLead = async () => {
    if (!leadModalItem) return;
    setIsConvertingLead(true);
    setMessage(null);
    try {
      const commentId = leadModalItem.id.replace('comment:', '');
      const response = await fetch('/activity-inbox/convert-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commentId,
          authorName: leadModalItem.actor || 'Social User',
          authorHandle: leadModalItem.actor ? `@${leadModalItem.actor.toLowerCase().replace(/\s+/g, '')}` : undefined,
          content: leadModalItem.message,
          platform: leadModalItem.platform || leadModalItem.channel || 'social',
          channel: leadModalItem.channel || undefined,
          postId: leadModalItem.metadata?.postId,
          postGroup: leadModalItem.postGroup || undefined,
          permalink: leadModalItem.metadata?.permalink,
          leadNotes,
        }),
      });
      const resData = await response.json();
      if (!response.ok) throw new Error(resData.message || 'Failed to convert engagement item to lead.');

      setLeadModalItem(null);
      setLeadNotes('');
      await mutate();
      setMessage({
        text: `Lead successfully created and routed to WallzaOS Unified Inbox (${leadModalItem.actor})!`,
        type: 'success',
      });
    } catch (err: any) {
      setMessage({ text: err.message, type: 'error' });
    } finally {
      setIsConvertingLead(false);
    }
  };

  if (isLoading && !data) return <LoadingComponent />;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 p-6 mobile:p-3">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-blockSeparator pb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Activity & Engagement Inbox</h1>
            <span className="rounded-full bg-[#6d4aff]/20 px-2.5 py-0.5 text-xs font-semibold text-[#a995ff]">
              Social Operations
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-textItemBlur">
            Publishing alerts, post collaboration comments, and client reviews. Direct customer messaging (WhatsApp, DMs, Email) remains in the WallzaOS Unified Inbox.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCapabilities(!showCapabilities)}
            className="rounded-lg border border-blockSeparator px-3 py-2 text-xs font-semibold hover:bg-newBgColorInner transition"
          >
            {showCapabilities ? 'Hide Platform Limits' : 'Channel Capabilities'}
          </button>
          <button
            type="button"
            onClick={() => mutate()}
            className="rounded-lg border border-blockSeparator px-3 py-2 text-xs font-semibold hover:bg-newBgColorInner transition"
            title="Refresh feed"
          >
            ↻ Refresh
          </button>
          <button
            type="button"
            onClick={markRead}
            disabled={!data?.counts.unreadNotifications}
            className="rounded-lg bg-[#6d4aff] hover:bg-[#5b3adb] px-3.5 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 transition"
          >
            Mark alerts read{data?.counts.unreadNotifications ? ` (${data.counts.unreadNotifications})` : ''}
          </button>
        </div>
      </header>

      {/* Capabilities Panel (Conditional) */}
      {showCapabilities && (
        <div className="rounded-xl border border-blockSeparator bg-newBgColorInner p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-textItemBlur">
              Connected Channel Engagement Support
            </h3>
            <span className="text-[11px] text-textItemBlur">Official Provider API Constraints</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {(capData?.connectedChannels || []).length === 0 ? (
              <p className="text-xs text-textItemBlur col-span-full">No active channels connected.</p>
            ) : (
              capData?.connectedChannels.map((c) => (
                <div key={c.integrationId} className="p-3 rounded-lg border border-blockSeparator bg-background text-xs space-y-1">
                  <div className="flex items-center justify-between font-bold">
                    <span>{c.channelName}</span>
                    <span className="text-[10px] uppercase text-textItemBlur">{c.provider}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${c.readComments ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                      {c.readComments ? '✓ Read Comments' : '✕ No Comments'}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${c.replyComments ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-800 text-zinc-500'}`}>
                      {c.replyComments ? '✓ Post Replies' : '✕ No Replies'}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${c.moderation ? 'bg-indigo-500/20 text-indigo-400' : 'bg-zinc-800 text-zinc-500'}`}>
                      {c.moderation ? '✓ Moderation' : '✕ Standard Post'}
                    </span>
                  </div>
                  <p className="text-[11px] text-textItemBlur pt-1">{c.notes}</p>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: 'Total Activity Items', value: data?.counts.totalItems ?? 0 },
          { label: 'Publishing Alerts', value: data?.counts.notifications ?? 0 },
          { label: 'Post Comments', value: data?.counts.comments ?? 0 },
          { label: 'Client Reviews', value: data?.counts.reviews ?? 0 },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-blockSeparator bg-newBgColorInner p-3">
            <div className="text-2xl font-bold tabular-nums">{stat.value}</div>
            <div className="mt-1 text-xs text-textItemBlur">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Activity filters">
          {FILTERS.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              key={item.id}
              onClick={() => {
                setFilter(item.id);
                setPage(1);
              }}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                filter === item.id
                  ? 'border-[#6d4aff] bg-[#6d4aff]/15 text-[#a995ff]'
                  : 'border-blockSeparator text-textItemBlur hover:text-textColor'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {/* Status selector */}
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as any);
              setPage(1);
            }}
            className="rounded-lg border border-blockSeparator bg-newBgColorInner px-2.5 py-1.5 text-xs text-textColor outline-none"
          >
            <option value="all">All statuses</option>
            <option value="unread">Unread only</option>
            <option value="resolved">Resolved only</option>
          </select>

          {/* Search box */}
          <input
            type="search"
            placeholder="Search activity..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-blockSeparator bg-newBgColorInner px-3 py-1.5 text-xs text-textColor placeholder:text-textItemBlur outline-none w-48"
          />
        </div>
      </div>

      {/* Banner Message */}
      {message && (
        <div
          role="status"
          className={`rounded-lg border px-3 py-2 text-sm flex items-center justify-between ${
            message.type === 'success'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-400'
          }`}
        >
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} className="text-xs opacity-60 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-400 flex items-center justify-between">
          <span>Failed to load publishing activity feed.</span>
          <button type="button" onClick={() => mutate()} className="underline text-xs">
            Retry
          </button>
        </div>
      )}

      {/* Activity List */}
      {(data?.items || []).length === 0 ? (
        <div className="rounded-xl border border-dashed border-blockSeparator px-5 py-14 text-center">
          <h2 className="text-base font-semibold">No activity matches this view</h2>
          <p className="mt-1 text-sm text-textItemBlur">
            Try switching filters or clearing the search query. New publishing alerts and reviews will appear here.
          </p>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-blockSeparator rounded-xl border border-blockSeparator">
          {data?.items.map((item) => (
            <article key={item.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-newBgColorInner px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-textItemBlur">
                    {item.kind === 'notification' ? 'Alert' : item.kind === 'comment' ? 'Comment' : 'Review'}
                  </span>
                  {item.platform && (
                    <span className="rounded-full bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 text-[10px] font-semibold text-indigo-400 uppercase">
                      {item.platform}
                    </span>
                  )}
                  {item.unread && <span className="h-2 w-2 rounded-full bg-[#8b72ff]" title="Unread" />}
                  {item.resolved && <span className="text-[10px] font-semibold text-emerald-400">✓ Resolved</span>}
                </div>

                <h2 className="mt-2 text-sm font-semibold">{item.title}</h2>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-textItemBlur">{item.message}</p>

                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-textItemBlur">
                  <time dateTime={item.createdAt}>{dateLabel(item.createdAt)}</time>
                  {item.actor && <span>By {item.actor}</span>}
                  {item.channel && <span>Channel: {item.channel}</span>}
                  {item.postGroup && <span>Post Group: {item.postGroup.slice(0, 10)}</span>}
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2 pt-1 sm:pt-0">
                {/* Convert to Lead Button for eligible comments */}
                {item.leadEligible && (
                  <button
                    type="button"
                    onClick={() => {
                      setLeadModalItem(item);
                      setLeadNotes(`Captured from ${item.platform || 'social'} comment: "${item.message.slice(0, 120)}"`);
                    }}
                    className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs font-semibold text-amber-400 hover:bg-amber-500/20 transition flex items-center gap-1"
                    title="Export comment as lead to WallzaOS Unified Inbox"
                  >
                    <span>⚡</span> Convert to Lead
                  </button>
                )}

                {/* Resolve / Unresolve Comment */}
                {item.kind === 'comment' && (
                  <button
                    type="button"
                    disabled={busyId === item.id.replace('comment:', '')}
                    onClick={() => resolveComment(item.id.replace('comment:', ''), item.resolved)}
                    className="rounded-lg border border-blockSeparator px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50 hover:bg-newBgColorInner transition"
                  >
                    {busyId === item.id.replace('comment:', '') ? 'Saving…' : item.resolved ? 'Unresolve' : 'Resolve'}
                  </button>
                )}

                {/* Deep Link to Post / Review / Calendar */}
                <a
                  href={item.href}
                  className="rounded-lg bg-[#6d4aff]/15 px-3 py-1.5 text-xs font-semibold text-[#a995ff] hover:bg-[#6d4aff]/25 transition"
                >
                  {item.kind === 'comment' ? 'View in Post' : item.kind === 'review' ? 'View Review' : 'Open Link'}
                </a>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Pagination Controls */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-blockSeparator pt-4 text-xs text-textItemBlur">
          <span>
            Page {data.page} of {data.totalPages} ({data.total} total items)
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-lg border border-blockSeparator px-3 py-1.5 disabled:opacity-30 hover:bg-newBgColorInner"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= data.totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-blockSeparator px-3 py-1.5 disabled:opacity-30 hover:bg-newBgColorInner"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Lead Conversion Modal */}
      {leadModalItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-blockSeparator bg-background p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-blockSeparator pb-3">
              <div className="flex items-center gap-2">
                <span className="text-amber-400 text-lg">⚡</span>
                <h3 className="text-base font-bold">Route to WallzaOS Unified Inbox</h3>
              </div>
              <button
                type="button"
                onClick={() => setLeadModalItem(null)}
                className="text-textItemBlur hover:text-textColor text-sm"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-textItemBlur">
              This action will export the social engagement details to your WallzaOS Unified Inbox CRM lead pipeline. Conversation history and author metadata will be preserved without creating duplicate chat threads.
            </p>

            <div className="rounded-xl border border-blockSeparator bg-newBgColorInner p-3 text-xs space-y-1.5">
              <div>
                <span className="font-semibold text-textItemBlur">Author: </span>
                <span className="font-bold text-textColor">{leadModalItem.actor || 'Social User'}</span>
              </div>
              <div>
                <span className="font-semibold text-textItemBlur">Platform: </span>
                <span className="font-bold text-indigo-400 uppercase">{leadModalItem.platform || leadModalItem.channel || 'Social'}</span>
              </div>
              <div>
                <span className="font-semibold text-textItemBlur">Comment: </span>
                <span className="italic text-textColor">"{leadModalItem.message}"</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-textItemBlur">CRM Lead Notes (Optional)</label>
              <textarea
                rows={3}
                value={leadNotes}
                onChange={(e) => setLeadNotes(e.target.value)}
                placeholder="Add context for your sales or support team..."
                className="w-full rounded-xl border border-blockSeparator bg-newBgColorInner p-2.5 text-xs text-textColor outline-none focus:border-[#6d4aff]"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-blockSeparator">
              <button
                type="button"
                onClick={() => setLeadModalItem(null)}
                className="rounded-lg border border-blockSeparator px-4 py-2 text-xs font-semibold hover:bg-newBgColorInner transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isConvertingLead}
                onClick={submitConvertToLead}
                className="rounded-lg bg-amber-500 hover:bg-amber-600 px-4 py-2 text-xs font-bold text-black shadow transition disabled:opacity-50"
              >
                {isConvertingLead ? 'Routing…' : 'Create WallzaOS Lead'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Architecture Disclaimer */}
      <footer className="pt-2 text-[11px] text-textItemBlur">
        <span>Architecture Policy: </span>
        Direct customer chats (WhatsApp, Instagram DMs, Email) are strictly owned by the WallzaOS Unified Inbox. This Social Studio feed only manages publishing alerts, post discussions, and social engagement conversions.
      </footer>
    </div>
  );
};
