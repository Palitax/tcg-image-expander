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
    const skipCardCrop = formData.get("skipCardCrop") === "true";

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
            `The dimensions of the uploaded image are ${width}x${height} pixels. Please identify:
1. "card": Bounding box coordinates (x1, y1, x2, y2) of the physical trading card itself.
   Rules for locating the card bounds:
   - Identify the actual card frame or borders (which contain name text, rarity codes, cost symbols, copyright).
   - Ignore any external mount boards, white sheets/margins, card sleeves, holder cases, scanner borders, or background scenery.
   - For full-art, borderless, or extended-art cards: the artwork might overflow/bleed beyond the card borders, or characters (like hands, weapons, or effects) might protrude out. Do NOT extend the card bounding box to include outer background decorations. Focus on the core card layout itself.
   - Trading cards are strictly vertical rectangles with an aspect ratio of approximately 2.5:3.5 (width-to-height ratio of ~0.71). Ensure the detected bounding box matches this shape, avoiding square or wide/tall distortions.
2. "illustration": Bounding box coordinates (x1, y1, x2, y2) of the clean inner illustration/artwork area inside the card.
   Rules for illustration:
   - Locate the main artwork area. Differentiate it from bottom gameplay rules text, character banners, and borders.
3. "hasSampleWatermark": Set to true if the card has a "SAMPLE" text watermark overlaid on it, otherwise false.
4. "isCleanCardImage": Set to true if the uploaded image contains ONLY the physical trading card itself, with NO outer mounting boards, cases, white margins, or background scenery surrounding it (the card edges extend all the way to the boundary of the image). Otherwise false.`
          ],
          config: {
            systemInstruction: "You are an expert at analyzing trading card layouts (Pokémon, One Piece, Yu-Gi-Oh, MTG). Your task is to identify: 1) the precise bounding box of the physical trading card, 2) a clean rectangular illustration area inside the card, 3) whether a 'SAMPLE' watermark exists, and 4) whether the uploaded image contains ONLY the card itself with no margins or backgrounds (isCleanCardImage). Return ONLY a JSON object matching the requested schema.",
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
                },
                hasSampleWatermark: {
                  type: "boolean",
                  description: "True if the large text watermark 'SAMPLE' is overlaid on the card illustration/layout, false otherwise"
                },
                isCleanCardImage: {
                  type: "boolean",
                  description: "True if the uploaded image contains only the physical trading card itself with no outer backing, case, mount, white space, or table backgrounds. False otherwise."
                }
              },
              required: ["card", "illustration", "hasSampleWatermark", "isCleanCardImage"]
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
    let hasSampleWatermark = false;
    let isCleanCardImage = false;
    let usedFallback = false;

    if (layoutText) {
      try {
        const parsed = JSON.parse(layoutText);
        if (parsed.card && parsed.illustration) {
          cardCoords = parsed.card;
          illustrationCoords = parsed.illustration;
          hasSampleWatermark = !!parsed.hasSampleWatermark;
          isCleanCardImage = !!parsed.isCleanCardImage;
          console.log("[Crop API] AI successfully detected layout:", parsed);
        } else {
          throw new Error("Missing card or illustration coordinates in model response.");
        }
      } catch (e: any) {
        console.warn(`[Crop API] Failed to parse layout JSON: "${layoutText}". Error: ${e.message}`);
      }
    }

    if (skipCardCrop || isCleanCardImage) {
      console.log(`[Crop API] Using full image dimensions for card coordinates (skipCardCrop: ${skipCardCrop}, isCleanCardImage: ${isCleanCardImage}).`);
      cardCoords = { x1: 0, y1: 0, x2: width, y2: height };
      // If we don't have illustration coords yet, calculate a safe default illustration area (e.g. 70% centered box)
      if (!illustrationCoords) {
        illustrationCoords = {
          x1: Math.round(width * 0.15),
          y1: Math.round(height * 0.18),
          x2: Math.round(width * 0.85),
          y2: Math.round(height * 0.58)
        };
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

    let workingImageBuffer: any = originalImageBuffer;

    if (hasSampleWatermark) {
      console.log("[Crop API] Watermark 'SAMPLE' detected. Attempting to remove it...");
      try {
        const imageModels = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"];
        let cleanedBase64 = "";
        let lastCleanError;

        // Determine best aspect ratio for editing
        let editAspectRatio = "3:4";
        const ratio = width / height;
        if (Math.abs(ratio - 1) < 0.15) {
          editAspectRatio = "1:1";
        } else if (Math.abs(ratio - (3/4)) < 0.15) {
          editAspectRatio = "3:4";
        } else if (Math.abs(ratio - (4/3)) < 0.15) {
          editAspectRatio = "4:3";
        } else if (Math.abs(ratio - (9/16)) < 0.15) {
          editAspectRatio = "9:16";
        } else if (Math.abs(ratio - (16/9)) < 0.15) {
          editAspectRatio = "16:9";
        }

        for (const modelName of imageModels) {
          try {
            console.log(`[Crop API] Clean watermark using ${modelName}`);
            const cleanResponse = await generateContentWithRetry(ai, {
              model: modelName,
              contents: [
                {
                  inlineData: {
                    data: base64Image,
                    mimeType: file.type || "image/png"
                  }
                },
                "Please remove the large diagonal semi-transparent 'SAMPLE' watermark text from this card. Ensure that the card artwork, text, border, and numbers underneath are clean, fully visible, and seamlessly restored, with no watermark remaining."
              ],
              config: {
                responseModalities: ["IMAGE"],
                imageConfig: {
                  aspectRatio: editAspectRatio
                }
              }
            });

            const parts = cleanResponse.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                cleanedBase64 = part.inlineData.data;
                break;
              }
            }

            if (cleanedBase64) {
              const cleanedBuf = Buffer.from(cleanedBase64, "base64");
              // Resize back to original image dimensions to maintain coordinate alignment
              workingImageBuffer = await sharp(cleanedBuf)
                .resize(width, height)
                .toBuffer();
              console.log(`[Crop API] Successfully removed watermark and resized back to original size (${width}x${height}) using ${modelName}`);
              break;
            }
          } catch (e: any) {
            console.warn(`[Crop API] Watermark removal failed with ${modelName}:`, e.message);
            lastCleanError = e;
          }
        }

        if (!cleanedBase64 && lastCleanError) {
          console.warn("[Crop API] Watermark removal failed for all models. Falling back to original image.");
        }
      } catch (cleanError: any) {
        console.warn("[Crop API] Error during watermark cleaning block:", cleanError.message);
      }
    }

    // Enforce standard trading card aspect ratio (~0.715) on detected card coordinates
    // Only apply if we are NOT skipping card crop and NOT using the full clean card image
    if (!skipCardCrop && !isCleanCardImage) {
      const TARGET_RATIO = 0.715;
      const cardW = cardCoords.x2 - cardCoords.x1;
      const cardH = cardCoords.y2 - cardCoords.y1;
      if (cardW > 0 && cardH > 0) {
        const currentRatio = cardW / cardH;
        const centerX = (cardCoords.x1 + cardCoords.x2) / 2;
        const centerY = (cardCoords.y1 + cardCoords.y2) / 2;

        // Adjust dimensions to match TARGET_RATIO of 0.715
        if (currentRatio > TARGET_RATIO) {
          // Too wide (contains white space on sides) - shrink width centered
          const newW = cardH * TARGET_RATIO;
          cardCoords.x1 = centerX - newW / 2;
          cardCoords.x2 = centerX + newW / 2;
          console.log(`[Crop API] Adjusted card width to match 0.715 aspect ratio: ${cardW.toFixed(1)} -> ${newW.toFixed(1)}`);
        } else if (currentRatio < TARGET_RATIO) {
          // Too tall/narrow - shrink height centered
          const newH = cardW / TARGET_RATIO;
          cardCoords.y1 = centerY - newH / 2;
          cardCoords.y2 = centerY + newH / 2;
          console.log(`[Crop API] Adjusted card height to match 0.715 aspect ratio: ${cardH.toFixed(1)} -> ${newH.toFixed(1)}`);
        }
      }
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

    // Crop the card itself, downscaling it to a reasonable maximum height (800px) for performance
    let cardResizeHeight = Math.min(800, cardHeight);
    let cardResizeWidth = Math.round((cardWidth / cardHeight) * cardResizeHeight);

    const cardBuffer = await sharp(workingImageBuffer)
      .extract({ left: cx1, top: cy1, width: cardWidth, height: cardHeight })
      .resize(cardResizeWidth, cardResizeHeight)
      .png({ compressionLevel: 7 })
      .toBuffer();

    // Round the corners of the card using SVG mask
    const cornerRadius = Math.round(cardResizeWidth * 0.035); // 3.5% corner radius for trading cards
    const roundedCornersMask = Buffer.from(
      `<svg width="${cardResizeWidth}" height="${cardResizeHeight}"><rect x="0" y="0" width="${cardResizeWidth}" height="${cardResizeHeight}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/></svg>`
    );

    const roundedCardBuffer = await sharp(cardBuffer)
      .composite([{
        input: roundedCornersMask,
        blend: 'dest-in'
      }])
      .webp({ quality: 85 })
      .toBuffer();

    const trimmedCardBase64 = roundedCardBuffer.toString("base64");

    // Crop the inner illustration (for outpainting input), resizing to max 512px and compressing as JPEG
    const croppedBuffer = await sharp(workingImageBuffer)
      .extract({ left: ix1, top: iy1, width: cropWidth, height: cropHeight })
      .resize(512, 512, { fit: "inside" })
      .jpeg({ quality: 85 })
      .toBuffer();

    const croppedBase64 = croppedBuffer.toString("base64");

    return NextResponse.json({
      croppedImage: `data:image/png;base64,${croppedBase64}`,
      trimmedCard: `data:image/webp;base64,${trimmedCardBase64}`,
      coords: { ix1, iy1, ix2, iy2 },
      usedFallback
    });

  } catch (error: any) {
    console.error("Error in Crop API:", error);
    return NextResponse.json({ error: error.message || "Internal server error during crop." }, { status: 500 });
  }
}
