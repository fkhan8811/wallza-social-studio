'use client';

import { FC, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';

interface ScheduleSlot {
  dayOfWeek: number;
  time: string;
  integrations?: string[];
}

interface ConnectedIntegration {
  id: string;
  name: string;
  originalName?: string;
  identifier: string;
  disabled: boolean;
}

interface IntegrationResponse {
  integrations: ConnectedIntegration[];
}

interface PublishingQueue {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  timezone: string;
  scheduleSlots: ScheduleSlot[];
  minSpacingMinutes: number;
  capacityLimit: number | null;
  queuedPostsCount?: number;
}

interface AutomationRule {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  trigger: string;
  conditions: any;
  actions: any;
  executionCount: number;
  lastExecutedAt: string | null;
}

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const AutomationComponent: FC = () => {
  const fetch = useFetch();
  const [activeTab, setActiveTab] = useState<'queues' | 'rules'>('queues');

  // Queue state
  const [isQueueModalOpen, setIsQueueModalOpen] = useState(false);
  const [queueName, setQueueName] = useState('');
  const [queueDescription, setQueueDescription] = useState('');
  const [queueTimezone, setQueueTimezone] = useState('UTC');
  const [queueSlots, setQueueSlots] = useState<ScheduleSlot[]>([
    { dayOfWeek: 1, time: '09:00' },
    { dayOfWeek: 1, time: '17:00' },
    { dayOfWeek: 2, time: '09:00' },
    { dayOfWeek: 3, time: '09:00' },
    { dayOfWeek: 4, time: '09:00' },
    { dayOfWeek: 5, time: '09:00' },
  ]);
  const [selectedQueueForNextSlot, setSelectedQueueForNextSlot] = useState<string | null>(null);
  const [nextSlotInfo, setNextSlotInfo] = useState<any>(null);

  // Rule state
  const [isRuleModalOpen, setIsRuleModalOpen] = useState(false);
  const [ruleName, setRuleName] = useState('');
  const [ruleTrigger, setRuleTrigger] = useState('draft_approved');
  const [rulePlatform, setRulePlatform] = useState('all');
  const [ruleTargetQueue, setRuleTargetQueue] = useState('');

  const { data: queues = [], mutate: mutateQueues, isLoading: queuesLoading } = useSWR<PublishingQueue[]>(
    '/automation/queues',
    async (url) => {
      const res = await fetch(url);
      return res.json();
    }
  );

  const { data: rules = [], mutate: mutateRules, isLoading: rulesLoading } = useSWR<AutomationRule[]>(
    '/automation/rules',
    async (url) => {
      const res = await fetch(url);
      return res.json();
    }
  );

  const { data: integrationData } = useSWR<IntegrationResponse>(
    '/integrations/list',
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Could not load connected social accounts.');
      return res.json();
    }
  );
  const availableIntegrations = (integrationData?.integrations || []).filter((item) => !item.disabled);

  const updateQueueSlot = (slotIndex: number, changes: Partial<ScheduleSlot>) => {
    setQueueSlots((current) =>
      current.map((slot, index) => (index === slotIndex ? { ...slot, ...changes } : slot))
    );
  };

  const toggleQueueSlotIntegration = (slotIndex: number, integrationId: string, checked: boolean) => {
    setQueueSlots((current) =>
      current.map((slot, index) => {
        if (index !== slotIndex) return slot;
        const existing = slot.integrations || [];
        const integrations = checked
          ? [...new Set([...existing, integrationId])]
          : existing.filter((id) => id !== integrationId);
        return { ...slot, integrations: integrations.length ? integrations : undefined };
      })
    );
  };

  const handleCreateQueue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!queueName.trim()) return;
    try {
      await fetch('/automation/queues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: queueName.trim(),
          description: queueDescription.trim() || undefined,
          timezone: queueTimezone,
          scheduleSlots: queueSlots,
        }),
      });
      setIsQueueModalOpen(false);
      setQueueName('');
      setQueueDescription('');
      mutateQueues();
    } catch (err: any) {
      alert(`Error creating queue: ${err.message}`);
    }
  };

  const toggleQueueActive = async (queue: PublishingQueue) => {
    try {
      await fetch(`/automation/queues/${queue.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !queue.isActive }),
      });
      mutateQueues();
    } catch (err: any) {
      alert(`Error toggling queue: ${err.message}`);
    }
  };

  const checkNextSlot = async (queueId: string) => {
    setSelectedQueueForNextSlot(queueId);
    try {
      const res = await fetch(`/automation/queues/${queueId}/next-slot`);
      const data = await res.json();
      setNextSlotInfo(data);
    } catch (err: any) {
      alert(`Failed to calculate next slot: ${err.message}`);
    }
  };

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleName.trim()) return;
    try {
      await fetch('/automation/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: ruleName.trim(),
          trigger: ruleTrigger,
          conditions: { platform: rulePlatform !== 'all' ? rulePlatform : undefined },
          actions: { targetQueueId: ruleTargetQueue || undefined, autoRetry: true },
        }),
      });
      setIsRuleModalOpen(false);
      setRuleName('');
      mutateRules();
    } catch (err: any) {
      alert(`Error creating rule: ${err.message}`);
    }
  };

  const toggleRuleActive = async (rule: AutomationRule) => {
    try {
      await fetch(`/automation/rules/${rule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      mutateRules();
    } catch (err: any) {
      alert(`Error toggling rule: ${err.message}`);
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border/40 pb-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-white flex items-center gap-3">
            <span className="p-2 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 text-white shadow-lg">
              ⚡
            </span>
            Publishing Automation & Queues
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure recurring slot schedules, named queues, collision prevention, and event-driven automation rules.
          </p>
        </div>

        <div className="flex gap-2">
          {activeTab === 'queues' ? (
            <button
              onClick={() => setIsQueueModalOpen(true)}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow transition"
            >
              + Create Publishing Queue
            </button>
          ) : (
            <button
              onClick={() => setIsRuleModalOpen(true)}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow transition"
            >
              + Add Automation Rule
            </button>
          )}
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex gap-3 border-b border-border/40 pb-px">
        <button
          onClick={() => setActiveTab('queues')}
          className={`pb-3 text-sm font-semibold border-b-2 transition ${
            activeTab === 'queues'
              ? 'border-indigo-500 text-white font-bold'
              : 'border-transparent text-muted-foreground hover:text-white'
          }`}
        >
          Publishing Queues ({queues.length})
        </button>
        <button
          onClick={() => setActiveTab('rules')}
          className={`pb-3 text-sm font-semibold border-b-2 transition ${
            activeTab === 'rules'
              ? 'border-indigo-500 text-white font-bold'
              : 'border-transparent text-muted-foreground hover:text-white'
          }`}
        >
          Automation Rules ({rules.length})
        </button>
      </div>

      {/* Tab 1: Queues */}
      {activeTab === 'queues' && (
        <div className="space-y-6">
          {queuesLoading ? (
            <div className="py-20 flex justify-center">
              <LoadingComponent />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {queues.map((q) => (
                <div
                  key={q.id}
                  className="rounded-2xl border border-border/50 bg-card p-5 space-y-4 hover:border-indigo-500/50 transition flex flex-col justify-between"
                >
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-white text-base truncate">{q.name}</h3>
                        {q.isDefault && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] bg-indigo-600/30 text-indigo-300 font-mono font-bold">
                            Default
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => toggleQueueActive(q)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition ${
                          q.isActive
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : 'bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {q.isActive ? 'Active' : 'Paused'}
                      </button>
                    </div>

                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {q.description || 'Configured recurring weekly slot distribution.'}
                    </p>

                    {/* Slot Schedule Grid */}
                    <div className="space-y-1.5 pt-2 border-t border-border/40">
                      <span className="text-[11px] font-mono text-muted-foreground">
                        {q.scheduleSlots?.length || 0} Posting Slots / Week ({q.timezone})
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {DAYS_OF_WEEK.map((day, idx) => {
                          const slotsForDay = (q.scheduleSlots || []).filter((s) => s.dayOfWeek === idx);
                          const hasSlots = slotsForDay.length > 0;
                          return (
                            <span
                              key={day}
                              className={`px-2 py-1 rounded text-[10px] font-mono font-bold ${
                                hasSlots
                                  ? 'bg-indigo-950/80 text-indigo-300 border border-indigo-500/30'
                                  : 'bg-muted/40 text-muted-foreground'
                              }`}
                              title={hasSlots ? `${slotsForDay.map((s) => s.time).join(', ')}` : 'No slots'}
                            >
                              {day} {hasSlots && `(${slotsForDay.length})`}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Actions & Next Slot Check */}
                  <div className="pt-3 border-t border-border/40 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground font-mono text-[11px]">
                      Spacing: {q.minSpacingMinutes}m
                    </span>
                    <button
                      onClick={() => checkNextSlot(q.id)}
                      className="px-3 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 font-semibold transition"
                    >
                      Next Slot ➔
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Next Slot Calculator Drawer */}
          {nextSlotInfo && (
            <div className="p-4 rounded-xl bg-indigo-950/40 border border-indigo-500/30 flex items-center justify-between animate-fade-in">
              <div>
                <p className="text-xs font-bold text-white">Next Available Posting Slot Calculated</p>
                <p className="text-sm font-mono text-indigo-300 mt-0.5">
                  {new Date(nextSlotInfo.nextSlot).toUTCString()} ({nextSlotInfo.timezone})
                </p>
              </div>
              <button
                onClick={() => setNextSlotInfo(null)}
                className="text-xs text-muted-foreground hover:text-white"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Rules */}
      {activeTab === 'rules' && (
        <div className="space-y-6">
          {rulesLoading ? (
            <div className="py-20 flex justify-center">
              <LoadingComponent />
            </div>
          ) : rules.length === 0 ? (
            <div className="text-center py-20 bg-card/20 rounded-2xl border border-dashed border-border/60">
              <span className="text-4xl block mb-2">⚡</span>
              <h3 className="text-lg font-bold text-white">No Automation Rules Configured</h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1 mb-5">
                Automatically route approved drafts into specific queues, trigger notifications, or handle retry actions.
              </p>
              <button
                onClick={() => setIsRuleModalOpen(true)}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
              >
                Create Your First Rule
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="rounded-2xl border border-border/50 bg-card p-5 space-y-3 hover:border-indigo-500/40 transition"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-white text-sm">{rule.name}</h3>
                    <button
                      onClick={() => toggleRuleActive(rule)}
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        rule.isActive
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {rule.isActive ? 'Active' : 'Disabled'}
                    </button>
                  </div>

                  <div className="p-3 rounded-xl bg-background border border-border/60 text-xs font-mono space-y-1">
                    <p className="text-indigo-400 font-bold">WHEN: {rule.trigger}</p>
                    <p className="text-slate-400">
                      IF: {Object.keys(rule.conditions || {}).length ? JSON.stringify(rule.conditions) : 'Any post/draft'}
                    </p>
                    <p className="text-emerald-400 font-bold">THEN: Route to Queue & Auto-Assign</p>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-2 border-t border-border/40 font-mono">
                    <span>Executions: {rule.executionCount || 0} times</span>
                    <span>Last run: {rule.lastExecutedAt ? new Date(rule.lastExecutedAt).toLocaleDateString() : 'Never'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Modal: Create Queue */}
      {isQueueModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-card rounded-2xl border border-border p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-white">Create Publishing Queue</h3>
            <form onSubmit={handleCreateQueue} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Queue Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Afternoon Peak Engagement"
                  value={queueName}
                  onChange={(e) => setQueueName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Timezone</label>
                <select
                  value={queueTimezone}
                  onChange={(e) => setQueueTimezone(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="UTC">UTC (Coordinated Universal Time)</option>
                  <option value="America/New_York">America/New_York</option>
                  <option value="America/Los_Angeles">America/Los_Angeles</option>
                  <option value="Europe/London">Europe/London</option>
                  <option value="Europe/Paris">Europe/Paris</option>
                  <option value="Asia/Dubai">Asia/Dubai</option>
                  <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
                </select>
              </div>

              <div className="space-y-3 rounded-xl border border-border/60 bg-background/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h4 className="text-xs font-bold text-white">Weekly posting slots</h4>
                    <p className="text-[10px] text-muted-foreground">Choose days, local times and optional accounts for each slot.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setQueueSlots((current) => [...current, { dayOfWeek: 1, time: '09:00' }])}
                    className="rounded-lg border border-indigo-500/40 px-2.5 py-1.5 text-[10px] font-semibold text-indigo-300 hover:bg-indigo-500/10"
                  >
                    + Add slot
                  </button>
                </div>

                {queueSlots.map((slot, index) => (
                  <div key={index} className="space-y-2 rounded-lg border border-border/50 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={slot.dayOfWeek}
                        onChange={(e) => updateQueueSlot(index, { dayOfWeek: Number(e.target.value) })}
                        className="min-w-[110px] flex-1 rounded-lg border border-border bg-card px-2 py-2 text-xs text-white"
                        aria-label={`Slot ${index + 1} day`}
                      >
                        {DAYS_OF_WEEK.map((day, dayIndex) => <option key={dayIndex} value={dayIndex}>{day}</option>)}
                      </select>
                      <input
                        type="time"
                        value={slot.time}
                        onChange={(e) => updateQueueSlot(index, { time: e.target.value })}
                        className="rounded-lg border border-border bg-card px-2 py-2 text-xs text-white"
                        aria-label={`Slot ${index + 1} time`}
                      />
                      <button
                        type="button"
                        disabled={queueSlots.length <= 1}
                        onClick={() => setQueueSlots((current) => current.filter((_, slotIndex) => slotIndex !== index))}
                        className="rounded-lg border border-red-500/30 px-2.5 py-2 text-[10px] text-red-300 disabled:opacity-30"
                      >
                        Remove
                      </button>
                    </div>
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold text-muted-foreground">Apply to accounts (empty = all accounts)</p>
                      {availableIntegrations.length ? (
                        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                          {availableIntegrations.map((integration) => (
                            <label key={integration.id} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={(slot.integrations || []).includes(integration.id)}
                                onChange={(e) => toggleQueueSlotIntegration(index, integration.id, e.target.checked)}
                              />
                              {integration.name || integration.originalName || integration.identifier}
                            </label>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[10px] text-amber-300">Connect social accounts first to configure account-specific slots.</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-border/40">
                <button
                  type="button"
                  onClick={() => setIsQueueModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-border text-xs font-semibold text-muted-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
                >
                  Save Queue
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Create Rule */}
      {isRuleModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-card rounded-2xl border border-border p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-white">Add Automation Rule</h3>
            <form onSubmit={handleCreateRule} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Rule Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Route Approved Drafts to Primary Queue"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Event Trigger</label>
                <select
                  value={ruleTrigger}
                  onChange={(e) => setRuleTrigger(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="draft_approved">Draft Approved in Client Review</option>
                  <option value="post_failed">Post Publishing Failed (Auto-Retry)</option>
                  <option value="campaign_assigned">Post Assigned to Campaign</option>
                  <option value="queue_low">Queue Running Low (Alert Ops)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Platform Filter</label>
                <select
                  value={rulePlatform}
                  onChange={(e) => setRulePlatform(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="all">All Platforms</option>
                  <option value="linkedin">LinkedIn Only</option>
                  <option value="x">X (Twitter) Only</option>
                  <option value="instagram">Instagram Only</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-border/40">
                <button
                  type="button"
                  onClick={() => setIsRuleModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-border text-xs font-semibold text-muted-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
                >
                  Save Rule
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

