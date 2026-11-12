'use client';

import { FC } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ImageEditorComponent } from './image-editor.component';
import { CarouselDesignerComponent } from './carousel-designer.component';
import { VideoEditorComponent } from './video-editor.component';

export const CreativeStudioEditorComponent: FC<{ projectId: string }> = ({ projectId }) => {
  const fetch = useFetch();

  const { data: project, mutate, error, isLoading } = useSWR(
    `/creative-studio/projects/${projectId}`,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load creative project');
      return res.json();
    }
  );

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

  if (project.type === 'carousel') {
    return <CarouselDesignerComponent project={project} onProjectUpdated={mutate} />;
  }

  if (project.type === 'video') {
    return <VideoEditorComponent project={project} onProjectUpdated={mutate} />;
  }

  return <ImageEditorComponent project={project} onProjectUpdated={mutate} />;
};
