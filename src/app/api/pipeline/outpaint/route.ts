import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

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

// Map aspect ratio string to dimensions for background
const getDimensionsForRatio = (ratio: string): { width: number; height: number } => {
  switch (ratio) {
    case "1:1":
      return { width: 1024, height: 1024 };
    case "9:16":
      return { width: 576, height: 1024 };
    case "16:9":
      return { width: 1024, height: 576 };
    case "4:3":
      return { width: 1024, height: 768 };
    case "3:4":
    default:
      return { width: 768, height: 1024 };
  }
};

// Returns prioritized list of aspect ratios to attempt with the AI models
const getCandidateRatios = (targetRatio: string): string[] => {
  switch (targetRatio) {
    case "1:1":
      // If 1:1 is requested, try 1:1 first, then fallback to 4:3, 3:4, or 16:9 and crop to 1:1
      return ["1:1", "4:3", "3:4", "16:9"];
    case "9:16":
      return ["9:16", "3:4", "1:1", "16:9"];
    case "16:9":
      return ["16:9", "4:3", "1:1", "3:4"];
    case "4:3":
      return ["4:3", "16:9", "1:1", "3:4"];
    case "3:4":
    default:
      return ["3:4", "9:16", "1:1", "4:3", "16:9"];
  }
};

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const apiKey = body?.apiKey || request.headers.get("x-gemini-api-key") || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Kein Google Gemini API-Key gefunden. Bitte trage deinen API-Key in den Einstellungen (Schlüssel-Symbol oben) oder in die .env.local ein." },
        { status: 400 }
      );
    }

    const ai = new GoogleGenAI({ apiKey });
    const { croppedImage, aspectRatio, mode = "backdrop", isDisplay = false } = body;

    if (!croppedImage) {
      return NextResponse.json({ error: "Fehlende croppedImage Base64-Daten." }, { status: 400 });
    }

    // Extract raw base64 from Data URL
    const base64Data = croppedImage.includes(",") ? croppedImage.split(",")[1] : croppedImage;
    const croppedBuffer = Buffer.from(base64Data, "base64");

    // Check if dual ratio (16:9 AND 9:16) is requested
    const isDual = aspectRatio === "both" || aspectRatio === "16:9+9:16" || aspectRatio === "dual";

    // Target background dimensions for single or fallback
    const { width: bgWidth, height: bgHeight } = getDimensionsForRatio(isDual ? "16:9" : aspectRatio);
    const { width: bgWidth916, height: bgHeight916 } = getDimensionsForRatio("9:16");

    let backgroundImageBase64 = "";
    let verticalBackgroundImageBase64 = "";
    let usedFallback = false;
    let fallbackReason = "";

    try {
      // STEP 3A: Describe cropped image style using Gemini (fast lean models)
      let description = "";
      let lastError;

      const describePrompt = isDisplay
        ? "Analyze this collectible display box packaging. Describe the visual theme, franchise setting, color scheme, artistic style, and artwork motifs visible on the box. Write a detailed prompt to generate a matching background scenery/backdrop that feels like a natural environment or thematic setting for this display box. Focus ONLY on the background scenery/backdrop, style, and colors. You MUST completely ignore and exclude the display box itself, any text, and branding logos from the background description. Return only the descriptive prompt for the background scenery."
        : (mode === "backdrop"
          ? "Analyze this trading card illustration. Write a detailed prompt to generate a matching background scenery/backdrop. Your description MUST focus ONLY on the environment, scenery, backdrop elements, artistic style (e.g. anime sketch, watercolor, oil painting), color palette, lighting, brushstrokes, and general aesthetic. You MUST completely ignore and exclude any characters, figures, or humans in the illustration—do NOT describe them at all. Return only the descriptive prompt for the background scenery."
          : "Analyze this trading card illustration. Describe the environmental scenery, artistic style (e.g. anime, oil painting, watercolor), key color palette, lighting, and general aesthetic. You MUST completely ignore and exclude any character figures, card text, card borders, play cost symbols, and power attributes from your description. Return only the description.");

      const styleModels = ["gemini-2.5-flash", "gemini-1.5-flash"];
      for (const model of styleModels) {
        try {
          console.log(`[Outpaint API] Describing style with model ${model} (mode: ${mode}, isDisplay: ${isDisplay})`);
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
          const payload = {
            contents: [
              {
                parts: [
                  { inlineData: { mimeType: "image/png", data: base64Data } },
                  { text: describePrompt }
                ]
              }
            ]
          };

          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(4000)
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
          console.warn(`[Outpaint API] Description with ${model} failed: ${e.message}`);
          lastError = e;
        }
      }

      if (!description) {
        description = "Fantasy scenery background in vibrant colorful aesthetic";
      }

      // Filter and sanitize description to prevent safety triggers in Imagen
      let sanitizedDescription = description
        .replace(/\b(kill|blood|dead|die|sword|weapon|fight|attack|monster|devil|demon|gun|stab|wound|hurt|gore|blade|combat)\b/gi, "fantasy element")
        .trim();

      let outpaintPrompt = "";
      if (isDisplay) {
        outpaintPrompt = `A beautiful, high-quality scenery backdrop: ${sanitizedDescription}. High quality, detailed, continuous landscape in the same aesthetic and art style. Exclude any characters, boxes, or text.`;
      } else if (mode === "backdrop") {
        outpaintPrompt = `A beautiful, high-quality scenery backdrop: ${sanitizedDescription}. High quality, detailed, continuous landscape in the same aesthetic and art style. Exclude any characters or text.`;
      } else {
        outpaintPrompt = `A beautiful, continuous, seamless background expansion of this scene: ${sanitizedDescription}. Expand the background environment to fill the target aspect ratio, preserving the exact same anime/art style, drawing technique, color palette, lighting, and general aesthetic. Do NOT replicate, extend, or generate any characters, figures, humans, text, play cost symbols, power attributes, or card borders. Focus strictly on extending the background scenery.`;
      }

      // Helper function to generate single background image for a given aspect ratio
      const generateBgForRatio = async (targetRatio: string): Promise<string> => {
        let generatedBase64 = "";
        let lastImageError;

        const candidateRatios = getCandidateRatios(targetRatio);

        for (const candidateRatio of candidateRatios) {
          if (generatedBase64) break;

          // 1. Try Imagen 3 via Direct REST :predict
          try {
            console.log(`[Outpaint API] Attempting REST Imagen predict for candidate ratio ${candidateRatio} (target: ${targetRatio})...`);
            const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${encodeURIComponent(apiKey)}`;
            const payload = {
              instances: [
                { prompt: outpaintPrompt }
              ],
              parameters: {
                sampleCount: 1,
                aspectRatio: candidateRatio,
                safetySetting: "block_only_high",
                outputOptions: {
                  mimeType: "image/jpeg"
                }
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
              const bytes = json?.predictions?.[0]?.bytesBase64Encoded;
              if (bytes) {
                console.log(`[Outpaint API] REST Imagen generated image successfully for ratio ${candidateRatio}`);
                generatedBase64 = bytes;
                break;
              }
            } else {
              const errText = await res.text();
              console.warn(`[Outpaint API] REST Imagen HTTP ${res.status}:`, errText.slice(0, 160));
            }
          } catch (restErr: any) {
            console.warn(`[Outpaint API] REST Imagen failed:`, restErr?.message || restErr);
            lastImageError = restErr;
          }
        }

        // 2. Secondary: Imagen 3 via @google/genai SDK generateImages
        if (!generatedBase64) {
          try {
            console.log(`[Outpaint API] Attempting Imagen 3 SDK generateImages for ratio ${targetRatio}...`);
            const validRatio = targetRatio === "dual" || targetRatio === "both" ? "16:9" : targetRatio;
            const imagenRes = await ai.models.generateImages({
              model: "imagen-3.0-generate-002",
              prompt: outpaintPrompt,
              config: {
                numberOfImages: 1,
                aspectRatio: validRatio as any,
                outputMimeType: "image/jpeg"
              }
            });
            const imgBytes = imagenRes.generatedImages?.[0]?.image?.imageBytes;
            if (imgBytes) {
              console.log("[Outpaint API] Imagen 3 SDK generated image successfully!");
              generatedBase64 = imgBytes;
            }
          } catch (sdkErr: any) {
            console.warn("[Outpaint API] Imagen 3 SDK failed:", sdkErr?.message || sdkErr);
            lastImageError = sdkErr;
          }
        }

        // 3. Tertiary: Gemini Dedicated Image Generation Models (gemini-2.5-flash-image, gemini-3.1-flash-image-preview)
        // (Note: Models require responseModalities: ["TEXT", "IMAGE"])
        if (!generatedBase64) {
          const dedicatedImgModels = ["gemini-2.5-flash-image", "gemini-3.1-flash-image-preview"];
          for (const imgModel of dedicatedImgModels) {
            if (generatedBase64) break;
            try {
              console.log(`[Outpaint API] Attempting Gemini image generation with ${imgModel} for target ratio ${targetRatio}...`);
              let contentsArray: any[] = [];
              if (mode === "backdrop" || isDisplay) {
                contentsArray = [
                  {
                    parts: [
                      { text: `High quality continuous scenery backdrop wallpaper: ${outpaintPrompt}` }
                    ]
                  }
                ];
              } else {
                contentsArray = [
                  {
                    parts: [
                      {
                        inlineData: {
                          mimeType: "image/png",
                          data: base64Data
                        }
                      },
                      { text: `Seamless extended background environment: ${outpaintPrompt}` }
                    ]
                  }
                ];
              }

              const url = `https://generativelanguage.googleapis.com/v1beta/models/${imgModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
              const payload = {
                contents: contentsArray,
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
                    console.log(`[Outpaint API] ${imgModel} REST generated image successfully!`);
                    generatedBase64 = imgData;
                    break;
                  }
                }
              } else {
                const errText = await res.text();
                console.warn(`[Outpaint API] ${imgModel} REST error ${res.status}:`, errText.slice(0, 160));
              }
            } catch (gErr: any) {
              console.warn(`[Outpaint API] ${imgModel} REST failed:`, gErr?.message || gErr);
              lastImageError = gErr;
            }
          }
        }

        if (generatedBase64) {
          // Normalize and resize/crop generated background to target dimensions using Sharp
          const { width: targetW, height: targetH } = getDimensionsForRatio(targetRatio);
          console.log(`[Outpaint API] Formatting generated background with Sharp to exact target size ${targetW}x${targetH} (fit: cover)...`);
          const rawBuffer = Buffer.from(generatedBase64, "base64");
          const fittedBuffer = await sharp(rawBuffer)
            .resize(targetW, targetH, { fit: "cover", position: "centre" })
            .jpeg({ quality: 92 })
            .toBuffer();
          return fittedBuffer.toString("base64");
        }

        throw lastImageError || new Error(`Keine Bilddaten für das Seitenverhältnis ${targetRatio} erhalten.`);
      };

      if (isDual) {
        // Generate both 16:9 and 9:16 backgrounds
        const [bg169, bg916] = await Promise.all([
          generateBgForRatio("16:9"),
          generateBgForRatio("9:16")
        ]);
        backgroundImageBase64 = bg169;
        verticalBackgroundImageBase64 = bg916;
      } else {
        backgroundImageBase64 = await generateBgForRatio(aspectRatio || "3:4");
      }

    } catch (e: any) {
      console.warn("[Outpaint API] AI Outpainting failed. Error:", e.message);
      usedFallback = true;
      const rawMsg = e.message || String(e);
      if (rawMsg.includes("400") || rawMsg.includes("INVALID_ARGUMENT") || rawMsg.includes("Aspect ratio")) {
        fallbackReason = "KI-Bildgenerierung konnte für dieses Seitenverhältnis kein Bild erzeugen.";
      } else if (rawMsg.includes("429") || rawMsg.toLowerCase().includes("quota") || rawMsg.toLowerCase().includes("rate limit")) {
        fallbackReason = "API-Ratenlimit oder Kontingent für Bildgenerierung erreicht.";
      } else if (rawMsg.includes("403") || rawMsg.toLowerCase().includes("permission")) {
        fallbackReason = "Keine Berechtigung für KI-Bildgenerierung mit diesem API-Key.";
      } else {
        fallbackReason = rawMsg;
      }
      
      // GENERATE BLURRED AMBIENT BACKDROP (Bulletproof fallback)
      const blurredBgBuffer = await sharp(croppedBuffer)
        .resize(bgWidth, bgHeight, { fit: "cover" })
        .blur(45) // Beautiful soft Gaussian blur
        .modulate({ brightness: 0.55, saturation: 0.85 }) // Darken and desaturate to let foreground card stand out
        .webp({ quality: 80 })
        .toBuffer();

      backgroundImageBase64 = blurredBgBuffer.toString("base64");

      if (isDual) {
        const blurredBgBuffer916 = await sharp(croppedBuffer)
          .resize(bgWidth916, bgHeight916, { fit: "cover" })
          .blur(45)
          .modulate({ brightness: 0.55, saturation: 0.85 })
          .webp({ quality: 80 })
          .toBuffer();
        verticalBackgroundImageBase64 = blurredBgBuffer916.toString("base64");
      }
    }

    const mimeType = usedFallback ? "image/webp" : "image/jpeg";

    return NextResponse.json({
      backgroundImage: `data:${mimeType};base64,${backgroundImageBase64}`,
      verticalBackgroundImage: verticalBackgroundImageBase64 ? `data:${mimeType};base64,${verticalBackgroundImageBase64}` : undefined,
      usedFallback,
      fallbackReason
    });

  } catch (error: any) {
    console.error("Fatal error in Outpaint API:", error);
    return NextResponse.json({ error: error.message || "Interner Serverfehler während der Hintergrunderweiterung." }, { status: 500 });
  }
}
