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
  // Standardmäßig auf Epson DS-530 TCG-Maße kalibriert (1118 x 1560 px)
  const [box, setBox] = useState<CropBox>({
    x: 68,
    y: 42,
    width: 1118,
    height: 1560
  });

  // Schrittweite für Nudge-Buttons (1px, 5px, 10px)
  const [stepSize, setStepSize] = useState<number>(1);

  // Drag-Status
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [resizeMode, setResizeMode] = useState<"corner" | "width" | "height" | null>(null);

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
      initialW = 1118;
      initialH = Math.round(initialW * targetRatio); // 1560px
      initialX = 68;
      initialY = 42;
    } else {
      // Universelle Karte: 86% der Breite
      initialW = Math.round(nw * 0.86);
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

  // ResizeObserver auf dem Wrapper, um bei Fenstergrößenänderung immer scharf und unverzerrt zu skalieren
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

      const clampedW = Math.max(80, Math.min(naturalSize.width, Math.round(next.width)));
      const clampedH = Math.max(80, Math.min(naturalSize.height, Math.round(next.height)));
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

  // Breiten- und Höhenanpassung
  const adjustWidth = useCallback((deltaW: number) => {
    updateBox((prev) => {
      const newW = prev.width + deltaW;
      const newH = isRatioLocked ? Math.round(newW * targetRatio) : prev.height;
      const shiftX = Math.round(-deltaW / 2);
      const shiftY = isRatioLocked ? Math.round(-(newH - prev.height) / 2) : 0;
      return {
        ...prev,
        x: prev.x + shiftX,
        y: prev.y + shiftY,
        width: newW,
        height: newH
      };
    });
  }, [updateBox, isRatioLocked, targetRatio]);

  const adjustHeight = useCallback((deltaH: number) => {
    updateBox((prev) => {
      const newH = prev.height + deltaH;
      const newW = isRatioLocked ? Math.round(newH / targetRatio) : prev.width;
      const shiftY = Math.round(-deltaH / 2);
      const shiftX = isRatioLocked ? Math.round(-(newW - prev.width) / 2) : 0;
      return {
        ...prev,
        x: prev.x + shiftX,
        y: prev.y + shiftY,
        width: newW,
        height: newH
      };
    });
  }, [updateBox, isRatioLocked, targetRatio]);

  // Schnell-Presets
  const applyPresetEpson = () => {
    if (!naturalSize) return;
    const w = 1118;
    const h = Math.round(w * targetRatio);
    updateBox(() => ({
      x: 68,
      y: 42,
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

  // Tastatursteuerung für pixelgenaue Ausrichtung
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
        adjustWidth(mult * 2);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        adjustWidth(-mult * 2);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nudge, adjustWidth, stepSize]);

  // Drag-Verschiebung
  const handlePointerDownDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      boxX: box.x,
      boxY: box.y,
      boxW: box.width,
      boxH: box.height
    };
  };

  const handlePointerMoveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || uniformScale <= 0) return;
    const deltaMouseX = e.clientX - dragStartRef.current.mouseX;
    const deltaMouseY = e.clientY - dragStartRef.current.mouseY;

    // Exakt 1:1 mit uniformScale umrechnen
    const deltaImgX = deltaMouseX / uniformScale;
    const deltaImgY = deltaMouseY / uniformScale;

    updateBox(() => ({
      ...box,
      x: dragStartRef.current.boxX + deltaImgX,
      y: dragStartRef.current.boxY + deltaImgY
    }));
  };

  const handlePointerUpDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      setIsDragging(false);
    }
  };

  // Resize-Handlers
  const startResize = (mode: "corner" | "width" | "height", e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setResizeMode(mode);
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      boxX: box.x,
      boxY: box.y,
      boxW: box.width,
      boxH: box.height
    };
  };

  const handlePointerMoveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeMode || uniformScale <= 0) return;
    const deltaMouseX = e.clientX - dragStartRef.current.mouseX;
    const deltaMouseY = e.clientY - dragStartRef.current.mouseY;

    const deltaImgX = deltaMouseX / uniformScale;
    const deltaImgY = deltaMouseY / uniformScale;

    if (resizeMode === "corner") {
      const newW = Math.max(80, dragStartRef.current.boxW + deltaImgX);
      const newH = isRatioLocked
        ? Math.round(newW * targetRatio)
        : Math.max(80, dragStartRef.current.boxH + deltaImgY);

      updateBox(() => ({
        ...box,
        width: newW,
        height: newH
      }));
    } else if (resizeMode === "width") {
      const newW = Math.max(80, dragStartRef.current.boxW + deltaImgX);
      const newH = isRatioLocked ? Math.round(newW * targetRatio) : box.height;
      updateBox(() => ({
        ...box,
        width: newW,
        height: newH
      }));
    } else if (resizeMode === "height") {
      const newH = Math.max(80, dragStartRef.current.boxH + deltaImgY);
      const newW = isRatioLocked ? Math.round(newH / targetRatio) : box.width;
      updateBox(() => ({
        ...box,
        width: newW,
        height: newH
      }));
    }
  };

  const stopResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resizeMode) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      setResizeMode(null);
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
                className={`flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border transition-colors cursor-pointer ${
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
                ? "TCG-Verhältnis aktiv: Breite und Höhe skalieren exakt proportional."
                : "Freies Format: Breite und Höhe können unabhängig justiert werden."}
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

            {/* Der interaktive Stanzrahmen (Draggable & Resizable) */}
            <div
              onPointerDown={handlePointerDownDrag}
              onPointerMove={handlePointerMoveDrag}
              onPointerUp={handlePointerUpDrag}
              onPointerCancel={handlePointerUpDrag}
              className={`absolute border-2 transition-shadow cursor-move flex flex-col justify-between p-2 select-none ${
                isDragging
                  ? "border-purple-300 shadow-[0_0_25px_rgba(168,85,247,0.9)] bg-purple-500/10"
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
              {/* Obere Badge mit Pixelmaßen */}
              <div className="flex items-center justify-between pointer-events-none">
                <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-purple-950/85 text-purple-200 border border-purple-500/40 backdrop-blur-sm">
                  {box.width}×{box.height} px
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900/85 text-zinc-300 border border-zinc-700/60 backdrop-blur-sm">
                  X:{box.x} Y:{box.y}
                </span>
              </div>

              {/* Fadenkreuz */}
              <div className="self-center pointer-events-none flex items-center justify-center opacity-40 hover:opacity-80 transition-opacity">
                <Move className="w-6 h-6 text-purple-300 drop-shadow" />
              </div>

              {/* Resize-Handle: Rechte Kante (Breite) */}
              {!isRatioLocked && (
                <div
                  onPointerDown={(e) => startResize("width", e)}
                  onPointerMove={handlePointerMoveResize}
                  onPointerUp={stopResize}
                  onPointerCancel={stopResize}
                  className="absolute top-1/2 -right-2.5 -translate-y-1/2 w-5 h-8 rounded-full bg-purple-600/80 border border-white/60 cursor-ew-resize flex items-center justify-center hover:scale-110 transition-transform"
                  title="Breite anpassen"
                >
                  <div className="w-0.5 h-4 bg-white/80 rounded" />
                </div>
              )}

              {/* Resize-Handle: Untere Kante (Höhe) */}
              {!isRatioLocked && (
                <div
                  onPointerDown={(e) => startResize("height", e)}
                  onPointerMove={handlePointerMoveResize}
                  onPointerUp={stopResize}
                  onPointerCancel={stopResize}
                  className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-8 h-5 rounded-full bg-purple-600/80 border border-white/60 cursor-ns-resize flex items-center justify-center hover:scale-110 transition-transform"
                  title="Höhe anpassen"
                >
                  <div className="h-0.5 w-4 bg-white/80 rounded" />
                </div>
              )}

              {/* Resize-Handle: Ecke unten rechts */}
              <div
                onPointerDown={(e) => startResize("corner", e)}
                onPointerMove={handlePointerMoveResize}
                onPointerUp={stopResize}
                onPointerCancel={stopResize}
                className="absolute -bottom-2.5 -right-2.5 w-6 h-6 rounded-full bg-purple-500 border-2 border-white shadow-lg cursor-nwse-resize flex items-center justify-center hover:scale-125 transition-transform"
                title={isRatioLocked ? "Größe anpassen (63:88 mm gesperrt)" : "Größe frei anpassen"}
              >
                <Maximize2 className="w-3 h-3 text-white rotate-90" />
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
          <span className="text-[11px] font-medium text-zinc-400">Position verschieben</span>
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

        {/* Größen-Skalierung & Schrittweite */}
        <div className="flex flex-col justify-between gap-2">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-medium text-zinc-400">Stanzgröße</span>
              <span className="text-[10px] text-purple-300 font-mono">
                {box.width} × {box.height} px
              </span>
            </div>
            <div className="flex items-center gap-2 mb-1.5">
              <button
                type="button"
                onClick={() => adjustWidth(-stepSize * 2)}
                className="flex-1 py-1 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center justify-center gap-1 transition-colors cursor-pointer"
                title="Stanzrahmen verkleinern"
              >
                <Minimize2 className="w-3.5 h-3.5 text-zinc-400" />
                - Kleiner
              </button>
              <button
                type="button"
                onClick={() => adjustWidth(stepSize * 2)}
                className="flex-1 py-1 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center justify-center gap-1 transition-colors cursor-pointer"
                title="Stanzrahmen vergrößern"
              >
                <Maximize2 className="w-3.5 h-3.5 text-zinc-400" />
                + Größer
              </button>
            </div>

            {/* Zusätzliche unabhängige Höhenjustierung bei Bedarf */}
            {!isRatioLocked && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => adjustHeight(-stepSize * 2)}
                  className="flex-1 py-1 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center justify-center gap-1 transition-colors cursor-pointer"
                  title="Höhe verringern"
                >
                  - Höhe
                </button>
                <button
                  type="button"
                  onClick={() => adjustHeight(stepSize * 2)}
                  className="flex-1 py-1 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center justify-center gap-1 transition-colors cursor-pointer"
                  title="Höhe vergrößern"
                >
                  + Höhe
                </button>
              </div>
            )}
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
                Auto Epson DS-530
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
            Stanze: {box.x}, {box.y}, {box.width}×{box.height} px
          </div>
        </div>
      </div>
    </div>
  );
};
