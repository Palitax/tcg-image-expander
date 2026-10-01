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

    const edgePaddingPx = parseInt((formData.get("edgePadding") as string) || "0", 10) || 0;
    const verticalOffsetPx = parseInt((formData.get("verticalOffset") as string) || "0", 10) || 0;
    const bottomTrimPx = parseInt((formData.get("bottomTrim") as string) || "0", 10) || 0;
    const topPaddingPx = parseInt((formData.get("topPadding") as string) || "0", 10) || 0;

    let cropBox: { x: number; y: number; width: number; height: number; imageWidth?: number; imageHeight?: number } | null = null;
    const cropBoxParam = formData.get("cropBox") as string | null;
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
        console.warn("[Crop API] Ungültiges cropBox-Format:", cropBoxParam);
      }
    }

    const cutoutResult = await extractCardCutout(originalImageBuffer, {
      apiKey,
      skipCardCrop,
      cornerRadiusPercent: 0.038,
      maxCardDimension: 1000,
      edgePaddingPx,
      verticalOffsetPx,
      bottomTrimPx,
      topPaddingPx,
      cropBox
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

