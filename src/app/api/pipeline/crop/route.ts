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

    const base64Image = originalImageBuffer.toString("base64"); // Send original image to Gemini so it has full context of backgrounds
    
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
            `The dimensions of the uploaded trading card image are ${width}x${height} pixels. Please identify two bounding boxes in these exact pixel coordinates:
1. "card": Bounding box coordinates (x1, y1, x2, y2) of the entire card itself (excluding outer backgrounds/margins/holder cases).
2. "illustration": Bounding box coordinates (x1, y1, x2, y2) of the clean inner illustration/artwork area inside the card (excluding card frames, borders, text boxes, attribute symbols, play cost circles, and power numbers).`
          ],
          config: {
            systemInstruction: "You are an expert at analyzing trading card layouts (Pokémon, One Piece, Yu-Gi-Oh, MTG). Your task is to identify: 1) the bounding box of the entire card itself, and 2) a clean rectangular illustration area inside the card that is completely free of text and numbers. Return ONLY a JSON object containing 'card' and 'illustration' properties matching the requested schema.",
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                card: {
                  type: "object",
                  properties: {
                    x1: { type: "integer", description: "Top-left X coordinate of the card itself" },
                    y1: { type: "integer", description: "Top-left Y coordinate of the card itself" },
                    x2: { type: "integer", description: "Bottom-right X coordinate of the card itself" },
                    y2: { type: "integer", description: "Bottom-right Y coordinate of the card itself" }
                  },
                  required: ["x1", "y1", "x2", "y2"]
                },
                illustration: {
                  type: "object",
                  properties: {
                    x1: { type: "integer", description: "Top-left X coordinate of the clean illustration area" },
                    y1: { type: "integer", description: "Top-left Y coordinate of the clean illustration area" },
                    x2: { type: "integer", description: "Bottom-right X coordinate of the clean illustration area" },
                    y2: { type: "integer", description: "Bottom-right Y coordinate of the clean illustration area" }
                  },
                  required: ["x1", "y1", "x2", "y2"]
                }
              },
              required: ["card", "illustration"]
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

    let cardCoords;
    let illustrationCoords;
    let usedFallback = false;

    if (layoutText) {
      try {
        const parsed = JSON.parse(layoutText);
        if (parsed.card && parsed.illustration) {
          cardCoords = parsed.card;
          illustrationCoords = parsed.illustration;
          console.log("[Crop API] AI successfully detected layout:", parsed);
        } else {
          throw new Error("Missing card or illustration coordinates in model response.");
        }
      } catch (e: any) {
        console.warn(`[Crop API] Failed to parse layout JSON: "${layoutText}". Error: ${e.message}`);
      }
    }

    if (!cardCoords || !illustrationCoords) {
      console.warn("[Crop API] Using backup/fallback layout detection.");
      usedFallback = true;
      
      let tWidth = trimmedWidth;
      let tHeight = trimmedHeight;
      let cx1 = trimmedWidth === width ? 0 : (width - trimmedWidth) / 2; // approximation if trim was not used
      let cy1 = trimmedHeight === height ? 0 : (height - trimmedHeight) / 2;
      let cx2 = cx1 + trimmedWidth;
      let cy2 = cy1 + trimmedHeight;

      // Programmatic backup trim to refine card borders
      try {
        const trimmed = await sharp(originalImageBuffer)
          .trim()
          .toBuffer({ resolveWithObject: true });
        
        const offsetLeft = trimmed.info.trimOffsetLeft;
        const offsetTop = trimmed.info.trimOffsetTop;
        const trimW = trimmed.info.width || width;
        const trimH = trimmed.info.height || height;

        const tOffsetLeft = typeof offsetLeft === 'number' ? Math.max(0, offsetLeft) : 0;
        const tOffsetTop = typeof offsetTop === 'number' ? Math.max(0, offsetTop) : 0;

        if (trimW >= width * 0.4 && trimH >= height * 0.4) {
          cx1 = tOffsetLeft;
          cy1 = tOffsetTop;
          cx2 = cx1 + trimW;
          cy2 = cy1 + trimH;
          tWidth = trimW;
          tHeight = trimH;
        }
      } catch (trimError: any) {
        console.log("[Crop API Fallback] Programmatic card trim skipped:", trimError.message);
      }

      cardCoords = { x1: cx1, y1: cy1, x2: cx2, y2: cy2 };
      illustrationCoords = {
        x1: cx1 + Math.round(tWidth * 0.20),
        y1: cy1 + Math.round(tHeight * 0.22),
        x2: cx1 + Math.round(tWidth * 0.80),
        y2: cy1 + Math.round(tHeight * 0.58)
      };
    }

    // Clamp coordinates relative to original image size
    let cx1 = Math.max(0, Math.min(Math.round(cardCoords.x1), width - 1));
    let cy1 = Math.max(0, Math.min(Math.round(cardCoords.y1), height - 1));
    let cx2 = Math.max(cx1 + 1, Math.min(Math.round(cardCoords.x2), width));
    let cy2 = Math.max(cy1 + 1, Math.min(Math.round(cardCoords.y2), height));

    let ix1 = Math.max(cx1, Math.min(Math.round(illustrationCoords.x1), cx2 - 1));
    let iy1 = Math.max(cy1, Math.min(Math.round(illustrationCoords.y1), cy2 - 1));
    let ix2 = Math.max(ix1 + 1, Math.min(Math.round(illustrationCoords.x2), cx2));
    let iy2 = Math.max(iy1 + 1, Math.min(Math.round(illustrationCoords.y2), cy2));

    let cardWidth = cx2 - cx1;
    let cardHeight = cy2 - cy1;
    let cropWidth = ix2 - ix1;
    let cropHeight = iy2 - iy1;

    // Validate illustration crop boundaries
    if (cropWidth < 10 || cropHeight < 10) {
      console.warn("[Crop API] Crop area too small. Resetting to fallback.");
      ix1 = cx1 + Math.round(cardWidth * 0.20);
      iy1 = cy1 + Math.round(cardHeight * 0.22);
      ix2 = cx1 + Math.round(cardWidth * 0.80);
      iy2 = cx1 + Math.round(cardHeight * 0.58);
      cropWidth = ix2 - ix1;
      cropHeight = iy2 - iy1;
    }

    // Crop the clean card itself
    const cardBuffer = await sharp(originalImageBuffer)
      .extract({ left: cx1, top: cy1, width: cardWidth, height: cardHeight })
      .png()
      .toBuffer();

    // Round the corners of the card
    const cornerRadius = Math.round(cardWidth * 0.035); // 3.5% corner radius for trading cards
    const roundedCornersMask = Buffer.from(
      `<svg width="${cardWidth}" height="${cardHeight}"><rect x="0" y="0" width="${cardWidth}" height="${cardHeight}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/></svg>`
    );

    const roundedCardBuffer = await sharp(cardBuffer)
      .composite([{
        input: roundedCornersMask,
        blend: 'dest-in'
      }])
      .png()
      .toBuffer();

    const trimmedCardBase64 = roundedCardBuffer.toString("base64");

    // Crop the inner illustration (for outpainting input)
    const croppedBuffer = await sharp(originalImageBuffer)
      .extract({ left: ix1, top: iy1, width: cropWidth, height: cropHeight })
      .png()
      .toBuffer();

    const croppedBase64 = croppedBuffer.toString("base64");

    return NextResponse.json({
      croppedImage: `data:image/png;base64,${croppedBase64}`,
      trimmedCard: `data:image/png;base64,${trimmedCardBase64}`,
      coords: { ix1, iy1, ix2, iy2 },
      usedFallback
    });

  } catch (error: any) {
    console.error("Error in Crop API:", error);
    return NextResponse.json({ error: error.message || "Internal server error during crop." }, { status: 500 });
  }
}
