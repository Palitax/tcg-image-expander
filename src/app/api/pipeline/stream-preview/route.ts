import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp, { OverlayOptions } from "sharp";
import { enrichCardMetadata, CardMetadata } from "@/utils/tcgDatabase";
import { buildStreamPreviewVectorSvg } from "@/utils/svgVectorText";
import { extractCardCutout } from "@/utils/cardCutout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

    // STEP 1 & 2: High-precision Card Cutout & Vision Analysis
    const cardCutoutResult = await extractCardCutout(originalCardBuffer, {
      apiKey,
      cornerRadiusPercent: 0.035
    });

    const roundedCardBuffer = cardCutoutResult.cutoutCardBuffer;
    let usedFallback = cardCutoutResult.usedFallback;

    // STEP 3: Enrich card metadata using TCG Database
    const enrichedMetadata = enrichCardMetadata({
      cardName: cardCutoutResult.cardName || cardFile.name.replace(/\.[^/.]+$/, ""),
      cardNumber: cardCutoutResult.cardNumber,
      setCode: cardCutoutResult.setCode,
      setName: cardCutoutResult.setName
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
      // Use clean inner illustration extracted by extractCardCutout
      const croppedIllustrationBuffer = cardCutoutResult.illustrationBuffer;
      const illustrationBase64 = cardCutoutResult.illustrationBase64.includes(",")
        ? cardCutoutResult.illustrationBase64.split(",")[1]
        : cardCutoutResult.illustrationBase64;

      try {
        let description = cardCutoutResult.sceneryDescription;

        // If vision in Step 1 didn't produce sceneryDescription, run quick fallback describer
        if (!description) {
          try {
            const describePrompt = `Analyze this trading card illustration. Write a vivid, detailed prompt describing ONLY the environment scenery, landscape, room setting, background elements, artistic style (e.g. anime watercolor, vibrant fantasy digital art), color palette, lighting, and general aesthetic. You MUST completely ignore and exclude any characters, pokemon creatures, figures, humans, text, or card borders in the illustration—do NOT describe them at all. Return only the descriptive prompt for the background scenery.`;
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
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
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(3000)
            });

            if (res.ok) {
              const json = await res.json();
              description = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
            }
          } catch (e: any) {
            console.warn("[Stream Preview API] Fallback describer timed out or failed:", e?.message || e);
          }
        }

        const cleanDesc = (description || `${cardCutoutResult.cardName || "Trading card"} environmental scenery in vibrant colorful fantasy anime aesthetic`)
          .replace(/^(here is a prompt|prompt:|description:|sure, here is|an anime)/gi, "")
          .replace(/\b(kill|blood|dead|die|sword|weapon|fight|attack|monster|devil|demon|gun|stab|wound|hurt|gore|blade|combat)\b/gi, "fantasy motif")
          .trim();

        const outpaintPrompt = `Anime scenery wallpaper, seamless extended background environment: ${cleanDesc}. Vibrant, highly detailed fantasy environment, beautiful lighting, consistent color palette, masterwork art style. Exclude all characters, figures, pokemon, text, symbols, and card borders.`;

        console.log(`[Stream Preview API] Outpainting prompt: "${outpaintPrompt.slice(0, 120)}..."`);

        // 1. Primary: Fast Imagen 3 generation attempt via REST :predict
        try {
          console.log("[Stream Preview API] Attempting Imagen 3 predict (1:1)...");
          const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${encodeURIComponent(apiKey)}`;
          const payload = {
            instances: [{ prompt: outpaintPrompt }],
            parameters: {
              sampleCount: 1,
              aspectRatio: "1:1",
              safetySetting: "block_only_high",
              outputOptions: { mimeType: "image/jpeg" }
            }
          };

          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(25000)
          });

          if (res.ok) {
            const json = await res.json();
            const bytes = json?.predictions?.[0]?.bytesBase64Encoded;
            if (bytes) {
              const rawBuf = Buffer.from(bytes, "base64");
              backgroundBuffer = await sharp(rawBuf)
                .resize(1024, 1024, { fit: "cover", position: "centre" })
                .jpeg({ quality: 92 })
                .toBuffer();
              console.log(`[Stream Preview API] Imagen 3 generated backdrop successfully (${backgroundBuffer.length} bytes).`);
            }
          } else {
            const errText = await res.text();
            console.warn(`[Stream Preview API] Imagen 3 HTTP ${res.status}:`, errText.slice(0, 160));
          }
        } catch (imgErr: any) {
          console.warn("[Stream Preview API] Imagen 3 call failed:", imgErr?.message || imgErr);
        }

        // 2. Secondary: Imagen 3 via @google/genai SDK generateImages
        if (!backgroundBuffer) {
          try {
            console.log("[Stream Preview API] Attempting Imagen 3 SDK generateImages...");
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
              const rawBuf = Buffer.from(imgBytes, "base64");
              backgroundBuffer = await sharp(rawBuf)
                .resize(1024, 1024, { fit: "cover", position: "centre" })
                .jpeg({ quality: 92 })
                .toBuffer();
              console.log("[Stream Preview API] Imagen 3 SDK generated backdrop successfully.");
            }
          } catch (sdkImgErr: any) {
            console.warn("[Stream Preview API] Imagen 3 SDK failed:", sdkImgErr?.message || sdkImgErr);
          }
        }

        // 3. Tertiary: Dedicated Gemini Image Generation Models (gemini-2.5-flash-image, gemini-3.1-flash-image-preview)
        // Note: Models require responseModalities: ["TEXT", "IMAGE"]
        if (!backgroundBuffer) {
          const dedicatedImgModels = ["gemini-2.5-flash-image", "gemini-3.1-flash-image-preview"];
          for (const imgModel of dedicatedImgModels) {
            if (backgroundBuffer) break;
            try {
              console.log(`[Stream Preview API] Attempting REST image generation with ${imgModel}...`);
              const url = `https://generativelanguage.googleapis.com/v1beta/models/${imgModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
              const payload = {
                contents: [
                  {
                    parts: [
                      { text: `Create a beautiful anime scenery background wallpaper: ${outpaintPrompt}` }
                    ]
                  }
                ],
                generationConfig: {
                  responseModalities: ["TEXT", "IMAGE"]
                }
              };

              const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(8000)
              });

              if (res.ok) {
                const json = await res.json();
                const parts = json?.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                  const imgData = part.inlineData?.data || (part as any).inline_data?.data;
                  if (imgData) {
                    console.log(`[Stream Preview API] ${imgModel} REST generated image successfully! Resizing to 1024x1024 (1:1)...`);
                    const rawBuf = Buffer.from(imgData, "base64");
                    backgroundBuffer = await sharp(rawBuf)
                      .resize(1024, 1024, { fit: "cover", position: "centre" })
                      .jpeg({ quality: 92 })
                      .toBuffer();
                    break;
                  }
                }
              } else {
                const errText = await res.text();
                console.warn(`[Stream Preview API] ${imgModel} REST error ${res.status}:`, errText.slice(0, 160));
              }
            } catch (gErr: any) {
              console.warn(`[Stream Preview API] ${imgModel} REST failed:`, gErr?.message || gErr);
            }
          }
        }

        // 4. Quaternary: Multimodal Image Outpainting using the Card's Cropped Illustration
        if (!backgroundBuffer && illustrationBase64) {
          try {
            console.log("[Stream Preview API] Attempting multimodal artwork expansion with illustration...");
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(apiKey)}`;
            const payload = {
              contents: [
                {
                  parts: [
                    {
                      inlineData: {
                        mimeType: "image/jpeg",
                        data: illustrationBase64
                      }
                    },
                    {
                      text: `Expand this card illustration outwards into a seamless, high-quality full background scenery wallpaper. Match the exact same art style, colors, and lighting. Fill the entire canvas completely from top to bottom with the scenery. Do NOT include any characters, Pokemon, figures, or text. Do NOT leave any blank white, transparent, or checkerboard areas.`
                    }
                  ]
                }
              ],
              generationConfig: {
                responseModalities: ["TEXT", "IMAGE"]
              }
            };

            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(8000)
            });

            if (res.ok) {
              const json = await res.json();
              const parts = json?.candidates?.[0]?.content?.parts || [];
              for (const part of parts) {
                const imgData = part.inlineData?.data || (part as any).inline_data?.data;
                if (imgData) {
                  console.log("[Stream Preview API] Multimodal illustration expansion succeeded!");
                  const rawBuf = Buffer.from(imgData, "base64");
                  backgroundBuffer = await sharp(rawBuf)
                    .resize(1024, 1024, { fit: "cover", position: "centre" })
                    .jpeg({ quality: 92 })
                    .toBuffer();
                  break;
                }
              }
            }
          } catch (multimodalErr: any) {
            console.warn("[Stream Preview API] Multimodal outpaint failed:", multimodalErr?.message || multimodalErr);
          }
        }
      } catch (outpaintErr) {
        console.warn("[Stream Preview API] AI backdrop generation exception:", outpaintErr);
      }

      // 4. Bulletproof ambient blur fallback if all AI image generators fail
      if (!backgroundBuffer) {
        console.log("[Stream Preview API] All AI image generators failed. Falling back to ambient blur backdrop.");
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
