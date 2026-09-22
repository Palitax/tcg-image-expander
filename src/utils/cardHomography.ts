import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";

export interface CardCorners {
  top_left: [number, number];
  top_right: [number, number];
  bottom_right: [number, number];
  bottom_left: [number, number];
}

export interface CardAnalysisResult {
  card_name: string;
  collector_number: string;
  set_code: string;
  set_name?: string;
  scene_prompt: string;
  corners: CardCorners;
  is_small_japanese_game?: boolean;
  illustration_box?: [number, number, number, number];
  is_full_art?: boolean;
  is_card_back?: boolean;
}

export interface CardHomographyResult {
  cutoutBuffer: Buffer;
  cutoutBase64: string;
  analysis: CardAnalysisResult;
  width: number;
  height: number;
}

export interface CardCropBox {
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth?: number;
  imageHeight?: number;
}

export interface ExtractCardHomographyOptions {
  apiKey?: string | null;
  targetWidth?: number;
  edgePaddingPx?: number;
  verticalOffsetPx?: number;
  bottomTrimPx?: number;
  topPaddingPx?: number;
  cropBox?: CardCropBox | null;
}

function getPythonExecutable(): string {
  if (process.env.PYTHON_BIN) {
    return process.env.PYTHON_BIN;
  }
  // Construct path dynamically to avoid Turbopack static DirAssetReference symlink tracing
  const segments = [process.cwd(), ".venv", "bin", "python"];
  return segments.join(path.sep);
}

/**
 * Führt die Homographie-basierte Freistell-Engine (Gemini 4-Punkt Grounding + cv2.warpPerspective) aus.
 * 
 * @param imageBuffer Eingabebild als Buffer
 * @param options Optionale Parameter wie API-Key und Zielbreite
 * @returns CardHomographyResult mit transparentem RGBA-Stanzling und Metadaten
 */
export async function extractCardHomography(
  imageBuffer: Buffer,
  options: ExtractCardHomographyOptions = {}
): Promise<CardHomographyResult> {
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `tcg_in_${uniqueId}.jpg`);
  const outputPath = path.join(tempDir, `tcg_out_${uniqueId}.png`);
  const jsonPath = path.join(tempDir, `tcg_meta_${uniqueId}.json`);

  const pythonBin = getPythonExecutable();

  try {
    // 1. Eingabepuffer temporär speichern
    await fs.writeFile(inputPath, imageBuffer);

    // 2. CLI-Argumente vorbereiten
    const args = [
      "-m",
      "card_engine.cli",
      "-i",
      inputPath,
      "-o",
      outputPath,
      "--json",
      jsonPath
    ];

    if (options.apiKey && options.apiKey.trim()) {
      args.push("--api-key", options.apiKey.trim());
    }
    if (options.targetWidth) {
      args.push("--width", options.targetWidth.toString());
    }
    if (options.edgePaddingPx) {
      args.push("--edge-padding", options.edgePaddingPx.toString());
    }
    if (options.verticalOffsetPx) {
      args.push("--vertical-offset", options.verticalOffsetPx.toString());
    }
    if (options.bottomTrimPx) {
      args.push("--bottom-trim", options.bottomTrimPx.toString());
    }
    if (options.topPaddingPx) {
      args.push("--top-padding", options.topPaddingPx.toString());
    }
    if (options.cropBox) {
      const { x, y, width, height, imageWidth, imageHeight } = options.cropBox;
      if (imageWidth && imageHeight && imageWidth > 0 && imageHeight > 0) {
        const nx = (x / imageWidth).toFixed(6);
        const ny = (y / imageHeight).toFixed(6);
        const nw = (width / imageWidth).toFixed(6);
        const nh = (height / imageHeight).toFixed(6);
        args.push("--crop-box", `${nx},${ny},${nw},${nh}`);
      } else {
        args.push("--crop-box", `${x},${y},${width},${height}`);
      }
    }

    // 3. Python-Prozess ausführen
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(pythonBin, args, {
        cwd: process.cwd(),
        env: { ...process.env, PYTHONUNBUFFERED: "1" }
      });

      let stderrOutput = "";
      proc.stderr.on("data", (chunk) => {
        stderrOutput += chunk.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`card_engine fehlgeschlagen (Exit-Code ${code}): ${stderrOutput}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Konnte Python-Prozess für card_engine nicht starten: ${err.message}`));
      });
    });

    // 4. Ergebnisse einlesen
    const [cutoutBuffer, jsonStr] = await Promise.all([
      fs.readFile(outputPath),
      fs.readFile(jsonPath, "utf-8")
    ]);

    const analysis = JSON.parse(jsonStr) as CardAnalysisResult;

    // Bildmaße ermitteln
    return {
      cutoutBuffer,
      cutoutBase64: `data:image/png;base64,${cutoutBuffer.toString("base64")}`,
      analysis,
      width: options.targetWidth || 750,
      height: Math.round((options.targetWidth || 750) * (88.0 / 63.0))
    };
  } finally {
    // 5. Aufräumen
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
    await fs.unlink(jsonPath).catch(() => {});
  }
}
