import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";

export interface RemoveBackgroundOptions {
  noDecontaminate?: boolean;
  noRefine?: boolean;
  noTiling?: boolean;
  threshold?: number;
}

/**
 * Führt die Python-basierte Deep-Learning-Engine `bg_remover` (RMBG-1.4, Guided Filter, Despill) aus.
 * 
 * @param imageBuffer Eingabebild als Buffer (PNG, JPEG, WebP)
 * @param options Optionale Flags zur Steuerung der Pipeline
 * @returns Buffer des transparenten 4-Kanal RGBA-Bildes
 */
function getPythonExecutable(): string {
  if (process.env.PYTHON_BIN) {
    return process.env.PYTHON_BIN;
  }
  // Construct path dynamically to avoid Turbopack static DirAssetReference symlink tracing
  const segments = [process.cwd(), ".venv", "bin", "python"];
  return segments.join(path.sep);
}

export async function removeBackgroundAI(
  imageBuffer: Buffer,
  options: RemoveBackgroundOptions = {}
): Promise<Buffer> {
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `bgr_in_${uniqueId}.png`);
  const outputPath = path.join(tempDir, `bgr_out_${uniqueId}.png`);

  const pythonBin = getPythonExecutable();

  try {
    // 1. Schreibe Eingabepuffer temporär auf die Festplatte
    await fs.writeFile(inputPath, imageBuffer);

    // 2. Erstelle CLI-Argumente
    const args = [
      "-m",
      "bg_remover.cli",
      "-i",
      inputPath,
      "-o",
      outputPath
    ];

    if (options.noDecontaminate) args.push("--no-decontaminate");
    if (options.noRefine) args.push("--no-refine");
    if (options.noTiling) args.push("--no-tiling");
    if (options.threshold) args.push("--threshold", options.threshold.toString());

    // 3. Führe den Python-Prozess aus
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
          reject(new Error(`bg_remover fehlgeschlagen (Exit-Code ${code}): ${stderrOutput}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Konnte Python-Prozess für bg_remover nicht starten: ${err.message}`));
      });
    });

    // 4. Lies das freigestellte RGBA-Bild ein
    const resultBuffer = await fs.readFile(outputPath);
    return resultBuffer;
  } finally {
    // 5. Temporäre Dateien sauber aufräumen
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}
