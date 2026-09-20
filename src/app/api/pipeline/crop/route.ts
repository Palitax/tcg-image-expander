import { NextResponse } from "next/server";
import sharp from "sharp";
import { extractCardCutout } from "@/utils/cardCutout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const apiKey = (formData.get("apiKey") as string) || request.headers.get("x-gemini-api-key") || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Kein Google Gemini API-Key gefunden. Bitte trage deinen API-Key in den Einstellungen (Schlüssel-Symbol oben) oder in die .env.local ein." },
        { status: 400 }
      );
    }

    const file = formData.get("cardImage") as File | null;
    const skipCardCrop = formData.get("skipCardCrop") === "true";

    if (!file) {
      return NextResponse.json({ error: "Keine Bilddatei hochgeladen." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const rawImageBuffer = Buffer.from(arrayBuffer);

    // Normalize orientation with .rotate()
    const originalImageBuffer = await sharp(rawImageBuffer)
      .rotate()
      .toBuffer();

    const cutoutResult = await extractCardCutout(originalImageBuffer, {
      apiKey,
      skipCardCrop,
      cornerRadiusPercent: 0.038,
      maxCardDimension: 1200
    });

    console.log(`[Crop API] Extracted card cutout:`, {
      cardCoords: cutoutResult.cardCoords,
      cardName: cutoutResult.cardName,
      cardNumber: cutoutResult.cardNumber,
      usedFallback: cutoutResult.usedFallback
    });

    return NextResponse.json({
      croppedImage: cutoutResult.illustrationBase64,
      trimmedCard: cutoutResult.cutoutCardBase64,
      coords: cutoutResult.illustrationCoords,
      usedFallback: cutoutResult.usedFallback,
      cardName: cutoutResult.cardName,
      cardNumber: cutoutResult.cardNumber
    });

  } catch (error: any) {
    console.error("Error in Crop API:", error);
    return NextResponse.json({ error: error.message || "Interner Serverfehler beim Zuschneiden der Karte." }, { status: 500 });
  }
}

