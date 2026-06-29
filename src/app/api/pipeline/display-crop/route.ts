import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

export const dynamic = "force-dynamic";
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
          break;
        }
      } catch (e: any) {
        console.warn(`[Display Crop API] Model ${model} failed: ${e.message}`);
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
        } else {
          throw new Error("Invalid or empty polygon returned by model.");
        }
      } catch (e: any) {
        console.warn(`[Display Crop API] Failed to parse layout JSON: "${layoutText}". Error: ${e.message}`);
      }
    }

    if (polygon.length < 3) {
      console.warn("[Display Crop API] Using backup/fallback layout detection.");
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

    // Create SVG Mask for the polygon
    const pointsString = clampedPolygon.map(p => `${p.x},${p.y}`).join(" ");
    const polygonMask = Buffer.from(
      `<svg width="${width}" height="${height}"><polygon points="${pointsString}" fill="white"/></svg>`
    );

    // Apply the polygon mask to make background transparent
    const cutout = await sharp(originalImageBuffer)
      .composite([{
        input: polygonMask,
        blend: "dest-in"
      }])
      .png()
      .toBuffer();

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

    const cutoutBase64 = resizedCutoutBuffer.toString("base64");

    // Crop style reference image (max 512px inside)
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
    console.error("Error in Display Crop API:", error);
    return NextResponse.json({ error: error.message || "Internal server error during crop." }, { status: 500 });
  }
}
