import { NextResponse } from "next/server";
import sharp, { OverlayOptions } from "sharp";
import fs from "fs";
import path from "path";
import { extractCardCutout, CardCutoutResult } from "@/utils/cardCutout";
import { removeBackgroundAI } from "@/utils/bgRemover";
import { extractCardHomography } from "@/utils/cardHomography";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;


export async function POST(request: Request) {
  const reqStart = Date.now();
  console.log(`[Stream Card API] === Incoming POST Request at ${new Date().toISOString()} ===`);

  try {
    const formData = await request.formData();
    const cardFile = formData.get("cardImage") as File | null;
    const customBgFile = formData.get("backgroundImage") as File | null;
    const cardScaleFactor = parseFloat(formData.get("cardScale") as string || "0.75");
    const shadowStyle = (formData.get("shadowStyle") as string || "soft") as "soft" | "intense" | "glow" | "none";
    const mattingEngine = (formData.get("mattingEngine") as string || "gemini_homography") as "gemini_homography" | "ai_matting" | "tcg_cutout";

    console.log(`[Stream Card API] Params: cardFileName=${cardFile?.name || "none"}, cardFileSize=${cardFile?.size || 0} bytes, scale=${cardScaleFactor}, shadowStyle=${shadowStyle}, mattingEngine=${mattingEngine}`);

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

    const edgePaddingPx = parseInt((formData.get("edgePadding") as string) || "0", 10) || 0;
    const verticalOffsetPx = parseInt((formData.get("verticalOffset") as string) || "0", 10) || 0;
    const bottomTrimPx = parseInt((formData.get("bottomTrim") as string) || "0", 10) || 0;
    const topPaddingPx = parseInt((formData.get("topPadding") as string) || "0", 10) || 0;

    let cropBox: { x: number; y: number; width: number; height: number } | null = null;
    const cropBoxParam = formData.get("cropBox") as string | null;
    const cropX = formData.get("cropX");
    const cropY = formData.get("cropY");
    const cropW = formData.get("cropW");
    const cropH = formData.get("cropH");

    if (cropBoxParam) {
      try {
        if (cropBoxParam.startsWith("{")) {
          cropBox = JSON.parse(cropBoxParam);
        } else {
          const parts = cropBoxParam.split(",").map(Number);
          if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
            cropBox = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
          }
        }
      } catch (e) {
        console.warn("[Stream Card API] Ungültiges cropBox-Format:", cropBoxParam);
      }
    } else if (cropX !== null && cropY !== null && cropW !== null && cropH !== null) {
      cropBox = {
        x: parseFloat(cropX as string),
        y: parseFloat(cropY as string),
        width: parseFloat(cropW as string),
        height: parseFloat(cropH as string)
      };
    }

    if (cropBox) {
      console.log(`[Stream Card API] Visier-Stanzrahmen aktiv: x=${cropBox.x}, y=${cropBox.y}, w=${cropBox.width}, h=${cropBox.height}`);
    }

    // High-precision Card Cutout & AI Analysis
    let roundedCardBuffer: Buffer;
    let cardCutoutResult: CardCutoutResult;
    let usedFallback = false;

    if (cropBox) {
      console.log(`[Stream Card API] Visier-Stanzrahmen aktiv: x=${cropBox.x}, y=${cropBox.y}, w=${cropBox.width}, h=${cropBox.height}`);
      cardCutoutResult = await extractCardCutout(originalCardBuffer, {
        apiKey,
        cornerRadiusPercent: 0.038,
        edgePaddingPx,
        verticalOffsetPx,
        bottomTrimPx,
        topPaddingPx,
        cropBox
      });
      roundedCardBuffer = cardCutoutResult.cutoutCardBuffer;
    } else if (mattingEngine === "gemini_homography") {
      console.log("[Stream Card API] Starte Gemini 4-Punkt Grounding & Homographie-Entzerrung...");
      try {
        const homographyResult = await extractCardHomography(originalCardBuffer, {
          apiKey,
          targetWidth: 750,
          edgePaddingPx,
          verticalOffsetPx,
          bottomTrimPx,
          topPaddingPx,
          cropBox
        });
        roundedCardBuffer = homographyResult.cutoutBuffer;

        cardCutoutResult = {
          cutoutCardBuffer: homographyResult.cutoutBuffer,
          cutoutCardBase64: homographyResult.cutoutBase64,
          illustrationBuffer: homographyResult.cutoutBuffer,
          illustrationBase64: homographyResult.cutoutBase64,
          cardCoords: {
            x1: 0,
            y1: 0,
            x2: homographyResult.width,
            y2: homographyResult.height
          },
          illustrationCoords: {
            x1: 0,
            y1: 0,
            x2: homographyResult.width,
            y2: homographyResult.height
          },
          cardName: homographyResult.analysis.card_name || cardFile.name.replace(/\.[^/.]+$/, ""),
          cardNumber: homographyResult.analysis.collector_number || "",
          setCode: homographyResult.analysis.set_code || "",
          setName: homographyResult.analysis.set_name || "",
          sceneryDescription: homographyResult.analysis.scene_prompt || "",
          hasSampleWatermark: false,
          usedFallback: false,
          originalWidth: width,
          originalHeight: height
        };
      } catch (hErr: any) {
        console.warn("[Stream Card API] Homographie fehlgeschlagen, Fallback auf TCG Cutout:", hErr?.message || hErr);
        usedFallback = true;
        cardCutoutResult = await extractCardCutout(originalCardBuffer, {
          apiKey,
          cornerRadiusPercent: 0.038,
          edgePaddingPx,
          verticalOffsetPx,
          bottomTrimPx,
          topPaddingPx,
          cropBox
        });
        roundedCardBuffer = cardCutoutResult.cutoutCardBuffer;
      }
    } else if (mattingEngine === "ai_matting") {
      console.log("[Stream Card API] Starte paralleles AI Alpha Matting (RMBG-1.4) und TCG-Analyse...");
      const [mattedCard, cutoutData] = await Promise.all([
        (async () => {
          try {
            const matted = await removeBackgroundAI(originalCardBuffer);
            const trimmed = await sharp(matted).trim().png().toBuffer();
            console.log(`[Stream Card API] AI Alpha Matting erfolgreich abgeschlossen (${trimmed.length} Bytes).`);
            return trimmed;
          } catch (mErr: any) {
            console.warn("[Stream Card API] AI Alpha Matting fehlgeschlagen, Fallback auf TCG Cutout:", mErr?.message || mErr);
            return null;
          }
        })(),
        extractCardCutout(originalCardBuffer, {
          apiKey,
          cornerRadiusPercent: 0.038,
          edgePaddingPx,
          verticalOffsetPx,
          bottomTrimPx,
          topPaddingPx
        })
      ]);

      cardCutoutResult = cutoutData;
      if (mattedCard) {
        roundedCardBuffer = mattedCard;
        usedFallback = cardCutoutResult.usedFallback;
      } else {
        roundedCardBuffer = cardCutoutResult.cutoutCardBuffer;
        usedFallback = true;
      }
    } else {
      console.log("[Stream Card API] Verwende TCG Geometrie-Zuschnitt (Druckfarben-Anker)...");
      cardCutoutResult = await extractCardCutout(originalCardBuffer, {
        apiKey,
        cornerRadiusPercent: 0.038,
        edgePaddingPx,
        verticalOffsetPx,
        bottomTrimPx,
        topPaddingPx
      });
      roundedCardBuffer = cardCutoutResult.cutoutCardBuffer;
      usedFallback = cardCutoutResult.usedFallback;
    }

    const cardMeta = await sharp(roundedCardBuffer).metadata();
    const extractW = cardMeta.width || (cardCutoutResult.cardCoords.x2 - cardCutoutResult.cardCoords.x1);
    const extractH = cardMeta.height || (cardCutoutResult.cardCoords.y2 - cardCutoutResult.cardCoords.y1);
    const cardName = cardCutoutResult.cardName;
    const isCardBack = false;

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
      coords: cardCutoutResult.cardCoords,
      cardName,
      isCardBack,
      usedFallback: cardCutoutResult.usedFallback
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
