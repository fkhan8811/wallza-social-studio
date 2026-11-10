'use client';

import { FC, FormEvent, useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';

type Campaign = {
  id: string;
  name: string;
  description: string;
  goal: string;
  status: 'planning' | 'active' | 'paused' | 'completed' | 'archived';
  startAt: string | null;
  endAt: string | null;
  updatedAt: string;
  _count?: { ideas: number };
};

const STATUSES: Campaign['status'][] = ['planning', 'active', 'paused', 'completed', 'archived'];

export const CampaignsComponent: FC = () => {
  const fetch = useFetch();
  const load = useCallback(async (path: string): Promise<Campaign[]> => {
    const response = await fetch(path);
    if (!response.ok) throw new Error('Could not load campaigns.');
    return response.json();
  }, [fetch]);
  const { data, error, isLoading, mutate } = useSWR<Campaign[]>('/campaigns', load);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [goal, setGoal] = useState('');
  const [status, setStatus] = useState<Campaign['status']>('planning');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reset = () => {
    setEditingId(null);
    setName('');
    setDescription('');
    setGoal('');
    setStatus('planning');
    setStartAt('');
    setEndAt('');
    setShowForm(false);
  };

  const edit = (campaign: Campaign) => {
    setEditingId(campaign.id);
    setName(campaign.name);
    setDescription(campaign.description || '');
    setGoal(campaign.goal || '');
    setStatus(campaign.status);
    setStartAt(campaign.startAt ? campaign.startAt.slice(0, 10) : '');
    setEndAt(campaign.endAt ? campaign.endAt.slice(0, 10) : '');
    setShowForm(true);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(editingId ? `/campaigns/${editingId}` : '/campaigns', {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description,
          goal,
          status,
          startAt: startAt || null,
          endAt: endAt || null,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'Could not save the campaign.');
      }
      reset();
      await mutate();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not save the campaign.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (campaign: Campaign) => {
    if (!window.confirm(`Delete "${campaign.name}"? Its ideas will remain and become unassigned.`)) return;
    const response = await fetch(`/campaigns/${campaign.id}`, { method: 'DELETE' });
    if (!response.ok) {
      setMessage('Could not delete this campaign.');
      return;
    }
    await mutate();
  };

  if (isLoading) return <LoadingComponent />;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-[20px] p-[24px] mobile:p-[14px]">
      <div className="flex flex-wrap items-end justify-between gap-[16px]">
        <div className="flex flex-col gap-[6px]">
          <h1 className="text-[24px] font-[700]">Campaigns</h1>
          <p className="text-[13px] text-textItemBlur">Plan coordinated content across channels, dates and goals.</p>
          <p className="text-[12px] text-textItemBlur">{(data || []).length} campaigns</p>
        </div>
        <button type="button" onClick={() => { reset(); setShowForm(true); }} className="rounded-[9px] bg-[#6d4aff] px-[16px] py-[10px] text-[13px] font-[600] text-white">
          + New campaign
        </button>
      </div>

      {(message || error) && <div role="alert" className="rounded-[8px] border border-red-500/30 bg-red-500/10 px-[14px] py-[10px] text-[13px] text-red-300">{message || 'Could not load campaigns.'}</div>}

      {showForm && (
        <form onSubmit={save} className="grid grid-cols-1 gap-[12px] rounded-[12px] border border-blockSeparator bg-newBgColorInner p-[16px] lg:grid-cols-2">
          <div className="flex flex-col gap-[6px] lg:col-span-2">
            <label className="text-[12px] text-textItemBlur">Campaign name *</label>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]" placeholder="e.g. Black Friday launch" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <label className="text-[12px] text-textItemBlur">Description</label>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} rows={3} className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <label className="text-[12px] text-textItemBlur">Goal</label>
            <textarea value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={1000} rows={3} className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]" placeholder="Awareness, leads, product launch..." />
          </div>
          <div className="flex flex-col gap-[6px]">
            <label className="text-[12px] text-textItemBlur">Status</label>
            <select value={status} onChange={(event) => setStatus(event.target.value as Campaign['status'])} className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px]">
              {STATUSES.map((value) => <option key={value} value={value}>{value.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-[10px]">
            <label className="flex flex-col gap-[6px] text-[12px] text-textItemBlur">Start date
              <input type="date" value={startAt} onChange={(event) => setStartAt(event.target.value)} className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[10px] py-[10px] text-[13px]" />
            </label>
            <label className="flex flex-col gap-[6px] text-[12px] text-textItemBlur">End date
              <input type="date" value={endAt} onChange={(event) => setEndAt(event.target.value)} className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[10px] py-[10px] text-[13px]" />
            </label>
          </div>
          <div className="flex justify-end gap-[8px] lg:col-span-2">
            <button type="button" onClick={reset} className="rounded-[8px] px-[14px] py-[9px] text-[12px] text-textItemBlur">Cancel</button>
            <button disabled={saving} type="submit" className="rounded-[8px] bg-[#6d4aff] px-[16px] py-[9px] text-[12px] font-[600] text-white disabled:opacity-50">{saving ? 'Saving...' : editingId ? 'Save changes' : 'Create campaign'}</button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 gap-[12px] md:grid-cols-2 xl:grid-cols-3">
        {(data || []).map((campaign) => (
          <article key={campaign.id} className="flex flex-col gap-[12px] rounded-[12px] border border-blockSeparator bg-newBgColorInner p-[16px]">
            <div className="flex items-start justify-between gap-[10px]">
              <div className="min-w-0">
                <h2 className="break-words text-[15px] font-[700]">{campaign.name}</h2>
                <p className="mt-[4px] text-[11px] capitalize text-textItemBlur">{campaign.status}</p>
              </div>
              <span className="rounded-full bg-newBgColor px-[9px] py-[4px] text-[11px] text-textItemBlur">{campaign._count?.ideas ?? 0} ideas</span>
            </div>
            {campaign.description && <p className="whitespace-pre-wrap text-[12px] leading-[1.6] text-textItemBlur">{campaign.description}</p>}
            {campaign.goal && <p className="text-[12px]"><span className="text-textItemBlur">Goal: </span>{campaign.goal}</p>}
            <div className="mt-auto border-t border-blockSeparator pt-[10px] text-[11px] text-textItemBlur">
              {campaign.startAt ? new Date(campaign.startAt).toLocaleDateString() : 'No start date'} — {campaign.endAt ? new Date(campaign.endAt).toLocaleDateString() : 'No end date'}
            </div>
            <div className="flex justify-end gap-[8px]">
              <button type="button" onClick={() => edit(campaign)} className="rounded-[7px] border border-blockSeparator px-[10px] py-[7px] text-[11px]">Edit</button>
              <button type="button" onClick={() => void remove(campaign)} className="rounded-[7px] border border-red-500/30 px-[10px] py-[7px] text-[11px] text-red-400">Delete</button>
            </div>
          </article>
        ))}
        {!data?.length && <div className="rounded-[12px] border border-dashed border-blockSeparator p-[24px] text-[13px] text-textItemBlur">No campaigns yet. Create one to organize ideas and publishing work.</div>}
      </div>
    </div>
  );
};
