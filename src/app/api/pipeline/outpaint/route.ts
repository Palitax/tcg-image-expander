import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const dynamic = "force-dynamic";

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
    const base64Data = croppedImage.replace(/^data:image\/\w+;base64,/, "");

    // STEP 3A: Describe cropped image style using Gemini (flash fallback chain)
    const models = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.0-flash"];
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

    console.log(`[Outpaint API] Imagen prompt: "${outpaintPrompt}"`);

    // STEP 3B: Generate background with Imagen 3
    let generatedImageBytes = "";
    try {
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
        generatedImageBytes = bytes;
      }
    } catch (e: any) {
      console.error("[Outpaint API] Imagen 3 failed:", e);
      if (e.message?.toLowerCase().includes("safety") || e.message?.toLowerCase().includes("block")) {
        return NextResponse.json({
          error: "The image content generated a description that triggered Google's safety filters. Please try another card image."
        }, { status: 400 });
      }
      throw e;
    }

    if (!generatedImageBytes) {
      throw new Error("Imagen image generation failed or returned no image bytes.");
    }

    return NextResponse.json({
      backgroundImage: `data:image/png;base64,${generatedImageBytes}`
    });

  } catch (error: any) {
    console.error("Error in Outpaint API:", error);
    
    // Check for high demand 503 errors and return a specific status code
    const isBusy = error.message?.includes("503") || 
                    error.message?.includes("UNAVAILABLE") || 
                    error.message?.includes("high demand") ||
                    error.status === 503;
                    
    if (isBusy) {
      return NextResponse.json(
        { error: "Google's image generation models are currently experiencing high demand. Please try again in a few seconds." },
        { status: 503 }
      );
    }

    return NextResponse.json({ error: error.message || "Internal server error during outpaint." }, { status: 500 });
  }
}
