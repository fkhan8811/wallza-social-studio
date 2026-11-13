'use client';

import { FC, useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface VideoClip {
  id: string;
  title: string;
  startSec: number;
  endSec: number;
  src?: string;
  volume: number;
}

interface AudioTrackItem {
  id: string;
  title: string;
  startSec: number;
  endSec: number;
  src?: string;
  volume: number;
}

interface TextOverlay {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
  fontSize: number;
  fill: string;
  x: number;
  y: number;
}

export const VideoEditorComponent: FC<{ project: any; onProjectUpdated: () => void }> = ({
  project,
  onProjectUpdated,
}) => {
  const fetch = useFetch();

  const [totalDuration, setTotalDuration] = useState<number>(project.data?.durationSeconds || 15);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const [videoClips, setVideoClips] = useState<VideoClip[]>(
    project.data?.videoClips || [
      { id: 'v1', title: 'Hook Intro', startSec: 0, endSec: 4, volume: 1 },
      { id: 'v2', title: 'Core Demonstration', startSec: 4, endSec: 10, volume: 1 },
      { id: 'v3', title: 'Outro Call to Action', startSec: 10, endSec: 15, volume: 1 },
    ]
  );

  const [audioClips, setAudioClips] = useState<AudioTrackItem[]>(
    project.data?.audioClips || [
      { id: 'a1', title: 'Background Lofi Beats', startSec: 0, endSec: 15, volume: 0.35 },
    ]
  );

  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>(
    project.data?.textOverlays || [
      { id: 't1', text: 'Wait until the end... 🔥', startSec: 0, endSec: 3.5, fontSize: 32, fill: '#FDE047', x: 50, y: 150 },
      { id: 't2', text: 'Follow for more content hacks ➔', startSec: 10, endSec: 15, fontSize: 28, fill: '#FFFFFF', x: 50, y: 450 },
    ]
  );

  const [selectedItem, setSelectedItem] = useState<{ type: 'video' | 'audio' | 'text'; id: string } | null>({
    type: 'video',
    id: 'v1',
  });

  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Playhead timer simulation
  useEffect(() => {
    let interval: any = null;
    if (isPlaying) {
      interval = setInterval(() => {
        setCurrentTime((prev) => {
          if (prev >= totalDuration) {
            setIsPlaying(false);
            return 0;
          }
          return Math.min(totalDuration, prev + 0.1);
        });
      }, 100);
    }
    return () => clearInterval(interval);
  }, [isPlaying, totalDuration]);

  const activeOverlay = textOverlays.find((t) => currentTime >= t.startSec && currentTime <= t.endSec);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await fetch(`/creative-studio/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: {
            durationSeconds: totalDuration,
            videoClips,
            audioClips,
            textOverlays,
          },
          dimensions: project.dimensions || { width: 1080, height: 1920, preset: '9:16 Vertical Video' },
        }),
      });
      onProjectUpdated();
    } catch (err: any) {
      alert(`Save error: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const renderClientVideoDataUrl = async (): Promise<string> => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error('Canvas recording is only supported in browser environments.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 1280;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');

    if (typeof (canvas as any).captureStream !== 'function' || typeof window.MediaRecorder === 'undefined') {
      throw new Error('Your browser does not support canvas video capture.');
    }

    const stream = (canvas as any).captureStream(30);
    let mimeType = 'video/webm;codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4';
    }

    const mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2500000 });
    const chunks: BlobPart[] = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    return new Promise<string>((resolve, reject) => {
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === 'string') {
            resolve(reader.result);
          } else {
            reject(new Error('Failed to convert recorded video blob to dataUrl.'));
          }
        };
        reader.onerror = () => reject(reader.error || new Error('FileReader error.'));
        reader.readAsDataURL(blob);
      };

      mediaRecorder.onerror = (e) => reject(e);
      mediaRecorder.start();

      const fps = 30;
      const renderDurationSec = Math.min(totalDuration, 8);
      const totalFrames = Math.max(fps, Math.round(renderDurationSec * fps));
      let frame = 0;

      const renderFrame = () => {
        const sec = (frame / totalFrames) * totalDuration;

        ctx.fillStyle = '#09090b';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        grad.addColorStop(0, '#1e1b4b');
        grad.addColorStop(0.5, '#09090b');
        grad.addColorStop(1, '#0f172a');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const activeClip = videoClips.find((c) => sec >= c.startSec && sec <= c.endSec) || videoClips[0];
        if (activeClip) {
          ctx.fillStyle = '#1e293b';
          if (typeof ctx.roundRect === 'function') {
            ctx.beginPath();
            ctx.roundRect(40, 240, canvas.width - 80, 600, 24);
            ctx.fill();
          } else {
            ctx.fillRect(40, 240, canvas.width - 80, 600);
          }

          ctx.fillStyle = '#6366f1';
          ctx.font = 'bold 36px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(activeClip.title, canvas.width / 2, 500);

          ctx.fillStyle = '#94a3b8';
          ctx.font = '22px sans-serif';
          ctx.fillText(`Timeline: ${sec.toFixed(1)}s / ${totalDuration}s`, canvas.width / 2, 560);
        }

        textOverlays.forEach((overlay) => {
          if (sec >= overlay.startSec && sec <= overlay.endSec) {
            ctx.fillStyle = overlay.fill || '#ffffff';
            ctx.font = `bold ${Math.round(overlay.fontSize * 1.2)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText(overlay.text, canvas.width / 2, overlay.y * 1.8 + 200);
          }
        });

        ctx.fillStyle = '#334155';
        ctx.fillRect(40, canvas.height - 100, canvas.width - 80, 10);
        ctx.fillStyle = '#6366f1';
        ctx.fillRect(40, canvas.height - 100, (canvas.width - 80) * (sec / totalDuration), 10);

        frame++;
        if (frame < totalFrames) {
          requestAnimationFrame(renderFrame);
        } else {
          setTimeout(() => {
            if (mediaRecorder.state !== 'inactive') {
              mediaRecorder.stop();
            }
          }, 100);
        }
      };

      requestAnimationFrame(renderFrame);
    });
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      await handleSave();
      let dataUrl: string | undefined;
      try {
        dataUrl = await renderClientVideoDataUrl();
      } catch (renderErr: any) {
        console.warn('Client-side video capture note:', renderErr);
      }

      const res = await fetch(`/creative-studio/projects/${project.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exportFormat: 'mp4', dataUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Export failed');
      alert('Video export completed! Asset registered in your Media Library ready for publishing.');
      onProjectUpdated();
    } catch (err: any) {
      alert(`Export error: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const addClip = () => {
    const newClip: VideoClip = {
      id: `v_${Date.now()}`,
      title: `Clip ${videoClips.length + 1}`,
      startSec: totalDuration,
      endSec: totalDuration + 4,
      volume: 1,
    };
    setVideoClips([...videoClips, newClip]);
    setTotalDuration(totalDuration + 4);
  };

  const addTextOverlay = () => {
    const newOverlay: TextOverlay = {
      id: `t_${Date.now()}`,
      text: 'New Caption Overlay',
      startSec: currentTime,
      endSec: Math.min(totalDuration, currentTime + 3),
      fontSize: 32,
      fill: '#FFFFFF',
      x: 50,
      y: 300,
    };
    setTextOverlays([...textOverlays, newOverlay]);
    setSelectedItem({ type: 'text', id: newOverlay.id });
  };

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* Top Bar */}
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
            <span>🎬</span> {project.name}
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-muted text-muted-foreground">
              {totalDuration}s (9:16 Short / Reel)
            </span>
          </h2>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-4 py-1.5 rounded-xl border border-border hover:bg-muted text-xs font-semibold text-white transition"
          >
            {isSaving ? 'Saving...' : 'Save Video Project'}
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting}
            className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white shadow transition flex items-center gap-1.5"
          >
            <span>⬇️</span> {isExporting ? 'Exporting MP4...' : 'Export Video & Attach'}
          </button>
        </div>
      </div>

      {/* Main Workspace (Preview + Properties) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left/Center Video Monitor */}
        <div className="flex-1 bg-slate-950 flex flex-col items-center justify-center p-6 overflow-auto">
          {/* Vertical Video Viewport (9:16 Aspect) */}
          <div className="relative rounded-2xl shadow-2xl overflow-hidden border border-white/10 w-[300px] h-[533px] bg-gradient-to-br from-indigo-950 via-slate-900 to-black flex items-center justify-center">
            {/* Simulated Frame */}
            <div className="text-center p-4">
              <span className="text-4xl block mb-2">🎞️</span>
              <p className="text-xs font-mono text-indigo-400 font-bold uppercase tracking-wider">
                {videoClips.find((c) => currentTime >= c.startSec && currentTime <= c.endSec)?.title || 'Video Track'}
              </p>
              <p className="text-[11px] text-slate-400 font-mono mt-1">
                Timecode: {currentTime.toFixed(1)}s / {totalDuration}s
              </p>
            </div>

            {/* Active Text Overlay */}
            {activeOverlay && (
              <div
                className="absolute inset-x-4 p-3 rounded-xl bg-black/60 backdrop-blur-sm border border-white/10 text-center animate-fade-in"
                style={{
                  top: activeOverlay.y ? `${(activeOverlay.y / 600) * 100}%` : '60%',
                  color: activeOverlay.fill,
                  fontSize: `${activeOverlay.fontSize / 2}px`,
                  fontWeight: 'bold',
                }}
              >
                {activeOverlay.text}
              </div>
            )}
          </div>

          {/* Playback Controls */}
          <div className="flex items-center gap-4 mt-6">
            <button
              onClick={() => setCurrentTime(0)}
              className="p-2 rounded-xl bg-card border border-border text-xs hover:bg-muted"
              title="Jump to Start"
            >
              ⏮
            </button>
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow transition"
            >
              {isPlaying ? 'Pause ⏸' : 'Play ▶'}
            </button>
            <span className="text-xs font-mono text-muted-foreground w-20 text-center">
              {currentTime.toFixed(1)}s
            </span>
          </div>
        </div>

        {/* Right Inspector Panel */}
        <div className="w-80 border-l border-border/50 bg-card/60 p-5 overflow-y-auto space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Clip Inspector
            </h3>
            <button
              onClick={addTextOverlay}
              className="px-2 py-1 rounded bg-indigo-600/20 text-indigo-300 text-xs font-semibold hover:bg-indigo-600/40"
            >
              + Add Caption
            </button>
          </div>

          {selectedItem?.type === 'text' ? (
            <div className="space-y-3 pt-2">
              {(() => {
                const overlay = textOverlays.find((t) => t.id === selectedItem.id);
                if (!overlay) return null;
                return (
                  <>
                    <div>
                      <label className="block text-[11px] text-muted-foreground mb-1">Overlay Text</label>
                      <textarea
                        rows={2}
                        value={overlay.text}
                        onChange={(e) => {
                          setTextOverlays(
                            textOverlays.map((t) => (t.id === overlay.id ? { ...t, text: e.target.value } : t))
                          );
                        }}
                        className="w-full p-2 rounded-lg bg-background border border-border text-xs text-white"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] text-muted-foreground mb-1">Start (sec)</label>
                        <input
                          type="number"
                          step="0.1"
                          value={overlay.startSec}
                          onChange={(e) => {
                            setTextOverlays(
                              textOverlays.map((t) =>
                                t.id === overlay.id ? { ...t, startSec: parseFloat(e.target.value) || 0 } : t
                              )
                            );
                          }}
                          className="w-full p-1.5 rounded-lg bg-background border border-border text-xs text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-muted-foreground mb-1">End (sec)</label>
                        <input
                          type="number"
                          step="0.1"
                          value={overlay.endSec}
                          onChange={(e) => {
                            setTextOverlays(
                              textOverlays.map((t) =>
                                t.id === overlay.id ? { ...t, endSec: parseFloat(e.target.value) || 0 } : t
                              )
                            );
                          }}
                          className="w-full p-1.5 rounded-lg bg-background border border-border text-xs text-white"
                        />
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">Select a clip or track in the timeline below to edit.</p>
              <button
                onClick={addClip}
                className="w-full py-2 rounded-xl border border-dashed border-border hover:border-indigo-500 text-xs font-semibold text-muted-foreground hover:text-white transition"
              >
                + Add Video Clip Segment
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Multi-Track Timeline */}
      <div className="h-56 border-t border-border/50 bg-card/40 flex flex-col">
        {/* Timeline Header & Scrubber */}
        <div className="h-8 border-b border-border/40 px-6 flex items-center justify-between bg-card text-[11px] font-mono text-muted-foreground">
          <span>Tracks & Audio Mix</span>
          <span>Timeline Scale: 0s - {totalDuration}s</span>
        </div>

        {/* Tracks Area */}
        <div className="flex-1 p-3 overflow-y-auto space-y-2">
          {/* Video Track */}
          <div className="flex items-center gap-3">
            <span className="w-20 text-[11px] font-bold text-muted-foreground uppercase font-mono">Video</span>
            <div className="flex-1 flex gap-1 h-10 bg-slate-900 rounded-lg p-1 border border-border/40">
              {videoClips.map((clip) => {
                const widthPercent = ((clip.endSec - clip.startSec) / totalDuration) * 100;
                return (
                  <div
                    key={clip.id}
                    onClick={() => setSelectedItem({ type: 'video', id: clip.id })}
                    style={{ width: `${widthPercent}%` }}
                    className={`h-full rounded px-2 flex items-center justify-between text-[11px] font-semibold cursor-pointer transition ${
                      selectedItem?.id === clip.id
                        ? 'bg-indigo-600 text-white shadow-md'
                        : 'bg-indigo-950/80 text-indigo-300 hover:bg-indigo-900'
                    }`}
                  >
                    <span className="truncate">{clip.title}</span>
                    <span className="text-[9px] font-mono opacity-80">{clip.endSec - clip.startSec}s</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Captions Track */}
          <div className="flex items-center gap-3">
            <span className="w-20 text-[11px] font-bold text-muted-foreground uppercase font-mono">Captions</span>
            <div className="flex-1 relative h-9 bg-slate-900 rounded-lg p-1 border border-border/40">
              {textOverlays.map((txt) => {
                const leftPercent = (txt.startSec / totalDuration) * 100;
                const widthPercent = ((txt.endSec - txt.startSec) / totalDuration) * 100;
                return (
                  <div
                    key={txt.id}
                    onClick={() => setSelectedItem({ type: 'text', id: txt.id })}
                    style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
                    className={`absolute top-1 bottom-1 rounded px-2 flex items-center text-[10px] font-bold cursor-pointer transition truncate ${
                      selectedItem?.id === txt.id
                        ? 'bg-amber-500 text-black shadow-md'
                        : 'bg-amber-950/80 text-amber-300 hover:bg-amber-900'
                    }`}
                  >
                    💬 {txt.text}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Audio Track */}
          <div className="flex items-center gap-3">
            <span className="w-20 text-[11px] font-bold text-muted-foreground uppercase font-mono">Audio</span>
            <div className="flex-1 flex gap-1 h-9 bg-slate-900 rounded-lg p-1 border border-border/40">
              {audioClips.map((audio) => (
                <div
                  key={audio.id}
                  style={{ width: '100%' }}
                  className="h-full rounded bg-emerald-950/80 text-emerald-300 border border-emerald-500/30 px-3 flex items-center justify-between text-[11px] font-semibold"
                >
                  <span>🎵 {audio.title}</span>
                  <span className="text-[10px] font-mono">Vol: {Math.round(audio.volume * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

