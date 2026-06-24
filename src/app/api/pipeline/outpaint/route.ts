import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

export const dynamic = "force-dynamic";
export const preferredRegion = "iad1"; // Force US-East server to bypass EU IP blocks for Imagen 3

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
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY is not configured. Please add it to your environment variables." },
        { status: 500 }
      );
    }

    const ai = new GoogleGenAI({ apiKey });
    const { croppedImage, aspectRatio, mode = "backdrop" } = await request.json();

    if (!croppedImage) {
      return NextResponse.json({ error: "Missing croppedImage base64 data." }, { status: 400 });
    }

    // Extract raw base64 from Data URL
    const base64Data = croppedImage.includes(",") ? croppedImage.split(",")[1] : croppedImage;
    const croppedBuffer = Buffer.from(base64Data, "base64");

    // Get target background dimensions
    const { width: bgWidth, height: bgHeight } = getDimensionsForRatio(aspectRatio);

    let backgroundImageBase64 = "";
    let usedFallback = false;
    let fallbackReason = "";

    try {
      // STEP 3A: Describe cropped image style using Gemini (flash fallback chain)
      const models = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"];
      let description = "";
      let lastError;

      const describePrompt = mode === "backdrop"
        ? "Analyze this trading card illustration. Write a detailed prompt to generate a matching background scenery/backdrop. Your description MUST focus ONLY on the environment, scenery, backdrop elements, artistic style (e.g. anime sketch, watercolor, oil painting), color palette, lighting, brushstrokes, and general aesthetic. You MUST completely ignore and exclude any characters, figures, or humans in the illustration—do NOT describe them at all. Return only the descriptive prompt for the background scenery."
        : "Analyze this trading card illustration. Describe the environmental scenery, artistic style (e.g. anime, oil painting, watercolor), key color palette, lighting, and general aesthetic. You MUST completely ignore and exclude any character figures, card text, card borders, play cost symbols, and power attributes from your description. Return only the description.";

      for (const model of models) {
        try {
          console.log(`[Outpaint API] Describing style with model ${model} (mode: ${mode})`);
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
      if (mode === "backdrop") {
        outpaintPrompt = `A beautiful, high-quality scenery backdrop: ${sanitizedDescription}. High quality, detailed, continuous landscape in the same aesthetic and art style. Exclude any characters or text.`;
      } else {
        outpaintPrompt = `A beautiful, continuous, seamless background expansion of this scene: ${sanitizedDescription}. Expand the background environment to fill the target aspect ratio, preserving the exact same anime/art style, drawing technique, color palette, lighting, and general aesthetic. Do NOT replicate, extend, or generate any characters, figures, humans, text, play cost symbols, power attributes, or card borders. Focus strictly on extending the background scenery.`;
      }

      // STEP 3B: Generate background with image models fallback chain
      const imageModels = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"];
      let generatedBase64 = "";
      let lastImageError;

      for (const imgModel of imageModels) {
        try {
          console.log(`[Outpaint API] Attempting Gemini Image Generation with model ${imgModel} (mode: ${mode})`);
          
          let contentsArray: any[] = [];
          if (mode === "backdrop") {
            // Text-to-Image mode: do not pass the reference image to prevent character replication in background
            contentsArray = [outpaintPrompt];
          } else {
            // Outpaint/Image-to-Image mode: pass the reference image to extend it
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

          const imagenResponse = await generateContentWithRetry(ai, {
            model: imgModel,
            contents: contentsArray,
            config: {
              responseModalities: ["IMAGE"],
              imageConfig: {
                aspectRatio: aspectRatio || "3:4"
              }
            }
          });

          const parts = imagenResponse.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.inlineData?.data) {
              generatedBase64 = part.inlineData.data;
              break;
            }
          }
          if (generatedBase64) {
            console.log(`[Outpaint API] Image generated successfully with ${imgModel}`);
            break;
          }
        } catch (e: any) {
          console.warn(`[Outpaint API] Image generation with ${imgModel} failed: ${e.message}`);
          lastImageError = e;
        }
      }

      if (generatedBase64) {
        backgroundImageBase64 = generatedBase64;
      } else {
        throw lastImageError || new Error("No image bytes returned by any Gemini Image model.");
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
    }

    const mimeType = usedFallback ? "image/webp" : "image/jpeg";

    return NextResponse.json({
      backgroundImage: `data:${mimeType};base64,${backgroundImageBase64}`,
      usedFallback,
      fallbackReason
    });

  } catch (error: any) {
    console.error("Fatal error in Outpaint API:", error);
    return NextResponse.json({ error: error.message || "Internal server error during outpaint." }, { status: 500 });
  }
}
