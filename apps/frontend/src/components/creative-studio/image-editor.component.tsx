'use client';

import { FC, useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface LayerElement {
  id: string;
  type: 'text' | 'shape' | 'image';
  text?: string;
  shape?: 'rect' | 'circle' | 'pill';
  src?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  fill?: string;
  fontSize?: number;
  fontWeight?: string;
  fontFamily?: string;
  textAlign?: string;
  rotation?: number;
  opacity?: number;
  locked?: boolean;
  visible?: boolean;
}

export const ImageEditorComponent: FC<{ project: any; onProjectUpdated: () => void }> = ({
  project,
  onProjectUpdated,
}) => {
  const fetch = useFetch();
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [layers, setLayers] = useState<LayerElement[]>(
    project.data?.layers || [
      { id: 'bg', type: 'shape', shape: 'rect', x: 0, y: 0, width: 1080, height: 1080, fill: '#0F172A', locked: true, visible: true },
      { id: 'txt1', type: 'text', text: 'Double click to edit text', x: 100, y: 500, fontSize: 48, fontWeight: 'bold', fill: '#FFFFFF', visible: true },
    ]
  );
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [bgColor, setBgColor] = useState<string>(project.data?.backgroundColor || '#0F172A');
  const [aspectRatio, setAspectRatio] = useState<string>(project.dimensions?.preset || '1:1 Square');
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>(
    project.dimensions || { width: 1080, height: 1080 }
  );

  const [history, setHistory] = useState<LayerElement[][]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const selectedLayer = layers.find((l) => l.id === selectedLayerId);

  // Push state to history
  const pushState = (newLayers: LayerElement[]) => {
    const nextHistory = history.slice(0, historyIndex + 1);
    nextHistory.push(JSON.parse(JSON.stringify(newLayers)));
    if (nextHistory.length > 30) nextHistory.shift();
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
  };

  const undo = () => {
    if (historyIndex > 0) {
      const prev = history[historyIndex - 1];
      setLayers(JSON.parse(JSON.stringify(prev)));
      setHistoryIndex(historyIndex - 1);
    }
  };

  const redo = () => {
    if (historyIndex < history.length - 1) {
      const next = history[historyIndex + 1];
      setLayers(JSON.parse(JSON.stringify(next)));
      setHistoryIndex(historyIndex + 1);
    }
  };

  // Render canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background fill
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw layers
    layers.forEach((layer) => {
      if (layer.visible === false) return;
      ctx.save();

      if (layer.opacity !== undefined) {
        ctx.globalAlpha = layer.opacity;
      }

      if (layer.type === 'shape') {
        ctx.fillStyle = layer.fill || '#3B82F6';
        if (layer.shape === 'rect' || !layer.shape) {
          ctx.fillRect(layer.x, layer.y, layer.width || 200, layer.height || 200);
        } else if (layer.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(layer.x, layer.y, layer.radius || 100, 0, Math.PI * 2);
          ctx.fill();
        } else if (layer.shape === 'pill') {
          const w = layer.width || 200;
          const h = layer.height || 50;
          const r = h / 2;
          ctx.beginPath();
          ctx.moveTo(layer.x + r, layer.y);
          ctx.arcTo(layer.x + w, layer.y, layer.x + w, layer.y + h, r);
          ctx.arcTo(layer.x + w, layer.y + h, layer.x, layer.y + h, r);
          ctx.arcTo(layer.x, layer.y + h, layer.x, layer.y, r);
          ctx.arcTo(layer.x, layer.y, layer.x + w, layer.y, r);
          ctx.closePath();
          ctx.fill();
        }
      } else if (layer.type === 'text') {
        const weight = layer.fontWeight || 'normal';
        const size = layer.fontSize || 36;
        const font = layer.fontFamily || 'Inter, sans-serif';
        ctx.font = `${weight} ${size}px ${font}`;
        ctx.fillStyle = layer.fill || '#FFFFFF';
        ctx.textAlign = (layer.textAlign as any) || 'left';
        ctx.fillText(layer.text || '', layer.x, layer.y + size);
      }

      // Highlight selected layer boundary
      if (layer.id === selectedLayerId) {
        ctx.strokeStyle = '#6366F1';
        ctx.lineWidth = 4;
        ctx.setLineDash([8, 4]);
        const w = layer.width || 200;
        const h = layer.height || 60;
        ctx.strokeRect(layer.x - 4, layer.y - 4, w + 8, h + 8);
      }

      ctx.restore();
    });
  }, [layers, selectedLayerId, bgColor, dimensions]);

  const addText = () => {
    const newId = `txt_${Date.now()}`;
    const newLayer: LayerElement = {
      id: newId,
      type: 'text',
      text: 'New Heading',
      x: 100,
      y: 200 + layers.length * 30,
      fontSize: 48,
      fontWeight: 'bold',
      fill: '#FFFFFF',
      width: 400,
      height: 60,
      visible: true,
    };
    const next = [...layers, newLayer];
    setLayers(next);
    setSelectedLayerId(newId);
    pushState(next);
  };

  const addShape = (shape: 'rect' | 'circle' | 'pill') => {
    const newId = `shape_${Date.now()}`;
    const newLayer: LayerElement = {
      id: newId,
      type: 'shape',
      shape,
      x: 200,
      y: 200,
      width: shape === 'pill' ? 240 : 200,
      height: shape === 'pill' ? 50 : 200,
      radius: 100,
      fill: '#6366F1',
      visible: true,
    };
    const next = [...layers, newLayer];
    setLayers(next);
    setSelectedLayerId(newId);
    pushState(next);
  };

  const updateSelectedLayer = (updates: Partial<LayerElement>) => {
    if (!selectedLayerId) return;
    const next = layers.map((l) => (l.id === selectedLayerId ? { ...l, ...updates } : l));
    setLayers(next);
  };

  const deleteSelected = () => {
    if (!selectedLayerId) return;
    const next = layers.filter((l) => l.id !== selectedLayerId);
    setLayers(next);
    setSelectedLayerId(null);
    pushState(next);
  };

  const duplicateSelected = () => {
    if (!selectedLayer) return;
    const dup: LayerElement = {
      ...JSON.parse(JSON.stringify(selectedLayer)),
      id: `${selectedLayer.type}_${Date.now()}`,
      x: selectedLayer.x + 30,
      y: selectedLayer.y + 30,
    };
    const next = [...layers, dup];
    setLayers(next);
    setSelectedLayerId(dup.id);
    pushState(next);
  };

  const moveLayer = (direction: 'up' | 'down') => {
    if (!selectedLayerId) return;
    const idx = layers.findIndex((l) => l.id === selectedLayerId);
    if (idx === -1) return;
    const next = [...layers];
    if (direction === 'up' && idx < next.length - 1) {
      const temp = next[idx];
      next[idx] = next[idx + 1];
      next[idx + 1] = temp;
    } else if (direction === 'down' && idx > 0) {
      const temp = next[idx];
      next[idx] = next[idx - 1];
      next[idx - 1] = temp;
    }
    setLayers(next);
    pushState(next);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const canvas = canvasRef.current;
      const thumbnail = canvas ? canvas.toDataURL('image/jpeg', 0.6) : null;
      await fetch(`/creative-studio/projects/${project.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: { layers, backgroundColor: bgColor },
          dimensions,
          thumbnailUrl: thumbnail,
        }),
      });
      onProjectUpdated();
    } catch (err: any) {
      alert(`Save error: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleExport = async (format: 'png' | 'jpeg') => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setIsExporting(true);
    try {
      await handleSave();
      const res = await fetch(`/creative-studio/projects/${project.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exportFormat: format }),
      });
      const data = await res.json();

      // Trigger browser download
      const a = document.createElement('a');
      a.href = canvas.toDataURL(`image/${format}`, 0.95);
      a.download = `${project.name}.${format}`;
      a.click();

      alert(`Export complete! Asset saved to your Media Library and downloaded locally.`);
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
            <span>🖼️</span> {project.name}
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-muted text-muted-foreground">
              {dimensions.width}x{dimensions.height}
            </span>
          </h2>
        </div>

        <div className="flex items-center gap-2">
          {/* History Controls */}
          <button
            onClick={undo}
            disabled={historyIndex <= 0}
            className="p-1.5 rounded-lg border border-border/50 text-xs disabled:opacity-40 hover:bg-muted"
            title="Undo"
          >
            ↩
          </button>
          <button
            onClick={redo}
            disabled={historyIndex >= history.length - 1}
            className="p-1.5 rounded-lg border border-border/50 text-xs disabled:opacity-40 hover:bg-muted"
            title="Redo"
          >
            ↪
          </button>
          <div className="h-4 w-px bg-border/60 mx-1" />

          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-3.5 py-1.5 rounded-xl border border-border hover:bg-muted text-xs font-semibold text-white transition"
          >
            {isSaving ? 'Saving...' : 'Save Project'}
          </button>

          <button
            onClick={() => handleExport('png')}
            disabled={isExporting}
            className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white shadow transition flex items-center gap-1.5"
          >
            <span>⬇️</span> {isExporting ? 'Exporting...' : 'Export & Use in Post'}
          </button>
        </div>
      </div>

      {/* Editor Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Toolbar */}
        <div className="w-16 border-r border-border/50 flex flex-col items-center py-4 gap-3 bg-card/30">
          <button
            onClick={addText}
            className="p-2.5 rounded-xl bg-muted/60 hover:bg-indigo-600 hover:text-white text-muted-foreground transition flex flex-col items-center gap-1"
            title="Add Text"
          >
            <span className="text-base font-bold">T</span>
            <span className="text-[9px]">Text</span>
          </button>
          <button
            onClick={() => addShape('rect')}
            className="p-2.5 rounded-xl bg-muted/60 hover:bg-indigo-600 hover:text-white text-muted-foreground transition flex flex-col items-center gap-1"
            title="Add Rectangle"
          >
            <span className="text-base">■</span>
            <span className="text-[9px]">Rect</span>
          </button>
          <button
            onClick={() => addShape('circle')}
            className="p-2.5 rounded-xl bg-muted/60 hover:bg-indigo-600 hover:text-white text-muted-foreground transition flex flex-col items-center gap-1"
            title="Add Circle"
          >
            <span className="text-base">●</span>
            <span className="text-[9px]">Circle</span>
          </button>
          <button
            onClick={() => addShape('pill')}
            className="p-2.5 rounded-xl bg-muted/60 hover:bg-indigo-600 hover:text-white text-muted-foreground transition flex flex-col items-center gap-1"
            title="Add Badge / Pill"
          >
            <span className="text-base">⬭</span>
            <span className="text-[9px]">Pill</span>
          </button>
        </div>

        {/* Center Canvas Viewport */}
        <div className="flex-1 overflow-auto bg-slate-950/80 flex items-center justify-center p-8">
          <div
            className="shadow-2xl rounded-lg overflow-hidden border border-white/10"
            style={{
              width: dimensions.width > dimensions.height ? 600 : 480,
              height: dimensions.width > dimensions.height ? 337 : 600,
            }}
          >
            <canvas
              ref={canvasRef}
              width={dimensions.width}
              height={dimensions.height}
              className="w-full h-full cursor-crosshair"
            />
          </div>
        </div>

        {/* Right Sidebar: Properties & Layer Stack */}
        <div className="w-80 border-l border-border/50 bg-card/60 flex flex-col">
          {/* Properties Panel */}
          <div className="p-4 border-b border-border/40 space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Element Properties
            </h3>

            {selectedLayer ? (
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-medium text-white capitalize">{selectedLayer.type} Layer</span>
                  <div className="flex gap-1">
                    <button
                      onClick={duplicateSelected}
                      className="p-1 rounded bg-muted/60 text-xs hover:bg-muted"
                      title="Duplicate"
                    >
                      📋
                    </button>
                    <button
                      onClick={deleteSelected}
                      className="p-1 rounded bg-rose-500/20 text-rose-300 text-xs hover:bg-rose-500/40"
                      title="Delete"
                    >
                      🗑️
                    </button>
                  </div>
                </div>

                {selectedLayer.type === 'text' && (
                  <>
                    <div>
                      <label className="block text-[11px] text-muted-foreground mb-1">Text Content</label>
                      <textarea
                        rows={2}
                        value={selectedLayer.text || ''}
                        onChange={(e) => updateSelectedLayer({ text: e.target.value })}
                        className="w-full p-2 rounded-lg bg-background border border-border text-xs text-white"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] text-muted-foreground mb-1">Font Size</label>
                        <input
                          type="number"
                          value={selectedLayer.fontSize || 36}
                          onChange={(e) => updateSelectedLayer({ fontSize: parseInt(e.target.value, 10) || 12 })}
                          className="w-full p-1.5 rounded-lg bg-background border border-border text-xs text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-muted-foreground mb-1">Font Weight</label>
                        <select
                          value={selectedLayer.fontWeight || 'normal'}
                          onChange={(e) => updateSelectedLayer({ fontWeight: e.target.value })}
                          className="w-full p-1.5 rounded-lg bg-background border border-border text-xs text-white"
                        >
                          <option value="normal">Normal</option>
                          <option value="bold">Bold</option>
                          <option value="900">Black / Ultra</option>
                        </select>
                      </div>
                    </div>
                  </>
                )}

                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1">Color Fill</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={selectedLayer.fill || '#FFFFFF'}
                      onChange={(e) => updateSelectedLayer({ fill: e.target.value })}
                      className="w-8 h-8 rounded border-none cursor-pointer bg-transparent"
                    />
                    <input
                      type="text"
                      value={selectedLayer.fill || '#FFFFFF'}
                      onChange={(e) => updateSelectedLayer({ fill: e.target.value })}
                      className="flex-1 p-1.5 rounded-lg bg-background border border-border text-xs text-white font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] text-muted-foreground mb-1">Position X</label>
                    <input
                      type="number"
                      value={selectedLayer.x || 0}
                      onChange={(e) => updateSelectedLayer({ x: parseInt(e.target.value, 10) || 0 })}
                      className="w-full p-1.5 rounded-lg bg-background border border-border text-xs text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-muted-foreground mb-1">Position Y</label>
                    <input
                      type="number"
                      value={selectedLayer.y || 0}
                      onChange={(e) => updateSelectedLayer({ y: parseInt(e.target.value, 10) || 0 })}
                      className="w-full p-1.5 rounded-lg bg-background border border-border text-xs text-white"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">Select an element on canvas to edit properties.</p>
            )}
          </div>

          {/* Layer Ordering Stack */}
          <div className="flex-1 p-4 overflow-y-auto space-y-2">
            <div className="flex justify-between items-center mb-1">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Layers</h3>
              <div className="flex gap-1">
                <button
                  onClick={() => moveLayer('up')}
                  disabled={!selectedLayerId}
                  className="px-1.5 py-0.5 rounded bg-muted/60 text-[10px] hover:bg-muted"
                  title="Bring Forward"
                >
                  ▲
                </button>
                <button
                  onClick={() => moveLayer('down')}
                  disabled={!selectedLayerId}
                  className="px-1.5 py-0.5 rounded bg-muted/60 text-[10px] hover:bg-muted"
                  title="Send Backward"
                >
                  ▼
                </button>
              </div>
            </div>

            <div className="space-y-1">
              {layers
                .slice()
                .reverse()
                .map((layer) => (
                  <div
                    key={layer.id}
                    onClick={() => setSelectedLayerId(layer.id)}
                    className={`p-2 rounded-lg text-xs flex items-center justify-between cursor-pointer border transition ${
                      layer.id === selectedLayerId
                        ? 'border-indigo-500 bg-indigo-950/40 text-white font-semibold'
                        : 'border-border/40 bg-card hover:bg-muted/40 text-muted-foreground'
                    }`}
                  >
                    <span className="truncate max-w-[140px]">
                      {layer.type === 'text' ? `T: ${layer.text?.substring(0, 16)}` : `Shape (${layer.shape || 'rect'})`}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          updateSelectedLayer({ visible: layer.visible === false ? true : false });
                        }}
                        className="text-xs hover:text-white"
                        title={layer.visible === false ? 'Hidden' : 'Visible'}
                      >
                        {layer.visible === false ? '👁️‍🗨️' : '👁️'}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          updateSelectedLayer({ locked: !layer.locked });
                        }}
                        className="text-xs hover:text-white"
                        title={layer.locked ? 'Locked' : 'Unlocked'}
                      >
                        {layer.locked ? '🔒' : '🔓'}
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
