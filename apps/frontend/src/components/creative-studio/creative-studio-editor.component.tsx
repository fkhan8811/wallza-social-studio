'use client';

import { FC, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ImageEditorComponent } from './image-editor.component';
import { CarouselDesignerComponent } from './carousel-designer.component';
import { VideoEditorComponent } from './video-editor.component';

type CreativeProjectVersion = {
  id: string;
  version: number;
  name: string;
  type: string;
  createdAt: string;
  createdById: string;
};

export const CreativeStudioEditorComponent: FC<{ projectId: string }> = ({ projectId }) => {
  const fetch = useFetch();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [historyMessage, setHistoryMessage] = useState<string | null>(null);

  const { data: project, mutate, error, isLoading } = useSWR(
    `/creative-studio/projects/${projectId}`,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load creative project');
      return res.json();
    }
  );

  const { data: versions, mutate: mutateVersions, isLoading: versionsLoading } = useSWR<CreativeProjectVersion[]>(
    historyOpen ? `/creative-studio/projects/${projectId}/versions` : null,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load project version history');
      return res.json();
    }
  );

  const restore = async (version: number) => {
    if (!window.confirm(`Restore Creative Studio version ${version}? Your current saved state will remain in the version history.`)) return;
    setRestoringVersion(version);
    setHistoryMessage(null);
    try {
      const res = await fetch(`/creative-studio/projects/${projectId}/versions/${version}/restore`, {
        method: 'POST',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || 'Could not restore project version.');
      await mutate();
      await mutateVersions();
      setHistoryOpen(false);
      setHistoryMessage(`Restored version ${version}. The restored state has been saved as a new version.`);
    } catch (cause) {
      setHistoryMessage(cause instanceof Error ? cause.message : 'Could not restore project version.');
    } finally {
      setRestoringVersion(null);
    }
  };

  if (isLoading) {
    return (
      <div className="h-[80vh] flex flex-col items-center justify-center space-y-4">
        <LoadingComponent />
        <p className="text-xs text-muted-foreground font-mono">Loading Creative Studio Canvas...</p>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="h-[80vh] flex flex-col items-center justify-center space-y-4">
        <span className="text-4xl">⚠️</span>
        <h3 className="text-lg font-bold text-white">Project Not Found</h3>
        <p className="text-xs text-muted-foreground">The project may have been deleted or belongs to another organization.</p>
        <Link
          href="/creative-studio"
          className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold"
        >
          ← Back to Creative Studio
        </Link>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setHistoryOpen((open) => !open)}
        className="fixed right-5 top-[68px] z-[80] rounded-lg border border-white/15 bg-slate-900/95 px-3 py-2 text-xs font-semibold text-white shadow-lg backdrop-blur hover:bg-slate-800"
      >
        Version history
      </button>

      {historyOpen && (
        <div className="fixed inset-y-24 right-4 z-[90] flex w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-white/15 bg-slate-950 text-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div>
              <h3 className="text-sm font-bold">Project version history</h3>
              <p className="mt-0.5 text-[11px] text-slate-400">Latest 20 saved versions</p>
            </div>
            <button type="button" onClick={() => setHistoryOpen(false)} className="rounded-md px-2 py-1 text-slate-300 hover:bg-white/10" aria-label="Close version history">✕</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {versionsLoading ? (
              <div className="py-8 text-center text-xs text-slate-400">Loading versions…</div>
            ) : !versions?.length ? (
              <div className="py-8 text-center text-xs text-slate-400">No saved versions yet. Save this project to start a history.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {versions.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold">Version {item.version}</div>
                      <div className="mt-1 text-[11px] text-slate-400">{new Date(item.createdAt).toLocaleString()}</div>
                    </div>
                    <button
                      type="button"
                      disabled={restoringVersion !== null}
                      onClick={() => restore(item.version)}
                      className="shrink-0 rounded-md bg-indigo-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
                    >
                      {restoringVersion === item.version ? 'Restoring…' : 'Restore'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {historyMessage && <div role="status" className="border-t border-white/10 px-4 py-3 text-xs text-slate-300">{historyMessage}</div>}
        </div>
      )}

      {project.type === 'carousel' ? (
        <CarouselDesignerComponent key={project.updatedAt} project={project} onProjectUpdated={mutate} />
      ) : project.type === 'video' ? (
        <VideoEditorComponent key={project.updatedAt} project={project} onProjectUpdated={mutate} />
      ) : (
        <ImageEditorComponent key={project.updatedAt} project={project} onProjectUpdated={mutate} />
      )}
    </div>
  );
};
