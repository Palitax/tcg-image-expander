import { NextResponse } from "next/server";
import sharp from "sharp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

    const file = formData.get("cardImage") as File | null;
    const skipCardCrop = formData.get("skipCardCrop") === "true";

    if (!file) {
      return NextResponse.json({ error: "No image file uploaded." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const rawImageBuffer = Buffer.from(arrayBuffer);

    // Normalize orientation with .rotate() to eliminate any EXIF orientation discrepancies
    const originalImageBuffer = await sharp(rawImageBuffer)
      .rotate()
      .toBuffer();

    // Get normalized image metadata
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
      const trimmed = await sharp(originalImageBuffer)
        .trim()
        .toBuffer({ resolveWithObject: true });
      
      const tWidth = trimmed.info.width || width;
      const tHeight = trimmed.info.height || height;
      
      if (tWidth >= width * 0.4 && tHeight >= height * 0.4) {
        trimmedBuffer = trimmed.data;
        trimmedWidth = tWidth;
        trimmedHeight = tHeight;
        console.log(`[Crop API] Auto-trimmed borders: ${width}x${height} -> ${trimmedWidth}x${trimmedHeight}`);
      }
    } catch (trimError: any) {
      console.log("[Crop API] Auto-trim borders skipped or failed:", trimError.message);
    }

    const base64Image = originalImageBuffer.toString("base64");
    
    // Fallback list of modern active Gemini models
    const models = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"];
    let layoutText = "";

    const prompt = `The dimensions of the uploaded image are ${width}x${height} pixels. Please identify:
1. "card": Bounding box coordinates (x1, y1, x2, y2) of the physical trading card itself.
   Rules for locating the card bounds:
   - Identify the actual card frame or borders (which contain name text, rarity codes, cost symbols, copyright).
   - Ignore any external mount boards, white sheets/margins, transparent penny sleeves, toploaders, scanner bed glass, or background scenery.
   - The bounding box must tightly wrap the physical cardboard of the card.
   - For full-art, borderless, or extended-art cards: the artwork might overflow beyond the card borders. Focus on the core card rectangle itself.
2. "illustration": Bounding box coordinates (x1, y1, x2, y2) of the clean inner illustration/artwork area inside the card.
3. "hasSampleWatermark": Set to true if the card has a "SAMPLE" text watermark overlaid on it, otherwise false.
4. "isCleanCardImage": Set to true if the uploaded image contains ONLY the physical trading card itself, with NO outer backing or background.
5. "cardName": The text title/name of the card (detecting and translating Japanese, Korean, Chinese names to their official English TCG equivalent). Empty string if not found.
6. "cardNumber": The set/card sequence number (e.g. "151/165", "OP05-119"). Empty string if not found.`;

    for (const model of models) {
      try {
        console.log(`[Crop API] Trying model ${model}`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const payload = {
          contents: [
            {
              parts: [
                { inlineData: { mimeType: file.type || "image/jpeg", data: base64Image } },
                { text: prompt }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                card: {
                  type: "OBJECT",
                  properties: {
                    x1: { type: "INTEGER" },
                    y1: { type: "INTEGER" },
                    x2: { type: "INTEGER" },
                    y2: { type: "INTEGER" }
                  },
                  required: ["x1", "y1", "x2", "y2"]
                },
                illustration: {
                  type: "OBJECT",
                  properties: {
                    x1: { type: "INTEGER" },
                    y1: { type: "INTEGER" },
                    x2: { type: "INTEGER" },
                    y2: { type: "INTEGER" }
                  },
                  required: ["x1", "y1", "x2", "y2"]
                },
                hasSampleWatermark: { type: "BOOLEAN" },
                isCleanCardImage: { type: "BOOLEAN" },
                cardName: { type: "STRING" },
                cardNumber: { type: "STRING" }
              },
              required: ["card", "illustration", "hasSampleWatermark", "isCleanCardImage", "cardName", "cardNumber"]
            }
          }
        };

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          const json = await res.json();
          const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            layoutText = text;
            break;
          }
        }
      } catch (e: any) {
        console.warn(`[Crop API] Model ${model} failed: ${e.message}`);
      }
    }

    let cardCoords;
    let illustrationCoords;
    let hasSampleWatermark = false;
    let isCleanCardImage = false;
    let usedFallback = false;
    let cardName = "";
    let cardNumber = "";

    if (layoutText) {
      try {
        const parsed = JSON.parse(layoutText);
        if (parsed.card && parsed.illustration) {
          cardCoords = parsed.card;
          illustrationCoords = parsed.illustration;
          hasSampleWatermark = !!parsed.hasSampleWatermark;
          isCleanCardImage = !!parsed.isCleanCardImage;
          cardName = parsed.cardName || "";
          cardNumber = parsed.cardNumber || "";

          // Scale normalized 0-1000 coordinates if Gemini returned them on large images
          if (cardCoords.x2 <= 1000 && cardCoords.y2 <= 1000 && (width > 1050 || height > 1050)) {
            console.log("[Crop API] Scaling Gemini 0-1000 normalized card coordinates to image size.");
            cardCoords.x1 = Math.round((cardCoords.x1 / 1000) * width);
            cardCoords.x2 = Math.round((cardCoords.x2 / 1000) * width);
            cardCoords.y1 = Math.round((cardCoords.y1 / 1000) * height);
            cardCoords.y2 = Math.round((cardCoords.y2 / 1000) * height);
          }

          if (illustrationCoords.x2 <= 1000 && illustrationCoords.y2 <= 1000 && (width > 1050 || height > 1050)) {
            illustrationCoords.x1 = Math.round((illustrationCoords.x1 / 1000) * width);
            illustrationCoords.x2 = Math.round((illustrationCoords.x2 / 1000) * width);
            illustrationCoords.y1 = Math.round((illustrationCoords.y1 / 1000) * height);
            illustrationCoords.y2 = Math.round((illustrationCoords.y2 / 1000) * height);
          }

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
      let cx1 = trimmedWidth === width ? 0 : (width - trimmedWidth) / 2;
      let cy1 = trimmedHeight === height ? 0 : (height - trimmedHeight) / 2;
      let cx2 = cx1 + trimmedWidth;
      let cy2 = cy1 + trimmedHeight;

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
        x1: cx1 + Math.round(tWidth * 0.15),
        y1: cy1 + Math.round(tHeight * 0.18),
        x2: cx1 + Math.round(tWidth * 0.85),
        y2: cy1 + Math.round(tHeight * 0.58)
      };
    }

    let workingImageBuffer: any = originalImageBuffer;

    if (hasSampleWatermark) {
      console.log("[Crop API] Watermark 'SAMPLE' detected. Attempting to remove it...");
      try {
        const imageModels = ["gemini-2.0-flash-exp", "imagen-3.0-generate-002"];
        let cleanedBase64 = "";

        for (const modelName of imageModels) {
          try {
            console.log(`[Crop API] Clean watermark using ${modelName}`);
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
            const payload = {
              contents: [
                {
                  parts: [
                    { inlineData: { mimeType: file.type || "image/jpeg", data: base64Image } },
                    { text: "Please remove the large diagonal semi-transparent 'SAMPLE' watermark text from this card. Ensure that the card artwork, text, border, and numbers underneath are clean, fully visible, and seamlessly restored, with no watermark remaining." }
                  ]
                }
              ],
              generationConfig: {
                responseModalities: ["IMAGE"]
              }
            };

            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });

            if (res.ok) {
              const json = await res.json();
              const parts = json?.candidates?.[0]?.content?.parts || [];
              for (const part of parts) {
                if (part.inlineData?.data) {
                  cleanedBase64 = part.inlineData.data;
                  break;
                }
              }
            }

            if (cleanedBase64) {
              const cleanedBuf = Buffer.from(cleanedBase64, "base64");
              workingImageBuffer = await sharp(cleanedBuf)
                .resize(width, height)
                .toBuffer();
              console.log(`[Crop API] Successfully removed watermark and resized back to original size (${width}x${height}) using ${modelName}`);
              break;
            }
          } catch (e: any) {
            console.warn(`[Crop API] Watermark removal failed with ${modelName}:`, e.message);
          }
        }
      } catch (cleanError: any) {
        console.warn("[Crop API] Error during watermark cleaning block:", cleanError.message);
      }
    }

    // Only normalize aspect ratio if severely distorted (outside 0.60 - 0.85) to preserve full borders
    if (!skipCardCrop && !isCleanCardImage) {
      const cardW = cardCoords.x2 - cardCoords.x1;
      const cardH = cardCoords.y2 - cardCoords.y1;
      if (cardW > 0 && cardH > 0) {
        const currentRatio = cardW / cardH;
        const centerX = (cardCoords.x1 + cardCoords.x2) / 2;
        const centerY = (cardCoords.y1 + cardCoords.y2) / 2;

        if (currentRatio < 0.60 || currentRatio > 0.85) {
          const TARGET_RATIO = 0.715;
          if (currentRatio > TARGET_RATIO) {
            const newW = cardH * TARGET_RATIO;
            cardCoords.x1 = centerX - newW / 2;
            cardCoords.x2 = centerX + newW / 2;
          } else {
            const newH = cardW / TARGET_RATIO;
            cardCoords.y1 = centerY - newH / 2;
            cardCoords.y2 = centerY + newH / 2;
          }
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
      ix1 = cx1 + Math.round(cardWidth * 0.15);
      iy1 = cy1 + Math.round(cardHeight * 0.18);
      ix2 = cx1 + Math.round(cardWidth * 0.85);
      iy2 = cy1 + Math.round(cardHeight * 0.58);
      cropWidth = ix2 - ix1;
      cropHeight = iy2 - iy1;
    }

    // Ensure strict bounds before Sharp extraction
    const extractCardWidth = Math.min(cardWidth, width - cx1);
    const extractCardHeight = Math.min(cardHeight, height - cy1);

    let cardResizeHeight = Math.min(800, extractCardHeight);
    let cardResizeWidth = Math.round((extractCardWidth / extractCardHeight) * cardResizeHeight);

    const cardBuffer = await sharp(workingImageBuffer)
      .extract({ left: cx1, top: cy1, width: extractCardWidth, height: extractCardHeight })
      .resize(cardResizeWidth, cardResizeHeight)
      .png({ compressionLevel: 7 })
      .toBuffer();

    // Round the corners of the card using SVG mask (authentic 3.5mm TCG corner radius ~3.8%)
    const cornerRadius = Math.max(2, Math.round(cardResizeWidth * 0.038));
    const roundedCornersMask = Buffer.from(
      `<svg width="${cardResizeWidth}" height="${cardResizeHeight}"><rect x="0" y="0" width="${cardResizeWidth}" height="${cardResizeHeight}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/></svg>`
    );

    const roundedCardBuffer = await sharp(cardBuffer)
      .composite([{
        input: roundedCornersMask,
        blend: 'dest-in'
      }])
      .png({ compressionLevel: 7 })
      .toBuffer();

    const trimmedCardBase64 = roundedCardBuffer.toString("base64");

    // Crop the inner illustration (for outpainting input), resizing to max 512px and compressing as JPEG
    const extractCropWidth = Math.min(cropWidth, width - ix1);
    const extractCropHeight = Math.min(cropHeight, height - iy1);

    const croppedBuffer = await sharp(workingImageBuffer)
      .extract({ left: ix1, top: iy1, width: extractCropWidth, height: extractCropHeight })
      .resize(512, 512, { fit: "inside" })
      .jpeg({ quality: 85 })
      .toBuffer();

    const croppedBase64 = croppedBuffer.toString("base64");

    return NextResponse.json({
      croppedImage: `data:image/png;base64,${croppedBase64}`,
      trimmedCard: `data:image/png;base64,${trimmedCardBase64}`,
      coords: { ix1, iy1, ix2, iy2 },
      usedFallback,
      cardName,
      cardNumber
    });

  } catch (error: any) {
    console.error("Error in Crop API:", error);
    return NextResponse.json({ error: error.message || "Internal server error during crop." }, { status: 500 });
  }
}
