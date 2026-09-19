import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp, { OverlayOptions } from "sharp";
import { enrichCardMetadata, CardMetadata } from "@/utils/tcgDatabase";
import { buildStreamPreviewVectorSvg } from "@/utils/svgVectorText";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Helper to call generateContent with retry on transient errors (503, 429)
async function generateContentWithRetry(ai: any, params: any, retries = 2, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await ai.models.generateContent(params);
    } catch (e: any) {
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
        console.warn(`[Stream Preview API] Transient error: "${errorStr}". Retrying in ${waitTime}ms...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Failed to generate content after retries.");
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
  cardCenterYRatio?: number; // default ~0.46
}): Promise<Buffer> {
  const {
    backgroundBuffer,
    cutoutCardBuffer,
    metadata,
    cardScale = 0.68,
    shadowStyle = "soft",
    cardCenterYRatio = 0.46
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

  const maxW = Math.round(bgWidth * 0.72);
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
    const shadowPadding = Math.max(16, Math.min(48, Math.round(targetCardW * 0.09)));
    const shadowW = targetCardW + shadowPadding * 2;
    const shadowH = targetCardH + shadowPadding * 2;
    const shadowRadius = Math.round(targetCardW * 0.038);

    let shadowAlpha = 0.75;
    let shadowR = 0;
    let shadowG = 0;
    let shadowB = 0;
    let blurSigma = Math.max(12, Math.min(28, Math.round(shadowPadding * 0.68)));

    if (shadowStyle === "intense") {
      shadowAlpha = 0.90;
      blurSigma = Math.max(14, Math.min(30, Math.round(shadowPadding * 0.78)));
    } else if (shadowStyle === "glow") {
      shadowR = 210;
      shadowG = 90;
      shadowB = 240;
      shadowAlpha = 0.80;
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

  // 2. Stream Preview Pure Vector SVG Overlay (Zero fontconfig dependency, no tofu boxes)
  const overlaySvgBuffer = buildStreamPreviewVectorSvg(metadata, bgWidth, bgHeight);
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
    const models = ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-1.5-flash", "gemini-1.5-flash-latest", "gemini-1.5-pro"];
    let layoutText = "";

    // Robust AI Vision Detection using Google Gemini REST API & SDK
    const visionPrompt = `The dimensions of the uploaded image are ${width}x${height} pixels. Please analyze this Trading Card Game (TCG) image:
1. "box_2d": Bounding box coordinates [ymin, xmin, ymax, xmax] as 4 integers normalized from 0 to 1000 (0=top/left, 1000=bottom/right) of the physical cardboard trading card.
   CRITICAL RULES:
   - Identify the actual cardboard card frame / rectangle.
   - Exclude and ignore any external semi-rigid card savers, top loaders, magnetic cases, penny sleeves, grading slabs, scanner glass, or background tables.
   - The bounding box must wrap the entire physical printed trading card from top border to bottom border!
2. "illustration_box": Bounding box coordinates [ymin, xmin, ymax, xmax] as 4 integers normalized from 0 to 1000 of the inner artwork illustration inside the card frame.
3. "cardName": Extract the official English TCG name of this card/character (translate Japanese e.g. 'デンリュウ' -> 'Ampharos', 'ワンパチ' -> 'Yamper', 'モルペコ' -> 'Morpeko', 'リザードン' -> 'Charizard').
4. "cardNumber": Locate the collector/card number printed at the bottom corner (e.g. '088/083', '086/080', '076/066', '151/165').
5. "setCode": Extract the set registration code or symbol printed at the bottom corner (e.g. 'SV8', 'SV9', 'SV4K', 'SV4a', 'SV2a', 'OP05', 'OBF', 'PAL', 'S12a').
6. "setName": Identify the official English set name for this card and set code (e.g. 'Supercharged Breaker', 'Battle Partners', 'Ancient Roar', 'Paldean Fates', 'Pokémon Card 151').`;

    // Try REST fetch first for maximum reliability across serverless environments
    for (const model of models) {
      try {
        console.log(`[Stream Preview API] Trying model ${model} for vision analysis...`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const payload = {
          contents: [
            {
              parts: [
                { inlineData: { mimeType, data: base64Image } },
                { text: visionPrompt }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                box_2d: {
                  type: "ARRAY",
                  items: { type: "INTEGER" },
                  description: "Bounding box of the physical trading card as [ymin, xmin, ymax, xmax] integers 0-1000."
                },
                illustration_box: {
                  type: "ARRAY",
                  items: { type: "INTEGER" },
                  description: "Bounding box of the inner illustration as [ymin, xmin, ymax, xmax] integers 0-1000."
                },
                cardName: { type: "STRING" },
                cardNumber: { type: "STRING" },
                setCode: { type: "STRING" },
                setName: { type: "STRING" }
              },
              required: ["cardName", "cardNumber", "setCode"]
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
      } catch (err: any) {
        console.warn(`[Stream Preview API] Model ${model} REST call failed:`, err?.message || err);
      }
    }

    // Fallback to @google/genai SDK if REST didn't return text
    if (!layoutText) {
      for (const model of models) {
        try {
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
              responseMimeType: "application/json"
            }
          });

          if (response.text) {
            layoutText = response.text;
            break;
          }
        } catch (sdkErr: any) {
          console.warn(`[Stream Preview API] SDK ${model} failed:`, sdkErr?.message || sdkErr);
        }
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

    // Robust Card Bounding Box Extraction:
    // Extract the physical cardboard card itself, stripping away any plastic card savers, penny sleeves, or scanner background.
    let cx1 = 0;
    let cy1 = 0;
    let cx2 = width;
    let cy2 = height;

    if (detectedCardCoords) {
      cx1 = detectedCardCoords.x1;
      cy1 = detectedCardCoords.y1;
      cx2 = detectedCardCoords.x2;
      cy2 = detectedCardCoords.y2;

      const detectedW = cx2 - cx1;
      const detectedH = cy2 - cy1;

      // Only skip cropping if the card truly occupies >= 98% of the image (direct borderless scan)
      if (detectedW >= width * 0.98 && detectedH >= height * 0.98 && cx1 <= width * 0.015 && cy1 <= height * 0.015) {
        cx1 = 0;
        cy1 = 0;
        cx2 = width;
        cy2 = height;
      } else if (detectedW > 0 && detectedH > 0) {
        const detectedRatio = detectedW / detectedH;
        // If detected box is square/horizontal (Gemini only detected top illustration), expand vertically to standard card ratio 0.714
        if (detectedRatio > 0.82) {
          const expectedH = Math.round(detectedW / 0.714);
          cy2 = Math.min(height, cy1 + expectedH);
          if (cy1 + expectedH > height) {
            cy1 = Math.max(0, height - expectedH);
          }
        } else if (detectedRatio < 0.58) {
          const expectedW = Math.round(detectedH * 0.714);
          const centerX = (cx1 + cx2) / 2;
          cx1 = Math.max(0, Math.round(centerX - expectedW / 2));
          cx2 = Math.min(width, Math.round(centerX + expectedW / 2));
        }
      }
    }

    // Strict clamping to image bounds
    cx1 = Math.max(0, Math.min(cx1, width - 1));
    cy1 = Math.max(0, Math.min(cy1, height - 1));
    cx2 = Math.max(cx1 + 1, Math.min(cx2, width));
    cy2 = Math.max(cy1 + 1, Math.min(cy2, height));

    const finalCardW = cx2 - cx1;
    const finalCardH = cy2 - cy1;

    console.log(`[Stream Preview API] Card cutout bounds: x1=${cx1}, y1=${cy1}, x2=${cx2}, y2=${cy2} (${finalCardW}x${finalCardH} from original ${width}x${height})`);

    // STEP 2: Extract Full Card Cutout with rounded corners
    const extractedCard = await sharp(originalCardBuffer)
      .extract({ left: cx1, top: cy1, width: finalCardW, height: finalCardH })
      .png()
      .toBuffer();

    const cornerRadius = Math.max(4, Math.round(finalCardW * 0.038));
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
      // Extract inner illustration for style analysis & outpainting
      let ix1 = detectedIllustrationCoords?.x1 ?? (cx1 + Math.round(finalCardW * 0.1));
      let iy1 = detectedIllustrationCoords?.y1 ?? (cy1 + Math.round(finalCardH * 0.12));
      let ix2 = detectedIllustrationCoords?.x2 ?? (cx1 + Math.round(finalCardW * 0.9));
      let iy2 = detectedIllustrationCoords?.y2 ?? (cy1 + Math.round(finalCardH * 0.58));

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
        const describePrompt = `Analyze this trading card illustration. Write a vivid, detailed prompt describing ONLY the environment scenery, landscape, room setting, background elements, artistic style (e.g. anime watercolor, vibrant fantasy digital art), color palette, lighting, and general aesthetic. You MUST completely ignore and exclude any characters, pokemon creatures, figures, humans, text, or card borders in the illustration—do NOT describe them at all. Return only the descriptive prompt for the background scenery.`;

        let description = "";

        // 1. Direct REST fetch for description
        for (const model of models) {
          try {
            console.log(`[Stream Preview Outpaint] Describing style via REST ${model}...`);
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
            const payload = {
              contents: [
                {
                  parts: [
                    { inlineData: { mimeType: "image/jpeg", data: illustrationBase64 } },
                    { text: describePrompt }
                  ]
                }
              ]
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
                description = text;
                break;
              }
            }
          } catch (e: any) {
            console.warn(`[Stream Preview Outpaint] REST describer ${model} failed:`, e?.message || e);
          }
        }

        // 2. SDK fallback for description
        if (!description) {
          for (const model of models) {
            try {
              const descRes = await generateContentWithRetry(ai, {
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
              console.warn(`[Stream Preview Outpaint] SDK describer ${model} failed:`, e?.message || e);
            }
          }
        }

        // Clean and construct the Imagen 3 expansion prompt
        const cleanDesc = (description || "Fantasy scenery background in vibrant colorful aesthetic")
          .replace(/^(here is a prompt|prompt:|description:|sure, here is|an anime)/gi, "")
          .replace(/\b(kill|blood|dead|die|sword|weapon|fight|attack|monster|devil|demon|gun|stab|wound|hurt|gore|blade|combat)\b/gi, "fantasy motif")
          .trim();

        const outpaintPrompt = `Anime scenery wallpaper, seamless extended background environment: ${cleanDesc}. Vibrant, highly detailed fantasy environment, beautiful lighting, consistent color palette, masterwork art style. Exclude all characters, figures, pokemon, text, symbols, and card borders.`;

        console.log(`[Stream Preview API] Outpainting prompt: "${outpaintPrompt.slice(0, 160)}..."`);

        // 1. Primary: Generate 1:1 backdrop with Imagen 3 via Direct REST API
        const imagenModels = ["imagen-3.0-generate-002", "imagen-3.0-generate-001", "imagen-3.0-fast-generate-001"];
        for (const imagenModel of imagenModels) {
          try {
            console.log(`[Stream Preview API] Attempting REST predict with ${imagenModel}...`);
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${imagenModel}:predict?key=${encodeURIComponent(apiKey)}`;
            const payload = {
              instances: [
                { prompt: outpaintPrompt }
              ],
              parameters: {
                sampleCount: 1,
                aspectRatio: "1:1",
                safetySetting: "block_only_high",
                outputOptions: {
                  mimeType: "image/jpeg"
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
              const bytes = json?.predictions?.[0]?.bytesBase64Encoded;
              if (bytes) {
                backgroundBuffer = Buffer.from(bytes, "base64");
                console.log(`[Stream Preview API] REST ${imagenModel} generated backdrop successfully (${backgroundBuffer.length} bytes).`);
                break;
              }
            } else {
              const errBody = await res.text();
              console.warn(`[Stream Preview API] REST ${imagenModel} HTTP ${res.status}:`, errBody.slice(0, 200));
            }
          } catch (restImgErr: any) {
            console.warn(`[Stream Preview API] REST ${imagenModel} failed:`, restImgErr?.message || restImgErr);
          }
        }

        // 2. Secondary: Generate with Imagen 3 via @google/genai SDK
        if (!backgroundBuffer) {
          for (const imagenModel of imagenModels) {
            try {
              console.log(`[Stream Preview API] Attempting SDK generateImages with ${imagenModel}...`);
              const imagenRes = await ai.models.generateImages({
                model: imagenModel,
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
                console.log(`[Stream Preview API] SDK ${imagenModel} generated backdrop successfully.`);
                break;
              }
            } catch (imgErr: any) {
              console.warn(`[Stream Preview API] SDK ${imagenModel} failed:`, imgErr?.message || imgErr);
            }
          }
        }

        // 3. Tertiary: Generate with Gemini Multimodal Image fallback
        if (!backgroundBuffer) {
          const fallbackImageModels = ["gemini-3.6-flash", "gemini-2.5-flash"];
          for (const imgModel of fallbackImageModels) {
            try {
              console.log(`[Stream Preview API] Attempting multimodal image generation with ${imgModel}...`);
              const url = `https://generativelanguage.googleapis.com/v1beta/models/${imgModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
              const payload = {
                contents: [
                  {
                    parts: [
                      { inlineData: { mimeType: "image/jpeg", data: illustrationBase64 } },
                      { text: outpaintPrompt }
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
                    backgroundBuffer = Buffer.from(part.inlineData.data, "base64");
                    console.log(`[Stream Preview API] Multimodal ${imgModel} generated backdrop successfully.`);
                    break;
                  }
                }
                if (backgroundBuffer) break;
              }
            } catch (gErr: any) {
              console.warn(`[Stream Preview API] ${imgModel} image generation failed:`, gErr?.message || gErr);
            }
          }
        }
      } catch (outpaintErr) {
        console.warn("[Stream Preview API] AI outpainting failed:", outpaintErr);
      }

      // 4. Bulletproof ambient blur fallback
      if (!backgroundBuffer) {
        console.warn("[Stream Preview API] All AI image generators failed. Falling back to ambient blur backdrop.");
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
