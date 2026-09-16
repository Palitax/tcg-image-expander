import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp, { OverlayOptions } from "sharp";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";
export const preferredRegion = "iad1";

// Helper to call generateContent with retry on transient errors (503, 429)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function generateContentWithRetry(ai: any, params: any, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await ai.models.generateContent(params);
    } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const errorStr = String(e.message || e);
      const isUnavailable =
        errorStr.includes("503") ||
        errorStr.toLowerCase().includes("demand") ||
        errorStr.toLowerCase().includes("unavailable") ||
        e.status === 503 ||
        e.statusCode === 503;
      const isRateLimit =
        errorStr.includes("429") ||
        errorStr.toLowerCase().includes("rate limit") ||
        errorStr.toLowerCase().includes("quota") ||
        e.status === 429 ||
        e.statusCode === 429;

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

// Programmatic computer-vision card detector for scanned cards on scanner beds
async function detectCardBordersCV(
  originalCardBuffer: Buffer,
  width: number,
  height: number
): Promise<{ x1: number; y1: number; x2: number; y2: number }> {
  try {
    const { data, info } = await sharp(originalCardBuffer)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;

    // Sample corner pixel average brightness (scanner bed / background color)
    let cornerSum = 0;
    let cornerCount = 0;
    const cornerSize = Math.max(5, Math.min(25, Math.round(Math.min(w, h) * 0.02)));

    for (let dy = 0; dy < cornerSize; dy++) {
      for (let dx = 0; dx < cornerSize; dx++) {
        cornerSum += data[dy * w + dx]; // top-left
        cornerSum += data[dy * w + (w - 1 - dx)]; // top-right
        cornerSum += data[(h - 1 - dy) * w + dx]; // bottom-left
        cornerSum += data[(h - 1 - dy) * w + (w - 1 - dx)]; // bottom-right
        cornerCount += 4;
      }
    }
    const bgLuminance = cornerCount > 0 ? cornerSum / cornerCount : 0;

    // Threshold difference
    const diffThreshold = 22;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    let matchCount = 0;

    // Scan lines with a small step for high speed and robustness
    const step = 2;
    for (let y = 0; y < h; y += step) {
      const rowOffset = y * w;
      for (let x = 0; x < w; x += step) {
        const val = data[rowOffset + x];
        if (Math.abs(val - bgLuminance) > diffThreshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          matchCount++;
        }
      }
    }

    const detectedW = maxX - minX;
    const detectedH = maxY - minY;

    // Validate that the detected region is plausible for a card (at least 30% of image size)
    if (matchCount > 100 && detectedW >= w * 0.3 && detectedH >= h * 0.3) {
      return {
        x1: Math.max(0, minX),
        y1: Math.max(0, minY),
        x2: Math.min(w, maxX),
        y2: Math.min(h, maxY)
      };
    }
  } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    console.warn("[Stream Card API CV] Raw scan failed:", err.message);
  }

  // Fallback to Sharp trim
  try {
    const trimmed = await sharp(originalCardBuffer)
      .trim()
      .toBuffer({ resolveWithObject: true });

    const offsetLeft = typeof trimmed.info.trimOffsetLeft === "number" ? Math.max(0, trimmed.info.trimOffsetLeft) : 0;
    const offsetTop = typeof trimmed.info.trimOffsetTop === "number" ? Math.max(0, trimmed.info.trimOffsetTop) : 0;
    const trimW = trimmed.info.width || width;
    const trimH = trimmed.info.height || height;

    if (trimW >= width * 0.3 && trimH >= height * 0.3) {
      return {
        x1: offsetLeft,
        y1: offsetTop,
        x2: Math.min(width, offsetLeft + trimW),
        y2: Math.min(height, offsetTop + trimH)
      };
    }
  } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    console.warn("[Stream Card API CV] Trim failed:", err.message);
  }

  return { x1: 0, y1: 0, x2: width, y2: height };
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const cardFile = formData.get("cardImage") as File | null;
    const customBgFile = formData.get("backgroundImage") as File | null;
    const cardScaleFactor = parseFloat(formData.get("cardScale") as string || "0.75");
    const shadowStyle = (formData.get("shadowStyle") as string || "soft") as "soft" | "intense" | "glow" | "none";

    if (!cardFile) {
      return NextResponse.json({ error: "Keine Bilddatei hochgeladen." }, { status: 400 });
    }

    const cardArrayBuffer = await cardFile.arrayBuffer();
    const originalCardBuffer = Buffer.from(cardArrayBuffer);

    // Read card image dimensions
    const originalMetadata = await sharp(originalCardBuffer).metadata();
    const width = originalMetadata.width || 0;
    const height = originalMetadata.height || 0;

    if (width === 0 || height === 0) {
      return NextResponse.json({ error: "Bildabmessungen konnten nicht gelesen werden." }, { status: 400 });
    }

    // Load background image
    let backgroundBuffer: Buffer;
    if (customBgFile) {
      const bgArrayBuffer = await customBgFile.arrayBuffer();
      backgroundBuffer = Buffer.from(bgArrayBuffer);
    } else {
      const defaultBgPath = path.join(process.cwd(), "public", "stream-background.jpg");
      if (fs.existsSync(defaultBgPath)) {
        backgroundBuffer = fs.readFileSync(defaultBgPath);
      } else {
        // Fallback: create vibrant dark blue background if file is missing
        backgroundBuffer = await sharp({
          create: {
            width: 1024,
            height: 1024,
            channels: 4,
            background: { r: 10, g: 15, b: 35, alpha: 1 }
          }
        }).png().toBuffer();
      }
    }

    const bgMetadata = await sharp(backgroundBuffer).metadata();
    const bgWidth = bgMetadata.width || 1024;
    const bgHeight = bgMetadata.height || 1024;

    const apiKey = process.env.GEMINI_API_KEY;
    let cardCoords: { x1: number; y1: number; x2: number; y2: number } | null = null;
    let isCardBack = false;
    let cardName = "";
    let usedFallback = false;

    // Normalize mime type for Gemini API
    let mimeType = cardFile.type || "image/jpeg";
    if (mimeType === "image/jpg") mimeType = "image/jpeg";
    if (!["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mimeType)) {
      mimeType = "image/jpeg";
    }

    // Attempt AI vision detection if GEMINI_API_KEY is available
    if (apiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey });
        const base64Image = originalCardBuffer.toString("base64");
        const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
        let layoutText = "";

        const prompt = `The uploaded image is a scan or photo of a collectible trading card (such as Pokémon, One Piece, Magic: The Gathering, Yu-Gi-Oh, Lorcana, Sports cards).
Image dimensions: ${width}x${height} pixels.

CRITICAL INSTRUCTIONS FOR SCANNER & SLEEVE DETECTION:
1. The card is often inside a clear plastic sleeve (penny sleeve, toploader, or binder pocket) and scanned on a scanner glass bed or against a background.
2. Clear plastic sleeves typically extend PAST the edges of the card (especially at the bottom or top flap) and create horizontal seam lines, reflection glares, or transparent plastic margins.
3. Your job is to locate the BOUNDING BOX of the PHYSICAL TRADING CARD ITSELF:
   - x1, y1 (top-left pixel coordinates)
   - x2, y2 (bottom-right pixel coordinates)
4. EXCLUDE ALL surrounding background, scanner glass edges, transparent penny sleeve plastic overhang, plastic folds, tape, and condition sticker tags. The bounding box must tightly wrap only the printed card rectangle.
5. Standard trading cards have a vertical rectangular aspect ratio of approximately 2.5 : 3.5 (~0.714 ratio).
6. Determine whether this is the FRONT of a card or the BACK of a card (e.g. standard blue Pokémon card back with Pokéball, Yu-Gi-Oh swirl, Magic oval).
7. If it's a card front with a legible character/card name, return the translated official English name in "cardName". If it is a card back or illegible, return an empty string for "cardName".`;

        for (const model of models) {
          try {
            console.log(`[Stream Card API] Detecting card layout using model ${model}`);
            const layoutResponse = await generateContentWithRetry(ai, {
              model,
              contents: [
                {
                  inlineData: {
                    data: base64Image,
                    mimeType
                  }
                },
                prompt
              ],
              config: {
                systemInstruction: "You are an expert at precision computer vision detection for trading card game scans (Pokémon, MTG, Yu-Gi-Oh, One Piece). Your task is to detect the exact pixel bounding box of the physical trading card inside sleeves or scans, distinguishing it from transparent sleeve margins, scanner beds, and outer backgrounds. Return ONLY JSON.",
                responseMimeType: "application/json",
                responseSchema: {
                  type: "object",
                  properties: {
                    card: {
                      type: "object",
                      properties: {
                        x1: { type: "integer", description: "Top-left X coordinate of the physical card in pixels" },
                        y1: { type: "integer", description: "Top-left Y coordinate of the physical card in pixels" },
                        x2: { type: "integer", description: "Bottom-right X coordinate of the physical card in pixels" },
                        y2: { type: "integer", description: "Bottom-right Y coordinate of the physical card in pixels" }
                      },
                      required: ["x1", "y1", "x2", "y2"]
                    },
                    isCardBack: {
                      type: "boolean",
                      description: "True if this is the back of a trading card, false if it is the front artwork/gameplay face."
                    },
                    cardName: {
                      type: "string",
                      description: "The name of the card/character if visible on front. Empty string for card backs."
                    }
                  },
                  required: ["card", "isCardBack", "cardName"]
                }
              }
            });

            if (layoutResponse.text) {
              layoutText = layoutResponse.text;
              break;
            }
          } catch (modelErr: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
            console.warn(`[Stream Card API] Model ${model} failed: ${modelErr.message}`);
          }
        }

        if (layoutText) {
          const parsed = JSON.parse(layoutText);
          if (parsed.card && typeof parsed.card.x1 === "number" && typeof parsed.card.x2 === "number") {
            const coords = {
              x1: Number(parsed.card.x1),
              y1: Number(parsed.card.y1),
              x2: Number(parsed.card.x2),
              y2: Number(parsed.card.y2),
            };

            // Scale 0-1000 normalized coordinates if Gemini returned them on large images
            if (coords.x2 <= 1000 && coords.y2 <= 1000 && (width > 1050 || height > 1050)) {
              coords.x1 = Math.round((coords.x1 / 1000) * width);
              coords.x2 = Math.round((coords.x2 / 1000) * width);
              coords.y1 = Math.round((coords.y1 / 1000) * height);
              coords.y2 = Math.round((coords.y2 / 1000) * height);
            }

            cardCoords = coords;
            isCardBack = !!parsed.isCardBack;
            cardName = parsed.cardName || "";
            console.log("[Stream Card API] AI detected card coordinates:", cardCoords);
          }
        }
      } catch (aiErr: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
        console.warn("[Stream Card API] Gemini vision failed, using CV detector:", aiErr.message);
      }
    }

    // High-precision Computer-Vision Fallback if AI detection was unavailable or incomplete
    if (!cardCoords || (cardCoords.x2 - cardCoords.x1) < 50 || (cardCoords.y2 - cardCoords.y1) < 50) {
      console.log("[Stream Card API] Running smart CV border detection...");
      usedFallback = true;
      cardCoords = await detectCardBordersCV(originalCardBuffer, width, height);
    }

    // Standard TCG card aspect ratio validation (~0.714 = 2.5 / 3.5)
    const TARGET_RATIO = 0.714;
    const detectedW = cardCoords.x2 - cardCoords.x1;
    const detectedH = cardCoords.y2 - cardCoords.y1;

    if (detectedW > 0 && detectedH > 0) {
      const currentRatio = detectedW / detectedH;
      const centerX = (cardCoords.x1 + cardCoords.x2) / 2;
      const centerY = (cardCoords.y1 + cardCoords.y2) / 2;

      // Allow 5% tolerance, otherwise conform to standard ratio
      if (Math.abs(currentRatio - TARGET_RATIO) > 0.04) {
        if (currentRatio > TARGET_RATIO) {
          // Detected box is too wide, adjust width
          const newW = detectedH * TARGET_RATIO;
          cardCoords.x1 = Math.round(centerX - newW / 2);
          cardCoords.x2 = Math.round(centerX + newW / 2);
        } else {
          // Detected box is too tall, adjust height
          const newH = detectedW / TARGET_RATIO;
          cardCoords.y1 = Math.round(centerY - newH / 2);
          cardCoords.y2 = Math.round(centerY + newH / 2);
        }
      }
    }

    // Clamp coordinates safely within original image bounds
    const extractX = Math.max(0, Math.min(Math.round(cardCoords.x1), width - 10));
    const extractY = Math.max(0, Math.min(Math.round(cardCoords.y1), height - 10));
    const extractW = Math.max(10, Math.min(Math.round(cardCoords.x2 - cardCoords.x1), width - extractX));
    const extractH = Math.max(10, Math.min(Math.round(cardCoords.y2 - cardCoords.y1), height - extractY));

    // Extract the card
    const extractedCard = await sharp(originalCardBuffer)
      .extract({ left: extractX, top: extractY, width: extractW, height: extractH })
      .png()
      .toBuffer();

    // Round the corners using an SVG alpha mask (TCG cards have ~3.5% corner radius)
    const cornerRadius = Math.round(extractW * 0.035);
    const roundedCornersMask = Buffer.from(
      `<svg width="${extractW}" height="${extractH}"><rect x="0" y="0" width="${extractW}" height="${extractH}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/></svg>`
    );

    const roundedCardBuffer = await sharp(extractedCard)
      .composite([{
        input: roundedCornersMask,
        blend: "dest-in"
      }])
      .png({ compressionLevel: 7 })
      .toBuffer();

    // Calculate final sizing on the stream background
    // Ensure card + shadow fits strictly within background dimensions
    const clampedScaleFactor = Math.max(0.4, Math.min(0.90, cardScaleFactor));
    
    // Maximum allowable height for the card itself on the background
    const maxAvailableHeight = shadowStyle !== "none" ? Math.floor(bgHeight * 0.88) : bgHeight;
    const maxAvailableWidth = shadowStyle !== "none" ? Math.floor(bgWidth * 0.88) : bgWidth;

    let targetCardHeight = Math.round(bgHeight * clampedScaleFactor);
    let targetCardWidth = Math.round((extractW / extractH) * targetCardHeight);

    if (targetCardHeight > maxAvailableHeight) {
      targetCardHeight = maxAvailableHeight;
      targetCardWidth = Math.round((extractW / extractH) * targetCardHeight);
    }
    if (targetCardWidth > maxAvailableWidth) {
      targetCardWidth = maxAvailableWidth;
      targetCardHeight = Math.round((extractH / extractW) * targetCardWidth);
    }

    const resizedCardBuffer = await sharp(roundedCardBuffer)
      .resize(targetCardWidth, targetCardHeight)
      .png()
      .toBuffer();

    const compositeLayers: OverlayOptions[] = [];

    if (shadowStyle !== "none") {
      const shadowPadding = Math.max(8, Math.min(40, Math.round(targetCardWidth * 0.08)));
      const shadowWidth = targetCardWidth + shadowPadding * 2;
      const shadowHeight = targetCardHeight + shadowPadding * 2;
      const targetShadowRadius = Math.round(targetCardWidth * 0.035);

      let shadowColorR = 0;
      let shadowColorG = 0;
      let shadowColorB = 0;
      let shadowAlpha = 0.55;
      let blurSigma = Math.max(10, Math.min(24, Math.round(shadowPadding * 0.6)));

      if (shadowStyle === "intense") {
        shadowAlpha = 0.8;
        blurSigma = Math.max(12, Math.min(28, Math.round(shadowPadding * 0.75)));
      } else if (shadowStyle === "glow") {
        shadowColorR = 0;
        shadowColorG = 180;
        shadowColorB = 255;
        shadowAlpha = 0.75;
        blurSigma = Math.max(12, Math.min(28, Math.round(shadowPadding * 0.7)));
      }

      const shadowMask = Buffer.from(
        `<svg width="${targetCardWidth}" height="${targetCardHeight}"><rect x="0" y="0" width="${targetCardWidth}" height="${targetCardHeight}" rx="${targetShadowRadius}" ry="${targetShadowRadius}" fill="white"/></svg>`
      );

      const innerShadow = await sharp({
        create: {
          width: targetCardWidth,
          height: targetCardHeight,
          channels: 4,
          background: { r: shadowColorR, g: shadowColorG, b: shadowColorB, alpha: shadowAlpha }
        }
      })
      .composite([{
        input: shadowMask,
        blend: "dest-in"
      }])
      .png()
      .toBuffer();

      const shadowLayer = await sharp({
        create: {
          width: shadowWidth,
          height: shadowHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      })
      .composite([
        {
          input: innerShadow,
          top: shadowPadding,
          left: shadowPadding
        }
      ])
      .blur(blurSigma)
      .png()
      .toBuffer();

      const cardWithShadow = await sharp(shadowLayer)
        .composite([
          {
            input: resizedCardBuffer,
            top: shadowPadding,
            left: shadowPadding
          }
        ])
        .png()
        .toBuffer();

      const finalTop = Math.max(0, Math.min(bgHeight - shadowHeight, Math.round((bgHeight - shadowHeight) / 2)));
      const finalLeft = Math.max(0, Math.min(bgWidth - shadowWidth, Math.round((bgWidth - shadowWidth) / 2)));

      compositeLayers.push({
        input: cardWithShadow,
        top: finalTop,
        left: finalLeft
      });
    } else {
      const finalTop = Math.max(0, Math.min(bgHeight - targetCardHeight, Math.round((bgHeight - targetCardHeight) / 2)));
      const finalLeft = Math.max(0, Math.min(bgWidth - targetCardWidth, Math.round((bgWidth - targetCardWidth) / 2)));

      compositeLayers.push({
        input: resizedCardBuffer,
        top: finalTop,
        left: finalLeft
      });
    }

    // Composite card (+ shadow) onto background
    const finalCompositeBuffer = await sharp(backgroundBuffer)
      .composite(compositeLayers)
      .png({ compressionLevel: 6 })
      .toBuffer();

    const finalBase64 = finalCompositeBuffer.toString("base64");
    const cutoutBase64 = roundedCardBuffer.toString("base64");

    return NextResponse.json({
      resultImageUrl: `data:image/png;base64,${finalBase64}`,
      cutoutImageUrl: `data:image/png;base64,${cutoutBase64}`,
      coords: { x1: extractX, y1: extractY, x2: extractX + extractW, y2: extractY + extractH },
      cardName,
      isCardBack,
      usedFallback
    });

  } catch (error: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    console.error("Error in Stream Card API:", error);
    return NextResponse.json(
      { error: error.message || "Fehler bei der Stream-Kartenverarbeitung." },
      { status: 500 }
    );
  }
}
