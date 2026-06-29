import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

function writeDebugLog(message: string) {
  try {
    const logPath = path.join(process.cwd(), "public", "display_crop_debug.log");
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch (err) {
    console.error("Failed to write debug log:", err);
  }
}
export const preferredRegion = "iad1"; // Force US-East server

// Helper to call generateContent with retry on transient errors (503, 429)
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
  const visited = new Uint8Array(size); // 0 = unvisited, 1 = background, 2 = border/visited
  const mask = new Uint8Array(size);
  mask.fill(1); // 1 = keep, 0 = remove

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

  // Average corner colors to find bg reference
  const bgR = Math.round(corners.reduce((sum, c) => sum + c.r, 0) / 4);
  const bgG = Math.round(corners.reduce((sum, c) => sum + c.g, 0) / 4);
  const bgB = Math.round(corners.reduce((sum, c) => sum + c.b, 0) / 4);

  // If the background is not solid (e.g. corners have high variance), we should abort and use AI
  const variance = corners.reduce((sum, c) => {
    return sum + Math.abs(c.r - bgR) + Math.abs(c.g - bgG) + Math.abs(c.b - bgB);
  }, 0) / 4;

  if (variance > 45) {
    console.log("[removeSolidBackground] Corner variance is too high, aborting solid background removal.");
    return null;
  }

  // BFS Queue
  const queue: number[] = [];

  const enqueue = (x: number, y: number) => {
    const idx = y * width + x;
    if (visited[idx] === 0) {
      const p = getPixel(x, y);
      const diff = Math.abs(p.r - bgR) + Math.abs(p.g - bgG) + Math.abs(p.b - bgB);
      if (diff < threshold) {
        visited[idx] = 1; // background
        mask[idx] = 0;    // remove
        queue.push(idx);
      } else {
        visited[idx] = 2; // visited but foreground
      }
    }
  };

  // Enqueue all boundary pixels
  for (let x = 0; x < width; x++) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  // BFS loop
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

  // Create new RGBA buffer with updated alpha channel
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

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY is not configured. Please add it to your environment variables." },
        { status: 500 }
      );
    }

    const ai = new GoogleGenAI({ apiKey });
    const formData = await request.formData();
    const file = formData.get("displayImage") as File | null;
    const borderWidth = Number(formData.get("borderWidth") || "0");
    const borderColorHex = String(formData.get("borderColor") || "#ffffff");

    const hexToRgb = (hex: string) => {
      const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
      return match ? {
        r: parseInt(match[1], 16),
        g: parseInt(match[2], 16),
        b: parseInt(match[3], 16)
      } : { r: 255, g: 255, b: 255 };
    };
    const borderColor = hexToRgb(borderColorHex);

    if (!file) {
      return NextResponse.json({ error: "No image file uploaded." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const originalImageBuffer = Buffer.from(arrayBuffer);

    // Get original image metadata
    const originalMetadata = await sharp(originalImageBuffer).metadata();
    const width = originalMetadata.width || 0;
    const height = originalMetadata.height || 0;

    if (width === 0 || height === 0) {
      return NextResponse.json({ error: "Failed to read image dimensions." }, { status: 400 });
    }

    // Try to remove solid background using BFS contour extraction
    let solidBgCutoutBuffer: Buffer | null = null;
    try {
      const rawImage = await sharp(originalImageBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      
      solidBgCutoutBuffer = removeSolidBackground(width, height, rawImage.data);
    } catch (bfsError: any) {
      console.warn("[Display Crop API] Solid background BFS extraction failed:", bfsError.message);
      writeDebugLog(`Solid background BFS extraction failed: ${bfsError.message}`);
    }

    const base64Image = originalImageBuffer.toString("base64");
    
    // Fallback list of modern active Gemini models
    const models = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"];
    let layoutText = "";
    let lastError;

    const describePrompt = `The dimensions of the uploaded image are ${width}x${height} pixels. The image contains a display box on a plain background (often white or light grey). Please identify:
1. "polygon": A list of vertices (x, y coordinates in absolute pixels) forming a closed polygon that tightly traces the outer boundary/silhouette of the collectible display box (like a booster box, trainer box, or deck box) in the image.
   Rules for tracing display boundary:
   - Identify the actual printed packaging box. Ignore any shadows, table backgrounds, scanner borders, hands, or surrounding background scenery.
   - The polygon MUST tightly outline ONLY the printed display box. Place the vertices exactly on the boundary where the printed box artwork ends and the plain background (e.g. the white background) begins.
   - Do NOT include any part of the plain background (e.g., the white space) inside the polygon. If the box is dark and has a high-contrast transition to a white background, be extremely careful not to let the polygon bleed into the white background.
   - Only trace faces that are actually visible and part of the printed box. Do NOT assume there are additional faces or construct a symmetric hexagon if a side face is not visible or if the box ends earlier.
   - Coordinates MUST be absolute integer values between 0 and the image dimensions (width: ${width}, height: ${height}).
2. "displayName": The name/title of the display box (usually printed on the front, e.g. "One Piece OP-16 Booster Box"). Detect and translate Japanese, Korean, Chinese, or non-English names to their official English equivalent (e.g. translate '결전의 각' or '决战之刻' to 'Decisive Battle' or OP-16 equivalent). If not visible, return empty.
3. "displaySeries": The franchise or game series name (e.g., 'One Piece Card Game', 'Pokemon TCG', 'Yu-Gi-Oh').`;

    for (const model of models) {
      try {
        console.log(`[Display Crop API] Trying model ${model}`);
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
            systemInstruction: "You are an expert at analyzing product packaging layouts, particularly for collectible trading card game display boxes (booster boxes, trainer boxes). Your task is to detect the display box boundary as an ordered list of polygon points, identify its English name, and identify its series. Return ONLY a JSON object matching the requested schema.",
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
                  description: "Ordered list of polygon vertices tracing the display box boundary"
                },
                displayName: {
                  type: "string",
                  description: "Detected name of the display box translated to English"
                },
                displaySeries: {
                  type: "string",
                  description: "Franchise/series of the display box"
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
        console.warn(`[Display Crop API] Model ${model} failed: ${e.message}`);
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
          console.log("[Display Crop API] AI successfully detected layout:", parsed);
          writeDebugLog(`Parsed polygon vertices count: ${polygon.length}. Name: ${displayName}, Series: ${displaySeries}`);
        } else {
          throw new Error("Invalid or empty polygon returned by model.");
        }
      } catch (e: any) {
        console.warn(`[Display Crop API] Failed to parse layout JSON: "${layoutText}". Error: ${e.message}`);
        writeDebugLog(`Failed to parse layout JSON: "${layoutText}". Error: ${e.message}`);
      }
    }

    if (polygon.length < 3) {
      console.warn("[Display Crop API] Using backup/fallback layout detection.");
      writeDebugLog(`Polygon length is ${polygon.length}. Triggering backup/fallback layout detection!`);
      usedFallback = true;
      // Fallback polygon: A simple centered rectangle (70% of dimensions)
      polygon = [
        { x: Math.round(width * 0.15), y: Math.round(height * 0.15) },
        { x: Math.round(width * 0.85), y: Math.round(height * 0.15) },
        { x: Math.round(width * 0.85), y: Math.round(height * 0.85) },
        { x: Math.round(width * 0.15), y: Math.round(height * 0.85) }
      ];
    }

    // Clamp coordinates relative to original image size
    const clampedPolygon = polygon.map(p => ({
      x: Math.max(0, Math.min(Math.round(p.x), width - 1)),
      y: Math.max(0, Math.min(Math.round(p.y), height - 1))
    }));

    // Apply either BFS solid background cutout or polygon mask
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
      
      console.log("[Display Crop API] Solid background cutout successfully generated via BFS contour extraction.");
      writeDebugLog("Solid background cutout successfully generated via BFS contour extraction.");
    } else {
      // Create SVG Mask for the polygon
      const pointsString = clampedPolygon.map(p => `${p.x},${p.y}`).join(" ");
      const polygonMask = Buffer.from(
        `<svg width="${width}" height="${height}"><polygon points="${pointsString}" fill="white"/></svg>`
      );

      // Apply the polygon mask to make background transparent
      cutout = await sharp(originalImageBuffer)
        .composite([{
          input: polygonMask,
          blend: "dest-in"
        }])
        .png()
        .toBuffer();
    }

    // Auto-trim transparent borders
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
        console.log(`[Display Crop API] Trimmed transparent padding: ${width}x${height} -> ${finalWidth}x${finalHeight}`);
      }
    } catch (e: any) {
      console.warn("[Display Crop API] Cutout trim failed, using untrimmed cutout:", e.message);
    }

    // Resize the cutout to a reasonable maximum height/width (800px) for performance
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

    let borderedCutoutBuffer = resizedCutoutBuffer;
    if (borderWidth > 0) {
      try {
        console.log(`[Display Crop API] Applying outline border: ${borderWidth}px, color: rgb(${borderColor.r}, ${borderColor.g}, ${borderColor.b})`);
        writeDebugLog(`Applying outline border: ${borderWidth}px, color: rgb(${borderColor.r}, ${borderColor.g}, ${borderColor.b})`);
        
        const pad = borderWidth + 2;
        const paddedImage = await sharp(resizedCutoutBuffer)
          .ensureAlpha()
          .extend({
            top: pad,
            bottom: pad,
            left: pad,
            right: pad,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .raw()
          .toBuffer({ resolveWithObject: true });
        
        const pWidth = paddedImage.info.width;
        const pHeight = paddedImage.info.height;
        const pBuffer = paddedImage.data;

        // Extract alpha channel directly from raw pixel buffer
        const alphaImage = new Uint8Array(pWidth * pHeight);
        for (let i = 0; i < pWidth * pHeight; i++) {
          alphaImage[i] = pBuffer[i * 4 + 3];
        }

        const dilatedAlpha = new Uint8Array(pWidth * pHeight);
        
        // Fast 2D dilation
        for (let y = 0; y < pHeight; y++) {
          for (let x = 0; x < pWidth; x++) {
            const idx = y * pWidth + x;
            if (alphaImage[idx] > 20) {
              dilatedAlpha[idx] = 255;
              continue;
            }
            
            // Check neighbors within distance W
            let isNearForeground = false;
            for (let dy = -borderWidth; dy <= borderWidth; dy++) {
              for (let dx = -borderWidth; dx <= borderWidth; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < pWidth && ny >= 0 && ny < pHeight) {
                  const nidx = ny * pWidth + nx;
                  if (alphaImage[nidx] > 20) {
                    isNearForeground = true;
                    break;
                  }
                }
              }
              if (isNearForeground) break;
            }
            
            if (isNearForeground) {
              dilatedAlpha[idx] = 255;
            }
          }
        }

        // Morphological erosion to shrink the foreground mask by 1.5 pixels,
        // which removes white background pixels clinging to the display edge.
        const erodedAlpha = new Uint8Array(pWidth * pHeight);
        const erosionRadius = 1.5;
        const rInt = Math.ceil(erosionRadius);

        for (let y = 0; y < pHeight; y++) {
          for (let x = 0; x < pWidth; x++) {
            const idx = y * pWidth + x;
            if (alphaImage[idx] <= 20) {
              erodedAlpha[idx] = 0;
              continue;
            }

            let isNearBackground = false;
            for (let dy = -rInt; dy <= rInt; dy++) {
              for (let dx = -rInt; dx <= rInt; dx++) {
                if (dx * dx + dy * dy > erosionRadius * erosionRadius) continue;
                
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < pWidth && ny >= 0 && ny < pHeight) {
                  const nidx = ny * pWidth + nx;
                  if (alphaImage[nidx] <= 20) {
                    isNearBackground = true;
                    break;
                  }
                } else {
                  isNearBackground = true;
                  break;
                }
              }
              if (isNearBackground) break;
            }

            erodedAlpha[idx] = isNearBackground ? 0 : 255;
          }
        }

        // Smooth both masks (dilated and eroded) with high-quality Gaussian blur for anti-aliasing
        const smoothDilatedAlpha = await sharp(Buffer.from(dilatedAlpha), {
          raw: {
            width: pWidth,
            height: pHeight,
            channels: 1
          }
        })
        .blur(0.8)
        .raw()
        .toBuffer();

        const smoothErodedAlpha = await sharp(Buffer.from(erodedAlpha), {
          raw: {
            width: pWidth,
            height: pHeight,
            channels: 1
          }
        })
        .blur(0.6)
        .raw()
        .toBuffer();

        // Mathematically composite layers with precise alpha blending in raw pixel buffer
        const borderedLayer = Buffer.alloc(pWidth * pHeight * 4);
        for (let i = 0; i < pWidth * pHeight; i++) {
          const idx = i * 4;
          const fgAlpha = (smoothErodedAlpha[i] / 255) * (pBuffer[idx + 3] / 255);
          
          if (fgAlpha >= 0.99) {
            borderedLayer[idx] = pBuffer[idx];
            borderedLayer[idx + 1] = pBuffer[idx + 1];
            borderedLayer[idx + 2] = pBuffer[idx + 2];
            borderedLayer[idx + 3] = pBuffer[idx + 3];
          } else if (fgAlpha <= 0.01) {
            borderedLayer[idx] = borderColor.r;
            borderedLayer[idx + 1] = borderColor.g;
            borderedLayer[idx + 2] = borderColor.b;
            borderedLayer[idx + 3] = smoothDilatedAlpha[i];
          } else {
            const bgAlpha = (smoothDilatedAlpha[i] / 255) * (1 - fgAlpha);
            const outAlpha = fgAlpha + bgAlpha;
            
            if (outAlpha > 0) {
              borderedLayer[idx] = Math.round((pBuffer[idx] * fgAlpha + borderColor.r * bgAlpha) / outAlpha);
              borderedLayer[idx + 1] = Math.round((pBuffer[idx + 1] * fgAlpha + borderColor.g * bgAlpha) / outAlpha);
              borderedLayer[idx + 2] = Math.round((pBuffer[idx + 2] * fgAlpha + borderColor.b * bgAlpha) / outAlpha);
              borderedLayer[idx + 3] = Math.round(outAlpha * 255);
            } else {
              borderedLayer[idx + 3] = 0;
            }
          }
        }

        const bordered = await sharp(borderedLayer, {
          raw: {
            width: pWidth,
            height: pHeight,
            channels: 4
          }
        })
        .png()
        .toBuffer();

        // Trim transparency to fit tightly
        const trimmedBordered = await sharp(bordered)
          .trim()
          .png()
          .toBuffer();

        borderedCutoutBuffer = trimmedBordered;
      } catch (borderErr: any) {
        console.warn("[Display Crop API] Failed to apply outline border:", borderErr.message);
        writeDebugLog(`Failed to apply outline border: ${borderErr.message}`);
      }
    }

    const cutoutBase64 = borderedCutoutBuffer.toString("base64");

    // Crop style reference image (max 512px inside) using the clean bordered cutout
    const styleRefBuffer = await sharp(borderedCutoutBuffer)
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
    console.error("Error in Display Crop API:", error);
    writeDebugLog(`CRITICAL ERROR in Display Crop API: ${error.message}. Stack: ${error.stack || ""}`);
    return NextResponse.json({ error: error.message || "Internal server error during crop." }, { status: 500 });
  }
}
