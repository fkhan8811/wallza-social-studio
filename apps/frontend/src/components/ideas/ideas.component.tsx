'use client';

import { FC, FormEvent, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';

type ContentIdea = {
  id: string;
  title: string;
  brief: string;
  stageId: string;
  position: number;
  platformTargets: string[];
  labels: string[];
  dueDate: string | null;
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
};

type IdeaStage = {
  id: string;
  name: string;
  color: string;
  position: number;
  ideas: ContentIdea[];
};

const splitList = (value: string) =>
  [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];

const readableDate = (value: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date);
};

export const IdeasComponent: FC = () => {
  const fetch = useFetch();
  const load = useCallback(async (path: string): Promise<IdeaStage[]> => {
    const response = await fetch(path);
    if (!response.ok) throw new Error('Could not load the Ideas pipeline.');
    return response.json();
  }, [fetch]);

  const { data, isLoading, error, mutate } = useSWR<IdeaStage[]>('/ideas', load);
  const [showComposer, setShowComposer] = useState(false);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [targets, setTargets] = useState('');
  const [labels, setLabels] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [targetStageId, setTargetStageId] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [draggedIdeaId, setDraggedIdeaId] = useState<string | null>(null);
  const [newStageName, setNewStageName] = useState('');
  const [addingStage, setAddingStage] = useState(false);

  const stages = useMemo(() => data || [], [data]);
  const totalIdeas = useMemo(
    () => stages.reduce((total, stage) => total + stage.ideas.length, 0),
    [stages]
  );

  const createIdea = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) {
      setMessage('Add a title before saving this idea.');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch('/ideas', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          brief,
          platformTargets: splitList(targets),
          labels: splitList(labels),
          ownerName: ownerName.trim() || null,
          dueDate: dueDate || null,
          stageId: targetStageId || stages[0]?.id,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'Could not save this idea.');
      }
      setTitle('');
      setBrief('');
      setTargets('');
      setLabels('');
      setOwnerName('');
      setDueDate('');
      setShowComposer(false);
      await mutate();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not save this idea.');
    } finally {
      setSaving(false);
    }
  }, [title, brief, targets, labels, ownerName, dueDate, targetStageId, stages, fetch, mutate]);

  const moveIdea = useCallback(async (ideaId: string, stageId: string) => {
    if (!ideaId || !stageId) return;
    setDraggedIdeaId(null);
    const response = await fetch(`/ideas/${ideaId}/move`, {
      method: 'POST',
      body: JSON.stringify({ stageId }),
    });
    if (!response.ok) {
      setMessage('The idea could not be moved. Please try again.');
      return;
    }
    setMessage(null);
    await mutate();
  }, [fetch, mutate]);

  const deleteIdea = useCallback(async (ideaId: string) => {
    if (!window.confirm('Delete this idea? This cannot be undone.')) return;
    const response = await fetch(`/ideas/${ideaId}`, { method: 'DELETE' });
    if (!response.ok) {
      setMessage('The idea could not be deleted.');
      return;
    }
    await mutate();
  }, [fetch, mutate]);

  const addStage = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newStageName.trim();
    if (!name) return;
    const response = await fetch('/ideas/stages', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      setMessage('Could not add this stage. Check that its name is unique.');
      return;
    }
    setNewStageName('');
    setAddingStage(false);
    await mutate();
  }, [newStageName, fetch, mutate]);

  if (isLoading) return <LoadingComponent />;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-[20px] p-[24px] mobile:p-[14px] overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-[16px]">
        <div className="flex flex-col gap-[6px]">
          <div className="text-[24px] font-[700]">Ideas & Content Pipeline</div>
          <div className="text-[13px] text-textItemBlur">
            Capture ideas, develop briefs and move content towards publication.
          </div>
          <div className="text-[12px] text-textItemBlur">{totalIdeas} {totalIdeas === 1 ? 'idea' : 'ideas'} across {stages.length} stages</div>
        </div>
        <button
          type="button"
          onClick={() => setShowComposer((value) => !value)}
          className="rounded-[9px] bg-[#6d4aff] px-[16px] py-[10px] text-[13px] font-[600] text-white hover:opacity-90"
        >
          {showComposer ? 'Close' : '+ New idea'}
        </button>
      </div>

      {(message || error) && (
        <div role="alert" className="rounded-[8px] border border-red-500/30 bg-red-500/10 px-[14px] py-[10px] text-[13px] text-red-300">
          {message || (error instanceof Error ? error.message : 'Could not load the Ideas pipeline.')}
        </div>
      )}

      {showComposer && (
        <form onSubmit={createIdea} className="grid grid-cols-1 gap-[12px] rounded-[12px] border border-blockSeparator bg-newBgColorInner p-[16px] lg:grid-cols-2">
          <div className="flex flex-col gap-[6px]">
            <label className="text-[12px] text-textItemBlur">Idea title *</label>
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required placeholder="e.g. Diwali campaign launch" className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px] outline-none focus:border-[#8b6cff]" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <label className="text-[12px] text-textItemBlur">Owner</label>
            <input value={ownerName} onChange={(event) => setOwnerName(event.target.value)} maxLength={80} placeholder="Assign a team member" className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px] outline-none focus:border-[#8b6cff]" />
          </div>
          <div className="flex flex-col gap-[6px] lg:col-span-2">
            <label className="text-[12px] text-textItemBlur">Brief / notes</label>
            <textarea value={brief} onChange={(event) => setBrief(event.target.value)} maxLength={4000} rows={3} placeholder="Describe the angle, hook, key message or creative direction..." className="resize-y rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px] outline-none focus:border-[#8b6cff]" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <label className="text-[12px] text-textItemBlur">Target platforms (comma separated)</label>
            <input value={targets} onChange={(event) => setTargets(event.target.value)} placeholder="Instagram, LinkedIn, TikTok" className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px] outline-none focus:border-[#8b6cff]" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <label className="text-[12px] text-textItemBlur">Labels (comma separated)</label>
            <input value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="Campaign, Product launch" className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px] outline-none focus:border-[#8b6cff]" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <label className="text-[12px] text-textItemBlur">Due date</label>
            <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px] outline-none focus:border-[#8b6cff]" />
          </div>
          <div className="flex flex-col gap-[6px]">
            <label className="text-[12px] text-textItemBlur">Starting stage</label>
            <select value={targetStageId} onChange={(event) => setTargetStageId(event.target.value)} className="rounded-[8px] border border-blockSeparator bg-newBgColor px-[12px] py-[10px] text-[13px] outline-none focus:border-[#8b6cff]">
              {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
            </select>
          </div>
          <div className="flex justify-end lg:col-span-2">
            <button disabled={saving} type="submit" className="rounded-[8px] bg-[#6d4aff] px-[18px] py-[10px] text-[13px] font-[600] text-white disabled:opacity-50">
              {saving ? 'Saving...' : 'Save idea'}
            </button>
          </div>
        </form>
      )}

      <div className="flex min-h-[420px] flex-1 items-start gap-[14px] overflow-x-auto pb-[12px]">
        {stages.map((stage) => (
          <section
            key={stage.id}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (draggedIdeaId) void moveIdea(draggedIdeaId, stage.id);
            }}
            className="flex min-h-[400px] w-[280px] min-w-[280px] flex-col rounded-[12px] border border-blockSeparator bg-newBgColorInner"
          >
            <div className="flex items-center justify-between border-b border-blockSeparator px-[14px] py-[13px]">
              <div className="flex items-center gap-[9px]">
                <span className="h-[9px] w-[9px] rounded-full" style={{ backgroundColor: stage.color }} />
                <h2 className="text-[13px] font-[700]">{stage.name}</h2>
                <span className="rounded-full bg-newBgColor px-[7px] py-[2px] text-[11px] text-textItemBlur">{stage.ideas.length}</span>
              </div>
            </div>
            <div className="flex flex-1 flex-col gap-[10px] p-[10px]">
              {stage.ideas.map((idea) => (
                <article
                  key={idea.id}
                  draggable
                  onDragStart={() => setDraggedIdeaId(idea.id)}
                  onDragEnd={() => setDraggedIdeaId(null)}
                  className="group cursor-grab rounded-[9px] border border-blockSeparator bg-newBgColor p-[12px] active:cursor-grabbing"
                >
                  <div className="flex items-start justify-between gap-[8px]">
                    <h3 className="min-w-0 break-words text-[13px] font-[650]">{idea.title}</h3>
                    <button type="button" aria-label="Delete idea" onClick={() => void deleteIdea(idea.id)} className="shrink-0 text-[12px] text-textItemBlur opacity-0 hover:text-red-400 group-hover:opacity-100">×</button>
                  </div>
                  {idea.brief && <p className="mt-[8px] whitespace-pre-wrap break-words text-[12px] leading-[1.55] text-textItemBlur">{idea.brief}</p>}
                  {!!idea.platformTargets?.length && (
                    <div className="mt-[10px] flex flex-wrap gap-[5px]">
                      {idea.platformTargets.map((platform) => <span key={platform} className="rounded-full bg-[#6d4aff]/10 px-[7px] py-[3px] text-[10px] text-[#b7a5ff]">{platform}</span>)}
                    </div>
                  )}
                  {!!idea.labels?.length && (
                    <div className="mt-[7px] flex flex-wrap gap-[5px]">
                      {idea.labels.map((label) => <span key={label} className="rounded-full bg-newBgColorInner px-[7px] py-[3px] text-[10px] text-textItemBlur">{label}</span>)}
                    </div>
                  )}
                  <div className="mt-[12px] flex flex-wrap items-center justify-between gap-[8px] border-t border-blockSeparator pt-[9px] text-[10px] text-textItemBlur">
                    <span>{idea.ownerName || 'Unassigned'}</span>
                    {readableDate(idea.dueDate) && <span>Due {readableDate(idea.dueDate)}</span>}
                  </div>
                </article>
              ))}
              {stage.ideas.length === 0 && (
                <div className="flex min-h-[100px] items-center justify-center rounded-[8px] border border-dashed border-blockSeparator px-[12px] text-center text-[11px] text-textItemBlur">
                  Drop an idea here
                </div>
              )}
            </div>
          </section>
        ))}
        <div className="w-[250px] min-w-[250px]">
          {addingStage ? (
            <form onSubmit={addStage} className="flex flex-col gap-[8px] rounded-[10px] border border-blockSeparator bg-newBgColorInner p-[12px]">
              <input autoFocus value={newStageName} onChange={(event) => setNewStageName(event.target.value)} maxLength={40} placeholder="Stage name" className="rounded-[7px] border border-blockSeparator bg-newBgColor px-[10px] py-[8px] text-[12px] outline-none" />
              <div className="flex gap-[7px]">
                <button type="submit" className="rounded-[7px] bg-[#6d4aff] px-[10px] py-[7px] text-[11px] text-white">Add stage</button>
                <button type="button" onClick={() => setAddingStage(false)} className="rounded-[7px] px-[10px] py-[7px] text-[11px] text-textItemBlur">Cancel</button>
              </div>
            </form>
          ) : (
            <button type="button" onClick={() => setAddingStage(true)} className="w-full rounded-[10px] border border-dashed border-blockSeparator px-[12px] py-[13px] text-left text-[12px] text-textItemBlur hover:border-[#8b6cff] hover:text-newTextColor">
              + Add stage
            </button>
          )}
        </div>
      </div>
      <div className="text-[11px] text-textItemBlur">
        Drag cards between stages. Ideas are saved to your organization and remain separate from scheduled posts until you create a post from them.
      </div>
    </div>
  );
};
