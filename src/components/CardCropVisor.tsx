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
  Scan
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
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Natürliche Bildabmessungen (Pixel im Originalscan)
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  // Anzeigegröße des <img> Elements im DOM
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // TCG Format: Standard (63:88) oder Japanisch/Yu-Gi-Oh (59:86)
  const [format, setFormat] = useState<"standard" | "small">("standard");
  const aspectRatio = format === "standard" ? 88.0 / 63.0 : 86.0 / 59.0;

  // Stanzrahmen in Pixelkoordinaten des Originalbildes
  const [box, setBox] = useState<CropBox>({
    x: 70,
    y: 42,
    width: 1115,
    height: 1556
  });

  // Schrittweite für Nudge-Buttons (1px, 5px, 10px)
  const [stepSize, setStepSize] = useState<number>(1);

  // Drag-Status
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; boxX: number; boxY: number; boxW: number }>({
    mouseX: 0,
    mouseY: 0,
    boxX: 0,
    boxY: 0,
    boxW: 0
  });

  // Skalierungsfaktor Anzeige -> Originalbild
  const scaleX = displaySize.width > 0 && naturalSize ? displaySize.width / naturalSize.width : 1;
  const scaleY = displaySize.height > 0 && naturalSize ? displaySize.height / naturalSize.height : 1;

  // Initialisierung bei Bildwechsel
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    setNaturalSize({ width: nw, height: nh });

    const rect = img.getBoundingClientRect();
    setDisplaySize({ width: rect.width, height: rect.height });

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
      // Epson DS-530 Standard-Scan (1299 x 1800 px)
      initialW = 1118;
      initialH = Math.round(initialW * (88.0 / 63.0)); // 1560px
      initialX = 68;
      initialY = 42;
    } else {
      // Universelle Karte: 86% der Breite zentriert
      initialW = Math.round(nw * 0.86);
      initialH = Math.round(initialW * (88.0 / 63.0));
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

  // ResizeObserver für responsive Größenanpassung
  useEffect(() => {
    const imgEl = imgRef.current;
    if (!imgEl) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === imgEl) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            setDisplaySize({ width, height });
          }
        }
      }
    });

    observer.observe(imgEl);
    return () => observer.disconnect();
  }, []);

  // Update-Funktion mit Grenzwert-Prüfung
  const updateBox = useCallback((updater: (prev: CropBox) => CropBox) => {
    setBox((prev) => {
      const next = updater(prev);
      if (!naturalSize) return next;

      const clampedW = Math.max(100, Math.min(naturalSize.width, Math.round(next.width)));
      const clampedH = Math.max(100, Math.min(naturalSize.height, Math.round(clampedW * aspectRatio)));
      const clampedX = Math.max(0, Math.min(naturalSize.width - clampedW, Math.round(next.x)));
      const clampedY = Math.max(0, Math.min(naturalSize.height - clampedH, Math.round(next.y)));

      const finalBox = { x: clampedX, y: clampedY, width: clampedW, height: clampedH };
      onChange(finalBox);
      return finalBox;
    });
  }, [naturalSize, aspectRatio, onChange]);

  // Nudge-Helfer
  const nudge = useCallback((dx: number, dy: number) => {
    updateBox((prev) => ({
      ...prev,
      x: prev.x + dx,
      y: prev.y + dy
    }));
  }, [updateBox]);

  const scaleBox = useCallback((deltaW: number) => {
    updateBox((prev) => {
      const newW = prev.width + deltaW;
      const newH = Math.round(newW * aspectRatio);
      // Beim Skalieren vom Zentrum aus wachsen
      const shiftX = Math.round(-deltaW / 2);
      const shiftY = Math.round(-(newH - prev.height) / 2);
      return {
        x: prev.x + shiftX,
        y: prev.y + shiftY,
        width: newW,
        height: newH
      };
    });
  }, [updateBox, aspectRatio]);

  // Schnell-Presets
  const applyPresetEpson = () => {
    if (!naturalSize) return;
    const w = 1118;
    const h = Math.round(w * aspectRatio);
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

  // Tastatursteuerung für pixelgenaue Ausrichtung
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Nur reagieren wenn keine Texteingabe fokussiert ist
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
        scaleBox(mult * 2);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        scaleBox(-mult * 2);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nudge, scaleBox, stepSize]);

  // Drag Handler (Verschieben des Visiers)
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
      boxW: box.width
    };
  };

  const handlePointerMoveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !naturalSize || scaleX <= 0 || scaleY <= 0) return;
    const deltaMouseX = e.clientX - dragStartRef.current.mouseX;
    const deltaMouseY = e.clientY - dragStartRef.current.mouseY;

    const deltaImgX = deltaMouseX / scaleX;
    const deltaImgY = deltaMouseY / scaleY;

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

  // Resize Handler (Ecke unten rechts)
  const handlePointerDownResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setIsResizing(true);
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      boxX: box.x,
      boxY: box.y,
      boxW: box.width
    };
  };

  const handlePointerMoveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing || !naturalSize || scaleX <= 0) return;
    const deltaMouseX = e.clientX - dragStartRef.current.mouseX;
    const deltaImgX = deltaMouseX / scaleX;

    const newW = Math.max(100, dragStartRef.current.boxW + deltaImgX);
    const newH = Math.round(newW * aspectRatio);

    updateBox(() => ({
      ...box,
      width: newW,
      height: newH
    }));
  };

  const handlePointerUpResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isResizing) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      setIsResizing(false);
    }
  };

  // Berechnete Pixel auf dem Anzeigebildschirm
  const dispX = box.x * scaleX;
  const dispY = box.y * scaleY;
  const dispW = box.width * scaleX;
  const dispH = box.height * scaleY;
  // Radius für abgerundete Ecken (~3.6% der Kartenbreite)
  const dispR = Math.max(4, Math.round(dispW * 0.038));

  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      {/* Header mit Titel und TCG-Format-Auswahl */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-zinc-900/70 border border-zinc-800 rounded-xl p-3 px-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400">
            <Scan className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">Präzisions-Stanzvisier</span>
              <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
                100% Vektor-Stanze
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              Verhältnis {format === "standard" ? "63×88 mm" : "59×86 mm"} gesperrt • Keine abgeschnittenen Ränder
            </p>
          </div>
        </div>

        {/* Format-Umschalter */}
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

      {/* Interaktiver Bildbereich mit Overlay-Visier */}
      <div
        ref={containerRef}
        className="relative w-full max-w-xl mx-auto rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950 select-none shadow-2xl flex items-center justify-center"
        style={{ touchAction: "none" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={imageUrl}
          alt="Scan-Vorschau"
          onLoad={handleImageLoad}
          className="w-full h-auto max-h-[580px] object-contain block pointer-events-none"
        />

        {/* SVG Verdunkelungs-Maske außerhalb der Stanzung */}
        {displaySize.width > 0 && displaySize.height > 0 && (
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            viewBox={`0 0 ${displaySize.width} ${displaySize.height}`}
          >
            <defs>
              <mask id="visorMask">
                <rect width={displaySize.width} height={displaySize.height} fill="white" />
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
              width={displaySize.width}
              height={displaySize.height}
              fill="rgba(0, 0, 0, 0.65)"
              mask="url(#visorMask)"
            />
          </svg>
        )}

        {/* Interaktiver Stanzrahmen (Draggable & Resizable) */}
        {displaySize.width > 0 && displaySize.height > 0 && (
          <div
            onPointerDown={handlePointerDownDrag}
            onPointerMove={handlePointerMoveDrag}
            onPointerUp={handlePointerUpDrag}
            onPointerCancel={handlePointerUpDrag}
            className={`absolute border-2 transition-shadow cursor-move flex flex-col justify-between p-2 select-none ${
              isDragging
                ? "border-purple-300 shadow-[0_0_25px_rgba(168,85,247,0.9)] bg-purple-500/10"
                : "border-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.5)] hover:border-purple-300 hover:shadow-[0_0_20px_rgba(168,85,247,0.7)] bg-purple-500/5"
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
            {/* Obere Badge mit Format & Position */}
            <div className="flex items-center justify-between pointer-events-none">
              <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-purple-950/80 text-purple-200 border border-purple-500/40 backdrop-blur-sm">
                TCG {box.width}×{box.height} px
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900/80 text-zinc-300 border border-zinc-700/60 backdrop-blur-sm">
                X:{box.x} Y:{box.y}
              </span>
            </div>

            {/* Fadenkreuz-Zentrum */}
            <div className="self-center pointer-events-none flex items-center justify-center opacity-40 hover:opacity-80 transition-opacity">
              <Move className="w-6 h-6 text-purple-300 drop-shadow" />
            </div>

            {/* Resize-Handle (Unten Rechts) */}
            <div
              onPointerDown={handlePointerDownResize}
              onPointerMove={handlePointerMoveResize}
              onPointerUp={handlePointerUpResize}
              onPointerCancel={handlePointerUpResize}
              className="absolute -bottom-2.5 -right-2.5 w-6 h-6 rounded-full bg-purple-500 border-2 border-white shadow-lg cursor-nwse-resize flex items-center justify-center hover:scale-125 transition-transform"
              title="Größe anpassen (Seitenverhältnis bleibt gesperrt)"
            >
              <Maximize2 className="w-3 h-3 text-white rotate-90" />
            </div>
          </div>
        )}
      </div>

      {/* Feinjustierungs-Leiste (Pixel Nudge, Presets, Schrittweite) */}
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
            <span className="text-[11px] font-medium text-zinc-400 block mb-1">Stanzgröße anpassen</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => scaleBox(-stepSize * 2)}
                className="flex-1 py-1.5 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center justify-center gap-1 transition-colors cursor-pointer"
                title="Stanzrahmen verkleinern"
              >
                <Minimize2 className="w-3.5 h-3.5 text-zinc-400" />
                - Kleiner
              </button>
              <button
                type="button"
                onClick={() => scaleBox(stepSize * 2)}
                className="flex-1 py-1.5 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 flex items-center justify-center gap-1 transition-colors cursor-pointer"
                title="Stanzrahmen vergrößern"
              >
                <Maximize2 className="w-3.5 h-3.5 text-zinc-400" />
                + Größer
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

        {/* Schnell-Presets & Koordinaten */}
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
