import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const dynamic = "force-dynamic";
export const preferredRegion = "iad1"; // Force US-East server

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
        console.warn(`[Identify API] Transient error: "${errorStr}". Retrying in ${waitTime}ms (attempt ${i + 1}/${retries})...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Failed to generate content after retries.");
}

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
    const { imageUrl } = await request.json();

    if (!imageUrl) {
      return NextResponse.json({ error: "Missing imageUrl parameter." }, { status: 400 });
    }

    let base64Image = "";
    let mimeType = "image/png";

    if (imageUrl.startsWith("data:image/")) {
      const parts = imageUrl.split(",");
      base64Image = parts[1];
      const mimeMatch = parts[0].match(/:(.*?);/);
      if (mimeMatch) {
        mimeType = mimeMatch[1];
      }
    } else {
      console.log(`[Identify API] Fetching remote image: ${imageUrl}`);
      const res = await fetch(imageUrl);
      if (!res.ok) {
        return NextResponse.json(
          { error: `Failed to fetch image from URL: ${res.statusText} (${res.status})` },
          { status: 400 }
        );
      }
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      base64Image = buffer.toString("base64");
      const contentType = res.headers.get("content-type");
      if (contentType) {
        mimeType = contentType;
      }
    }

    // Fallback list of modern active Gemini models
    const models = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"];
    let responseText = "";
    let lastError;

    for (const model of models) {
      try {
        console.log(`[Identify API] Trying model ${model}`);
        const response = await generateContentWithRetry(ai, {
          model,
          contents: [
            {
              inlineData: {
                data: base64Image,
                mimeType: mimeType
              }
            },
            `Identify the trading card shown in this image.
Instructions:
1. Examine the bottom-right and bottom-left corners/borders of the card to find the card number/set code/rarity registration ID (e.g., '151/165', 'OP05-119', 'PR-060', 'ST01-001', '064/078').
2. Identify the official name of this character, pokemon, or item in the English TCG (Trading Card Game).
3. If the card text or character name printed on the card is in a foreign language (such as Japanese, Chinese, Korean, French, German, Spanish, etc.), detect that language, translate/map it, and determine its official English TCG card name (e.g. translate 'モンキー・D・ルフィ' or '蒙奇·D·路飞' to 'Monkey.D.Luffy', '리자몽' or 'リザードン' to 'Charizard').
4. Cross-reference the visual artwork style and the set/card number to ensure you are returning the correct, official card name and set number.
5. If the card number is not readable or the border is missing, try to identify the card name based on the illustration/character alone.

Return ONLY a JSON object matching the requested schema.`
          ],
          config: {
            systemInstruction: "You are an expert at analyzing and identifying trading cards from games like Pokémon, One Piece, Yu-Gi-Oh, Magic: The Gathering, and Lorcana. Your job is to extract the card's identifier number from the bottom-right or bottom-left corners, determine its official English card name, translate/map foreign languages to English, and return this data in a structured JSON schema.",
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                isFound: {
                  type: "boolean",
                  description: "True if you successfully identified the card name, false otherwise."
                },
                cardName: {
                  type: "string",
                  description: "The official English TCG name of the card. Leave blank if not found."
                },
                cardNumber: {
                  type: "string",
                  description: "The card number / set code printed in the bottom corner (e.g. 'OP05-119'). Leave blank if not found."
                },
                detectedLanguage: {
                  type: "string",
                  description: "The language printed on the card (e.g. 'Japanese', 'Korean', 'English'). Leave blank if not found."
                }
              },
              required: ["isFound", "cardName", "cardNumber", "detectedLanguage"]
            }
          }
        });

        if (response.text) {
          responseText = response.text;
          break;
        }
      } catch (e: any) {
        console.warn(`[Identify API] Model ${model} failed: ${e.message}`);
        lastError = e;
        if (e.message?.toLowerCase().includes("safety") || e.message?.toLowerCase().includes("block")) {
          throw e;
        }
      }
    }

    if (!responseText) {
      throw lastError || new Error("Failed to get response from Gemini API models.");
    }

    const parsed = JSON.parse(responseText);
    console.log("[Identify API] Result:", parsed);
    return NextResponse.json(parsed);

  } catch (error: any) {
    console.error("[Identify API] Error:", error);
    return NextResponse.json(
      { error: error.message || "An error occurred during card identification." },
      { status: 500 }
    );
  }
}
