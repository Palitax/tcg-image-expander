import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

// Allow execution up to 60 seconds on Vercel
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Helper function to retry API calls on 503 (high demand) and 429 (rate limits) errors
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries = 3,
  delay = 2000
): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (retries <= 0) throw error;

    const errMsg = String(error.message || "");
    const errStatus = error.status;
    const isRetryable =
      errMsg.includes("503") ||
      errMsg.includes("429") ||
      errMsg.includes("UNAVAILABLE") ||
      errMsg.includes("high demand") ||
      errMsg.includes("experiencing high demand") ||
      errStatus === 503 ||
      errStatus === 429;

    if (!isRetryable) throw error;

    console.warn(`API call failed (503/429), retrying in ${delay}ms... (${retries} retries left). Error: ${errMsg}`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return retryWithBackoff(fn, retries - 1, delay * 2);
  }
}

// Helper to query Gemini with fallbacks (3.5 -> 2.5 -> 1.5)
async function generateContentWithFallback(ai: any, contents: any[], config: any): Promise<string> {
  const models = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-1.5-flash"];
  let lastError;

  for (const model of models) {
    try {
      console.log(`[Gemini] Attempting generateContent with model: ${model}`);
      const response = await ai.models.generateContent({
        model,
        contents,
        config
      });
      if (response.text) {
        console.log(`[Gemini] Success using model: ${model}`);
        return response.text;
      }
    } catch (e: any) {
      console.warn(`[Gemini] Model ${model} failed: ${e.message}`);
      lastError = e;
      // Wait a moment before fallback to prevent hammering
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastError || new Error("All Gemini models failed.");
}

export async function POST(request: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendStep = (step: string, message: string, data?: any) => {
        controller.enqueue(encoder.encode(JSON.stringify({ step, message, data }) + "\n"));
      };

      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          throw new Error("GEMINI_API_KEY is not configured. Please add it to your environment variables.");
        }

        const ai = new GoogleGenAI({ apiKey });
        
        // Parse Form Data
        const formData = await request.formData();
        const file = formData.get("cardImage") as File | null;
        const aspectRatio = (formData.get("aspectRatio") as string) || "3:4";

        if (!file) {
          throw new Error("No image file uploaded.");
        }

        const arrayBuffer = await file.arrayBuffer();
        const originalImageBuffer = Buffer.from(arrayBuffer);

        // Get original image metadata
        const originalMetadata = await sharp(originalImageBuffer).metadata();
        const width = originalMetadata.width || 0;
        const height = originalMetadata.height || 0;

        if (width === 0 || height === 0) {
          throw new Error("Failed to read image dimensions.");
        }

        // STEP 1: Layout Analysis (Gemini Bounding Box)
        sendStep("LAYOUT", `Analyzing card layout (${width}x${height}px)...`);

        const base64Image = originalImageBuffer.toString("base64");
        
        const layoutText = await retryWithBackoff(async () => {
          return await generateContentWithFallback(
            ai,
            [
              {
                inlineData: {
                  data: base64Image,
                  mimeType: file.type || "image/png"
                }
              },
              `The dimensions of the trading card image are ${width}x${height} pixels. Please identify the bounding box coordinates (x1, y1, x2, y2) of the inner primary illustration/artwork in these exact pixel coordinates.`
            ],
            {
              systemInstruction: "Identify the bounding box of the inner primary illustration/artwork of this trading card. Exclude the card frames, text boxes, and borders. Return only the pixel coordinates.",
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  x1: { type: "INTEGER", description: "Top-left X coordinate in pixels" },
                  y1: { type: "INTEGER", description: "Top-left Y coordinate in pixels" },
                  x2: { type: "INTEGER", description: "Bottom-right X coordinate in pixels" },
                  y2: { type: "INTEGER", description: "Bottom-right Y coordinate in pixels" }
                },
                required: ["x1", "y1", "x2", "y2"]
              }
            }
          );
        });

        let coords;
        try {
          coords = JSON.parse(layoutText);
        } catch (e) {
          throw new Error(`Failed to parse layout JSON: ${layoutText}`);
        }

        let { x1, y1, x2, y2 } = coords;
        
        // Sanitize coordinates to prevent sharp from crashing
        x1 = Math.max(0, Math.min(x1, width - 1));
        y1 = Math.max(0, Math.min(y1, height - 1));
        x2 = Math.max(x1 + 1, Math.min(x2, width));
        y2 = Math.max(y1 + 1, Math.min(y2, height));

        const cropWidth = x2 - x1;
        const cropHeight = y2 - y1;

        // STEP 2: Crop Inner Artwork
        sendStep("CROP", `Extracting card artwork at [${x1}, ${y1}] to [${x2}, ${y2}]...`);

        const croppedBuffer = await sharp(originalImageBuffer)
          .extract({ left: x1, top: y1, width: cropWidth, height: cropHeight })
          .png()
          .toBuffer();

        // STEP 3: Outpainting (Gemini description + Imagen 3)
        sendStep("OUTPAINT", "Analyzing art style and outpainting background...");

        const croppedBase64 = croppedBuffer.toString("base64");

        const description = await retryWithBackoff(async () => {
          return await generateContentWithFallback(
            ai,
            [
              {
                inlineData: {
                  data: croppedBase64,
                  mimeType: "image/png"
                }
              },
              "Describe the visual content, artistic style (e.g. anime, oil painting, watercolor), key color palette, character details, and backdrop elements of this trading card illustration. This description will be used as a prompt for Imagen 3 to expand the image. Do not mention card borders, text, or the card itself. Return only the description."
            ],
            undefined
          );
        });

        const outpaintPrompt = `A beautiful, continuous, seamless background expansion of this scene: ${description}. Expand the artwork to fill the target aspect ratio, preserving the exact same anime/art style, drawing technique, color palette, lighting, and general aesthetic of the original illustration. High quality, detailed, continuous landscape.`;

        // Generate outpainted background with robust fallback logic
        const generatedImageBytes = await retryWithBackoff(async () => {
          const imageModels = ["imagen-3.0-generate-002", "imagen-3.0-generate-001", "imagen-3.0-fast-generate-001"];
          let lastError;

          for (const model of imageModels) {
            try {
              console.log(`[Imagen] Attempting image generation with model: ${model}`);
              const imagenResponse = await ai.models.generateImages({
                model,
                prompt: outpaintPrompt,
                config: {
                  numberOfImages: 1,
                  aspectRatio: aspectRatio,
                  outputMimeType: "image/png"
                }
              });
              const bytes = imagenResponse.generatedImages?.[0]?.image?.imageBytes;
              if (bytes) {
                console.log(`[Imagen] Success using model: ${model}`);
                return bytes;
              }
            } catch (e: any) {
              console.warn(`[Imagen] Model ${model} failed: ${e.message}`);
              lastError = e;
              await new Promise(r => setTimeout(r, 500));
            }
          }
          throw lastError || new Error("All Imagen models failed.");
        });

        if (!generatedImageBytes) {
          throw new Error("Imagen image generation failed or returned no image bytes.");
        }

        const backgroundBuffer = Buffer.from(generatedImageBytes, "base64");

        // STEP 4: Merging with Shadow
        sendStep("MERGE", "Compositing original card over expanded background with drop shadow...");

        const bgMetadata = await sharp(backgroundBuffer).metadata();
        const bgWidth = bgMetadata.width || 1024;
        const bgHeight = bgMetadata.height || 1024;

        // Scale original card to ~70% of background height for premium margins
        const targetCardHeight = Math.round(bgHeight * 0.70);
        const targetCardWidth = Math.round((width / height) * targetCardHeight);

        const resizedCard = await sharp(originalImageBuffer)
          .resize(targetCardWidth, targetCardHeight)
          .toBuffer();

        // Create elegant drop shadow canvas
        const shadowPadding = 45;
        const shadowWidth = targetCardWidth + shadowPadding * 2;
        const shadowHeight = targetCardHeight + shadowPadding * 2;

        const cardShadow = await sharp({
          create: {
            width: shadowWidth,
            height: shadowHeight,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          }
        })
        .composite([
          {
            input: await sharp({
              create: {
                width: targetCardWidth,
                height: targetCardHeight,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0.5 } // soft dark shadow
              }
            }).toBuffer(),
            top: shadowPadding,
            left: shadowPadding
          }
        ])
        .blur(22) // Gaussian blur for soft shadow
        .toBuffer();

        // Overlay resized card over the shadow
        const cardWithShadow = await sharp(cardShadow)
          .composite([
            {
              input: resizedCard,
              top: shadowPadding,
              left: shadowPadding
            }
          ])
          .toBuffer();

        // Overlay card + shadow in center of the background
        const finalTop = Math.round((bgHeight - shadowHeight) / 2);
        const finalLeft = Math.round((bgWidth - shadowWidth) / 2);

        const finalResultBuffer = await sharp(backgroundBuffer)
          .composite([
            {
              input: cardWithShadow,
              top: finalTop,
              left: finalLeft
            }
          ])
          .png()
          .toBuffer();

        const finalBase64 = finalResultBuffer.toString("base64");
        const dataUrl = `data:image/png;base64,${finalBase64}`;

        // Complete Success
        sendStep("SUCCESS", "Pipeline completed successfully!", { resultImageUrl: dataUrl });

      } catch (error: any) {
        console.error("Backend pipeline error:", error);
        sendStep("ERROR", error.message || "An unexpected error occurred in the backend pipeline.");
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}
