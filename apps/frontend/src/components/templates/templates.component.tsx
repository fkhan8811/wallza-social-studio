'use client';

import { FC, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';

interface PostTemplate {
  id: string;
  name: string;
  category: string;
  content: string;
  platformVersions?: Record<string, { content: string }>;
  tags: string[];
  updatedAt: string;
}

interface DynamicVariable {
  id: string;
  name: string;
  fallbackValue: string;
  description: string | null;
}

interface HashtagGroup {
  id: string;
  name: string;
  category: string;
  tags: string[];
}

export const TemplatesComponent: FC = () => {
  const fetch = useFetch();
  const [activeTab, setActiveTab] = useState<'templates' | 'variables' | 'hashtags'>('templates');

  // Templates state
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [tplName, setTplName] = useState('');
  const [tplCategory, setTplCategory] = useState('Marketing');
  const [tplContent, setTplContent] = useState('');
  const [tplPlatform, setTplPlatform] = useState<string>('all');
  const [tplPlatformContent, setTplPlatformContent] = useState<Record<string, string>>({});
  const [searchTpl, setSearchTpl] = useState('');

  // Variables state
  const [isVarModalOpen, setIsVarModalOpen] = useState(false);
  const [varName, setVarName] = useState('');
  const [varValue, setVarValue] = useState('');
  const [varDesc, setVarDesc] = useState('');

  // Variable Resolver Test state
  const [testText, setTestText] = useState('Welcome to {brand_name}! Explore our platform at {website}.');
  const [resolvedResult, setResolvedResult] = useState<any>(null);

  // Hashtags state
  const [isHashModalOpen, setIsHashModalOpen] = useState(false);
  const [hashName, setHashName] = useState('');
  const [hashCategory, setHashCategory] = useState('Tech');
  const [hashTagsInput, setHashTagsInput] = useState('#SaaS, #Growth, #AI, #Productivity');
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [combinedHashtags, setCombinedHashtags] = useState<string>('');

  const { data: templates = [], mutate: mutateTemplates, isLoading: tplsLoading } = useSWR<PostTemplate[]>(
    `/content/templates?search=${encodeURIComponent(searchTpl)}`,
    async (url) => {
      const res = await fetch(url);
      return res.json();
    }
  );

  const { data: variables = [], mutate: mutateVariables, isLoading: varsLoading } = useSWR<DynamicVariable[]>(
    '/content/variables',
    async (url) => {
      const res = await fetch(url);
      return res.json();
    }
  );

  const { data: hashtagGroups = [], mutate: mutateHashtags, isLoading: hashesLoading } = useSWR<HashtagGroup[]>(
    '/content/hashtag-groups',
    async (url) => {
      const res = await fetch(url);
      return res.json();
    }
  );

  const handleCreateTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tplName.trim() || !tplContent.trim()) return;

    try {
      const platformVersions: Record<string, { content: string }> = {};
      Object.entries(tplPlatformContent).forEach(([p, c]) => {
        if (c.trim()) platformVersions[p] = { content: c.trim() };
      });

      await fetch('/content/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: tplName.trim(),
          category: tplCategory.trim() || 'General',
          content: tplContent.trim(),
          platformVersions,
        }),
      });

      setIsTemplateModalOpen(false);
      setTplName('');
      setTplContent('');
      setTplPlatformContent({});
      mutateTemplates();
    } catch (err: any) {
      alert(`Error creating template: ${err.message}`);
    }
  };

  const handleDuplicateTemplate = async (id: string) => {
    try {
      await fetch(`/content/templates/${id}/duplicate`, { method: 'POST' });
      mutateTemplates();
    } catch (err: any) {
      alert(`Duplicate error: ${err.message}`);
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm('Are you sure you want to delete this template?')) return;
    try {
      await fetch(`/content/templates/${id}`, { method: 'DELETE' });
      mutateTemplates();
    } catch (err: any) {
      alert(`Delete error: ${err.message}`);
    }
  };

  const handleUpsertVariable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!varName.trim()) return;
    try {
      await fetch('/content/variables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: varName.trim(),
          fallbackValue: varValue.trim(),
          description: varDesc.trim() || undefined,
        }),
      });
      setIsVarModalOpen(false);
      setVarName('');
      setVarValue('');
      setVarDesc('');
      mutateVariables();
    } catch (err: any) {
      alert(`Variable error: ${err.message}`);
    }
  };

  const handleTestResolve = async () => {
    try {
      const res = await fetch('/content/variables/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: testText }),
      });
      const data = await res.json();
      setResolvedResult(data);
    } catch (err: any) {
      alert(`Resolve error: ${err.message}`);
    }
  };

  const handleCreateHashtagGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hashName.trim() || !hashTagsInput.trim()) return;
    const tags = hashTagsInput.split(/[,\s]+/).map((t) => t.trim()).filter((t) => t.length > 1);

    try {
      await fetch('/content/hashtag-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: hashName.trim(),
          category: hashCategory.trim() || 'General',
          tags,
        }),
      });
      setIsHashModalOpen(false);
      setHashName('');
      setHashTagsInput('');
      mutateHashtags();
    } catch (err: any) {
      alert(`Hashtag error: ${err.message}`);
    }
  };

  const handleCombineGroups = async () => {
    if (selectedGroupIds.length === 0) return;
    try {
      const res = await fetch('/content/hashtag-groups/combine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupIds: selectedGroupIds }),
      });
      const data = await res.json();
      setCombinedHashtags(data.formattedString);
    } catch (err: any) {
      alert(`Combine error: ${err.message}`);
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-border/40 pb-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-white flex items-center gap-3">
            <span className="p-2 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-600 text-white shadow-lg">
              📝
            </span>
            Content Templates & Efficiency
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Build reusable post templates with dynamic variable substitutions and curated hashtag sets.
          </p>
        </div>

        <div className="flex gap-2">
          {activeTab === 'templates' && (
            <button
              onClick={() => setIsTemplateModalOpen(true)}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow transition"
            >
              + Create Template
            </button>
          )}
          {activeTab === 'variables' && (
            <button
              onClick={() => setIsVarModalOpen(true)}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow transition"
            >
              + Add Variable
            </button>
          )}
          {activeTab === 'hashtags' && (
            <button
              onClick={() => setIsHashModalOpen(true)}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow transition"
            >
              + New Hashtag Group
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-3 border-b border-border/40 pb-px">
        <button
          onClick={() => setActiveTab('templates')}
          className={`pb-3 text-sm font-semibold border-b-2 transition ${
            activeTab === 'templates'
              ? 'border-indigo-500 text-white font-bold'
              : 'border-transparent text-muted-foreground hover:text-white'
          }`}
        >
          Post Templates ({templates.length})
        </button>
        <button
          onClick={() => setActiveTab('variables')}
          className={`pb-3 text-sm font-semibold border-b-2 transition ${
            activeTab === 'variables'
              ? 'border-indigo-500 text-white font-bold'
              : 'border-transparent text-muted-foreground hover:text-white'
          }`}
        >
          Dynamic Variables ({variables.length})
        </button>
        <button
          onClick={() => setActiveTab('hashtags')}
          className={`pb-3 text-sm font-semibold border-b-2 transition ${
            activeTab === 'hashtags'
              ? 'border-indigo-500 text-white font-bold'
              : 'border-transparent text-muted-foreground hover:text-white'
          }`}
        >
          Hashtag Groups ({hashtagGroups.length})
        </button>
      </div>

      {/* Tab 1: Post Templates */}
      {activeTab === 'templates' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <input
              type="text"
              placeholder="Search templates..."
              value={searchTpl}
              onChange={(e) => setSearchTpl(e.target.value)}
              className="w-full sm:w-72 px-3 py-1.5 rounded-xl bg-card border border-border/60 text-xs text-white"
            />
          </div>

          {tplsLoading ? (
            <div className="py-20 flex justify-center">
              <LoadingComponent />
            </div>
          ) : templates.length === 0 ? (
            <div className="text-center py-20 bg-card/20 rounded-2xl border border-dashed border-border/60">
              <span className="text-4xl block mb-2">📋</span>
              <h3 className="text-lg font-bold text-white">No Templates Saved Yet</h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1 mb-5">
                Save time by turning your best-performing copy into reusable templates with platform variants.
              </p>
              <button
                onClick={() => setIsTemplateModalOpen(true)}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
              >
                Create Your First Template
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {templates.map((tpl) => (
                <div
                  key={tpl.id}
                  className="rounded-2xl border border-border/50 bg-card p-5 space-y-3 hover:border-indigo-500/40 transition flex flex-col justify-between"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-muted text-muted-foreground uppercase">
                        {tpl.category}
                      </span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleDuplicateTemplate(tpl.id)}
                          className="p-1 rounded text-xs text-muted-foreground hover:text-white"
                          title="Duplicate"
                        >
                          📋
                        </button>
                        <button
                          onClick={() => handleDeleteTemplate(tpl.id)}
                          className="p-1 rounded text-xs text-muted-foreground hover:text-rose-400"
                          title="Delete"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                    <h3 className="font-bold text-white text-sm truncate">{tpl.name}</h3>
                    <p className="text-xs text-slate-300 whitespace-pre-wrap line-clamp-4 bg-muted/20 p-2.5 rounded-xl border border-border/30 font-sans">
                      {tpl.content}
                    </p>
                  </div>

                  <div className="pt-3 border-t border-border/40 flex items-center justify-between text-xs text-muted-foreground">
                    <span className="text-[10px] font-mono">
                      {Object.keys(tpl.platformVersions || {}).length} platform variants
                    </span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(tpl.content);
                        alert('Template copied to clipboard! Paste directly into Postiz Composer.');
                      }}
                      className="px-3 py-1 rounded bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 font-semibold transition"
                    >
                      Copy Copy 📋
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Dynamic Variables */}
      {activeTab === 'variables' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-4">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              Configured Organization Variables
            </h3>
            {varsLoading ? (
              <LoadingComponent />
            ) : (
              <div className="rounded-2xl border border-border/50 bg-card overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/40 border-b border-border/40 text-muted-foreground uppercase font-mono text-[10px]">
                    <tr>
                      <th className="p-3">Variable Token</th>
                      <th className="p-3">Fallback Value</th>
                      <th className="p-3">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {variables.map((v) => (
                      <tr key={v.id} className="hover:bg-muted/20">
                        <td className="p-3 font-mono font-bold text-indigo-400">
                          {`{${v.name}}`}
                        </td>
                        <td className="p-3 text-white font-medium">{v.fallbackValue}</td>
                        <td className="p-3 text-muted-foreground">{v.description || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Variable Resolver Simulator */}
          <div className="rounded-2xl border border-border/50 bg-card p-5 space-y-4">
            <h3 className="text-sm font-bold text-white">Live Variable Resolver</h3>
            <p className="text-xs text-muted-foreground">
              Test variable replacement in your post text before scheduling.
            </p>
            <textarea
              rows={4}
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              className="w-full p-2.5 rounded-xl bg-background border border-border text-xs text-white"
            />
            <button
              onClick={handleTestResolve}
              className="w-full py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow transition"
            >
              Test Variable Substitution ➔
            </button>

            {resolvedResult && (
              <div className="p-3 rounded-xl bg-background border border-border/60 space-y-2 text-xs">
                <p className="font-semibold text-emerald-400">
                  {resolvedResult.isPublishSafe ? '✓ All variables resolved' : '⚠️ Missing variables detected'}
                </p>
                <p className="text-white whitespace-pre-wrap">{resolvedResult.resolvedText}</p>
                <div className="pt-2 border-t border-border/40 font-mono text-[10px] text-muted-foreground">
                  Used: {resolvedResult.variablesUsed.join(', ') || 'None'}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 3: Hashtags */}
      {activeTab === 'hashtags' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <p className="text-xs text-muted-foreground">
              Select multiple groups to combine and deduplicate into a single hashtag string.
            </p>
            <button
              onClick={handleCombineGroups}
              disabled={selectedGroupIds.length === 0}
              className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold text-xs transition"
            >
              Combine Selected Groups ({selectedGroupIds.length})
            </button>
          </div>

          {combinedHashtags && (
            <div className="p-4 rounded-xl bg-indigo-950/40 border border-indigo-500/30 space-y-2 animate-fade-in">
              <div className="flex justify-between items-center text-xs">
                <span className="font-bold text-white">Combined Hashtag String</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(combinedHashtags);
                    alert('Copied hashtags!');
                  }}
                  className="text-xs text-indigo-300 underline"
                >
                  Copy All
                </button>
              </div>
              <p className="text-xs text-indigo-200 font-mono">{combinedHashtags}</p>
            </div>
          )}

          {hashesLoading ? (
            <LoadingComponent />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {hashtagGroups.map((group) => {
                const isSelected = selectedGroupIds.includes(group.id);
                return (
                  <div
                    key={group.id}
                    onClick={() => {
                      setSelectedGroupIds(
                        isSelected ? selectedGroupIds.filter((id) => id !== group.id) : [...selectedGroupIds, group.id]
                      );
                    }}
                    className={`cursor-pointer rounded-2xl border p-5 space-y-3 transition ${
                      isSelected
                        ? 'border-indigo-500 bg-indigo-950/30'
                        : 'border-border/50 bg-card hover:border-border'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="font-bold text-white text-sm">{group.name}</h3>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        className="rounded border-border text-indigo-600 focus:ring-0"
                      />
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground uppercase">{group.category}</span>
                    <div className="flex flex-wrap gap-1 pt-1">
                      {group.tags.map((tag) => (
                        <span
                          key={tag}
                          className="px-2 py-0.5 rounded text-[11px] font-mono bg-muted/60 text-slate-300"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Modal: Create Template */}
      {isTemplateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg bg-card rounded-2xl border border-border p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-white">Create Post Template</h3>
            <form onSubmit={handleCreateTemplate} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Template Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Weekly Launch Announcement"
                  value={tplName}
                  onChange={(e) => setTplName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Category</label>
                <input
                  type="text"
                  placeholder="e.g. Product, Marketing, Culture"
                  value={tplCategory}
                  onChange={(e) => setTplCategory(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white"
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-xs font-semibold text-muted-foreground">Master Copy Content</label>
                  <div className="flex gap-1">
                    {['brand_name', 'website', 'call_to_action'].map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setTplContent((prev) => `${prev} {${v}}`)}
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 hover:bg-indigo-900"
                      >
                        +{v}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  rows={4}
                  required
                  placeholder="Draft your reusable caption with {variables}..."
                  value={tplContent}
                  onChange={(e) => setTplContent(e.target.value)}
                  className="w-full p-2.5 rounded-xl bg-background border border-border text-xs text-white"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-border/40">
                <button
                  type="button"
                  onClick={() => setIsTemplateModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-border text-xs font-semibold text-muted-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
                >
                  Save Template
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Create Variable */}
      {isVarModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-card rounded-2xl border border-border p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-white">Add Dynamic Variable</h3>
            <form onSubmit={handleUpsertVariable} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Variable Identifier</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. promo_code"
                  value={varName}
                  onChange={(e) => setVarName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Fallback Value</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. SAVE20"
                  value={varValue}
                  onChange={(e) => setVarValue(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Description</label>
                <input
                  type="text"
                  placeholder="e.g. Active discount code for Q4"
                  value={varDesc}
                  onChange={(e) => setVarDesc(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-border/40">
                <button
                  type="button"
                  onClick={() => setIsVarModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-border text-xs font-semibold text-muted-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
                >
                  Save Variable
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Create Hashtag Group */}
      {isHashModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-card rounded-2xl border border-border p-6 shadow-2xl space-y-4">
            <h3 className="text-lg font-bold text-white">Create Hashtag Group</h3>
            <form onSubmit={handleCreateHashtagGroup} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Group Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. AI Product Launch"
                  value={hashName}
                  onChange={(e) => setHashName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Category</label>
                <input
                  type="text"
                  placeholder="e.g. Artificial Intelligence"
                  value={hashCategory}
                  onChange={(e) => setHashCategory(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-background border border-border text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-muted-foreground mb-1">Hashtags (comma separated)</label>
                <textarea
                  rows={3}
                  required
                  placeholder="#ArtificialIntelligence, #MachineLearning, #TechNews"
                  value={hashTagsInput}
                  onChange={(e) => setHashTagsInput(e.target.value)}
                  className="w-full p-2.5 rounded-xl bg-background border border-border text-xs text-white"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-border/40">
                <button
                  type="button"
                  onClick={() => setIsHashModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-border text-xs font-semibold text-muted-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
                >
                  Save Group
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
