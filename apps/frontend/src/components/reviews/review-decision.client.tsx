'use client';

import { FC, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export const ReviewDecisionClient: FC<{
  token: string;
  initialStatus: string;
  initialComment: string | null;
}> = ({ token, initialStatus, initialComment }) => {
  const fetch = useFetch();
  const [comment, setComment] = useState(initialComment || '');
  const [status, setStatus] = useState(initialStatus);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'approved' | 'changes_requested') => {
    if (decision === 'changes_requested' && !comment.trim()) {
      setError('Add a comment describing the changes you need.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/reviews/public/${encodeURIComponent(token)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, comment }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'Could not submit your review.');
      }
      setStatus(decision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not submit your review.');
    } finally {
      setSaving(false);
    }
  };

  if (status !== 'pending') {
    return <div className="rounded-[10px] border border-blockSeparator bg-newBgColorInner p-[16px] text-[13px]">Review submitted: <strong className="capitalize">{status.replace('_', ' ')}</strong></div>;
  }

  return (
    <div className="flex flex-col gap-[10px] rounded-[12px] border border-blockSeparator bg-newBgColorInner p-[16px]">
      <label className="text-[12px] text-textItemBlur">Feedback or requested changes
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={2000} rows={4} placeholder="Share your feedback with the content team..." className="mt-[6px] w-full rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]" />
      </label>
      {error && <p role="alert" className="text-[12px] text-red-400">{error}</p>}
      <div className="flex flex-wrap justify-end gap-[8px]">
        <button disabled={saving} type="button" onClick={() => void decide('changes_requested')} className="rounded-[8px] border border-blockSeparator px-[14px] py-[9px] text-[12px] disabled:opacity-50">{saving ? 'Submitting...' : 'Request changes'}</button>
        <button disabled={saving} type="button" onClick={() => void decide('approved')} className="rounded-[8px] bg-[#6d4aff] px-[14px] py-[9px] text-[12px] font-[600] text-white disabled:opacity-50">{saving ? 'Submitting...' : 'Approve posts'}</button>
      </div>
    </div>
  );
};
