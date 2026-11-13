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
  postGroup?: string | null;
  actor?: string | null;
};
type ActivityResponse = {
  items: ActivityItem[];
  total: number;
  lastReadAt: string;
  counts: { notifications: number; comments: number; reviews: number; unreadNotifications: number };
  scope: 'publishing_activity';
};

const FILTERS: Array<{ id: 'all' | ActivityKind; label: string }> = [
  { id: 'all', label: 'All activity' },
  { id: 'notification', label: 'Alerts' },
  { id: 'comment', label: 'Post comments' },
  { id: 'review', label: 'Reviews' },
];

const dateLabel = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export const ActivityInboxComponent: FC = () => {
  const fetch = useFetch();
  const [filter, setFilter] = useState<'all' | ActivityKind>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (path: string): Promise<ActivityResponse> => {
    const response = await fetch(path);
    if (!response.ok) throw new Error('Could not load publishing activity.');
    return response.json();
  }, [fetch]);

  const { data, error, isLoading, mutate } = useSWR<ActivityResponse>('/activity-inbox?limit=100', load);
  const items = useMemo(
    () => (data?.items || []).filter((item) => filter === 'all' || item.kind === filter),
    [data?.items, filter]
  );

  const markRead = async () => {
    setMessage(null);
    try {
      const response = await fetch('/activity-inbox/mark-read', { method: 'POST' });
      if (!response.ok) throw new Error('Could not mark alerts as read.');
      await mutate();
      setMessage('Publishing alerts marked as read.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not mark alerts as read.');
    }
  };

  const resolveComment = async (commentId: string) => {
    setBusyId(commentId);
    setMessage(null);
    try {
      const response = await fetch(`/posts/comments/${commentId}/resolve`, {
        method: 'PUT',
        body: JSON.stringify({ resolved: true }),
      });
      if (!response.ok) throw new Error('Could not resolve this post comment.');
      await mutate();
      setMessage('Post discussion comment resolved.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not resolve this comment.');
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) return <LoadingComponent />;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 p-6 mobile:p-3">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-blockSeparator pb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Activity Inbox</h1>
          <p className="mt-1 max-w-3xl text-sm text-textItemBlur">
            Publishing alerts, post discussions and client review activity. Customer conversations and leads stay in the WallzaOS Unified Inbox.
          </p>
        </div>
        <button
          type="button"
          onClick={markRead}
          disabled={!data?.counts.unreadNotifications}
          className="rounded-lg border border-blockSeparator px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40"
        >
          Mark alerts read{data?.counts.unreadNotifications ? ` (${data.counts.unreadNotifications})` : ''}
        </button>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: 'Recent activity', value: data?.total ?? 0 },
          { label: 'Publishing alerts', value: data?.counts.notifications ?? 0 },
          { label: 'Post comments', value: data?.counts.comments ?? 0 },
          { label: 'Review events', value: data?.counts.reviews ?? 0 },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-blockSeparator bg-newBgColorInner p-3">
            <div className="text-2xl font-bold tabular-nums">{stat.value}</div>
            <div className="mt-1 text-xs text-textItemBlur">{stat.label}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Activity filters">
        {FILTERS.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            key={item.id}
            onClick={() => setFilter(item.id)}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${filter === item.id ? 'border-[#6d4aff] bg-[#6d4aff]/15 text-[#a995ff]' : 'border-blockSeparator text-textItemBlur hover:text-textColor'}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {(message || error) && (
        <div role="status" className="rounded-lg border border-blockSeparator px-3 py-2 text-sm text-textItemBlur">
          {message || 'Could not load publishing activity.'}
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-blockSeparator px-5 py-14 text-center">
          <h2 className="text-base font-semibold">Nothing here yet</h2>
          <p className="mt-1 text-sm text-textItemBlur">New publishing alerts, post comments and review decisions will appear here.</p>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-blockSeparator rounded-xl border border-blockSeparator">
          {items.map((item) => (
            <article key={item.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-newBgColorInner px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-textItemBlur">
                    {item.kind === 'notification' ? 'Alert' : item.kind === 'comment' ? 'Post comment' : 'Review'}
                  </span>
                  {item.unread && <span className="h-2 w-2 rounded-full bg-[#8b72ff]" aria-label="Unread" />}
                  {item.resolved && <span className="text-[10px] font-semibold text-emerald-500">Resolved</span>}
                </div>
                <h2 className="mt-2 text-sm font-semibold">{item.title}</h2>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-textItemBlur">{item.message}</p>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-textItemBlur">
                  <time dateTime={item.createdAt}>{dateLabel(item.createdAt)}</time>
                  {item.actor && <span>By {item.actor}</span>}
                  {item.channel && <span>{item.channel}</span>}
                  {item.postGroup && <span>Post group {item.postGroup.slice(0, 10)}</span>}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {item.kind === 'comment' && !item.resolved && (
                  <button
                    type="button"
                    disabled={busyId === item.id.replace('comment:', '')}
                    onClick={() => resolveComment(item.id.replace('comment:', ''))}
                    className="rounded-lg border border-blockSeparator px-3 py-2 text-xs font-semibold disabled:opacity-50"
                  >
                    {busyId === item.id.replace('comment:', '') ? 'Resolving…' : 'Resolve'}
                  </button>
                )}
                <a href={item.href} className="rounded-lg bg-[#6d4aff]/15 px-3 py-2 text-xs font-semibold text-[#a995ff] hover:bg-[#6d4aff]/25">
                  Open {item.kind === 'comment' ? 'calendar' : item.kind === 'review' ? 'reviews' : 'activity'}
                </a>
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="text-[11px] text-textItemBlur">
        This feed does not contain customer DMs, WhatsApp conversations or CRM leads. It does not fetch network comments unless a supported platform adapter is added separately.
      </p>
    </div>
  );
};
