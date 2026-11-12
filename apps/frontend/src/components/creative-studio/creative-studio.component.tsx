'use client';

import { FC, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';

interface CreativeProject {
  id: string;
  name: string;
  type: 'image' | 'carousel' | 'video';
  dimensions: { width: number; height: number; preset?: string };
  thumbnailUrl: string | null;
  updatedAt: string;
  owner?: { name: string; email: string };
}

interface Template {
  id: string;
  name: string;
  type: 'image' | 'carousel' | 'video';
  category: string;
  dimensions: { width: number; height: number; preset: string };
  thumbnailUrl: string;
}

export const CreativeStudioComponent: FC = () => {
  const fetch = useFetch();
  const router = useRouter();
  const [selectedType, setSelectedType] = useState<string>('all');
  const [search, setSearch] = useState<string>('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectType, setNewProjectType] = useState<'image' | 'carousel' | 'video'>('image');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: projectsData, mutate, isLoading } = useSWR(
    `/creative-studio/projects?type=${selectedType !== 'all' ? selectedType : ''}&search=${encodeURIComponent(search)}`,
    async (url) => {
      const res = await fetch(url);
      return res.json();
    }
  );

  const { data: templates = [] } = useSWR<Template[]>(
    '/creative-studio/templates',
    async (url) => {
      const res = await fetch(url);
      return res.json();
    }
  );

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;

    setIsSubmitting(true);
    try {
      const res = await fetch('/creative-studio/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newProjectName.trim(),
          type: newProjectType,
          fromTemplateId: selectedTemplateId || undefined,
        }),
      });
      const newProj = await res.json();
      setIsCreateOpen(false);
      setNewProjectName('');
      setSelectedTemplateId(null);
      mutate();
      router.push(`/creative-studio/${newProj.id}`);
    } catch (err: any) {
      alert(`Error creating project: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete project "${name}"?`)) return;
    try {
      await fetch(`/creative-studio/projects/${id}`, { method: 'DELETE' });
      mutate();
    } catch (err: any) {
      alert(`Delete failed: ${err.message}`);
    }
  };

  const projects: CreativeProject[] = projectsData?.projects || [];

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border/40 pb-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-white flex items-center gap-3">
            <span className="p-2 rounded-xl bg-gradient-to-tr from-pink-500 to-indigo-600 text-white shadow-lg">
              🎨
            </span>
            Creative Studio
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Design graphics, multi-slide carousels, and timeline videos natively. Export directly to your Postiz composer.
          </p>
        </div>
        <button
          onClick={() => {
            setIsCreateOpen(true);
            setSelectedTemplateId(null);
          }}
          className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm shadow-md transition flex items-center gap-2"
        >
          <span className="text-lg leading-none">+</span> New Creative Project
        </button>
      </div>

      {/* Templates Row */}
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Quick-Start Templates
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {templates.slice(0, 4).map((tpl) => (
            <div
              key={tpl.id}
              onClick={() => {
                setNewProjectName(tpl.name);
                setNewProjectType(tpl.type);
                setSelectedTemplateId(tpl.id);
                setIsCreateOpen(true);
              }}
              className="group relative cursor-pointer overflow-hidden rounded-xl border border-border/50 bg-card/60 p-3 hover:border-indigo-500/60 hover:bg-card transition"
            >
              <div
                className="w-full h-32 rounded-lg bg-cover bg-center mb-3 group-hover:scale-105 transition duration-300"
                style={{ backgroundImage: `url(${tpl.thumbnailUrl})` }}
              />
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase font-mono px-2 py-0.5 rounded bg-muted text-muted-foreground">
                  {tpl.type}
                </span>
                <span className="text-[11px] text-muted-foreground">{tpl.dimensions.preset}</span>
              </div>
              <h3 className="font-semibold text-sm text-white mt-1 group-hover:text-indigo-400 transition truncate">
                {tpl.name}
              </h3>
            </div>
          ))}
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row gap-4 items-center justify-between bg-card/40 p-4 rounded-xl border border-border/40">
        <div className="flex flex-wrap gap-2">
          {['all', 'image', 'carousel', 'video'].map((type) => (
            <button
              key={type}
              onClick={() => setSelectedType(type)}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold capitalize transition ${
                selectedType === type
                  ? 'bg-indigo-600 text-white shadow'
                  : 'bg-muted/60 text-muted-foreground hover:text-white'
              }`}
            >
              {type === 'all' ? 'All Projects' : `${type}s`}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search projects..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full sm:w-64 px-3 py-1.5 rounded-lg bg-background border border-border/60 text-xs text-white placeholder-muted-foreground focus:outline-none focus:border-indigo-500"
        />
      </div>

      {/* Projects Grid */}
      {isLoading ? (
        <div className="py-20 flex justify-center">
          <LoadingComponent />
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-20 bg-card/20 rounded-2xl border border-dashed border-border/60">
          <span className="text-4xl block mb-2">✨</span>
          <h3 className="text-lg font-bold text-white">No Creative Projects Yet</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1 mb-5">
            Start from scratch or use one of our social templates to design high-converting posts.
          </p>
          <button
            onClick={() => setIsCreateOpen(true)}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
          >
            Create Your First Project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {projects.map((proj) => (
            <div
              key={proj.id}
              className="flex flex-col justify-between overflow-hidden rounded-2xl border border-border/50 bg-card hover:border-indigo-500/50 transition group shadow-sm hover:shadow-md"
            >
              <Link href={`/creative-studio/${proj.id}`} className="block relative aspect-video bg-muted/30 overflow-hidden">
                {proj.thumbnailUrl ? (
                  <img
                    src={proj.thumbnailUrl}
                    alt={proj.name}
                    className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground bg-gradient-to-br from-slate-900 to-indigo-950/40">
                    <span className="text-3xl mb-1">
                      {proj.type === 'video' ? '🎬' : proj.type === 'carousel' ? '📑' : '🖼️'}
                    </span>
                    <span className="text-[11px] font-mono capitalize">{proj.type} Canvas</span>
                  </div>
                )}
                <div className="absolute top-2 left-2">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-black/70 text-white backdrop-blur border border-white/10">
                    {proj.type}
                  </span>
                </div>
              </Link>
              <div className="p-4 space-y-3">
                <div>
                  <Link href={`/creative-studio/${proj.id}`}>
                    <h3 className="font-bold text-sm text-white hover:text-indigo-400 transition truncate">
                      {proj.name}
                    </h3>
                  </Link>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Updated {new Date(proj.updatedAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border/40 text-xs">
                  <span className="text-[11px] text-muted-foreground font-mono">
                    {proj.dimensions?.width}x{proj.dimensions?.height}
                  </span>
                  <div className="flex gap-2">
                    <Link
                      href={`/creative-studio/${proj.id}`}
                      className="px-2.5 py-1 rounded bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 font-medium transition"
                    >
                      Open
                    </Link>
                    <button
                      onClick={() => handleDelete(proj.id, proj.name)}
                      className="p-1 rounded text-muted-foreground hover:text-rose-400 transition"
                      title="Delete project"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Project Modal */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-card rounded-2xl border border-border p-6 shadow-2xl space-y-5">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold text-white">Create Creative Project</h3>
              <button
                onClick={() => setIsCreateOpen(false)}
                className="text-muted-foreground hover:text-white text-lg"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">
                  Project Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Q4 Growth Carousel"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">
                  Project Format
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'image', label: 'Graphic Image', icon: '🖼️' },
                    { id: 'carousel', label: 'Multi-Slide', icon: '📑' },
                    { id: 'video', label: 'Timeline Video', icon: '🎬' },
                  ].map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setNewProjectType(f.id as any)}
                      className={`p-3 rounded-xl border flex flex-col items-center gap-1 transition ${
                        newProjectType === f.id
                          ? 'border-indigo-500 bg-indigo-600/10 text-white font-bold'
                          : 'border-border/60 bg-muted/30 text-muted-foreground hover:text-white'
                      }`}
                    >
                      <span className="text-xl">{f.icon}</span>
                      <span className="text-xs">{f.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {selectedTemplateId && (
                <div className="p-3 rounded-xl bg-indigo-950/40 border border-indigo-500/30 text-xs text-indigo-300 flex items-center justify-between">
                  <span>Selected template: <strong>{newProjectName}</strong></span>
                  <button
                    type="button"
                    onClick={() => setSelectedTemplateId(null)}
                    className="text-xs text-indigo-400 underline"
                  >
                    Clear
                  </button>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-3 border-t border-border/40">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  className="px-4 py-2 rounded-xl border border-border text-xs font-semibold text-muted-foreground hover:text-white transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !newProjectName.trim()}
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold transition"
                >
                  {isSubmitting ? 'Creating...' : 'Start Designing →'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
