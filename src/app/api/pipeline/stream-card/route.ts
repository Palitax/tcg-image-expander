import { NextResponse } from "next/server";
import sharp, { OverlayOptions } from "sharp";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Programmatic computer-vision card detector for scanned cards on scanner beds
async function detectCardBordersCV(
  cardBuffer: Buffer,
  width: number,
  height: number
): Promise<{ x1: number; y1: number; x2: number; y2: number }> {
  try {
    const { data, info } = await sharp(cardBuffer)
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;

    if (!w || !h || data.length < w * h) {
      return { x1: 0, y1: 0, x2: width, y2: height };
    }

    // Sample corner pixel average brightness (scanner bed / background color)
    let cornerSum = 0;
    let cornerCount = 0;
    const cornerSize = Math.max(3, Math.min(25, Math.round(Math.min(w, h) * 0.02)));

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

    if (matchCount > 100 && detectedW >= w * 0.3 && detectedH >= h * 0.3) {
      console.log(`[Stream Card CV] Plausible card detected: x1=${minX}, y1=${minY}, x2=${maxX}, y2=${maxY} (${detectedW}x${detectedH})`);
      return {
        x1: Math.max(0, minX),
        y1: Math.max(0, minY),
        x2: Math.min(w, maxX),
        y2: Math.min(h, maxY)
      };
    }
  } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    console.warn("[Stream Card CV] Pixel scan failed:", err?.message || err);
  }

  // Fallback to Sharp trim
  try {
    const trimmed = await sharp(cardBuffer)
      .trim()
      .toBuffer({ resolveWithObject: true });

    const offsetLeft = typeof trimmed.info.trimOffsetLeft === "number" ? Math.max(0, trimmed.info.trimOffsetLeft) : 0;
    const offsetTop = typeof trimmed.info.trimOffsetTop === "number" ? Math.max(0, trimmed.info.trimOffsetTop) : 0;
    const trimW = trimmed.info.width || width;
    const trimH = trimmed.info.height || height;

    if (trimW >= width * 0.3 && trimH >= height * 0.3) {
      console.log(`[Stream Card CV] Trim fallback detected: left=${offsetLeft}, top=${offsetTop}, w=${trimW}, h=${trimH}`);
      return {
        x1: offsetLeft,
        y1: offsetTop,
        x2: Math.min(width, offsetLeft + trimW),
        y2: Math.min(height, offsetTop + trimH)
      };
    }
  } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    console.warn("[Stream Card CV] Trim failed:", err?.message || err);
  }

  console.log("[Stream Card CV] Fallback to full image bounds.");
  return { x1: 0, y1: 0, x2: width, y2: height };
}

export async function POST(request: Request) {
  const reqStart = Date.now();
  console.log(`[Stream Card API] === Incoming POST Request at ${new Date().toISOString()} ===`);

  try {
    const formData = await request.formData();
    const cardFile = formData.get("cardImage") as File | null;
    const customBgFile = formData.get("backgroundImage") as File | null;
    const cardScaleFactor = parseFloat(formData.get("cardScale") as string || "0.75");
    const shadowStyle = (formData.get("shadowStyle") as string || "soft") as "soft" | "intense" | "glow" | "none";

    console.log(`[Stream Card API] Params: cardFileName=${cardFile?.name || "none"}, cardFileSize=${cardFile?.size || 0} bytes, scale=${cardScaleFactor}, shadowStyle=${shadowStyle}`);

    if (!cardFile) {
      console.error("[Stream Card API] Error: Keine Bilddatei im FormData vorhanden.");
      return NextResponse.json({ error: "Keine Bilddatei hochgeladen." }, { status: 400 });
    }

    const cardArrayBuffer = await cardFile.arrayBuffer();
    const rawCardBuffer = Buffer.from(cardArrayBuffer);

    // Normalize orientation with .rotate() to eliminate any EXIF orientation discrepancies
    const originalCardBuffer = await sharp(rawCardBuffer)
      .rotate()
      .toBuffer();

    // Read normalized card image dimensions
    const originalMetadata = await sharp(originalCardBuffer).metadata();
    const width = originalMetadata.width || 0;
    const height = originalMetadata.height || 0;
    console.log(`[Stream Card API] Normalized card metadata: ${width}x${height}px, format=${originalMetadata.format}, channels=${originalMetadata.channels}`);

    if (width === 0 || height === 0) {
      console.error("[Stream Card API] Error: Abmessungen konnten nicht ermittelt werden.");
      return NextResponse.json({ error: "Bildabmessungen konnten nicht gelesen werden." }, { status: 400 });
    }

    // Load background image with 3-tier fallback
    let backgroundBuffer: Buffer | null = null;
    if (customBgFile && typeof (customBgFile as any).arrayBuffer === "function") {
      try {
        console.log(`[Stream Card API] Using custom background: ${customBgFile.name} (${customBgFile.size} bytes)`);
        const bgArrayBuffer = await customBgFile.arrayBuffer();
        backgroundBuffer = Buffer.from(bgArrayBuffer);
      } catch (bgErr) {
        console.warn("[Stream Card API] Custom background read failed, falling back to default:", bgErr);
      }
    }

    // Tier 1: Local file system
    if (!backgroundBuffer) {
      try {
        const defaultBgPath = path.join(process.cwd(), "public", "stream-background.jpg");
        if (fs.existsSync(defaultBgPath)) {
          console.log(`[Stream Card API] Loading default background from ${defaultBgPath}`);
          backgroundBuffer = fs.readFileSync(defaultBgPath);
        }
      } catch (fsErr) {
        console.warn(`[Stream Card API] Local background file read failed:`, fsErr);
      }
    }

    // Tier 2: HTTP fetch from origin
    if (!backgroundBuffer) {
      try {
        const origin = new URL(request.url).origin;
        console.log(`[Stream Card API] Attempting to fetch background from ${origin}/stream-background.jpg`);
        const res = await fetch(`${origin}/stream-background.jpg`);
        if (res.ok) {
          backgroundBuffer = Buffer.from(await res.arrayBuffer());
          console.log(`[Stream Card API] Successfully fetched default background from URL.`);
        }
      } catch (fetchErr) {
        console.warn("[Stream Card API] HTTP fetch for background failed:", fetchErr);
      }
    }

    // Tier 3: Synthetic gradient fallback
    if (!backgroundBuffer) {
      console.warn(`[Stream Card API] Creating synthetic dark blue backdrop fallback.`);
      backgroundBuffer = await sharp({
        create: {
          width: 1024,
          height: 1024,
          channels: 4,
          background: { r: 12, g: 20, b: 45, alpha: 1 }
        }
      }).png().toBuffer();
    }

    const bgMetadata = await sharp(backgroundBuffer).metadata();
    const bgWidth = bgMetadata.width || 1024;
    const bgHeight = bgMetadata.height || 1024;
    console.log(`[Stream Card API] Background metadata: ${bgWidth}x${bgHeight}px`);

    const headerApiKey = request.headers.get("x-gemini-api-key");
    const formApiKey = formData.get("apiKey") as string;
    const envApiKey = process.env.GEMINI_API_KEY;
    const rawKey = formApiKey || headerApiKey || envApiKey;
    const apiKey = rawKey && typeof rawKey === "string" ? rawKey.trim() : null;

    const keySource = formApiKey ? "form-data" : headerApiKey ? "header (x-gemini-api-key)" : envApiKey ? "env (GEMINI_API_KEY)" : "none";
    console.log(`[Stream Card API] API Key resolution source: ${keySource} (key present: ${!!apiKey})`);

    if (!apiKey) {
      console.error("[Stream Card API] Kein API-Key gefunden.");
      return NextResponse.json(
        { error: "Kein Google Gemini API-Key gefunden. Bitte trage deinen API-Key in den Einstellungen (Schlüssel-Symbol oben) oder in die .env.local ein." },
        { status: 400 }
      );
    }

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

    // AI Vision detection using Google Gemini REST API (zero external SDK dependency)
    try {
      console.log(`[Stream Card API] Starting Gemini AI detection over direct REST API...`);
      const base64Image = originalCardBuffer.toString("base64");
      const models = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"];
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
          console.log(`[Stream Card API] Attempting Gemini card detection with model: ${model}`);
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
          
          const payload = {
            contents: [
              {
                parts: [
                  {
                    inlineData: {
                      mimeType,
                      data: base64Image
                    }
                  },
                  {
                    text: prompt
                  }
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
                      x1: { type: "INTEGER", description: "Top-left X coordinate of the physical card in pixels" },
                      y1: { type: "INTEGER", description: "Top-left Y coordinate of the physical card in pixels" },
                      x2: { type: "INTEGER", description: "Bottom-right X coordinate of the physical card in pixels" },
                      y2: { type: "INTEGER", description: "Bottom-right Y coordinate of the physical card in pixels" }
                    },
                    required: ["x1", "y1", "x2", "y2"]
                  },
                  isCardBack: {
                    type: "BOOLEAN",
                    description: "True if this is the back of a trading card, false if it is the front artwork/gameplay face."
                  },
                  cardName: {
                    type: "STRING",
                    description: "The name of the card/character if visible on front. Empty string for card backs."
                  }
                },
                required: ["card", "isCardBack", "cardName"]
              }
            }
          };

          const restResponse = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

          if (restResponse.ok) {
            const result = await restResponse.json();
            const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              console.log(`[Stream Card API] Model ${model} returned response: ${text.slice(0, 200)}...`);
              layoutText = text;
              break;
            }
          } else {
            const errorText = await restResponse.text();
            console.warn(`[Stream Card API] Model ${model} returned HTTP ${restResponse.status}: ${errorText}`);
          }
        } catch (modelErr: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
          console.warn(`[Stream Card API] Model ${model} call failed:`, modelErr?.message || modelErr);
        }
      }

      if (layoutText) {
        const parsed = JSON.parse(layoutText);
        if (parsed.card && typeof parsed.card.x1 === "number" && typeof parsed.card.x2 === "number") {
          let coords = {
            x1: Number(parsed.card.x1),
            y1: Number(parsed.card.y1),
            x2: Number(parsed.card.x2),
            y2: Number(parsed.card.y2),
          };

          // Scale 0-1000 normalized coordinates if Gemini returned them on large images
          if (coords.x2 <= 1000 && coords.y2 <= 1000 && (width > 1050 || height > 1050)) {
            console.log(`[Stream Card API] Scaling normalized coordinates (0-1000) to image dimensions (${width}x${height})`);
            coords = {
              x1: Math.round((coords.x1 / 1000) * width),
              x2: Math.round((coords.x2 / 1000) * width),
              y1: Math.round((coords.y1 / 1000) * height),
              y2: Math.round((coords.y2 / 1000) * height),
            };
          }

          cardCoords = coords;
          isCardBack = !!parsed.isCardBack;
          cardName = parsed.cardName || "";
          console.log("[Stream Card API] Gemini successfully parsed coordinates:", cardCoords, "cardName:", cardName, "isBack:", isCardBack);
        }
      }
    } catch (aiErr: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      console.warn("[Stream Card API] Gemini vision failed:", aiErr?.message || aiErr);
    }

    // High-precision Computer-Vision Fallback if AI detection was unavailable or incomplete
    if (!cardCoords || (cardCoords.x2 - cardCoords.x1) < 50 || (cardCoords.y2 - cardCoords.y1) < 50) {
      console.log("[Stream Card API] AI coordinates missing or invalid. Triggering Computer Vision fallback...");
      usedFallback = true;
      cardCoords = await detectCardBordersCV(originalCardBuffer, width, height);
    }

    // Sanitize coordinates and prevent any NaN or infinite values
    const safeX1 = Number.isFinite(cardCoords.x1) ? cardCoords.x1 : 0;
    const safeY1 = Number.isFinite(cardCoords.y1) ? cardCoords.y1 : 0;
    const safeX2 = Number.isFinite(cardCoords.x2) ? cardCoords.x2 : width;
    const safeY2 = Number.isFinite(cardCoords.y2) ? cardCoords.y2 : height;

    const detectedW = Math.max(10, safeX2 - safeX1);
    const detectedH = Math.max(10, safeY2 - safeY1);

    let adjX1 = safeX1;
    let adjY1 = safeY1;
    let adjX2 = safeX2;
    let adjY2 = safeY2;

    const TARGET_RATIO = 0.714;
    if (detectedW > 0 && detectedH > 0) {
      const currentRatio = detectedW / detectedH;
      const centerX = (safeX1 + safeX2) / 2;
      const centerY = (safeY1 + safeY2) / 2;

      // Allow 5% tolerance, otherwise conform to standard ratio
      if (Math.abs(currentRatio - TARGET_RATIO) > 0.04) {
        if (currentRatio > TARGET_RATIO) {
          const newW = detectedH * TARGET_RATIO;
          adjX1 = Math.round(centerX - newW / 2);
          adjX2 = Math.round(centerX + newW / 2);
        } else {
          const newH = detectedW / TARGET_RATIO;
          adjY1 = Math.round(centerY - newH / 2);
          adjY2 = Math.round(centerY + newH / 2);
        }
      }
    }

    // Strict mathematical clamping to prevent any out-of-bounds Sharp extraction errors
    const clampedLeft = Math.max(0, Math.min(Math.round(adjX1), width - 1));
    const clampedTop = Math.max(0, Math.min(Math.round(adjY1), height - 1));
    const clampedRight = Math.max(clampedLeft + 1, Math.min(Math.round(adjX2), width));
    const clampedBottom = Math.max(clampedTop + 1, Math.min(Math.round(adjY2), height));

    const extractX = clampedLeft;
    const extractY = clampedTop;
    const extractW = Math.max(1, clampedRight - clampedLeft);
    const extractH = Math.max(1, clampedBottom - clampedTop);

    console.log(`[Stream Card API] Final extraction rectangle: left=${extractX}, top=${extractY}, width=${extractW}, height=${extractH} (within ${width}x${height})`);

    // Extract the card
    const extractedCard = await sharp(originalCardBuffer)
      .extract({ left: extractX, top: extractY, width: extractW, height: extractH })
      .png()
      .toBuffer();

    // Round the corners using an SVG alpha mask (TCG cards have ~3.5% corner radius)
    const cornerRadius = Math.max(2, Math.round(extractW * 0.035));
    const roundedCornersMask = Buffer.from(
      `<svg width="${extractW}" height="${extractH}"><rect x="0" y="0" width="${extractW}" height="${extractH}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/></svg>`
    );

    const roundedCardBuffer = await sharp(extractedCard)
      .ensureAlpha()
      .composite([{
        input: roundedCornersMask,
        blend: "dest-in"
      }])
      .png({ compressionLevel: 8 })
      .toBuffer();

    // Calculate final sizing on the stream background
    const clampedScaleFactor = Math.max(0.4, Math.min(0.90, cardScaleFactor));
    
    // Available bounds on background
    const maxAvailableHeight = shadowStyle !== "none" ? Math.floor(bgHeight * 0.85) : Math.floor(bgHeight * 0.95);
    const maxAvailableWidth = shadowStyle !== "none" ? Math.floor(bgWidth * 0.85) : Math.floor(bgWidth * 0.95);

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

    targetCardWidth = Math.max(10, Math.min(maxAvailableWidth, targetCardWidth));
    targetCardHeight = Math.max(10, Math.min(maxAvailableHeight, targetCardHeight));

    console.log(`[Stream Card API] Target card dimensions on background: ${targetCardWidth}x${targetCardHeight}px`);

    const resizedCardBuffer = await sharp(roundedCardBuffer)
      .resize(targetCardWidth, targetCardHeight)
      .png()
      .toBuffer();

    const compositeLayers: OverlayOptions[] = [];

    if (shadowStyle !== "none") {
      const shadowPadding = Math.max(8, Math.min(36, Math.round(targetCardWidth * 0.07)));
      const shadowWidth = Math.min(bgWidth, targetCardWidth + shadowPadding * 2);
      const shadowHeight = Math.min(bgHeight, targetCardHeight + shadowPadding * 2);
      const targetShadowRadius = Math.round(targetCardWidth * 0.035);

      let shadowColorR = 0;
      let shadowColorG = 0;
      let shadowColorB = 0;
      let shadowAlpha = 0.55;
      let blurSigma = Math.max(8, Math.min(22, Math.round(shadowPadding * 0.6)));

      if (shadowStyle === "intense") {
        shadowAlpha = 0.8;
        blurSigma = Math.max(10, Math.min(24, Math.round(shadowPadding * 0.75)));
      } else if (shadowStyle === "glow") {
        shadowColorR = 0;
        shadowColorG = 180;
        shadowColorB = 255;
        shadowAlpha = 0.75;
        blurSigma = Math.max(10, Math.min(24, Math.round(shadowPadding * 0.7)));
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

    // Composite card (+ shadow) onto background and encode efficiently
    console.log(`[Stream Card API] Performing final Sharp background composite...`);
    const finalCompositeBuffer = await sharp(backgroundBuffer)
      .composite(compositeLayers)
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();

    const finalBase64 = finalCompositeBuffer.toString("base64");
    const cutoutBase64 = roundedCardBuffer.toString("base64");

    const totalDuration = Date.now() - reqStart;
    console.log(`[Stream Card API] Successfully finished in ${totalDuration}ms. Output JPEG size: ${(finalCompositeBuffer.length / 1024).toFixed(1)} KB`);

    return NextResponse.json({
      resultImageUrl: `data:image/jpeg;base64,${finalBase64}`,
      cutoutImageUrl: `data:image/png;base64,${cutoutBase64}`,
      coords: { x1: extractX, y1: extractY, x2: extractX + extractW, y2: extractY + extractH },
      cardName,
      isCardBack,
      usedFallback
    });

  } catch (error: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    console.error("[Stream Card API] Critical Error caught in POST handler:", error);
    const detailedMessage = error?.message || (typeof error === "string" ? error : JSON.stringify(error)) || "Unbekannter Fehler bei der Bildverarbeitung.";
    return NextResponse.json(
      { error: `Stream-Fehler: ${detailedMessage}` },
      { status: 500 }
    );
  }
}
