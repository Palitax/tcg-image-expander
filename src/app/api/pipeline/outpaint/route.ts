import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

export const dynamic = "force-dynamic";

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
    const { croppedImage, aspectRatio } = await request.json();

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

    try {
      // STEP 3A: Describe cropped image style using Gemini (flash fallback chain)
      const models = ["gemini-3.5-flash", "gemini-2.5-flash"];
      let description = "";
      let lastError;

      for (const model of models) {
        try {
          console.log(`[Outpaint API] Describing style with model ${model}`);
          const styleResponse = await ai.models.generateContent({
            model,
            contents: [
              {
                inlineData: {
                  data: base64Data,
                  mimeType: "image/png"
                }
              },
              "Describe the visual content, artistic style (e.g. anime, oil painting, watercolor), key color palette, character details, and backdrop elements of this trading card illustration. This description will be used as a prompt for Imagen 3 to expand the image. Do not mention card borders, text, or the card itself. Return only the description."
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

      const outpaintPrompt = `A beautiful, continuous, seamless background expansion of this scene: ${sanitizedDescription}. Expand the artwork to fill the target aspect ratio, preserving the exact same anime/art style, drawing technique, color palette, lighting, and general aesthetic of the original illustration. High quality, detailed, continuous landscape.`;

      console.log(`[Outpaint API] Attempting Imagen 3 with prompt: "${outpaintPrompt}"`);

      // STEP 3B: Generate background with Imagen 3
      const imagenResponse = await ai.models.generateImages({
        model: "imagen-3.0-generate-002",
        prompt: outpaintPrompt,
        config: {
          numberOfImages: 1,
          aspectRatio: aspectRatio || "3:4",
          outputMimeType: "image/png"
        }
      });
      
      const bytes = imagenResponse.generatedImages?.[0]?.image?.imageBytes;
      if (bytes) {
        backgroundImageBase64 = bytes;
        console.log("[Outpaint API] Imagen 3 generated successfully.");
      } else {
        throw new Error("No image bytes returned by Imagen 3.");
      }

    } catch (e: any) {
      console.warn("[Outpaint API] AI Outpainting failed or not supported in this region. Falling back to blurred ambient backdrop. Error:", e.message);
      usedFallback = true;
      
      // GENERATE BLURRED AMBIENT BACKDROP (Bulletproof fallback)
      const blurredBgBuffer = await sharp(croppedBuffer)
        .resize(bgWidth, bgHeight, { fit: "cover" })
        .blur(45) // Beautiful soft Gaussian blur
        .modulate({ brightness: 0.55, saturation: 0.85 }) // Darken and desaturate to let foreground card stand out
        .png()
        .toBuffer();

      backgroundImageBase64 = blurredBgBuffer.toString("base64");
    }

    return NextResponse.json({
      backgroundImage: `data:image/png;base64,${backgroundImageBase64}`,
      usedFallback
    });

  } catch (error: any) {
    console.error("Fatal error in Outpaint API:", error);
    return NextResponse.json({ error: error.message || "Internal server error during outpaint." }, { status: 500 });
  }
}
