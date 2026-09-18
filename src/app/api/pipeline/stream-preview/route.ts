import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp, { OverlayOptions } from "sharp";
import { enrichCardMetadata, CardMetadata } from "@/utils/tcgDatabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Helper to generate SVG Stream Preview frame & typography overlay
function buildStreamPreviewSvg(metadata: CardMetadata, width = 1024, height = 1024): Buffer {
  const line1 = [metadata.cardName, metadata.cardNumber, metadata.setCode].filter(Boolean).join(" - ");
  const line2 = metadata.setName || "";
  const line3 = metadata.slogan || "MANACARDS – Unpack the magic";

  // Escape special XML characters in text
  const escapeXml = (str: string) =>
    str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  const safeLine1 = escapeXml(line1);
  const safeLine2 = escapeXml(line2);
  const safeLine3 = escapeXml(line3);

  // Dynamic font sizing for long card names
  let line1FontSize = 42;
  if (safeLine1.length > 30) line1FontSize = 34;
  if (safeLine1.length > 40) line1FontSize = 28;

  let line2FontSize = 34;
  if (safeLine2.length > 25) line2FontSize = 28;
  if (safeLine2.length > 35) line2FontSize = 24;

  const svgContent = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Stream Preview Accent Glow Gradient -->
    <linearGradient id="lineGlow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f472b6" stop-opacity="0.9" />
      <stop offset="50%" stop-color="#c084fc" stop-opacity="0.8" />
      <stop offset="100%" stop-color="#f472b6" stop-opacity="0.9" />
    </linearGradient>

    <!-- Bottom Vignette for text contrast -->
    <linearGradient id="bottomVignette" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0" />
      <stop offset="25%" stop-color="#000000" stop-opacity="0.38" />
      <stop offset="65%" stop-color="#000000" stop-opacity="0.82" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0.95" />
    </linearGradient>

    <!-- Top Vignette for STREAM PREVIEW badge -->
    <linearGradient id="topVignette" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.65" />
      <stop offset="60%" stop-color="#000000" stop-opacity="0.25" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0" />
    </linearGradient>

    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>

  <!-- Top Vignette -->
  <rect x="0" y="0" width="${width}" height="120" fill="url(#topVignette)" />

  <!-- Bottom Dark Vignette for Text Contrast -->
  <rect x="0" y="680" width="${width}" height="344" fill="url(#bottomVignette)" />

  <!-- Top Left Badge -->
  <text x="42" y="55" font-family="Arial, Helvetica, sans-serif" font-size="23" font-weight="800" fill="#ffffff" letter-spacing="1.2">STREAM PREVIEW</text>

  <!-- Framing Neon Lines -->
  <!-- Top & Right framing path -->
  <path d="M 42 68 L 944 68 Q 980 68 980 104 L 980 916 Q 980 950 944 950 L 780 950" fill="none" stroke="url(#lineGlow)" stroke-width="1.8" filter="url(#glow)" />
  
  <!-- Left & Bottom framing path -->
  <path d="M 42 68 L 42 916 Q 42 950 78 950 L 244 950" fill="none" stroke="url(#lineGlow)" stroke-width="1.8" filter="url(#glow)" />

  <!-- Outer side accent brackets -->
  <path d="M 26 120 L 26 880 Q 26 915 52 915 L 70 915" fill="none" stroke="url(#lineGlow)" stroke-width="1.2" opacity="0.55" />
  <path d="M 998 120 L 998 880 Q 998 915 972 915 L 954 915" fill="none" stroke="url(#lineGlow)" stroke-width="1.2" opacity="0.55" />

  <!-- Line 1: Card Name - Number - Set Code -->
  <text x="512" y="868" font-family="Arial, Helvetica, sans-serif" font-size="${line1FontSize}" font-weight="800" fill="#ffffff" text-anchor="middle">${safeLine1}</text>

  <!-- Line 2: Set Name -->
  <text x="512" y="912" font-family="Arial, Helvetica, sans-serif" font-size="${line2FontSize}" font-weight="700" fill="#ffffff" text-anchor="middle">${safeLine2}</text>

  <!-- Line 3: Bottom Slogan flanked with accent lines -->
  <line x1="80" y1="948" x2="236" y2="948" stroke="url(#lineGlow)" stroke-width="1.5" />
  <text x="512" y="954" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="500" fill="#ffffff" letter-spacing="1.2" text-anchor="middle">${safeLine3}</text>
  <line x1="788" y1="948" x2="944" y2="948" stroke="url(#lineGlow)" stroke-width="1.5" />
</svg>`;

  return Buffer.from(svgContent);
}

// Programmatic computer-vision card detector fallback
async function detectCardBordersCV(
  cardBuffer: Buffer,
  width: number,
  height: number
): Promise<{ x1: number; y1: number; x2: number; y2: number }> {
  try {
    const trimmed = await sharp(cardBuffer).trim().toBuffer({ resolveWithObject: true });
    const offsetLeft = typeof trimmed.info.trimOffsetLeft === "number" ? Math.max(0, trimmed.info.trimOffsetLeft) : 0;
    const offsetTop = typeof trimmed.info.trimOffsetTop === "number" ? Math.max(0, trimmed.info.trimOffsetTop) : 0;
    const trimW = trimmed.info.width || width;
    const trimH = trimmed.info.height || height;

    if (trimW >= width * 0.35 && trimH >= height * 0.35) {
      return {
        x1: offsetLeft,
        y1: offsetTop,
        x2: Math.min(width, offsetLeft + trimW),
        y2: Math.min(height, offsetTop + trimH)
      };
    }
  } catch (err) {
    console.warn("[Stream Preview CV] Trim failed:", err);
  }

  return { x1: 0, y1: 0, x2: width, y2: height };
}

// Helper to composite Card + Shadow + SVG Overlay on top of Background
async function compositeStreamPreviewLayers(params: {
  backgroundBuffer: Buffer;
  cutoutCardBuffer: Buffer;
  metadata: CardMetadata;
  cardScale?: number;
  shadowStyle?: "soft" | "intense" | "glow" | "none";
  cardCenterYRatio?: number; // default ~0.47
}): Promise<Buffer> {
  const {
    backgroundBuffer,
    cutoutCardBuffer,
    metadata,
    cardScale = 0.68,
    shadowStyle = "soft",
    cardCenterYRatio = 0.47
  } = params;

  const bgMetadata = await sharp(backgroundBuffer).metadata();
  const bgWidth = bgMetadata.width || 1024;
  const bgHeight = bgMetadata.height || 1024;

  const cardMetadata = await sharp(cutoutCardBuffer).metadata();
  const rawCardW = cardMetadata.width || 500;
  const rawCardH = cardMetadata.height || 700;

  // Scale card appropriately on 1024x1024 canvas
  const clampedScale = Math.max(0.5, Math.min(0.82, cardScale));
  let targetCardH = Math.round(bgHeight * clampedScale);
  let targetCardW = Math.round((rawCardW / rawCardH) * targetCardH);

  const maxW = Math.round(bgWidth * 0.75);
  if (targetCardW > maxW) {
    targetCardW = maxW;
    targetCardH = Math.round((rawCardH / rawCardW) * targetCardW);
  }

  const resizedCardBuffer = await sharp(cutoutCardBuffer)
    .resize(targetCardW, targetCardH)
    .png()
    .toBuffer();

  const compositeLayers: OverlayOptions[] = [];

  // 1. Shadow Layer
  if (shadowStyle !== "none") {
    const shadowPadding = Math.max(12, Math.min(40, Math.round(targetCardW * 0.08)));
    const shadowW = targetCardW + shadowPadding * 2;
    const shadowH = targetCardH + shadowPadding * 2;
    const shadowRadius = Math.round(targetCardW * 0.038);

    let shadowAlpha = 0.65;
    let shadowR = 0;
    let shadowG = 0;
    let shadowB = 0;
    let blurSigma = Math.max(10, Math.min(26, Math.round(shadowPadding * 0.65)));

    if (shadowStyle === "intense") {
      shadowAlpha = 0.85;
      blurSigma = Math.max(12, Math.min(28, Math.round(shadowPadding * 0.75)));
    } else if (shadowStyle === "glow") {
      shadowR = 210;
      shadowG = 90;
      shadowB = 240;
      shadowAlpha = 0.75;
    }

    const shadowMask = Buffer.from(
      `<svg width="${targetCardW}" height="${targetCardH}"><rect x="0" y="0" width="${targetCardW}" height="${targetCardH}" rx="${shadowRadius}" ry="${shadowRadius}" fill="white"/></svg>`
    );

    const innerShadow = await sharp({
      create: {
        width: targetCardW,
        height: targetCardH,
        channels: 4,
        background: { r: shadowR, g: shadowG, b: shadowB, alpha: shadowAlpha }
      }
    })
      .composite([{ input: shadowMask, blend: "dest-in" }])
      .png()
      .toBuffer();

    const shadowLayer = await sharp({
      create: {
        width: shadowW,
        height: shadowH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([{ input: innerShadow, top: shadowPadding, left: shadowPadding }])
      .blur(blurSigma)
      .png()
      .toBuffer();

    const cardWithShadow = await sharp(shadowLayer)
      .composite([{ input: resizedCardBuffer, top: shadowPadding, left: shadowPadding }])
      .png()
      .toBuffer();

    const finalCenterY = Math.round(bgHeight * cardCenterYRatio);
    const finalTop = Math.max(40, Math.round(finalCenterY - shadowH / 2));
    const finalLeft = Math.round((bgWidth - shadowW) / 2);

    compositeLayers.push({
      input: cardWithShadow,
      top: finalTop,
      left: finalLeft
    });
  } else {
    const finalCenterY = Math.round(bgHeight * cardCenterYRatio);
    const finalTop = Math.max(40, Math.round(finalCenterY - targetCardH / 2));
    const finalLeft = Math.round((bgWidth - targetCardW) / 2);

    compositeLayers.push({
      input: resizedCardBuffer,
      top: finalTop,
      left: finalLeft
    });
  }

  // 2. Stream Preview SVG Overlay
  const overlaySvgBuffer = buildStreamPreviewSvg(metadata, bgWidth, bgHeight);
  compositeLayers.push({
    input: overlaySvgBuffer,
    top: 0,
    left: 0
  });

  return await sharp(backgroundBuffer)
    .composite(compositeLayers)
    .png({ quality: 95, compressionLevel: 7 })
    .toBuffer();
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";

    // CASE 1: Quick Re-composite request (JSON payload with edited metadata)
    if (contentType.includes("application/json")) {
      const jsonBody = await request.json();
      const {
        backgroundImage,
        cutoutImage,
        metadata: rawMetadata,
        cardScale = 0.68,
        shadowStyle = "soft"
      } = jsonBody;

      if (!backgroundImage || !cutoutImage) {
        return NextResponse.json(
          { error: "Hintergrundbild oder freigestellte Karte fehlt für die Neukomposition." },
          { status: 400 }
        );
      }

      const bgBase64 = backgroundImage.includes(",") ? backgroundImage.split(",")[1] : backgroundImage;
      const cutoutBase64 = cutoutImage.includes(",") ? cutoutImage.split(",")[1] : cutoutImage;

      const bgBuffer = Buffer.from(bgBase64, "base64");
      const cutoutBuffer = Buffer.from(cutoutBase64, "base64");

      const enrichedMetadata = enrichCardMetadata(rawMetadata || {});

      const resultBuffer = await compositeStreamPreviewLayers({
        backgroundBuffer: bgBuffer,
        cutoutCardBuffer: cutoutBuffer,
        metadata: enrichedMetadata,
        cardScale: Number(cardScale) || 0.68,
        shadowStyle
      });

      return NextResponse.json({
        resultImageUrl: `data:image/png;base64,${resultBuffer.toString("base64")}`,
        metadata: enrichedMetadata
      });
    }

    // CASE 2: Full generation request from FormData
    const formData = await request.formData();
    const cardFile = formData.get("cardImage") as File | null;
    const customBgFile = formData.get("backgroundImage") as File | null;
    const cardScale = parseFloat((formData.get("cardScale") as string) || "0.68");
    const shadowStyle = ((formData.get("shadowStyle") as string) || "soft") as "soft" | "intense" | "glow" | "none";

    const apiKey =
      (formData.get("apiKey") as string) ||
      request.headers.get("x-gemini-api-key") ||
      process.env.GEMINI_API_KEY;

    if (!cardFile) {
      return NextResponse.json({ error: "Keine Bilddatei hochgeladen." }, { status: 400 });
    }

    if (!apiKey) {
      return NextResponse.json(
        { error: "Kein Google Gemini API-Key gefunden. Bitte trage deinen API-Key in den Einstellungen ein." },
        { status: 400 }
      );
    }

    const ai = new GoogleGenAI({ apiKey });

    // Read and normalize card image buffer
    const cardArrayBuffer = await cardFile.arrayBuffer();
    const rawCardBuffer = Buffer.from(cardArrayBuffer);
    const originalCardBuffer = await sharp(rawCardBuffer).rotate().toBuffer();

    const originalMetadata = await sharp(originalCardBuffer).metadata();
    const width = originalMetadata.width || 0;
    const height = originalMetadata.height || 0;

    if (width === 0 || height === 0) {
      return NextResponse.json({ error: "Bildabmessungen konnten nicht ermittelt werden." }, { status: 400 });
    }

    const base64Image = originalCardBuffer.toString("base64");
    let mimeType = cardFile.type || "image/jpeg";
    if (mimeType === "image/jpg") mimeType = "image/jpeg";

    // STEP 1: AI Vision Layout Analysis & Metadata OCR
    const models = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"];
    let layoutText = "";

    const visionPrompt = `You are a high-precision Computer Vision model specialized in Trading Card Game (TCG) analysis (Pokémon, One Piece, Yu-Gi-Oh, Magic: The Gathering, Lorcana).
Image dimensions: ${width}x${height} pixels.

CRITICAL INSTRUCTIONS:
1. "card": Locate the EXACT bounding box [ymin, xmin, ymax, xmax] (integers 0-1000) of the physical cardboard card itself. Exclude transparent sleeve overhangs, scanner glass, or background.
2. "illustration": Locate the bounding box [ymin, xmin, ymax, xmax] (integers 0-1000) of the inner artwork illustration.
3. "cardName": Extract the official English TCG name of this card/character (translate Japanese, Korean, Chinese names to their official English name e.g. 'モルペコ' -> 'Morpeko', 'リザードン' -> 'Charizard').
4. "cardNumber": Locate the collector/card number printed at the bottom corner (e.g. '076/066', '151/165', 'OP05-119').
5. "setCode": Extract the set registration code or symbol printed at the bottom corner (e.g. 'SV4K', 'SV2a', 'MEW', 'OP05', 'OBF', 'PAL', 'S12a').
6. "setName": Identify the official English set name for this card and set code (e.g. 'Ancient Roar', 'Pokémon Card 151', 'Paradox Rift', 'Awakening of the New Era', 'Shiny Treasure ex').`;

    for (const model of models) {
      try {
        console.log(`[Stream Preview API] Trying model ${model} for vision analysis...`);
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              inlineData: {
                data: base64Image,
                mimeType
              }
            },
            visionPrompt
          ],
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                box_2d: {
                  type: "array",
                  items: { type: "integer" },
                  description: "Bounding box of the physical trading card as [ymin, xmin, ymax, xmax] (0-1000)."
                },
                illustration_box: {
                  type: "array",
                  items: { type: "integer" },
                  description: "Bounding box of the inner illustration as [ymin, xmin, ymax, xmax] (0-1000)."
                },
                cardName: { type: "string" },
                cardNumber: { type: "string" },
                setCode: { type: "string" },
                setName: { type: "string" }
              },
              required: ["cardName", "cardNumber", "setCode"]
            }
          }
        });

        if (response.text) {
          layoutText = response.text;
          break;
        }
      } catch (err: any) {
        console.warn(`[Stream Preview API] Model ${model} vision call failed:`, err?.message || err);
      }
    }

    let detectedCardCoords: { x1: number; y1: number; x2: number; y2: number } | null = null;
    let detectedIllustrationCoords: { x1: number; y1: number; x2: number; y2: number } | null = null;
    let rawCardName = "";
    let rawCardNumber = "";
    let rawSetCode = "";
    let rawSetName = "";
    let usedFallback = false;

    if (layoutText) {
      try {
        const parsed = JSON.parse(layoutText);
        rawCardName = parsed.cardName || "";
        rawCardNumber = parsed.cardNumber || "";
        rawSetCode = parsed.setCode || "";
        rawSetName = parsed.setName || "";

        if (parsed.box_2d && Array.isArray(parsed.box_2d) && parsed.box_2d.length === 4) {
          const [ymin, xmin, ymax, xmax] = parsed.box_2d.map(Number);
          detectedCardCoords = {
            x1: Math.round((xmin / 1000) * width),
            y1: Math.round((ymin / 1000) * height),
            x2: Math.round((xmax / 1000) * width),
            y2: Math.round((ymax / 1000) * height)
          };
        }

        if (parsed.illustration_box && Array.isArray(parsed.illustration_box) && parsed.illustration_box.length === 4) {
          const [ymin, xmin, ymax, xmax] = parsed.illustration_box.map(Number);
          detectedIllustrationCoords = {
            x1: Math.round((xmin / 1000) * width),
            y1: Math.round((ymin / 1000) * height),
            x2: Math.round((xmax / 1000) * width),
            y2: Math.round((ymax / 1000) * height)
          };
        }
      } catch (e) {
        console.warn("[Stream Preview API] JSON parse failed:", e);
      }
    }

    // Fallback detection if AI coords missing
    if (!detectedCardCoords || detectedCardCoords.x2 - detectedCardCoords.x1 < 50) {
      usedFallback = true;
      detectedCardCoords = await detectCardBordersCV(originalCardBuffer, width, height);
    }

    // Normalize aspect ratio if needed
    const cardW = detectedCardCoords.x2 - detectedCardCoords.x1;
    const cardH = detectedCardCoords.y2 - detectedCardCoords.y1;
    let cx1 = detectedCardCoords.x1;
    let cy1 = detectedCardCoords.y1;
    let cx2 = detectedCardCoords.x2;
    let cy2 = detectedCardCoords.y2;

    if (cardW > 0 && cardH > 0) {
      const ratio = cardW / cardH;
      const centerX = (cx1 + cx2) / 2;
      const centerY = (cy1 + cy2) / 2;
      if (ratio < 0.60 || ratio > 0.85) {
        const TARGET_RATIO = 0.714;
        if (ratio > TARGET_RATIO) {
          const newW = cardH * TARGET_RATIO;
          cx1 = Math.round(centerX - newW / 2);
          cx2 = Math.round(centerX + newW / 2);
        } else {
          const newH = cardW / TARGET_RATIO;
          cy1 = Math.round(centerY - newH / 2);
          cy2 = Math.round(centerY + newH / 2);
        }
      }
    }

    // Strict clamping
    cx1 = Math.max(0, Math.min(cx1, width - 1));
    cy1 = Math.max(0, Math.min(cy1, height - 1));
    cx2 = Math.max(cx1 + 1, Math.min(cx2, width));
    cy2 = Math.max(cy1 + 1, Math.min(cy2, height));

    const finalCardW = cx2 - cx1;
    const finalCardH = cy2 - cy1;

    // STEP 2: Extract Card Cutout with rounded corners
    const extractedCard = await sharp(originalCardBuffer)
      .extract({ left: cx1, top: cy1, width: finalCardW, height: finalCardH })
      .png()
      .toBuffer();

    const cornerRadius = Math.max(2, Math.round(finalCardW * 0.038));
    const roundedMask = Buffer.from(
      `<svg width="${finalCardW}" height="${finalCardH}"><rect x="0" y="0" width="${finalCardW}" height="${finalCardH}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/></svg>`
    );

    const roundedCardBuffer = await sharp(extractedCard)
      .ensureAlpha()
      .composite([{ input: roundedMask, blend: "dest-in" }])
      .png({ compressionLevel: 7 })
      .toBuffer();

    // STEP 3: Enrich card metadata using TCG Database
    const enrichedMetadata = enrichCardMetadata({
      cardName: rawCardName || cardFile.name.replace(/\.[^/.]+$/, ""),
      cardNumber: rawCardNumber,
      setCode: rawSetCode,
      setName: rawSetName
    });

    // STEP 4: Background Outpainting (or custom background if uploaded)
    let backgroundBuffer: Buffer | null = null;

    if (customBgFile && typeof (customBgFile as any).arrayBuffer === "function") {
      try {
        const customBgArrayBuf = await customBgFile.arrayBuffer();
        backgroundBuffer = await sharp(Buffer.from(customBgArrayBuf))
          .resize(1024, 1024, { fit: "cover" })
          .jpeg({ quality: 90 })
          .toBuffer();
      } catch (bgErr) {
        console.warn("[Stream Preview API] Custom background read failed:", bgErr);
      }
    }

    if (!backgroundBuffer) {
      // Extract inner illustration or upper half for style analysis & outpainting
      let ix1 = detectedIllustrationCoords?.x1 ?? (cx1 + Math.round(finalCardW * 0.1));
      let iy1 = detectedIllustrationCoords?.y1 ?? (cy1 + Math.round(finalCardH * 0.12));
      let ix2 = detectedIllustrationCoords?.x2 ?? (cx1 + Math.round(finalCardW * 0.9));
      let iy2 = detectedIllustrationCoords?.y2 ?? (cy1 + Math.round(finalCardH * 0.6));

      ix1 = Math.max(0, Math.min(ix1, width - 1));
      iy1 = Math.max(0, Math.min(iy1, height - 1));
      ix2 = Math.max(ix1 + 1, Math.min(ix2, width));
      iy2 = Math.max(iy1 + 1, Math.min(iy2, height));

      const croppedIllustrationBuffer = await sharp(originalCardBuffer)
        .extract({ left: ix1, top: iy1, width: ix2 - ix1, height: iy2 - iy1 })
        .resize(512, 512, { fit: "inside" })
        .jpeg({ quality: 85 })
        .toBuffer();

      const illustrationBase64 = croppedIllustrationBuffer.toString("base64");

      try {
        // Style description prompt
        const describePrompt = `Analyze this trading card artwork illustration. Describe the environmental scenery, backdrop elements, aesthetic art style, color palette, brushstrokes, and lighting. You MUST ignore all characters, text, numbers, and card borders. Return only the descriptive scenery prompt for background generation.`;

        let description = "";
        for (const model of models) {
          try {
            const descRes = await ai.models.generateContent({
              model,
              contents: [
                {
                  inlineData: {
                    data: illustrationBase64,
                    mimeType: "image/jpeg"
                  }
                },
                describePrompt
              ]
            });
            if (descRes.text) {
              description = descRes.text;
              break;
            }
          } catch (e: any) {
            console.warn(`[Stream Preview Outpaint] Describer ${model} failed:`, e?.message || e);
          }
        }

        const sanitizedDesc = (description || "Fantasy scenery background in vibrant colorful aesthetic")
          .replace(/\b(kill|blood|dead|die|sword|weapon|fight|attack|monster|devil|demon|gun|stab|wound|hurt|gore|blade|combat)\b/gi, "fantasy motif")
          .trim();

        const outpaintPrompt = `A beautiful, high-quality scenery backdrop: ${sanitizedDesc}. High quality, detailed, continuous landscape in the same anime aesthetic and art style. Exclude any characters, card borders, or text.`;

        // Generate with Imagen 3
        try {
          console.log(`[Stream Preview API] Generating 1:1 backdrop with Imagen 3...`);
          const imagenRes = await ai.models.generateImages({
            model: "imagen-3.0-generate-002",
            prompt: outpaintPrompt,
            config: {
              numberOfImages: 1,
              aspectRatio: "1:1",
              outputMimeType: "image/jpeg"
            }
          });
          const imgBytes = imagenRes.generatedImages?.[0]?.image?.imageBytes;
          if (imgBytes) {
            backgroundBuffer = Buffer.from(imgBytes, "base64");
          }
        } catch (imgErr: any) {
          console.warn("[Stream Preview API] Imagen 3 failed, attempting Gemini 2.0 Flash Exp:", imgErr?.message || imgErr);
        }

        // Generate with Gemini 2.0 Flash Exp fallback
        if (!backgroundBuffer) {
          try {
            const geminiImgRes = await ai.models.generateContent({
              model: "gemini-2.0-flash-exp",
              contents: [outpaintPrompt],
              config: {
                responseModalities: ["IMAGE"],
                imageConfig: { aspectRatio: "1:1" }
              }
            });
            const parts = geminiImgRes.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                backgroundBuffer = Buffer.from(part.inlineData.data, "base64");
                break;
              }
            }
          } catch (gErr: any) {
            console.warn("[Stream Preview API] Gemini image generation failed:", gErr?.message || gErr);
          }
        }
      } catch (outpaintErr) {
        console.warn("[Stream Preview API] AI outpainting failed:", outpaintErr);
      }

      // Bulletproof ambient blur fallback
      if (!backgroundBuffer) {
        console.log("[Stream Preview API] Using soft ambient Gaussian blur fallback backdrop.");
        usedFallback = true;
        backgroundBuffer = await sharp(croppedIllustrationBuffer)
          .resize(1024, 1024, { fit: "cover" })
          .blur(45)
          .modulate({ brightness: 0.65, saturation: 0.9 })
          .jpeg({ quality: 90 })
          .toBuffer();
      }
    }

    // STEP 5: Composite Card + Shadow + Stream Preview SVG Overlay
    const finalResultBuffer = await compositeStreamPreviewLayers({
      backgroundBuffer,
      cutoutCardBuffer: roundedCardBuffer,
      metadata: enrichedMetadata,
      cardScale,
      shadowStyle
    });

    const resultImageUrl = `data:image/png;base64,${finalResultBuffer.toString("base64")}`;
    const cutoutImageUrl = `data:image/png;base64,${roundedCardBuffer.toString("base64")}`;
    const backgroundImageUrl = `data:image/jpeg;base64,${backgroundBuffer.toString("base64")}`;

    return NextResponse.json({
      resultImageUrl,
      cutoutImageUrl,
      backgroundImageUrl,
      metadata: enrichedMetadata,
      usedFallback
    });
  } catch (error: any) {
    console.error("[Stream Preview API] Critical Error:", error);
    return NextResponse.json(
      { error: `Stream-Preview-Fehler: ${error.message || "Unbekannter Verarbeitungsfehler."}` },
      { status: 500 }
    );
  }
}
