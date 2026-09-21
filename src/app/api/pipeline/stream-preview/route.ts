import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp, { OverlayOptions } from "sharp";
import { enrichCardMetadata, CardMetadata } from "@/utils/tcgDatabase";
import { buildStreamPreviewVectorSvg } from "@/utils/svgVectorText";
import { extractCardCutout, CardCutoutResult } from "@/utils/cardCutout";
import { removeBackgroundAI } from "@/utils/bgRemover";
import { extractCardHomography } from "@/utils/cardHomography";

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
  cardCenterYRatio?: number;
  showOverlay?: boolean;
}): Promise<Buffer> {
  const {
    backgroundBuffer,
    cutoutCardBuffer,
    metadata,
    cardScale = 0.54,
    shadowStyle = "soft",
    showOverlay = false,
    cardCenterYRatio = showOverlay ? 0.46 : 0.50
  } = params;

  const bgMetadata = await sharp(backgroundBuffer).metadata();
  const bgWidth = bgMetadata.width || 1024;
  const bgHeight = bgMetadata.height || 1024;

  const cardMetadata = await sharp(cutoutCardBuffer).metadata();
  const rawCardW = cardMetadata.width || 500;
  const rawCardH = cardMetadata.height || 700;

  // Scale card appropriately on 1024x1024 canvas
  const clampedScale = Math.max(0.40, Math.min(0.85, cardScale));
  let targetCardH = Math.round(bgHeight * clampedScale);
  let targetCardW = Math.round((rawCardW / rawCardH) * targetCardH);

  const maxW = Math.round(bgWidth * 0.76);
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
    const shadowPadding = Math.max(20, Math.min(48, Math.round(targetCardW * 0.10)));
    const shadowW = targetCardW + shadowPadding * 2;
    const shadowH = targetCardH + shadowPadding * 2;
    const shadowRadius = Math.round(targetCardW * 0.038);

    let shadowAlpha = 0.50; // Natural soft drop shadow matching reference Image 2
    let shadowR = 0;
    let shadowG = 0;
    let shadowB = 0;
    let blurSigma = Math.max(14, Math.min(26, Math.round(shadowPadding * 0.68)));

    if (shadowStyle === "intense") {
      shadowAlpha = 0.85;
      blurSigma = Math.max(16, Math.min(30, Math.round(shadowPadding * 0.78)));
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
    const finalTop = Math.max(30, Math.round(finalCenterY - shadowH / 2));
    const finalLeft = Math.round((bgWidth - shadowW) / 2);

    compositeLayers.push({
      input: cardWithShadow,
      top: finalTop,
      left: finalLeft
    });
  } else {
    const finalCenterY = Math.round(bgHeight * cardCenterYRatio);
    const finalTop = Math.max(30, Math.round(finalCenterY - targetCardH / 2));
    const finalLeft = Math.round((bgWidth - targetCardW) / 2);

    compositeLayers.push({
      input: resizedCardBuffer,
      top: finalTop,
      left: finalLeft
    });
  }

  // 2. Stream Preview Pure Vector SVG Overlay (Only rendered if showOverlay is enabled)
  if (showOverlay) {
    const overlaySvgBuffer = buildStreamPreviewVectorSvg(metadata, bgWidth, bgHeight);
    compositeLayers.push({
      input: overlaySvgBuffer,
      top: 0,
      left: 0
    });
  }

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
        cardScale = 0.54,
        shadowStyle = "soft",
        showOverlay = false
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
        cardScale: Number(cardScale) || 0.54,
        shadowStyle,
        showOverlay: Boolean(showOverlay)
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
    const cardScale = parseFloat((formData.get("cardScale") as string) || "0.54");
    const shadowStyle = ((formData.get("shadowStyle") as string) || "soft") as "soft" | "intense" | "glow" | "none";
    const showOverlay = formData.get("showOverlay") === "true";
    const mattingEngine = ((formData.get("mattingEngine") as string) || "gemini_homography") as "gemini_homography" | "ai_matting" | "tcg_cutout";

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
        console.warn("[Stream Preview API] Ungültiges cropBox-Format:", cropBoxParam);
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
      console.log(`[Stream Preview API] Visier-Stanzrahmen aktiv: x=${cropBox.x}, y=${cropBox.y}, w=${cropBox.width}, h=${cropBox.height}`);
    }

    // STEP 1 & 2: High-precision Card Cutout & Vision Analysis
    let roundedCardBuffer: Buffer;
    let cardCutoutResult: CardCutoutResult;
    let usedFallback = false;

    if (cropBox) {
      console.log(`[Stream Preview API] Visier-Stanzrahmen aktiv: x=${cropBox.x}, y=${cropBox.y}, w=${cropBox.width}, h=${cropBox.height}`);
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
      console.log("[Stream Preview API] Starte Gemini 4-Punkt Grounding & Homographie-Entzerrung...");
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

        // Extract inner illustration for AI artwork expansion and ambient fallback
        const isFullArt = !!homographyResult.analysis.is_full_art;
        let illX: number;
        let illY: number;
        let illW: number;
        let illH: number;

        if (homographyResult.analysis.illustration_box && Array.isArray(homographyResult.analysis.illustration_box) && homographyResult.analysis.illustration_box.length === 4) {
          const [ymin, xmin, ymax, xmax] = homographyResult.analysis.illustration_box.map(Number);
          illX = Math.round((xmin / 1000) * homographyResult.width);
          illY = Math.round((ymin / 1000) * homographyResult.height);
          illW = Math.max(10, Math.round(((xmax - xmin) / 1000) * homographyResult.width));
          illH = Math.max(10, Math.round(((ymax - ymin) / 1000) * homographyResult.height));
        } else if (isFullArt) {
          illX = Math.round(homographyResult.width * 0.03);
          illY = Math.round(homographyResult.height * 0.03);
          illW = Math.round(homographyResult.width * 0.94);
          illH = Math.round(homographyResult.height * 0.94);
        } else {
          illW = Math.max(10, Math.round(homographyResult.width * 0.84));
          illH = Math.max(10, Math.round(homographyResult.height * 0.46));
          illX = Math.round(homographyResult.width * 0.08);
          illY = Math.round(homographyResult.height * 0.12);
        }

        // Clamp inside cutout bounds
        illX = Math.max(0, Math.min(illX, homographyResult.width - 10));
        illY = Math.max(0, Math.min(illY, homographyResult.height - 10));
        illW = Math.max(10, Math.min(illW, homographyResult.width - illX));
        illH = Math.max(10, Math.min(illH, homographyResult.height - illY));

        let illustrationBuffer: Buffer;
        try {
          illustrationBuffer = await sharp(homographyResult.cutoutBuffer)
            .extract({ left: illX, top: illY, width: illW, height: illH })
            .resize(768, 768, { fit: "inside" })
            .png()
            .toBuffer();
        } catch {
          illustrationBuffer = homographyResult.cutoutBuffer;
        }

        cardCutoutResult = {
          cutoutCardBuffer: homographyResult.cutoutBuffer,
          cutoutCardBase64: homographyResult.cutoutBase64,
          illustrationBuffer,
          illustrationBase64: `data:image/png;base64,${illustrationBuffer.toString("base64")}`,
          cardCoords: {
            x1: 0,
            y1: 0,
            x2: homographyResult.width,
            y2: homographyResult.height
          },
          illustrationCoords: {
            x1: illX,
            y1: illY,
            x2: illX + illW,
            y2: illY + illH
          },
          cardName: homographyResult.analysis.card_name || cardFile.name.replace(/\.[^/.]+$/, ""),
          cardNumber: homographyResult.analysis.collector_number || "",
          setCode: homographyResult.analysis.set_code || "",
          setName: homographyResult.analysis.set_name || "",
          sceneryDescription: homographyResult.analysis.scene_prompt || "",
          hasSampleWatermark: false,
          usedFallback: false,
          isFullArt,
          originalWidth: width,
          originalHeight: height
        };
      } catch (hErr: any) {
        console.warn("[Stream Preview API] Homographie fehlgeschlagen, Fallback auf TCG Cutout:", hErr?.message || hErr);
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
      console.log("[Stream Preview API] Starte paralleles AI Alpha Matting (RMBG-1.4) und TCG-Analyse...");
      const [mattedCard, cutoutData] = await Promise.all([
        (async () => {
          try {
            const matted = await removeBackgroundAI(originalCardBuffer);
            const trimmed = await sharp(matted).trim().png().toBuffer();
            console.log(`[Stream Preview API] AI Alpha Matting erfolgreich abgeschlossen (${trimmed.length} Bytes).`);
            return trimmed;
          } catch (mErr: any) {
            console.warn("[Stream Preview API] AI Alpha Matting fehlgeschlagen, Fallback auf TCG Cutout:", mErr?.message || mErr);
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
      console.log("[Stream Preview API] Verwende TCG Geometrie-Zuschnitt (Druckfarben-Anker)...");
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

    // STEP 3: Enrich card metadata using TCG Database
    const enrichedMetadata = enrichCardMetadata({
      cardName: cardCutoutResult.cardName || cardFile.name.replace(/\.[^/.]+$/, ""),
      cardNumber: cardCutoutResult.cardNumber,
      setCode: cardCutoutResult.setCode,
      setName: cardCutoutResult.setName
    });

    // STEP 4: Background Outpainting (or custom/existing background if uploaded)
    let backgroundBuffer: Buffer | null = null;
    const existingBgParam = formData.get("existingBgImage") as string | null;

    if (existingBgParam && existingBgParam.includes("base64,")) {
      try {
        const bgBase64 = existingBgParam.split(",")[1];
        backgroundBuffer = await sharp(Buffer.from(bgBase64, "base64"))
          .resize(1024, 1024, { fit: "cover" })
          .jpeg({ quality: 90 })
          .toBuffer();
        console.log("[Stream Preview API] Vorhandenes Hintergrundbild erfolgreich wiederverwendet.");
      } catch (bgReuseErr) {
        console.warn("[Stream Preview API] Fehler beim Wiederverwenden des vorhandenen Hintergrunds:", bgReuseErr);
      }
    }

    if (!backgroundBuffer && customBgFile && typeof (customBgFile as any).arrayBuffer === "function") {
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
      // Use clean inner illustration extracted by extractCardCutout or extractCardHomography
      const croppedIllustrationBuffer = cardCutoutResult.illustrationBuffer;
      const rawIllustrationBase64 = cardCutoutResult.illustrationBase64.includes(",")
        ? cardCutoutResult.illustrationBase64.split(",")[1]
        : cardCutoutResult.illustrationBase64;

      try {
        let description = cardCutoutResult.sceneryDescription;

        // If vision in Step 1 didn't produce sceneryDescription, run quick fallback describer
        if (!description) {
          try {
            const describePrompt = `Analyze this trading card illustration. Write a concise, vivid description of the scenery, environment, art medium (e.g. watercolor, digital anime painting), color palette, and lighting. Return only the descriptive prompt for the background scenery.`;
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
            const payload = {
              contents: [
                {
                  parts: [
                    { inlineData: { mimeType: "image/jpeg", data: rawIllustrationBase64 } },
                    { text: describePrompt }
                  ]
                }
              ]
            };

            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(3500)
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

        const cardTitle = cardCutoutResult.cardName || "Trading card";
        const sceneryOutpaintPrompt = `A beautiful, continuous, seamless background expansion of this scene: ${cleanDesc}. Expand the background environment to fill a square 1:1 format (1024x1024), preserving the exact same anime/art style, drawing technique, color palette, lighting, and general aesthetic. Do NOT replicate, duplicate, or generate any characters, Pokémon, figures, humans, text, play cost symbols, power attributes, or card borders. Focus strictly on extending the surrounding environment and background scenery seamlessly to all edges.`;

        console.log(`[Stream Preview API] Starting 1:1 background scenery generation for "${cardTitle}"...`);

        // 1. Primary: Imagen 3 REST :predict with native 1:1 aspect ratio
        try {
          console.log("[Stream Preview API] Attempting REST Imagen 3 predict for 1:1 square scenery...");
          const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${encodeURIComponent(apiKey)}`;
          const payload = {
            instances: [{ prompt: sceneryOutpaintPrompt }],
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
            signal: AbortSignal.timeout(12000)
          });

          if (res.ok) {
            const json = await res.json();
            const bytes = json?.predictions?.[0]?.bytesBase64Encoded;
            if (bytes) {
              console.log("[Stream Preview API] REST Imagen 3 successfully generated 1:1 scenery backdrop!");
              const rawBuf = Buffer.from(bytes, "base64");
              backgroundBuffer = await sharp(rawBuf)
                .resize(1024, 1024, { fit: "cover", position: "centre" })
                .jpeg({ quality: 92 })
                .toBuffer();
            }
          } else {
            const errText = await res.text();
            console.warn(`[Stream Preview API] REST Imagen 3 HTTP ${res.status}:`, errText.slice(0, 160));
          }
        } catch (restErr: any) {
          console.warn("[Stream Preview API] REST Imagen 3 failed:", restErr?.message || restErr);
        }

        // 2. Secondary: Imagen 3 SDK generateImages for 1:1
        if (!backgroundBuffer) {
          try {
            console.log("[Stream Preview API] Attempting Imagen 3 SDK generateImages for 1:1...");
            const imagenRes = await ai.models.generateImages({
              model: "imagen-3.0-generate-002",
              prompt: sceneryOutpaintPrompt,
              config: {
                numberOfImages: 1,
                aspectRatio: "1:1" as any,
                outputMimeType: "image/jpeg"
              }
            });
            const imgBytes = imagenRes.generatedImages?.[0]?.image?.imageBytes;
            if (imgBytes) {
              console.log("[Stream Preview API] Imagen 3 SDK generated 1:1 scenery backdrop successfully!");
              const rawBuf = Buffer.from(imgBytes, "base64");
              backgroundBuffer = await sharp(rawBuf)
                .resize(1024, 1024, { fit: "cover", position: "centre" })
                .jpeg({ quality: 92 })
                .toBuffer();
            }
          } catch (sdkErr: any) {
            console.warn("[Stream Preview API] Imagen 3 SDK failed:", sdkErr?.message || sdkErr);
          }
        }

        // 3. Tertiary: Multimodal Image Outpainting using the Card's Artwork with strict scenery prompt
        if (!backgroundBuffer) {
          const multimodalModels = [
            "gemini-2.5-flash-image",
            "gemini-3.1-flash-image-preview",
            "gemini-3.1-flash-lite-image"
          ];

          for (const imgModel of multimodalModels) {
            if (backgroundBuffer) break;
            try {
              console.log(`[Stream Preview API] Attempting multimodal artwork expansion with ${imgModel}...`);
              const url = `https://generativelanguage.googleapis.com/v1beta/models/${imgModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
              const payload = {
                contents: [
                  {
                    parts: [
                      {
                        inlineData: {
                          mimeType: "image/jpeg",
                          data: rawIllustrationBase64
                        }
                      },
                      {
                        text: `Seamless continuous background environment expansion: ${sceneryOutpaintPrompt}`
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
                signal: AbortSignal.timeout(20000)
              });

              if (res.ok) {
                const json = await res.json();
                const parts = json?.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                  const imgData = part.inlineData?.data || (part as any).inline_data?.data;
                  if (imgData) {
                    console.log(`[Stream Preview API] ${imgModel} successfully generated extended artwork backdrop!`);
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
                console.warn(`[Stream Preview API] ${imgModel} REST HTTP ${res.status}:`, errText.slice(0, 160));
              }
            } catch (modelErr: any) {
              console.warn(`[Stream Preview API] ${imgModel} failed:`, modelErr?.message || modelErr);
            }
          }
        }
      } catch (outpaintErr) {
        console.warn("[Stream Preview API] AI artwork expansion exception:", outpaintErr);
      }

      // 4. Bulletproof ambient blur fallback if all AI image generators fail
      if (!backgroundBuffer) {
        console.log("[Stream Preview API] AI artwork expansion models unavailable or rate-limited. Falling back to ambient blur backdrop of the card artwork.");
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
      shadowStyle,
      showOverlay
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
