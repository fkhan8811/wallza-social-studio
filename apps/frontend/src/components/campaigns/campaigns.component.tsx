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
  _count?: { ideas: number; postGroups: number };
};

type AvailablePostGroup = {
  group: string;
  title: string | null;
  publishDate: string;
  channels: string[];
  postCount: number;
};

type CampaignPostGroup = {
  group: string;
  createdAt: string;
  title: string | null;
  channels: string[];
  postCount: number;
  states: Record<string, number>;
  posts: Array<{
    title: string | null;
    state: string;
    publishDate: string;
    releaseURL: string | null;
    channel: string;
    content: string;
  }>;
};

const STATUSES: Campaign['status'][] = ['planning', 'active', 'paused', 'completed', 'archived'];

export const CampaignsComponent: FC = () => {
  const fetch = useFetch();
  const load = useCallback(async <T,>(path: string): Promise<T> => {
    const response = await fetch(path);
    if (!response.ok) throw new Error('Could not load campaign data.');
    return response.json();
  }, [fetch]);

  const { data, error, isLoading, mutate } = useSWR<Campaign[]>('/campaigns', load);
  const { data: availableGroups } = useSWR<AvailablePostGroup[]>('/campaigns/available-post-groups', load);
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
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [selectedPostGroup, setSelectedPostGroup] = useState('');
  const [analyticsData, setAnalyticsData] = useState<any | null>(null);
  const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(false);

  const loadAnalytics = async (id: string) => {
    setIsLoadingAnalytics(true);
    try {
      const res = await fetch(`/campaigns/${id}/analytics`);
      const data = await res.json();
      setAnalyticsData(data);
    } catch (err: any) {
      alert(`Could not load analytics: ${err.message}`);
    } finally {
      setIsLoadingAnalytics(false);
    }
  };

  const downloadReport = async (id: string) => {
    try {
      const res = await fetch(`/campaigns/${id}/report`);
      const data = await res.json();
      const blob = new Blob([data.csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data.campaignName.replace(/[^a-zA-Z0-9_-]/g, '_')}_analytics_report.csv`;
      a.click();
    } catch (err: any) {
      alert(`Report download failed: ${err.message}`);
    }
  };

  const { data: campaignPosts, mutate: mutateCampaignPosts } = useSWR<CampaignPostGroup[]>(
    selectedCampaignId ? `/campaigns/${selectedCampaignId}/post-groups` : null,
    load
  );

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
    if (!window.confirm(`Delete "${campaign.name}"? Its ideas remain and campaign links are removed.`)) return;
    const response = await fetch(`/campaigns/${campaign.id}`, { method: 'DELETE' });
    if (!response.ok) {
      setMessage('Could not delete this campaign.');
      return;
    }
    if (selectedCampaignId === campaign.id) setSelectedCampaignId(null);
    await mutate();
  };

  const attachPostGroup = async () => {
    if (!selectedCampaignId || !selectedPostGroup) return;
    setMessage(null);
    const response = await fetch(`/campaigns/${selectedCampaignId}/post-groups`, {
      method: 'POST',
      body: JSON.stringify({ postGroup: selectedPostGroup }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setMessage(payload.message || 'Could not attach this post group.');
      return;
    }
    setSelectedPostGroup('');
    await Promise.all([mutateCampaignPosts(), mutate()]);
  };

  const detachPostGroup = async (postGroup: string) => {
    if (!selectedCampaignId) return;
    const response = await fetch(`/campaigns/${selectedCampaignId}/post-groups/${encodeURIComponent(postGroup)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      setMessage('Could not remove this post group.');
      return;
    }
    await Promise.all([mutateCampaignPosts(), mutate()]);
  };

  if (isLoading) return <LoadingComponent />;

  const linkedGroups = campaignPosts || [];
  const linkedIds = new Set(linkedGroups.map((item) => item.group));
  const unassignedGroups = (availableGroups || []).filter((item) => !linkedIds.has(item.group));
  const stateTotals = linkedGroups.reduce<Record<string, number>>((totals, item) => {
    Object.entries(item.states).forEach(([stateKey, count]) => {
      totals[stateKey] = (totals[stateKey] || 0) + count;
    });
    return totals;
  }, {});

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-[20px] p-[24px] mobile:p-[14px]">
      <div className="flex flex-wrap items-end justify-between gap-[16px]">
        <div className="flex flex-col gap-[6px]">
          <h1 className="text-[24px] font-[700]">Campaigns</h1>
          <p className="text-[13px] text-textItemBlur">Plan content, connect scheduled posts and monitor publishing status.</p>
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
              <div className="text-right text-[10px] text-textItemBlur">
                <p>{campaign._count?.ideas ?? 0} ideas</p>
                <p>{campaign._count?.postGroups ?? 0} post groups</p>
              </div>
            </div>
            {campaign.description && <p className="whitespace-pre-wrap text-[12px] leading-[1.6] text-textItemBlur">{campaign.description}</p>}
            {campaign.goal && <p className="text-[12px]"><span className="text-textItemBlur">Goal: </span>{campaign.goal}</p>}
            <div className="mt-auto border-t border-blockSeparator pt-[10px] text-[11px] text-textItemBlur">
              {campaign.startAt ? new Date(campaign.startAt).toLocaleDateString() : 'No start date'} — {campaign.endAt ? new Date(campaign.endAt).toLocaleDateString() : 'No end date'}
            </div>
            <div className="flex flex-wrap justify-end gap-[8px]">
              <button type="button" onClick={() => loadAnalytics(campaign.id)} className="rounded-[7px] bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 px-[10px] py-[7px] text-[11px] font-semibold hover:bg-indigo-600/40">Analytics 📊</button>
              <button type="button" onClick={() => { setSelectedCampaignId(campaign.id === selectedCampaignId ? null : campaign.id); setMessage(null); }} className="rounded-[7px] border border-blockSeparator px-[10px] py-[7px] text-[11px]">{campaign.id === selectedCampaignId ? 'Close posts' : 'Manage posts'}</button>
              <button type="button" onClick={() => edit(campaign)} className="rounded-[7px] border border-blockSeparator px-[10px] py-[7px] text-[11px]">Edit</button>
              <button type="button" onClick={() => void remove(campaign)} className="rounded-[7px] border border-red-500/30 px-[10px] py-[7px] text-[11px] text-red-400">Delete</button>
            </div>
          </article>
        ))}
        {!data?.length && <div className="rounded-[12px] border border-dashed border-blockSeparator p-[24px] text-[13px] text-textItemBlur">No campaigns yet. Create one to organize ideas and publishing work.</div>}
      </div>

      {selectedCampaignId && (
        <section className="flex flex-col gap-[14px] rounded-[12px] border border-blockSeparator bg-newBgColorInner p-[16px]">
          <div>
            <h2 className="text-[16px] font-[700]">{data?.find((item) => item.id === selectedCampaignId)?.name || 'Campaign'} publishing</h2>
            <p className="mt-[3px] text-[12px] text-textItemBlur">Attach existing Postiz post groups. This does not republish or change their schedule.</p>
          </div>
          <div className="flex flex-wrap items-end gap-[8px]">
            <label className="flex min-w-[220px] flex-1 flex-col gap-[6px] text-[11px] text-textItemBlur">Add a scheduled or published post group
              <select value={selectedPostGroup} onChange={(event) => setSelectedPostGroup(event.target.value)} className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[12px]">
                <option value="">Choose post group</option>
                {unassignedGroups.map((item) => <option key={item.group} value={item.group}>{item.title || item.group} · {item.channels.join(', ')} · {item.postCount} posts</option>)}
              </select>
            </label>
            <button type="button" disabled={!selectedPostGroup} onClick={() => void attachPostGroup()} className="rounded-[8px] bg-[#6d4aff] px-[14px] py-[10px] text-[12px] font-[600] text-white disabled:opacity-50">Attach</button>
          </div>
          <div className="flex flex-wrap gap-[8px] text-[10px] text-textItemBlur">
            <span className="rounded-full bg-newBgColor px-[9px] py-[5px]">{linkedGroups.length} post groups</span>
            {Object.entries(stateTotals).map(([stateKey, count]) => <span key={stateKey} className="rounded-full bg-newBgColor px-[9px] py-[5px]">{stateKey}: {count}</span>)}
          </div>
          <div className="flex flex-col gap-[10px]">
            {linkedGroups.map((item) => (
              <article key={item.group} className="flex flex-col gap-[8px] rounded-[10px] border border-blockSeparator p-[12px]">
                <div className="flex flex-wrap items-start justify-between gap-[8px]">
                  <div>
                    <p className="text-[13px] font-[650]">{item.title || item.group}</p>
                    <p className="text-[11px] text-textItemBlur">{item.channels.join(', ')} · {item.postCount} channel posts</p>
                  </div>
                  <button type="button" onClick={() => void detachPostGroup(item.group)} className="rounded-[7px] border border-red-500/30 px-[9px] py-[6px] text-[10px] text-red-400">Remove</button>
                </div>
                <div className="flex flex-col gap-[6px]">
                  {item.posts.map((post, index) => (
                    <div key={`${item.group}-${index}`} className="flex flex-wrap items-center justify-between gap-[8px] border-t border-blockSeparator pt-[7px] text-[11px]">
                      <span className="min-w-0 flex-1 break-words">{post.channel} · {post.title || post.content.slice(0, 100) || 'Social post'}</span>
                      <span className="capitalize text-textItemBlur">{String(post.state).toLowerCase()} · {new Date(post.publishDate).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              </article>
            ))}
            {!linkedGroups.length && <div className="rounded-[9px] border border-dashed border-blockSeparator p-[16px] text-[12px] text-textItemBlur">No published or scheduled groups attached to this campaign yet.</div>}
          </div>
        </section>
      )}

      {/* Campaign Analytics & Reporting Modal */}
      {analyticsData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl bg-newBgColorInner rounded-2xl border border-blockSeparator p-6 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b border-blockSeparator pb-4">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  📊 {analyticsData.campaignName} — Performance Analytics
                </h3>
                <p className="text-xs text-textItemBlur mt-0.5">
                  Real operational and platform telemetry across attached post groups.
                </p>
              </div>
              <button
                onClick={() => setAnalyticsData(null)}
                className="text-textItemBlur hover:text-white text-lg"
              >
                ✕
              </button>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-xl bg-newBgColor border border-blockSeparator">
                <span className="text-[11px] text-textItemBlur block">Total Posts</span>
                <span className="text-xl font-bold text-white mt-1 block">{analyticsData.totalPosts}</span>
              </div>
              <div className="p-3 rounded-xl bg-newBgColor border border-blockSeparator">
                <span className="text-[11px] text-textItemBlur block">Published</span>
                <span className="text-xl font-bold text-emerald-400 mt-1 block">
                  {analyticsData.statesSummary?.PUBLISHED || 0}
                </span>
              </div>
              <div className="p-3 rounded-xl bg-newBgColor border border-blockSeparator">
                <span className="text-[11px] text-textItemBlur block">Scheduled</span>
                <span className="text-xl font-bold text-sky-400 mt-1 block">
                  {analyticsData.statesSummary?.SCHEDULED || 0}
                </span>
              </div>
              <div className="p-3 rounded-xl bg-newBgColor border border-blockSeparator">
                <span className="text-[11px] text-textItemBlur block">Linked Ideas</span>
                <span className="text-xl font-bold text-purple-400 mt-1 block">
                  {analyticsData.linkedIdeasCount || 0}
                </span>
              </div>
            </div>

            {/* Platform Distribution */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-textItemBlur">
                Platform Breakdown
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Object.entries(analyticsData.platformBreakdown || {}).map(([plat, stat]: [string, any]) => (
                  <div key={plat} className="p-2.5 rounded-lg bg-newBgColor border border-blockSeparator flex justify-between items-center text-xs">
                    <span className="capitalize font-medium text-white">{plat}</span>
                    <span className="text-textItemBlur font-mono">{stat.published}/{stat.posts} pub</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Top Posts Table */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-textItemBlur">
                Campaign Social Posts ({analyticsData.topPosts?.length || 0})
              </h4>
              <div className="rounded-xl border border-blockSeparator overflow-hidden bg-newBgColor">
                <table className="w-full text-left text-xs">
                  <thead className="bg-newBgColorInner border-b border-blockSeparator text-[10px] uppercase text-textItemBlur font-mono">
                    <tr>
                      <th className="p-2.5">Title / Content</th>
                      <th className="p-2.5">Platform</th>
                      <th className="p-2.5">Status</th>
                      <th className="p-2.5">Publish Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-blockSeparator">
                    {(analyticsData.topPosts || []).map((post: any) => (
                      <tr key={post.id} className="hover:bg-white/[0.02]">
                        <td className="p-2.5 max-w-xs truncate text-white">{post.title || 'Untitled Post'}</td>
                        <td className="p-2.5 text-textItemBlur capitalize">{post.platform}</td>
                        <td className="p-2.5">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            post.state === 'PUBLISHED' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-blue-500/20 text-blue-300'
                          }`}>
                            {post.state}
                          </span>
                        </td>
                        <td className="p-2.5 text-textItemBlur font-mono text-[11px]">
                          {post.publishDate ? new Date(post.publishDate).toLocaleDateString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex justify-between items-center pt-4 border-t border-blockSeparator">
              <span className="text-[11px] text-textItemBlur font-mono">
                {analyticsData.metricsSupported?.note}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => downloadReport(analyticsData.campaignId)}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition"
                >
                  Download CSV Report ⬇️
                </button>
                <button
                  type="button"
                  onClick={() => setAnalyticsData(null)}
                  className="px-4 py-2 rounded-xl border border-blockSeparator text-xs font-semibold text-textItemBlur hover:text-white"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
