import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function writeDebugLog(message: string) {
  console.log(`[Booster Crop Debug] ${message}`);
}

async function generateContentWithRetry(ai: any, params: any, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await ai.models.generateContent(params);
    } catch (e: any) {
      const errorStr = String(e.message || e);
      const isUnavailable = errorStr.includes("503") || errorStr.toLowerCase().includes("demand") || errorStr.toLowerCase().includes("unavailable") || e.status === 503 || e.statusCode === 503;
      const isRateLimit = errorStr.includes("429") || errorStr.toLowerCase().includes("rate limit") || errorStr.toLowerCase().includes("quota") || e.status === 429 || e.statusCode === 429;
      
      if ((isUnavailable || isRateLimit) && i < retries) {
        const waitTime = delay * Math.pow(2, i);
        console.warn(`[Gemini API] Transient error: "${errorStr}". Retrying in ${waitTime}ms (attempt ${i + 1}/${retries})...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Failed to generate content after retries.");
}

function removeSolidBackground(width: number, height: number, rawBuffer: Buffer, threshold = 40): Buffer | null {
  const size = width * height;
  const visited = new Uint8Array(size);
  const mask = new Uint8Array(size);
  mask.fill(1);

  const getPixel = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    return {
      r: rawBuffer[idx],
      g: rawBuffer[idx + 1],
      b: rawBuffer[idx + 2],
      a: rawBuffer[idx + 3]
    };
  };

  const corners = [
    getPixel(0, 0),
    getPixel(width - 1, 0),
    getPixel(0, height - 1),
    getPixel(width - 1, height - 1)
  ];

  const bgR = Math.round(corners.reduce((sum, c) => sum + c.r, 0) / 4);
  const bgG = Math.round(corners.reduce((sum, c) => sum + c.g, 0) / 4);
  const bgB = Math.round(corners.reduce((sum, c) => sum + c.b, 0) / 4);

  const variance = corners.reduce((sum, c) => {
    return sum + Math.abs(c.r - bgR) + Math.abs(c.g - bgG) + Math.abs(c.b - bgB);
  }, 0) / 4;

  if (variance > 45) {
    console.log("[removeSolidBackground] Corner variance is too high, aborting solid background removal.");
    return null;
  }

  const queue: number[] = [];

  const enqueue = (x: number, y: number) => {
    const idx = y * width + x;
    if (visited[idx] === 0) {
      const p = getPixel(x, y);
      const diff = Math.abs(p.r - bgR) + Math.abs(p.g - bgG) + Math.abs(p.b - bgB);
      if (diff < threshold) {
        visited[idx] = 1;
        mask[idx] = 0;
        queue.push(idx);
      } else {
        visited[idx] = 2;
      }
    }
  };

  for (let x = 0; x < width; x++) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % width;
    const y = Math.floor(idx / width);

    const neighbors = [
      { x: x + 1, y },
      { x: x - 1, y },
      { x, y: y + 1 },
      { x, y: y - 1 }
    ];

    for (const n of neighbors) {
      if (n.x >= 0 && n.x < width && n.y >= 0 && n.y < height) {
        enqueue(n.x, n.y);
      }
    }
  }

  const outBuffer = Buffer.alloc(rawBuffer.length);
  for (let i = 0; i < size; i++) {
    const srcIdx = i * 4;
    outBuffer[srcIdx] = rawBuffer[srcIdx];
    outBuffer[srcIdx + 1] = rawBuffer[srcIdx + 1];
    outBuffer[srcIdx + 2] = rawBuffer[srcIdx + 2];
    outBuffer[srcIdx + 3] = mask[i] === 0 ? 0 : rawBuffer[srcIdx + 3];
  }

  return outBuffer;
}

async function shaveCutoutEdges(cutoutBuffer: Buffer, radius = 2.5): Promise<Buffer> {
  const sharpCutout = sharp(cutoutBuffer);
  const metadata = await sharpCutout.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (width === 0 || height === 0) return cutoutBuffer;

  const rawCutout = await sharpCutout
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rawData = rawCutout.data;
  const size = width * height;
  const mask = new Uint8Array(size);

  for (let i = 0; i < size; i++) {
    mask[i] = rawData[i * 4 + 3] > 128 ? 1 : 0;
  }

  const temp = new Uint8Array(mask);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (temp[idx] === 1) {
        let hasBgNeighbor = false;
        const rInt = Math.ceil(radius);
        for (let dy = -rInt; dy <= rInt; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) {
            hasBgNeighbor = true;
            break;
          }
          for (let dx = -rInt; dx <= rInt; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) {
              hasBgNeighbor = true;
              break;
            }
            if (dx * dx + dy * dy <= radius * radius) {
              if (temp[ny * width + nx] === 0) {
                hasBgNeighbor = true;
                break;
              }
            }
          }
          if (hasBgNeighbor) break;
        }
        if (hasBgNeighbor) {
          mask[idx] = 0;
        }
      }
    }
  }

  for (let i = 0; i < size; i++) {
    const srcIdx = i * 4;
    if (mask[i] === 0) {
      rawData[srcIdx + 3] = 0;
    }
  }

  return await sharp(rawData, {
    raw: {
      width,
      height,
      channels: 4
    }
  })
  .png()
  .toBuffer();
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const apiKey = (formData.get("apiKey") as string) || request.headers.get("x-gemini-api-key") || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Kein Google Gemini API-Key gefunden. Bitte trage deinen API-Key in den Einstellungen (Schlüssel-Symbol oben) oder in die .env.local ein." },
        { status: 400 }
      );
    }

    const ai = new GoogleGenAI({ apiKey });
    const file = formData.get("boosterImage") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No image file uploaded." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const originalImageBuffer = Buffer.from(arrayBuffer);

    const originalMetadata = await sharp(originalImageBuffer).metadata();
    const width = originalMetadata.width || 0;
    const height = originalMetadata.height || 0;

    if (width === 0 || height === 0) {
      return NextResponse.json({ error: "Failed to read image dimensions." }, { status: 400 });
    }

    let solidBgCutoutBuffer: Buffer | null = null;
    try {
      const rawImage = await sharp(originalImageBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      
      solidBgCutoutBuffer = removeSolidBackground(width, height, rawImage.data);
    } catch (bfsError: any) {
      console.warn("[Booster Crop API] Solid background BFS extraction failed:", bfsError.message);
      writeDebugLog(`Solid background BFS extraction failed: ${bfsError.message}`);
    }

    const base64Image = originalImageBuffer.toString("base64");
    
    const models = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"];
    let layoutText = "";
    let lastError;

    const describePrompt = `The dimensions of the uploaded image are ${width}x${height} pixels. The image contains a trading card game booster pack on a plain background (often white or light grey). Please identify:
1. "polygon": A list of vertices (x, y coordinates in absolute pixels) forming a closed polygon that tightly traces the outer boundary/silhouette of the booster pack packaging (excluding hanger holes, background shadows, or plain backgrounds) in the image.
   Rules for tracing booster pack boundary:
   - Identify the actual foil booster pack packaging. Ignore any shadows, table backgrounds, or hanger display rods.
   - The polygon MUST tightly outline ONLY the booster pack. Place the vertices exactly on the boundary where the foil packaging ends and the plain background begins.
   - Coordinates MUST be absolute integer values between 0 and the image dimensions (width: ${width}, height: ${height}).
2. "displayName": The name/title of the booster pack (usually printed on the front, e.g. "One Piece OP-05 Awakening of the New Era Booster Pack"). Detect and translate Japanese, Korean, Chinese, or non-English names to their official English equivalent. If not visible, return empty.
3. "displaySeries": The franchise or TCG series name (e.g., 'One Piece Card Game', 'Pokemon TCG', 'Yu-Gi-Oh').`;

    for (const model of models) {
      try {
        console.log(`[Booster Crop API] Trying model ${model}`);
        const layoutResponse = await generateContentWithRetry(ai, {
          model,
          contents: [
            {
              inlineData: {
                data: base64Image,
                mimeType: file.type || "image/png"
              }
            },
            describePrompt
          ],
          config: {
            systemInstruction: "You are an expert at analyzing product packaging layouts, particularly for collectible trading card game booster packs. Your task is to detect the booster pack boundary (excluding hanger holes, background shadows, or plain backgrounds) as an ordered list of polygon points, identify its English name, and identify its series. Return ONLY a JSON object matching the requested schema.",
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                polygon: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      x: { type: "integer", description: "Absolute X coordinate in pixels" },
                      y: { type: "integer", description: "Absolute Y coordinate in pixels" }
                    },
                    required: ["x", "y"]
                  },
                  description: "Ordered list of polygon vertices tracing the booster pack boundary"
                },
                displayName: {
                  type: "string",
                  description: "Detected name of the booster pack translated to English"
                },
                displaySeries: {
                  type: "string",
                  description: "Franchise/series of the booster pack"
                }
              },
              required: ["polygon", "displayName", "displaySeries"]
            }
          }
        });
        if (layoutResponse.text) {
          layoutText = layoutResponse.text;
          writeDebugLog(`Model ${model} successfully returned text: ${layoutText}`);
          break;
        } else {
          writeDebugLog(`Model ${model} returned empty layoutResponse.text.`);
        }
      } catch (e: any) {
        console.warn(`[Booster Crop API] Model ${model} failed: ${e.message}`);
        writeDebugLog(`Model ${model} threw error: ${e.message}. Stack: ${e.stack || ""}`);
        lastError = e;
        if (e.message?.toLowerCase().includes("safety") || e.message?.toLowerCase().includes("block")) {
          throw e;
        }
      }
    }

    let polygon: { x: number; y: number }[] = [];
    let displayName = "";
    let displaySeries = "";
    let usedFallback = false;

    if (layoutText) {
      try {
        const parsed = JSON.parse(layoutText);
        if (parsed.polygon && Array.isArray(parsed.polygon) && parsed.polygon.length >= 3) {
          polygon = parsed.polygon;
          displayName = parsed.displayName || "";
          displaySeries = parsed.displaySeries || "";
          console.log("[Booster Crop API] AI successfully detected layout:", parsed);
          writeDebugLog(`Parsed polygon vertices count: ${polygon.length}. Name: ${displayName}, Series: ${displaySeries}`);
        } else {
          throw new Error("Invalid or empty polygon returned by model.");
        }
      } catch (e: any) {
        console.warn(`[Booster Crop API] Failed to parse layout JSON: "${layoutText}". Error: ${e.message}`);
        writeDebugLog(`Failed to parse layout JSON: "${layoutText}". Error: ${e.message}`);
      }
    }

    if (polygon.length < 3) {
      console.warn("[Booster Crop API] Using backup/fallback layout detection.");
      writeDebugLog(`Polygon length is ${polygon.length}. Triggering backup/fallback layout detection!`);
      usedFallback = true;
      polygon = [
        { x: Math.round(width * 0.15), y: Math.round(height * 0.15) },
        { x: Math.round(width * 0.85), y: Math.round(height * 0.15) },
        { x: Math.round(width * 0.85), y: Math.round(height * 0.85) },
        { x: Math.round(width * 0.15), y: Math.round(height * 0.85) }
      ];
    }

    const clampedPolygon = polygon.map(p => ({
      x: Math.max(0, Math.min(Math.round(p.x), width - 1)),
      y: Math.max(0, Math.min(Math.round(p.y), height - 1))
    }));

    let cutout;
    if (solidBgCutoutBuffer) {
      cutout = await sharp(solidBgCutoutBuffer, {
        raw: {
          width,
          height,
          channels: 4
        }
      })
      .png()
      .toBuffer();
      
      console.log("[Booster Crop API] Solid background cutout successfully generated via BFS contour extraction.");
      writeDebugLog("Solid background cutout successfully generated via BFS contour extraction.");
    } else {
      const pointsString = clampedPolygon.map(p => `${p.x},${p.y}`).join(" ");
      const polygonMask = Buffer.from(
        `<svg width="${width}" height="${height}"><polygon points="${pointsString}" fill="white"/></svg>`
      );

      cutout = await sharp(originalImageBuffer)
        .composite([{
          input: polygonMask,
          blend: "dest-in"
        }])
        .png()
        .toBuffer();
    }
    
    try {
      cutout = await shaveCutoutEdges(cutout, 2.5);
      console.log("[Booster Crop API] Shaved 2.5px from cutout edges to remove pixelated white border.");
      writeDebugLog("Shaved 2.5px from cutout edges to remove pixelated white border.");
    } catch (shaveError: any) {
      console.warn("[Booster Crop API] Edge shaving failed:", shaveError.message);
      writeDebugLog(`Edge shaving failed: ${shaveError.message}`);
    }

    let finalCutoutBuffer = cutout;
    let finalWidth = width;
    let finalHeight = height;

    try {
      const trimmed = await sharp(cutout)
        .trim()
        .png()
        .toBuffer({ resolveWithObject: true });

      if (trimmed.info.width > 0 && trimmed.info.height > 0) {
        finalCutoutBuffer = trimmed.data;
        finalWidth = trimmed.info.width;
        finalHeight = trimmed.info.height;
        console.log(`[Booster Crop API] Trimmed transparent padding: ${width}x${height} -> ${finalWidth}x${finalHeight}`);
      }
    } catch (e: any) {
      console.warn("[Booster Crop API] Cutout trim failed, using untrimmed cutout:", e.message);
    }

    let targetResizeHeight = finalHeight;
    let targetResizeWidth = finalWidth;
    const maxDimension = 800;
    if (finalWidth > maxDimension || finalHeight > maxDimension) {
      if (finalWidth > finalHeight) {
        targetResizeWidth = maxDimension;
        targetResizeHeight = Math.round((finalHeight / finalWidth) * maxDimension);
      } else {
        targetResizeHeight = maxDimension;
        targetResizeWidth = Math.round((finalWidth / finalHeight) * maxDimension);
      }
    }

    const resizedCutoutBuffer = await sharp(finalCutoutBuffer)
      .resize(targetResizeWidth, targetResizeHeight)
      .png({ compressionLevel: 7 })
      .toBuffer();

    const cutoutBase64 = resizedCutoutBuffer.toString("base64");

    const styleRefBuffer = await sharp(resizedCutoutBuffer)
      .resize(512, 512, { fit: "inside" })
      .png()
      .toBuffer();

    const styleRefBase64 = styleRefBuffer.toString("base64");

    return NextResponse.json({
      cutoutImage: `data:image/png;base64,${cutoutBase64}`,
      croppedImage: `data:image/png;base64,${styleRefBase64}`,
      coords: clampedPolygon,
      usedFallback,
      displayName,
      displaySeries
    });

  } catch (error: any) {
    console.error("Error in Booster Crop API:", error);
    writeDebugLog(`CRITICAL ERROR in Booster Crop API: ${error.message}. Stack: ${error.stack || ""}`);
    return NextResponse.json({ error: error.message || "Internal server error during crop." }, { status: 500 });
  }
}
