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

// Map aspect ratio string to dimensions for the fallback blurred background
const getDimensionsForRatio = (ratio: string): { width: number; height: number } => {
  switch (ratio) {
    case "1:1":
      return { width: 1024, height: 1024 };
    case "9:16":
      return { width: 576, height: 1024 };
    case "16:9":
      return { width: 1024, height: 576 };
    case "3:4":
    default:
      return { width: 768, height: 1024 };
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
      return NextResponse.json({ error: "Missing croppedImage base64 data." }, { status: 400 });
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
      // STEP 3A: Describe cropped image style using Gemini (flash fallback chain)
      const models = ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-flash-latest"];
      let description = "";
      let lastError;

      const describePrompt = isDisplay
        ? "Analyze this collectible display box packaging. Describe the visual theme, franchise setting, color scheme, artistic style, and artwork motifs visible on the box. Write a detailed prompt to generate a matching background scenery/backdrop that feels like a natural environment or thematic setting for this display box. Focus ONLY on the background scenery/backdrop, style, and colors. You MUST completely ignore and exclude the display box itself, any text, and branding logos from the background description. Return only the descriptive prompt for the background scenery."
        : (mode === "backdrop"
          ? "Analyze this trading card illustration. Write a detailed prompt to generate a matching background scenery/backdrop. Your description MUST focus ONLY on the environment, scenery, backdrop elements, artistic style (e.g. anime sketch, watercolor, oil painting), color palette, lighting, brushstrokes, and general aesthetic. You MUST completely ignore and exclude any characters, figures, or humans in the illustration—do NOT describe them at all. Return only the descriptive prompt for the background scenery."
          : "Analyze this trading card illustration. Describe the environmental scenery, artistic style (e.g. anime, oil painting, watercolor), key color palette, lighting, and general aesthetic. You MUST completely ignore and exclude any character figures, card text, card borders, play cost symbols, and power attributes from your description. Return only the description.");

      for (const model of models) {
        try {
          console.log(`[Outpaint API] Describing style with model ${model} (mode: ${mode}, isDisplay: ${isDisplay})`);
          const styleResponse = await generateContentWithRetry(ai, {
            model,
            contents: [
              {
                inlineData: {
                  data: base64Data,
                  mimeType: "image/png"
                }
              },
              describePrompt
            ]
          });
          if (styleResponse.text) {
            description = styleResponse.text;
            break;
          }
        } catch (e: any) {
          console.warn(`[Outpaint API] Description using ${model} failed: ${e.message}`);
          lastError = e;
          if (e.message?.toLowerCase().includes("safety") || e.message?.toLowerCase().includes("block")) {
            throw e;
          }
        }
      }

      if (!description) {
        throw lastError || new Error("Failed to generate description with Gemini.");
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

        // 1. Try Imagen 3 via generateImages
        try {
          console.log(`[Outpaint API] Attempting Imagen 3 generation for ratio ${targetRatio}...`);
          const imagenRes = await ai.models.generateImages({
            model: "imagen-3.0-generate-002",
            prompt: outpaintPrompt,
            config: {
              numberOfImages: 1,
              aspectRatio: targetRatio === "dual" || targetRatio === "both" ? "16:9" : (targetRatio as any),
              outputMimeType: "image/jpeg"
            }
          });
          const imgBytes = imagenRes.generatedImages?.[0]?.image?.imageBytes;
          if (imgBytes) {
            console.log(`[Outpaint API] Imagen 3 generated image successfully for ratio ${targetRatio}`);
            return imgBytes;
          }
        } catch (e: any) {
          console.warn(`[Outpaint API] Imagen 3 failed: ${e.message}`);
          lastImageError = e;
        }

        // 2. Try Gemini 3.6 / 2.5 Flash image generation
        try {
          console.log(`[Outpaint API] Attempting gemini-3.6-flash / gemini-2.5-flash for ratio ${targetRatio}...`);
          let contentsArray: any[] = [];
          if (mode === "backdrop" || isDisplay) {
            contentsArray = [outpaintPrompt];
          } else {
            contentsArray = [
              {
                inlineData: {
                  data: base64Data,
                  mimeType: "image/png"
                }
              },
              outpaintPrompt
            ];
          }

          const fallbackImageModels = ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.0-flash"];
          for (const imgModel of fallbackImageModels) {
            try {
              const geminiImgRes = await generateContentWithRetry(ai, {
                model: imgModel,
                contents: contentsArray,
                config: {
                  responseModalities: ["IMAGE"],
                  imageConfig: {
                    aspectRatio: targetRatio === "dual" || targetRatio === "both" ? "16:9" : (targetRatio as any)
                  }
                }
              });

              const parts = geminiImgRes.candidates?.[0]?.content?.parts || [];
              for (const part of parts) {
                if (part.inlineData?.data) {
                  generatedBase64 = part.inlineData.data;
                  break;
                }
              }
              if (generatedBase64) {
                console.log(`[Outpaint API] ${imgModel} generated image successfully for ratio ${targetRatio}`);
                return generatedBase64;
              }
            } catch (imgModelErr: any) {
              console.warn(`[Outpaint API] ${imgModel} failed:`, imgModelErr?.message || imgModelErr);
              lastImageError = imgModelErr;
            }
          }
        } catch (e: any) {
          console.warn(`[Outpaint API] Fallback image generation failed: ${e.message}`);
          lastImageError = e;
        }

        if (generatedBase64) {
          return generatedBase64;
        }
        throw lastImageError || new Error(`No image bytes returned for ratio ${targetRatio}.`);
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
      fallbackReason = e.message || String(e);
      
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
    return NextResponse.json({ error: error.message || "Internal server error during outpaint." }, { status: 500 });
  }
}
