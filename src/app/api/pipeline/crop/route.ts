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
    const file = formData.get("cardImage") as File | null;

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

    // Try to auto-trim uniform borders (like white/black margins) from the card image
    let trimmedBuffer: any = originalImageBuffer;
    let trimmedWidth = width;
    let trimmedHeight = height;

    try {
      // sharp().trim() will trim pixels matching the top-left pixel color.
      const trimmed = await sharp(originalImageBuffer)
        .trim()
        .toBuffer({ resolveWithObject: true });
      
      const tWidth = trimmed.info.width || width;
      const tHeight = trimmed.info.height || height;
      
      // Safety check: only use trimmed image if it's at least 40% of the original dimensions
      if (tWidth >= width * 0.4 && tHeight >= height * 0.4) {
        trimmedBuffer = trimmed.data;
        trimmedWidth = tWidth;
        trimmedHeight = tHeight;
        console.log(`[Crop API] Auto-trimmed borders: ${width}x${height} -> ${trimmedWidth}x${trimmedHeight}`);
      } else {
        console.log(`[Crop API] Trim rejected (too small): ${tWidth}x${tHeight}`);
      }
    } catch (trimError: any) {
      console.log("[Crop API] Auto-trim borders skipped or failed:", trimError.message);
    }

    const base64Image = trimmedBuffer.toString("base64");
    
    // Fallback list of modern active Gemini models
    const models = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"];
    let layoutText = "";
    let lastError;

    for (const model of models) {
      try {
        console.log(`[Crop API] Trying model ${model}`);
        const layoutResponse = await generateContentWithRetry(ai, {
          model,
          contents: [
            {
              inlineData: {
                data: base64Image,
                mimeType: file.type || "image/png"
              }
            },
            `The dimensions of the trading card image are ${trimmedWidth}x${trimmedHeight} pixels. Please identify the bounding box coordinates (x1, y1, x2, y2) of the clean illustration area in these exact pixel coordinates.`
          ],
          config: {
            systemInstruction: "You are an expert at analyzing trading card layouts (Pokémon, One Piece, Yu-Gi-Oh, MTG). Your task is to identify a clean, rectangular bounding box of the card's illustration. You MUST exclude: 1) the outer borders/frames, 2) play cost circles/symbols (typically top-left), 3) power values/text (typically top-right), and 4) character name bars/text boxes (typically bottom or middle). Return ONLY a JSON object containing x1, y1, x2, y2 coordinates of a completely clean sample of the artwork.",
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                x1: { type: "integer", description: "Top-left X coordinate in pixels" },
                y1: { type: "integer", description: "Top-left Y coordinate in pixels" },
                x2: { type: "integer", description: "Bottom-right X coordinate in pixels" },
                y2: { type: "integer", description: "Bottom-right Y coordinate in pixels" }
              },
              required: ["x1", "y1", "x2", "y2"]
            }
          }
        });
        if (layoutResponse.text) {
          layoutText = layoutResponse.text;
          break;
        }
      } catch (e: any) {
        console.warn(`[Crop API] Model ${model} failed: ${e.message}`);
        lastError = e;
        // If it's a safety block or validation/schema structure issue, stop and throw immediately
        if (e.message?.toLowerCase().includes("safety") || e.message?.toLowerCase().includes("block")) {
          throw e;
        }
      }
    }

    let coords;
    let usedFallback = false;

    if (!layoutText) {
      console.warn("[Crop API] Failed to analyze layout with all Gemini models. Using default crop fallback.");
      usedFallback = true;
      coords = {
        x1: Math.round(trimmedWidth * 0.20),
        y1: Math.round(trimmedHeight * 0.22),
        x2: Math.round(trimmedWidth * 0.80),
        y2: Math.round(trimmedHeight * 0.58)
      };
    } else {
      try {
        coords = JSON.parse(layoutText);
      } catch (e) {
        console.warn(`[Crop API] Failed to parse layout JSON: "${layoutText}". Using default crop fallback.`);
        usedFallback = true;
        coords = {
          x1: Math.round(trimmedWidth * 0.20),
          y1: Math.round(trimmedHeight * 0.22),
          x2: Math.round(trimmedWidth * 0.80),
          y2: Math.round(trimmedHeight * 0.58)
        };
      }
    }

    let { x1, y1, x2, y2 } = coords;
    x1 = Math.max(0, Math.min(x1, trimmedWidth - 1));
    y1 = Math.max(0, Math.min(y1, trimmedHeight - 1));
    x2 = Math.max(x1 + 1, Math.min(x2, trimmedWidth));
    y2 = Math.max(y1 + 1, Math.min(y2, trimmedHeight));

    let cropWidth = x2 - x1;
    let cropHeight = y2 - y1;

    // Validate crop boundaries
    if (cropWidth < 10 || cropHeight < 10) {
      console.warn(`[Crop API] Crop area ${cropWidth}x${cropHeight} is too small. Using default crop fallback.`);
      usedFallback = true;
      x1 = Math.round(trimmedWidth * 0.20);
      y1 = Math.round(trimmedHeight * 0.22);
      x2 = Math.round(trimmedWidth * 0.80);
      y2 = Math.round(trimmedHeight * 0.58);
      cropWidth = x2 - x1;
      cropHeight = y2 - y1;
    }

    const croppedBuffer = await sharp(trimmedBuffer)
      .extract({ left: x1, top: y1, width: cropWidth, height: cropHeight })
      .png()
      .toBuffer();

    const croppedBase64 = croppedBuffer.toString("base64");

    return NextResponse.json({
      croppedImage: `data:image/png;base64,${croppedBase64}`,
      coords: { x1, y1, x2, y2 },
      usedFallback
    });

  } catch (error: any) {
    console.error("Error in Crop API:", error);
    return NextResponse.json({ error: error.message || "Internal server error during crop." }, { status: 500 });
  }
}
