import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

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
    const formData = await request.formData();
    const file = formData.get("cardImage") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No image file uploaded." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const originalImageBuffer = Buffer.from(arrayBuffer);

    // Get original image metadata
    const originalMetadata = await sharp(originalImageBuffer).metadata();
    const width = originalMetadata.width || 0;
    const height = originalMetadata.height || 0;

    if (width === 0 || height === 0) {
      return NextResponse.json({ error: "Failed to read image dimensions." }, { status: 400 });
    }

    const base64Image = originalImageBuffer.toString("base64");
    
    // Fallback list of modern active Gemini models
    const models = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.0-flash"];
    let layoutText = "";
    let lastError;

    for (const model of models) {
      try {
        console.log(`[Crop API] Trying model ${model}`);
        const layoutResponse = await ai.models.generateContent({
          model,
          contents: [
            {
              inlineData: {
                data: base64Image,
                mimeType: file.type || "image/png"
              }
            },
            `The dimensions of the trading card image are ${width}x${height} pixels. Please identify the bounding box coordinates (x1, y1, x2, y2) of the inner primary illustration/artwork in these exact pixel coordinates.`
          ],
          config: {
            systemInstruction: "Identify the bounding box of the inner primary illustration/artwork of this trading card. Exclude the card frames, text boxes, and borders. Return only the pixel coordinates.",
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                x1: { type: "integer", description: "Top-left X coordinate in pixels" },
                y1: { type: "integer", description: "Top-left Y coordinate in pixels" },
                x2: { type: "integer", description: "Bottom-right X coordinate in pixels" },
                y2: { type: "integer", description: "Bottom-right Y coordinate in pixels" }
              },
              required: ["x1", "y1", "x2", "y2"]
            }
          }
        });
        if (layoutResponse.text) {
          layoutText = layoutResponse.text;
          break;
        }
      } catch (e: any) {
        console.warn(`[Crop API] Model ${model} failed: ${e.message}`);
        lastError = e;
        // If it's a safety block or validation/schema structure issue, stop and throw immediately
        if (e.message?.toLowerCase().includes("safety") || e.message?.toLowerCase().includes("block")) {
          throw e;
        }
      }
    }

    if (!layoutText) {
      throw lastError || new Error("Failed to analyze layout with all Gemini models.");
    }

    let coords;
    try {
      coords = JSON.parse(layoutText);
    } catch (e) {
      throw new Error(`Failed to parse layout JSON: ${layoutText}`);
    }

    let { x1, y1, x2, y2 } = coords;
    x1 = Math.max(0, Math.min(x1, width - 1));
    y1 = Math.max(0, Math.min(y1, height - 1));
    x2 = Math.max(x1 + 1, Math.min(x2, width));
    y2 = Math.max(y1 + 1, Math.min(y2, height));

    const cropWidth = x2 - x1;
    const cropHeight = y2 - y1;

    const croppedBuffer = await sharp(originalImageBuffer)
      .extract({ left: x1, top: y1, width: cropWidth, height: cropHeight })
      .png()
      .toBuffer();

    const croppedBase64 = croppedBuffer.toString("base64");

    return NextResponse.json({
      croppedImage: `data:image/png;base64,${croppedBase64}`,
      coords: { x1, y1, x2, y2 }
    });

  } catch (error: any) {
    console.error("Error in Crop API:", error);
    return NextResponse.json({ error: error.message || "Internal server error during crop." }, { status: 500 });
  }
}
