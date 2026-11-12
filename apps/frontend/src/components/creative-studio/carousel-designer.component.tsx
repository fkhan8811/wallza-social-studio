'use client';

import { FC, useState } from 'react';
import Link from 'next/link';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface Slide {
  id: string;
  slideNumber: number;
  title: string;
  headline: string;
  body: string;
  badgeText?: string;
  footerText?: string;
  bgColor?: string;
  textColor?: string;
  accentColor?: string;
}

export const CarouselDesignerComponent: FC<{ project: any; onProjectUpdated: () => void }> = ({
  project,
  onProjectUpdated,
}) => {
  const fetch = useFetch();

  const initialSlides: Slide[] = project.data?.slides || [
    {
      id: 's1',
      slideNumber: 1,
      title: 'Cover Slide',
      badgeText: 'SWIPE FOR INSIGHTS ➔',
      headline: 'The Ultimate Guide to Cross-Channel Content',
      body: 'Master modern social scheduling and brand voice in 5 simple slides.',
      footerText: 'Curated by Wallza Studio',
      bgColor: '#09090B',
      textColor: '#FFFFFF',
      accentColor: '#38BDF8',
    },
    {
      id: 's2',
      slideNumber: 2,
      title: 'Tactic 1',
      badgeText: 'STEP 01',
      headline: 'Prioritize Format Over Volume',
      body: 'Different networks demand specialized formats. Carousels perform highest on LinkedIn and Instagram.',
      footerText: 'Slide 2 of 5',
      bgColor: '#09090B',
      textColor: '#FFFFFF',
      accentColor: '#818CF8',
    },
    {
      id: 's3',
      slideNumber: 3,
      title: 'Tactic 2',
      badgeText: 'STEP 02',
      headline: 'Automate Recurring Slot Queues',
      body: 'Set preferred posting windows so your high-value ideas fill queue slots without manual date picking.',
      footerText: 'Slide 3 of 5',
      bgColor: '#09090B',
      textColor: '#FFFFFF',
      accentColor: '#34D399',
    },
    {
      id: 's4',
      slideNumber: 4,
      title: 'Call to Action',
      badgeText: 'TAKEAWAY',
      headline: 'Ready To Scale Your Content?',
      body: 'Save this carousel and start scheduling with Wallza Social Studio today.',
      footerText: 'Follow @wallzaofficial for daily breakdowns',
      bgColor: '#09090B',
      textColor: '#FFFFFF',
      accentColor: '#F472B6',
    },
  ];

  const [slides, setSlides] = useState<Slide[]>(initialSlides);
  const [currentSlideIndex, setCurrentSlideIndex] = useState<number>(0);
  const [brandGlobalColor, setBrandGlobalColor] = useState<string>('#09090B');
  const [brandGlobalAccent, setBrandGlobalAccent] = useState<string>('#38BDF8');
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);

  const currentSlide = slides[currentSlideIndex] || slides[0];

  const updateCurrentSlide = (updates: Partial<Slide>) => {
    const next = slides.map((s, idx) => (idx === currentSlideIndex ? { ...s, ...updates } : s));
    setSlides(next);
  };

  const addSlide = () => {
    const nextNum = slides.length + 1;
    const newSlide: Slide = {
      id: `s_${Date.now()}`,
      slideNumber: nextNum,
      title: `Slide ${nextNum}`,
      badgeText: `STEP 0${nextNum}`,
      headline: 'New Slide Headline',
      body: 'Add your strategic point or supporting breakdown here.',
      footerText: `Slide ${nextNum} of ${nextNum}`,
      bgColor: brandGlobalColor,
      textColor: '#FFFFFF',
      accentColor: brandGlobalAccent,
    };
    const next = [...slides, newSlide];
    setSlides(next);
    setCurrentSlideIndex(next.length - 1);
  };

  const duplicateSlide = () => {
    if (!currentSlide) return;
    const nextNum = slides.length + 1;
    const dup: Slide = {
      ...JSON.parse(JSON.stringify(currentSlide)),
      id: `s_${Date.now()}`,
      slideNumber: nextNum,
      title: `${currentSlide.title} (Copy)`,
    };
    const next = [...slides, dup];
    setSlides(next);
    setCurrentSlideIndex(next.length - 1);
  };

  const deleteSlide = () => {
    if (slides.length <= 1) {
      alert('Carousel must have at least 1 slide.');
      return;
    }
    const next = slides.filter((_, idx) => idx !== currentSlideIndex);
    setSlides(next);
    setCurrentSlideIndex(Math.max(0, currentSlideIndex - 1));
  };

  const moveSlide = (direction: 'left' | 'right') => {
    if (direction === 'left' && currentSlideIndex > 0) {
      const next = [...slides];
      const temp = next[currentSlideIndex];
      next[currentSlideIndex] = next[currentSlideIndex - 1];
      next[currentSlideIndex - 1] = temp;
      setSlides(next);
      setCurrentSlideIndex(currentSlideIndex - 1);
    } else if (direction === 'right' && currentSlideIndex < slides.length - 1) {
      const next = [...slides];
      const temp = next[currentSlideIndex];
      next[currentSlideIndex] = next[currentSlideIndex + 1];
      next[currentSlideIndex + 1] = temp;
      setSlides(next);
      setCurrentSlideIndex(currentSlideIndex + 1);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await fetch(`/creative-studio/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: { slides, brandGlobalColor, brandGlobalAccent },
          dimensions: { width: 1080, height: 1350, preset: '4:5 Carousel' },
        }),
      });
      onProjectUpdated();
    } catch (err: any) {
      alert(`Save error: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      await handleSave();
      const res = await fetch(`/creative-studio/projects/${project.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exportFormat: 'png' }),
      });
      const data = await res.json();
      alert(`All ${slides.length} slides exported successfully and registered in Media Library!`);
    } catch (err: any) {
      alert(`Export error: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* Top Navbar */}
      <div className="h-14 border-b border-border/50 px-6 flex items-center justify-between bg-card/60">
        <div className="flex items-center gap-4">
          <Link
            href="/creative-studio"
            className="text-xs font-semibold text-muted-foreground hover:text-white transition flex items-center gap-1"
          >
            ← Studio Hub
          </Link>
          <div className="h-4 w-px bg-border/60" />
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <span>📑</span> {project.name}
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-muted text-muted-foreground">
              {slides.length} Slides (4:5 Portrait)
            </span>
          </h2>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-4 py-1.5 rounded-xl border border-border hover:bg-muted text-xs font-semibold text-white transition"
          >
            {isSaving ? 'Saving...' : 'Save Carousel'}
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting}
            className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white shadow transition flex items-center gap-1.5"
          >
            <span>⬇️</span> {isExporting ? 'Exporting...' : 'Export Slides & Attach'}
          </button>
        </div>
      </div>

      {/* Editor Main */}
      <div className="flex-1 flex overflow-hidden">
        {/* Center Live Slide Preview */}
        <div className="flex-1 bg-slate-950 flex flex-col items-center justify-center p-6 overflow-auto">
          {/* Active Slide Card */}
          <div
            className="relative rounded-2xl shadow-2xl overflow-hidden border border-white/10 flex flex-col justify-between p-10 transition-all duration-200"
            style={{
              width: 440,
              height: 550,
              backgroundColor: currentSlide.bgColor || brandGlobalColor,
              color: currentSlide.textColor || '#FFFFFF',
            }}
          >
            {/* Slide Header */}
            <div>
              <span
                className="inline-block text-[11px] font-mono font-bold tracking-widest px-3 py-1 rounded-full uppercase"
                style={{
                  backgroundColor: `${currentSlide.accentColor || brandGlobalAccent}20`,
                  color: currentSlide.accentColor || brandGlobalAccent,
                }}
              >
                {currentSlide.badgeText || 'TIP'}
              </span>
              <h2 className="text-2xl font-black mt-6 tracking-tight leading-snug">
                {currentSlide.headline}
              </h2>
              <p className="text-sm text-slate-300 mt-4 leading-relaxed">
                {currentSlide.body}
              </p>
            </div>

            {/* Slide Footer */}
            <div className="pt-6 border-t border-white/10 flex items-center justify-between text-xs text-slate-400 font-mono">
              <span>{currentSlide.footerText || 'Wallza Studio'}</span>
              <span>{currentSlideIndex + 1} / {slides.length}</span>
            </div>
          </div>

          {/* Slide Navigation Controls */}
          <div className="flex items-center gap-4 mt-6">
            <button
              onClick={() => setCurrentSlideIndex(Math.max(0, currentSlideIndex - 1))}
              disabled={currentSlideIndex === 0}
              className="px-3 py-1.5 rounded-xl border border-border/60 bg-card text-xs font-semibold disabled:opacity-40 hover:bg-muted"
            >
              ◀ Previous Slide
            </button>
            <span className="text-xs font-mono text-muted-foreground">
              Slide {currentSlideIndex + 1} of {slides.length}
            </span>
            <button
              onClick={() => setCurrentSlideIndex(Math.min(slides.length - 1, currentSlideIndex + 1))}
              disabled={currentSlideIndex === slides.length - 1}
              className="px-3 py-1.5 rounded-xl border border-border/60 bg-card text-xs font-semibold disabled:opacity-40 hover:bg-muted"
            >
              Next Slide ▶
            </button>
          </div>
        </div>

        {/* Right Properties Panel */}
        <div className="w-84 border-l border-border/50 bg-card/60 p-5 overflow-y-auto space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Slide #{currentSlideIndex + 1} Content
            </h3>
            <div className="flex gap-1.5">
              <button
                onClick={() => moveSlide('left')}
                disabled={currentSlideIndex === 0}
                className="px-2 py-0.5 rounded bg-muted/60 text-xs hover:bg-muted disabled:opacity-30"
                title="Move Slide Earlier"
              >
                ◀
              </button>
              <button
                onClick={() => moveSlide('right')}
                disabled={currentSlideIndex === slides.length - 1}
                className="px-2 py-0.5 rounded bg-muted/60 text-xs hover:bg-muted disabled:opacity-30"
                title="Move Slide Later"
              >
                ▶
              </button>
              <button
                onClick={duplicateSlide}
                className="p-1 rounded bg-muted/60 text-xs hover:bg-muted"
                title="Duplicate Slide"
              >
                📋
              </button>
              <button
                onClick={deleteSlide}
                className="p-1 rounded bg-rose-500/20 text-rose-300 text-xs hover:bg-rose-500/40"
                title="Delete Slide"
              >
                🗑️
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Badge / Tagline</label>
              <input
                type="text"
                value={currentSlide.badgeText || ''}
                onChange={(e) => updateCurrentSlide({ badgeText: e.target.value })}
                className="w-full p-2 rounded-lg bg-background border border-border text-xs text-white"
              />
            </div>

            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Slide Headline</label>
              <textarea
                rows={2}
                value={currentSlide.headline || ''}
                onChange={(e) => updateCurrentSlide({ headline: e.target.value })}
                className="w-full p-2 rounded-lg bg-background border border-border text-xs text-white"
              />
            </div>

            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Body Text / Bullet points</label>
              <textarea
                rows={4}
                value={currentSlide.body || ''}
                onChange={(e) => updateCurrentSlide({ body: e.target.value })}
                className="w-full p-2 rounded-lg bg-background border border-border text-xs text-white"
              />
            </div>

            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Footer / Callout</label>
              <input
                type="text"
                value={currentSlide.footerText || ''}
                onChange={(e) => updateCurrentSlide({ footerText: e.target.value })}
                className="w-full p-2 rounded-lg bg-background border border-border text-xs text-white"
              />
            </div>

            <div className="pt-3 border-t border-border/40">
              <label className="block text-[11px] text-muted-foreground mb-2">Slide Accent Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={currentSlide.accentColor || brandGlobalAccent}
                  onChange={(e) => updateCurrentSlide({ accentColor: e.target.value })}
                  className="w-8 h-8 rounded border-none cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={currentSlide.accentColor || brandGlobalAccent}
                  onChange={(e) => updateCurrentSlide({ accentColor: e.target.value })}
                  className="flex-1 p-1.5 rounded-lg bg-background border border-border text-xs text-white font-mono"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Filmstrip Carousel Navigation */}
      <div className="h-28 border-t border-border/50 bg-card/40 px-6 py-3 flex items-center gap-3 overflow-x-auto">
        {slides.map((s, idx) => (
          <div
            key={s.id}
            onClick={() => setCurrentSlideIndex(idx)}
            className={`cursor-pointer rounded-xl p-2.5 h-full w-28 shrink-0 flex flex-col justify-between border transition ${
              idx === currentSlideIndex
                ? 'border-indigo-500 bg-indigo-950/40 text-white font-semibold shadow-md'
                : 'border-border/40 bg-card/60 text-muted-foreground hover:border-indigo-500/40'
            }`}
          >
            <div className="flex justify-between items-center text-[10px] font-mono">
              <span>#{idx + 1}</span>
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.accentColor || brandGlobalAccent }} />
            </div>
            <p className="text-[11px] font-bold truncate leading-tight mt-1">{s.headline || 'Slide'}</p>
            <span className="text-[9px] text-muted-foreground font-mono">1080x1350</span>
          </div>
        ))}

        <button
          onClick={addSlide}
          className="h-full w-24 shrink-0 rounded-xl border border-dashed border-border/70 hover:border-indigo-500 hover:text-white flex flex-col items-center justify-center text-muted-foreground text-xs gap-1 transition"
        >
          <span className="text-xl leading-none">+</span>
          <span>Add Slide</span>
        </button>
      </div>
    </div>
  );
};
