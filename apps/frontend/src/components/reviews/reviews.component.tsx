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
  const [reviewerEmail, setReviewerEmail] = useState('');
  const [reviewerName, setReviewerName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('7');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!postGroup || !reviewerEmail.trim()) return;
    setSaving(true);
    setMessage(null);
    setReviewUrl(null);
    try {
      const response = await fetch('/reviews', {
        method: 'POST',
        body: JSON.stringify({
          postGroup,
          reviewerEmail: reviewerEmail.trim(),
          reviewerName: reviewerName.trim(),
          expiresInDays: Number(expiresInDays),
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'Could not create a review link.');
      }
      const result = await response.json();
      const absoluteUrl = `${window.location.origin}${result.reviewPath}`;
      setReviewUrl(absoluteUrl);
      setReviewerEmail('');
      setReviewerName('');
      await mutate();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not create a review link.');
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!reviewUrl) return;
    try {
      await navigator.clipboard.writeText(reviewUrl);
      setMessage('Review link copied. Send it to the reviewer.');
    } catch {
      setMessage('Copy was blocked by the browser. Select and copy the link below.');
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm('Revoke this pending review link?')) return;
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
        <p className="text-[13px] text-textItemBlur">Create secure, expiring links for external reviewers without giving them workspace access.</p>
      </div>

      {(message || error) && <div role="status" className="rounded-[8px] border border-blockSeparator px-[14px] py-[10px] text-[13px] text-textItemBlur">{message || 'Could not load review requests.'}</div>}

      <form onSubmit={create} className="grid grid-cols-1 gap-[12px] rounded-[12px] border border-blockSeparator bg-newBgColorInner p-[16px] lg:grid-cols-2">
        <label className="flex flex-col gap-[6px] text-[12px] text-textItemBlur lg:col-span-2">Post group to review
          <select required value={postGroup} onChange={(event) => setPostGroup(event.target.value)} className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]">
            <option value="">Select a post group</option>
            {(groups || []).map((group) => <option key={group.group} value={group.group}>{group.title || group.group} · {group.channels.join(', ') || 'Post'} · {new Date(group.publishDate).toLocaleDateString()}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-[6px] text-[12px] text-textItemBlur">Reviewer email
          <input required type="email" maxLength={254} value={reviewerEmail} onChange={(event) => setReviewerEmail(event.target.value)} placeholder="client@example.com" className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]" />
        </label>
        <label className="flex flex-col gap-[6px] text-[12px] text-textItemBlur">Reviewer name
          <input maxLength={120} value={reviewerName} onChange={(event) => setReviewerName(event.target.value)} placeholder="Client / approver name" className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]" />
        </label>
        <label className="flex flex-col gap-[6px] text-[12px] text-textItemBlur">Link expiry
          <select value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)} className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]">
            <option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option>
          </select>
        </label>
        <div className="flex items-end justify-end">
          <button disabled={saving || !groups?.length} type="submit" className="rounded-[8px] bg-[#6d4aff] px-[16px] py-[10px] text-[12px] font-[600] text-white disabled:opacity-50">{saving ? 'Creating...' : 'Create review link'}</button>
        </div>
      </form>

      {reviewUrl && (
        <div className="flex flex-col gap-[8px] rounded-[10px] border border-blockSeparator p-[14px]">
          <p className="text-[12px] font-[650]">Your reviewer link</p>
          <input readOnly value={reviewUrl} className="w-full rounded-[7px] border border-blockSeparator bg-newBgColor px-[10px] py-[9px] text-[12px]" />
          <div className="flex justify-end"><button type="button" onClick={() => void copy()} className="rounded-[7px] bg-[#6d4aff] px-[12px] py-[8px] text-[11px] text-white">Copy link</button></div>
          <p className="text-[11px] text-textItemBlur">The raw token is shown only once. Send this link to the reviewer using your approved communication channel.</p>
        </div>
      )}

      <div className="flex flex-col gap-[10px]">
        <h2 className="text-[16px] font-[700]">Review history</h2>
        {(reviews || []).map((review) => (
          <article key={review.id} className="flex flex-wrap items-center justify-between gap-[12px] rounded-[10px] border border-blockSeparator bg-newBgColorInner p-[14px]">
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
          </article>
        ))}
        {!reviews?.length && <div className="rounded-[10px] border border-dashed border-blockSeparator p-[20px] text-[12px] text-textItemBlur">No review requests yet.</div>}
      </div>
    </div>
  );
};
