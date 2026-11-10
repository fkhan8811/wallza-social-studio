'use client';

import { FC, FormEvent, useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';

type PostGroup = {
  group: string;
  title: string | null;
  publishDate: string;
  channels: string[];
};

type ReviewEvent = {
  id: string;
  action: string;
  actorEmail: string | null;
  actorName: string | null;
  comment: string | null;
  createdAt: string;
};

type Review = {
  id: string;
  postGroup: string;
  reviewerEmail: string;
  reviewerName: string | null;
  status: string;
  comment: string | null;
  expiresAt: string;
  reviewedAt: string | null;
  createdAt: string;
  expired?: boolean;
  events: ReviewEvent[];
};

type CreatedReview = {
  id: string;
  reviewerEmail: string;
  reviewerName: string | null;
  reviewPath: string;
};

export const ReviewsComponent: FC = () => {
  const fetch = useFetch();
  const loadReviews = useCallback(async (path: string): Promise<Review[]> => {
    const response = await fetch(path);
    if (!response.ok) throw new Error('Could not load review requests.');
    return response.json();
  }, [fetch]);
  const loadGroups = useCallback(async (path: string): Promise<PostGroup[]> => {
    const response = await fetch(path);
    if (!response.ok) throw new Error('Could not load posts available for review.');
    return response.json();
  }, [fetch]);

  const { data: reviews, error, isLoading, mutate } = useSWR<Review[]>('/reviews', loadReviews);
  const { data: groups } = useSWR<PostGroup[]>('/reviews/available-post-groups', loadGroups);
  const [postGroup, setPostGroup] = useState('');
  const [reviewerEmails, setReviewerEmails] = useState('');
  const [reviewerNames, setReviewerNames] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('7');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [createdLinks, setCreatedLinks] = useState<Array<CreatedReview & { url: string }>>([]);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!postGroup || !reviewerEmails.trim()) return;
    const emails = reviewerEmails.split(/[\n,;]+/).map((value) => value.trim().toLowerCase()).filter(Boolean);
    const names = reviewerNames.split(/[\n,;]+/).map((value) => value.trim());
    if (emails.length > 10) {
      setMessage('You can invite up to 10 reviewers per request.');
      return;
    }
    if (new Set(emails).size !== emails.length) {
      setMessage('Each reviewer email must be unique.');
      return;
    }

    setSaving(true);
    setMessage(null);
    setCreatedLinks([]);
    try {
      const response = await fetch('/reviews', {
        method: 'POST',
        body: JSON.stringify({
          postGroup,
          reviewers: emails.map((email, index) => ({ email, name: names[index] || '' })),
          expiresInDays: Number(expiresInDays),
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'Could not create review links.');
      }
      const result = await response.json();
      const rows: CreatedReview[] = result.reviews || [];
      setCreatedLinks(rows.map((row) => ({
        ...row,
        url: `${window.location.origin}${row.reviewPath}`,
      })));
      setReviewerEmails('');
      setReviewerNames('');
      await mutate();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not create review links.');
    } finally {
      setSaving(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setMessage('Review link copied. Send it to the matching reviewer.');
    } catch {
      setMessage('Copy was blocked by the browser. Select and copy the link above.');
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm('Revoke this pending review link? The event will remain in the audit history.')) return;
    const response = await fetch(`/reviews/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      setMessage('Could not revoke this review link.');
      return;
    }
    await mutate();
  };

  if (isLoading) return <LoadingComponent />;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-[20px] p-[24px] mobile:p-[14px]">
      <div className="flex flex-col gap-[6px]">
        <h1 className="text-[24px] font-[700]">Client Reviews & Approvals</h1>
        <p className="text-[13px] text-textItemBlur">Invite up to 10 reviewers with separate private links. Decisions and revocations remain in the review history.</p>
      </div>

      {(message || error) && <div role="status" className="rounded-[8px] border border-blockSeparator px-[14px] py-[10px] text-[13px] text-textItemBlur">{message || 'Could not load review requests.'}</div>}

      <form onSubmit={create} className="grid grid-cols-1 gap-[12px] rounded-[12px] border border-blockSeparator bg-newBgColorInner p-[16px] lg:grid-cols-2">
        <label className="flex flex-col gap-[6px] text-[12px] text-textItemBlur lg:col-span-2">Post group to review
          <select required value={postGroup} onChange={(event) => setPostGroup(event.target.value)} className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]">
            <option value="">Select a post group</option>
            {(groups || []).map((group) => <option key={group.group} value={group.group}>{group.title || group.group} · {group.channels.join(', ')} · {new Date(group.publishDate).toLocaleDateString()}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-[6px] text-[12px] text-textItemBlur">Reviewer emails (comma or new line separated; maximum 10)
          <textarea required value={reviewerEmails} onChange={(event) => setReviewerEmails(event.target.value)} rows={3} placeholder="client@example.com&#10;approver@example.com" className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]" />
        </label>
        <label className="flex flex-col gap-[6px] text-[12px] text-textItemBlur">Reviewer names in the same order (optional)
          <textarea value={reviewerNames} onChange={(event) => setReviewerNames(event.target.value)} rows={3} placeholder="Client name&#10;Marketing approver" className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]" />
        </label>
        <label className="flex flex-col gap-[6px] text-[12px] text-textItemBlur">Link expiry
          <select value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)} className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]">
            <option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option>
          </select>
        </label>
        <div className="flex items-end justify-end">
          <button disabled={saving || !groups?.length} type="submit" className="rounded-[8px] bg-[#6d4aff] px-[16px] py-[10px] text-[12px] font-[600] text-white disabled:opacity-50">{saving ? 'Creating...' : 'Create review links'}</button>
        </div>
      </form>

      {!!createdLinks.length && (
        <section className="flex flex-col gap-[10px] rounded-[10px] border border-blockSeparator p-[14px]">
          <p className="text-[12px] font-[650]">Private links — copy each link for the matching reviewer</p>
          {createdLinks.map((item) => (
            <div key={item.id} className="flex flex-col gap-[6px] border-t border-blockSeparator pt-[8px]">
              <p className="text-[11px] text-textItemBlur">{item.reviewerName || item.reviewerEmail} · {item.reviewerEmail}</p>
              <div className="flex flex-wrap gap-[8px]">
                <input readOnly value={item.url} className="min-w-[200px] flex-1 rounded-[7px] border border-blockSeparator bg-newBgColor px-[10px] py-[9px] text-[11px]" />
                <button type="button" onClick={() => void copy(item.url)} className="rounded-[7px] bg-[#6d4aff] px-[12px] py-[8px] text-[11px] text-white">Copy link</button>
              </div>
            </div>
          ))}
          <p className="text-[11px] text-textItemBlur">Links are shown only once. Send them through your approved communication channel; no email invitation is sent automatically.</p>
        </section>
      )}

      <div className="flex flex-col gap-[10px]">
        <h2 className="text-[16px] font-[700]">Review history</h2>
        {(reviews || []).map((review) => (
          <article key={review.id} className="flex flex-col gap-[10px] rounded-[10px] border border-blockSeparator bg-newBgColorInner p-[14px]">
            <div className="flex flex-wrap items-center justify-between gap-[12px]">
              <div className="min-w-0">
                <p className="break-all text-[13px] font-[650]">{review.reviewerName || review.reviewerEmail}</p>
                <p className="mt-[3px] break-all text-[11px] text-textItemBlur">{review.reviewerEmail} · Post group {review.postGroup}</p>
                <p className="mt-[3px] text-[11px] text-textItemBlur">Expires {new Date(review.expiresAt).toLocaleString()}</p>
                {review.comment && <p className="mt-[5px] text-[12px] text-textItemBlur">Feedback: {review.comment}</p>}
              </div>
              <div className="flex items-center gap-[8px]">
                <span className="rounded-full bg-newBgColor px-[9px] py-[5px] text-[11px] capitalize">{review.expired ? 'expired' : review.status.replace('_', ' ')}</span>
                {review.status === 'pending' && !review.expired && <button type="button" onClick={() => void revoke(review.id)} className="rounded-[7px] border border-red-500/30 px-[10px] py-[7px] text-[11px] text-red-400">Revoke</button>}
              </div>
            </div>
            {!!review.events?.length && (
              <div className="flex flex-col gap-[6px] border-t border-blockSeparator pt-[8px]">
                <p className="text-[10px] font-[650] uppercase tracking-wide text-textItemBlur">Audit events</p>
                {review.events.map((item) => (
                  <div key={item.id} className="flex flex-wrap justify-between gap-[6px] text-[10px] text-textItemBlur">
                    <span className="capitalize">{item.action.replace('_', ' ')}{item.actorEmail ? ` · ${item.actorEmail}` : ''}{item.comment ? ` · ${item.comment}` : ''}</span>
                    <time>{new Date(item.createdAt).toLocaleString()}</time>
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
        {!reviews?.length && <div className="rounded-[10px] border border-dashed border-blockSeparator p-[20px] text-[12px] text-textItemBlur">No review requests yet.</div>}
      </div>
    </div>
  );
};
