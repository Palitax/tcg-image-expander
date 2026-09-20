"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Move,
  Maximize2,
  Minimize2,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Sparkles,
  Scan,
  Lock,
  Unlock
} from "lucide-react";

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CardCropVisorProps {
  imageUrl: string;
  onChange: (box: CropBox) => void;
  initialBox?: CropBox | null;
  className?: string;
}

type DragMode =
  | "move"
  | "edge-right"
  | "edge-left"
  | "edge-top"
  | "edge-bottom"
  | "corner-br"
  | "corner-bl"
  | "corner-tr"
  | "corner-tl"
  | null;

export const CardCropVisor: React.FC<CardCropVisorProps> = ({
  imageUrl,
  onChange,
  initialBox,
  className = ""
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Natürliche Pixelabmessungen des Originalscans
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  // Einheitlicher Skalierungsfaktor (garantiert identische X- und Y-Skalierung, keine Verzerrung!)
  const [uniformScale, setUniformScale] = useState<number>(0.35);

  // TCG Format: Standard (63:88 mm = 1:1.3968) oder Japanisch/Yu-Gi-Oh (59:86 mm = 1:1.4576)
  const [format, setFormat] = useState<"standard" | "small">("standard");
  const targetRatio = format === "standard" ? 88.0 / 63.0 : 86.0 / 59.0;

  // Seitenverhältnis-Sperre aktiv?
  const [isRatioLocked, setIsRatioLocked] = useState<boolean>(true);

  // Stanzrahmen in Pixelkoordinaten des Originalbildes
  // Standardmäßig auf Epson DS-530 TCG-Scanmaße kalibriert (1170 x 1634 px)
  const [box, setBox] = useState<CropBox>({
    x: 54,
    y: 36,
    width: 1170,
    height: 1634
  });

  // Schrittweite für Nudge-Buttons (1px, 5px, 10px)
  const [stepSize, setStepSize] = useState<number>(1);

  // Drag-Modus
  const [dragMode, setDragMode] = useState<DragMode>(null);

  const dragStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    boxX: number;
    boxY: number;
    boxW: number;
    boxH: number;
  }>({
    mouseX: 0,
    mouseY: 0,
    boxX: 0,
    boxY: 0,
    boxW: 0,
    boxH: 0
  });

  // Berechne gleichmäßige Skalierung basierend auf der verfügbaren Breite und Maximalhöhe
  const updateDisplayScale = useCallback((nw: number, nh: number) => {
    if (!wrapperRef.current) return;
    const availW = Math.max(260, wrapperRef.current.clientWidth - 16);
    const availH = 640; // Angenehme visuelle Maximalhöhe
    const s = Math.min(availW / nw, availH / nh);
    setUniformScale(s > 0 ? s : 0.35);
  }, []);

  // Bild geladen
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    setNaturalSize({ width: nw, height: nh });
    updateDisplayScale(nw, nh);

    let initialW: number;
    let initialH: number;
    let initialX: number;
    let initialY: number;

    if (initialBox && initialBox.width > 0 && initialBox.height > 0) {
      initialX = initialBox.x;
      initialY = initialBox.y;
      initialW = initialBox.width;
      initialH = initialBox.height;
    } else if (nw >= 1200 && nw <= 1400 && nh >= 1700 && nh <= 1900) {
      // Epson DS-530 Scan (1299 x 1800 px) -> Exakte TCG-Kartenmaße
      initialW = 1170;
      initialH = Math.round(initialW * targetRatio); // 1634px
      initialX = 54;
      initialY = 36;
    } else {
      // Universelle Karte: 90% der Breite
      initialW = Math.round(nw * 0.90);
      initialH = Math.round(initialW * targetRatio);
      initialX = Math.round((nw - initialW) / 2);
      initialY = Math.round((nh - initialH) / 2);
    }

    // Grenzwerte absichern
    initialX = Math.max(0, Math.min(nw - initialW, initialX));
    initialY = Math.max(0, Math.min(nh - initialH, initialY));

    const newBox = { x: initialX, y: initialY, width: initialW, height: initialH };
    setBox(newBox);
    onChange(newBox);
  };

  // ResizeObserver auf dem Wrapper
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const observer = new ResizeObserver(() => {
      if (naturalSize) {
        updateDisplayScale(naturalSize.width, naturalSize.height);
      }
    });

    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [naturalSize, updateDisplayScale]);

  // Update-Funktion mit Grenzwert-Prüfung
  const updateBox = useCallback((updater: (prev: CropBox) => CropBox) => {
    setBox((prev) => {
      const next = updater(prev);
      if (!naturalSize) return next;

      const clampedW = Math.max(50, Math.min(naturalSize.width, Math.round(next.width)));
      const clampedH = Math.max(50, Math.min(naturalSize.height, Math.round(next.height)));
      const clampedX = Math.max(0, Math.min(naturalSize.width - clampedW, Math.round(next.x)));
      const clampedY = Math.max(0, Math.min(naturalSize.height - clampedH, Math.round(next.y)));

      const finalBox = { x: clampedX, y: clampedY, width: clampedW, height: clampedH };
      onChange(finalBox);
      return finalBox;
    });
  }, [naturalSize, onChange]);

  // Nudge-Helfer (Verschieben)
  const nudge = useCallback((dx: number, dy: number) => {
    updateBox((prev) => ({
      ...prev,
      x: prev.x + dx,
      y: prev.y + dy
    }));
  }, [updateBox]);

  // Unabhängige Breitenanpassung (Horizontal)
  const adjustWidth = useCallback((deltaW: number) => {
    updateBox((prev) => {
      const newW = prev.width + deltaW;
      const shiftX = Math.round(-deltaW / 2);
      return {
        ...prev,
        x: prev.x + shiftX,
        width: newW
      };
    });
  }, [updateBox]);

  // Unabhängige Höhenanpassung (Vertikal)
  const adjustHeight = useCallback((deltaH: number) => {
    updateBox((prev) => {
      const newH = prev.height + deltaH;
      const shiftY = Math.round(-deltaH / 2);
      return {
        ...prev,
        y: prev.y + shiftY,
        height: newH
      };
    });
  }, [updateBox]);

  // Proportionale Skalierung
  const scaleProportional = useCallback((deltaW: number) => {
    updateBox((prev) => {
      const newW = prev.width + deltaW;
      const newH = Math.round(newW * targetRatio);
      const shiftX = Math.round(-deltaW / 2);
      const shiftY = Math.round(-(newH - prev.height) / 2);
      return {
        ...prev,
        x: prev.x + shiftX,
        y: prev.y + shiftY,
        width: newW,
        height: newH
      };
    });
  }, [updateBox, targetRatio]);

  // Schnell-Presets
  const applyPresetEpson = () => {
    if (!naturalSize) return;
    const w = 1170;
    const h = Math.round(w * targetRatio); // 1634px
    updateBox(() => ({
      x: 54,
      y: 36,
      width: w,
      height: h
    }));
  };

  const applyPresetCenter = () => {
    if (!naturalSize) return;
    updateBox((prev) => ({
      ...prev,
      x: Math.round((naturalSize.width - prev.width) / 2),
      y: Math.round((naturalSize.height - prev.height) / 2)
    }));
  };

  const resetToExactRatio = () => {
    updateBox((prev) => ({
      ...prev,
      height: Math.round(prev.width * targetRatio)
    }));
    setIsRatioLocked(true);
  };

  // Tastatursteuerung
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }

      const mult = e.shiftKey ? 10 : stepSize;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        nudge(-mult, 0);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nudge(mult, 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        nudge(0, -mult);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        nudge(0, mult);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        if (isRatioLocked) scaleProportional(mult * 2);
        else adjustWidth(mult * 2);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        if (isRatioLocked) scaleProportional(-mult * 2);
        else adjustWidth(-mult * 2);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nudge, adjustWidth, scaleProportional, isRatioLocked, stepSize]);

  // Pointer Handlers für Drag & Resize
  const startDrag = (mode: DragMode, e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragMode(mode);
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      boxX: box.x,
      boxY: box.y,
      boxW: box.width,
      boxH: box.height
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragMode || uniformScale <= 0 || !naturalSize) return;
    const deltaMouseX = e.clientX - dragStartRef.current.mouseX;
    const deltaMouseY = e.clientY - dragStartRef.current.mouseY;

    const deltaX = deltaMouseX / uniformScale;
    const deltaY = deltaMouseY / uniformScale;
    const { boxX, boxY, boxW, boxH } = dragStartRef.current;

    updateBox(() => {
      let nextX = boxX;
      let nextY = boxY;
      let nextW = boxW;
      let nextH = boxH;

      if (dragMode === "move") {
        // Freies Verschieben in jede Richtung
        nextX = boxX + deltaX;
        nextY = boxY + deltaY;
      } else if (dragMode === "edge-right") {
        // Ausschließlich HORIZONTAL nach rechts
        nextW = Math.max(50, boxW + deltaX);
      } else if (dragMode === "edge-left") {
        // Ausschließlich HORIZONTAL nach links
        const potentialX = boxX + deltaX;
        nextX = Math.min(boxX + boxW - 50, potentialX);
        nextW = boxW - (nextX - boxX);
      } else if (dragMode === "edge-bottom") {
        // Ausschließlich VERTIKAL nach unten
        nextH = Math.max(50, boxH + deltaY);
      } else if (dragMode === "edge-top") {
        // Ausschließlich VERTIKAL nach oben
        const potentialY = boxY + deltaY;
        nextY = Math.min(boxY + boxH - 50, potentialY);
        nextH = boxH - (nextY - boxY);
      } else if (dragMode === "corner-br") {
        nextW = Math.max(50, boxW + deltaX);
        nextH = isRatioLocked ? Math.round(nextW * targetRatio) : Math.max(50, boxH + deltaY);
      } else if (dragMode === "corner-tr") {
        nextW = Math.max(50, boxW + deltaX);
        const desiredH = isRatioLocked ? Math.round(nextW * targetRatio) : Math.max(50, boxH - deltaY);
        nextY = boxY + boxH - desiredH;
        nextH = desiredH;
      } else if (dragMode === "corner-bl") {
        const potentialX = boxX + deltaX;
        nextX = Math.min(boxX + boxW - 50, potentialX);
        nextW = boxW - (nextX - boxX);
        nextH = isRatioLocked ? Math.round(nextW * targetRatio) : Math.max(50, boxH + deltaY);
      } else if (dragMode === "corner-tl") {
        const potentialX = boxX + deltaX;
        nextX = Math.min(boxX + boxW - 50, potentialX);
        nextW = boxW - (nextX - boxX);
        const desiredH = isRatioLocked ? Math.round(nextW * targetRatio) : Math.max(50, boxH - deltaY);
        nextY = boxY + boxH - desiredH;
        nextH = desiredH;
      }

      return { x: nextX, y: nextY, width: nextW, height: nextH };
    });
  };

  const stopDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragMode) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      setDragMode(null);
    }
  };

  // Exakte Anzeige-Abmessungen der Leinwand (strikte Wahrung des Scan-Seitenverhältnisses)
  const displayW = naturalSize ? Math.round(naturalSize.width * uniformScale) : 0;
  const displayH = naturalSize ? Math.round(naturalSize.height * uniformScale) : 0;

  // Stanzrahmen-Positionen auf dem Bildschirm
  const dispX = Math.round(box.x * uniformScale);
  const dispY = Math.round(box.y * uniformScale);
  const dispW = Math.round(box.width * uniformScale);
  const dispH = Math.round(box.height * uniformScale);
  // Radius für abgerundete Ecken (~3.6% der Kartenbreite)
  const dispR = Math.max(4, Math.round(dispW * 0.038));

  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      {/* Header mit Titel, Verhältnis-Status und Format-Auswahl */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-zinc-900/70 border border-zinc-800 rounded-xl p-3 px-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400">
            <Scan className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">Präzisions-Stanzvisier</span>
              <button
                type="button"
                onClick={() => setIsRatioLocked(!isRatioLocked)}
                className={`flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full border transition-colors cursor-pointer ${
                  isRatioLocked
                    ? "bg-purple-500/20 text-purple-300 border-purple-500/40 hover:bg-purple-500/30"
                    : "bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30"
                }`}
                title="Klicken zum Sperren / Entsperren des Seitenverhältnisses"
              >
                {isRatioLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                {isRatioLocked ? (format === "standard" ? "63:88 mm gesperrt" : "59:86 mm gesperrt") : "Freies Format"}
              </button>
            </div>
            <p className="text-[11px] text-zinc-400">
              {isRatioLocked
                ? "Kanten ziehen passt Breite/Höhe einzeln an • Ecken ziehen skaliert proportional."
                : "Freies Format: Alle Kanten und Ecken können völlig frei verschoben werden."}
            </p>
          </div>
        </div>

        {/* Format-Umschalter & Reset */}
        <div className="flex items-center gap-2">
          {!isRatioLocked && (
            <button
              type="button"
              onClick={resetToExactRatio}
              className="px-2.5 py-1 text-xs rounded-lg bg-purple-900/40 hover:bg-purple-800/60 text-purple-200 border border-purple-700/50 flex items-center gap-1 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              63:88 sperren
            </button>
          )}

          <div className="flex items-center gap-1.5 bg-zinc-950 p-1 rounded-lg border border-zinc-800">
            <button
              type="button"
              onClick={() => {
                setFormat("standard");
                updateBox((prev) => ({
                  ...prev,
                  height: Math.round(prev.width * (88.0 / 63.0))
                }));
              }}
              className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors cursor-pointer ${
                format === "standard"
                  ? "bg-purple-600 text-white shadow-sm"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              Standard (63×88)
            </button>
            <button
              type="button"
              onClick={() => {
                setFormat("small");
                updateBox((prev) => ({
                  ...prev,
                  height: Math.round(prev.width * (86.0 / 59.0))
                }));
              }}
              className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors cursor-pointer ${
                format === "small"
                  ? "bg-purple-600 text-white shadow-sm"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              Japanisch (59×86)
            </button>
          </div>
        </div>
      </div>

      {/* Interaktive Bildbühne mit einheitlicher Skalierung */}
      <div
        ref={wrapperRef}
        className="w-full flex items-center justify-center p-2 select-none overflow-hidden"
        style={{ touchAction: "none" }}
      >
        {displayW > 0 && displayH > 0 && (
          <div
            ref={stageRef}
            style={{
              width: `${displayW}px`,
              height: `${displayH}px`,
              position: "relative"
            }}
            className="rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950 shadow-2xl shrink-0"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt="Scan-Vorschau"
              onLoad={handleImageLoad}
              style={{
                width: "100%",
                height: "100%",
                display: "block",
                pointerEvents: "none"
              }}
            />

            {/* SVG Maske: Dunkelt den Scannerbereich außerhalb der Stanzung präzise ab */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              viewBox={`0 0 ${displayW} ${displayH}`}
            >
              <defs>
                <mask id="visorDieCutMask">
                  <rect width={displayW} height={displayH} fill="white" />
                  <rect
                    x={dispX}
                    y={dispY}
                    width={dispW}
                    height={dispH}
                    rx={dispR}
                    ry={dispR}
                    fill="black"
                  />
                </mask>
              </defs>
              <rect
                width={displayW}
                height={displayH}
                fill="rgba(0, 0, 0, 0.65)"
                mask="url(#visorDieCutMask)"
              />
            </svg>

            {/* Der interaktive Stanzrahmen */}
            <div
              onPointerDown={(e) => startDrag("move", e)}
              onPointerMove={handlePointerMove}
              onPointerUp={stopDrag}
              onPointerCancel={stopDrag}
              className={`absolute border-2 transition-shadow cursor-move flex flex-col justify-between p-2 select-none ${
                dragMode === "move"
                  ? "border-purple-300 shadow-[0_0_25px_rgba(168,85,247,0.9)] bg-purple-500/15"
                  : "border-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.6)] hover:border-purple-300 hover:shadow-[0_0_20px_rgba(168,85,247,0.8)] bg-purple-500/5"
              }`}
              style={{
                left: `${dispX}px`,
                top: `${dispY}px`,
                width: `${dispW}px`,
                height: `${dispH}px`,
                borderRadius: `${dispR}px`,
                touchAction: "none"
              }}
            >
              {/* Schwebende Maß-Badge außerhalb der Karte (verdeckt keine Kartentexte/Symbole) */}
              <div className={`absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 pointer-events-none z-10 whitespace-nowrap transition-all ${
                dispY < 30 ? "bottom-2" : "-top-7"
              }`}>
                <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-purple-950/90 text-purple-200 border border-purple-500/50 shadow-md backdrop-blur-sm">
                  {box.width}×{box.height} px
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900/90 text-zinc-300 border border-zinc-700/70 shadow-md backdrop-blur-sm">
                  X:{box.x} Y:{box.y}
                </span>
              </div>

              {/* Fadenkreuz */}
              <div className="self-center pointer-events-none flex items-center justify-center opacity-40 hover:opacity-80 transition-opacity">
                <Move className="w-6 h-6 text-purple-300 drop-shadow" />
              </div>

              {/* ---------------- 4 KANTEN-GRIFFE (SEPARAT HORIZONTAL & VERTIKAL) ---------------- */}

              {/* Rechte Kante (Nur Breite / Horizontal) */}
              <div
                onPointerDown={(e) => startDrag("edge-right", e)}
                onPointerMove={handlePointerMove}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                className="absolute top-1/2 -right-3 -translate-y-1/2 w-4 h-10 rounded-full bg-purple-500 border border-white/80 cursor-ew-resize flex items-center justify-center hover:scale-115 shadow-md transition-transform"
                title="Rechte Kante ziehen (nur horizontal)"
              >
                <div className="w-0.5 h-4 bg-white rounded" />
              </div>

              {/* Linke Kante (Nur links / Horizontal) */}
              <div
                onPointerDown={(e) => startDrag("edge-left", e)}
                onPointerMove={handlePointerMove}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                className="absolute top-1/2 -left-3 -translate-y-1/2 w-4 h-10 rounded-full bg-purple-500 border border-white/80 cursor-ew-resize flex items-center justify-center hover:scale-115 shadow-md transition-transform"
                title="Linke Kante ziehen (nur horizontal)"
              >
                <div className="w-0.5 h-4 bg-white rounded" />
              </div>

              {/* Untere Kante (Nur Höhe / Vertikal) */}
              <div
                onPointerDown={(e) => startDrag("edge-bottom", e)}
                onPointerMove={handlePointerMove}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                className="absolute -bottom-3 left-1/2 -translate-x-1/2 w-10 h-4 rounded-full bg-purple-500 border border-white/80 cursor-ns-resize flex items-center justify-center hover:scale-115 shadow-md transition-transform"
                title="Untere Kante ziehen (nur vertikal)"
              >
                <div className="h-0.5 w-4 bg-white rounded" />
              </div>

              {/* Obere Kante (Nur oben / Vertikal) */}
              <div
                onPointerDown={(e) => startDrag("edge-top", e)}
                onPointerMove={handlePointerMove}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                className="absolute -top-3 left-1/2 -translate-x-1/2 w-10 h-4 rounded-full bg-purple-500 border border-white/80 cursor-ns-resize flex items-center justify-center hover:scale-115 shadow-md transition-transform"
                title="Obere Kante ziehen (nur vertikal)"
              >
                <div className="h-0.5 w-4 bg-white rounded" />
              </div>

              {/* ---------------- 4 ECKEN-GRIFFE ---------------- */}

              {/* Ecke unten rechts */}
              <div
                onPointerDown={(e) => startDrag("corner-br", e)}
                onPointerMove={handlePointerMove}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                className="absolute -bottom-2.5 -right-2.5 w-6 h-6 rounded-full bg-purple-600 border-2 border-white shadow-lg cursor-nwse-resize flex items-center justify-center hover:scale-125 transition-transform"
                title={isRatioLocked ? "Ecke unten-rechts (proportional)" : "Ecke unten-rechts (frei)"}
              >
                <Maximize2 className="w-3 h-3 text-white rotate-90" />
              </div>

              {/* Ecke unten links */}
              <div
                onPointerDown={(e) => startDrag("corner-bl", e)}
                onPointerMove={handlePointerMove}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                className="absolute -bottom-2.5 -left-2.5 w-6 h-6 rounded-full bg-purple-600 border-2 border-white shadow-lg cursor-nesw-resize flex items-center justify-center hover:scale-125 transition-transform"
                title={isRatioLocked ? "Ecke unten-links (proportional)" : "Ecke unten-links (frei)"}
              >
                <Maximize2 className="w-3 h-3 text-white rotate-180" />
              </div>

              {/* Ecke oben rechts */}
              <div
                onPointerDown={(e) => startDrag("corner-tr", e)}
                onPointerMove={handlePointerMove}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                className="absolute -top-2.5 -right-2.5 w-6 h-6 rounded-full bg-purple-600 border-2 border-white shadow-lg cursor-nesw-resize flex items-center justify-center hover:scale-125 transition-transform"
                title={isRatioLocked ? "Ecke oben-rechts (proportional)" : "Ecke oben-rechts (frei)"}
              >
                <Maximize2 className="w-3 h-3 text-white" />
              </div>

              {/* Ecke oben links */}
              <div
                onPointerDown={(e) => startDrag("corner-tl", e)}
                onPointerMove={handlePointerMove}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                className="absolute -top-2.5 -left-2.5 w-6 h-6 rounded-full bg-purple-600 border-2 border-white shadow-lg cursor-nwse-resize flex items-center justify-center hover:scale-125 transition-transform"
                title={isRatioLocked ? "Ecke oben-links (proportional)" : "Ecke oben-links (frei)"}
              >
                <Maximize2 className="w-3 h-3 text-white -rotate-90" />
              </div>
            </div>
          </div>
        )}

        {/* Fallback-Anzeige während des Ladens */}
        {(!displayW || !displayH) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt="Scan-Vorschau"
            onLoad={handleImageLoad}
            className="w-full h-auto max-h-[500px] object-contain block opacity-0"
          />
        )}
      </div>

      {/* Feinjustierungs-Leiste */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-zinc-900/50 border border-zinc-800 rounded-xl p-3.5">
        {/* D-Pad Pixel-Verschiebung */}
        <div className="flex flex-col items-center justify-center gap-1.5">
          <span className="text-[11px] font-medium text-zinc-400">Position verschieben (X / Y)</span>
          <div className="grid grid-cols-3 gap-1 w-28">
            <div />
            <button
              type="button"
              onClick={() => nudge(0, -stepSize)}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-purple-600 text-zinc-300 hover:text-white border border-zinc-700 flex items-center justify-center transition-colors cursor-pointer"
              title={`Nach oben (-${stepSize}px)`}
            >
              <ChevronUp className="w-4 h-4" />
            </button>
            <div />

            <button
              type="button"
              onClick={() => nudge(-stepSize, 0)}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-purple-600 text-zinc-300 hover:text-white border border-zinc-700 flex items-center justify-center transition-colors cursor-pointer"
              title={`Nach links (-${stepSize}px)`}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="flex items-center justify-center text-[10px] font-mono text-zinc-400">
              {stepSize}px
            </div>
            <button
              type="button"
              onClick={() => nudge(stepSize, 0)}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-purple-600 text-zinc-300 hover:text-white border border-zinc-700 flex items-center justify-center transition-colors cursor-pointer"
              title={`Nach rechts (+${stepSize}px)`}
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            <div />
            <button
              type="button"
              onClick={() => nudge(0, stepSize)}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-purple-600 text-zinc-300 hover:text-white border border-zinc-700 flex items-center justify-center transition-colors cursor-pointer"
              title={`Nach unten (+${stepSize}px)`}
            >
              <ChevronDown className="w-4 h-4" />
            </button>
            <div />
          </div>
        </div>

        {/* Größen-Skalierung (Getrennt Horizontal & Vertikal) */}
        <div className="flex flex-col justify-between gap-2">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-medium text-zinc-400">Größe anpassen</span>
              <span className="text-[10px] text-purple-300 font-mono font-semibold">
                {box.width} × {box.height} px
              </span>
            </div>

            {/* Horizontale Breite */}
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-[10px] text-zinc-400 font-medium w-14">Breite (X):</span>
              <button
                type="button"
                onClick={() => adjustWidth(-stepSize * 2)}
                className="flex-1 py-1 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center justify-center gap-1 transition-colors cursor-pointer"
                title="Breite verringern (nur horizontal)"
              >
                - {stepSize * 2}px
              </button>
              <button
                type="button"
                onClick={() => adjustWidth(stepSize * 2)}
                className="flex-1 py-1 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center justify-center gap-1 transition-colors cursor-pointer"
                title="Breite vergrößern (nur horizontal)"
              >
                + {stepSize * 2}px
              </button>
            </div>

            {/* Vertikale Höhe */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-400 font-medium w-14">Höhe (Y):</span>
              <button
                type="button"
                onClick={() => adjustHeight(-stepSize * 2)}
                className="flex-1 py-1 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center justify-center gap-1 transition-colors cursor-pointer"
                title="Höhe verringern (nur vertikal)"
              >
                - {stepSize * 2}px
              </button>
              <button
                type="button"
                onClick={() => adjustHeight(stepSize * 2)}
                className="flex-1 py-1 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center justify-center gap-1 transition-colors cursor-pointer"
                title="Höhe vergrößern (nur vertikal)"
              >
                + {stepSize * 2}px
              </button>
            </div>
          </div>

          <div>
            <span className="text-[11px] font-medium text-zinc-400 block mb-1">Schrittweite:</span>
            <div className="grid grid-cols-3 gap-1 bg-zinc-950 p-1 rounded-lg border border-zinc-800">
              {[1, 5, 10].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStepSize(s)}
                  className={`py-1 text-xs rounded font-mono font-medium transition-colors cursor-pointer ${
                    stepSize === s
                      ? "bg-purple-600 text-white"
                      : "text-zinc-400 hover:text-white"
                  }`}
                >
                  {s} px
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Schnell-Presets */}
        <div className="flex flex-col justify-between gap-2">
          <div>
            <span className="text-[11px] font-medium text-zinc-400 block mb-1">Schnell-Presets</span>
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={applyPresetEpson}
                className="w-full py-1.5 px-2.5 rounded-lg bg-purple-950/60 hover:bg-purple-900/80 text-purple-200 text-xs font-medium border border-purple-700/50 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                Auto Epson DS-530 (1170×1634 px)
              </button>
              <button
                type="button"
                onClick={applyPresetCenter}
                className="w-full py-1.5 px-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5 text-zinc-400" />
                Zentrieren
              </button>
            </div>
          </div>

          <div className="text-[10px] font-mono text-zinc-400 bg-zinc-950/80 p-1.5 px-2 rounded-lg border border-zinc-800/80 text-center truncate">
            Stanze: X:{box.x}, Y:{box.y} • {box.width}×{box.height} px
          </div>
        </div>
      </div>
    </div>
  );
};
