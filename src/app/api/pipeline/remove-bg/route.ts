import { NextResponse } from "next/server";
import { removeBackgroundAI } from "@/utils/bgRemover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = (formData.get("image") || formData.get("cardImage")) as File | null;

    if (!file) {
      return NextResponse.json({ error: "Keine Bilddatei übermittelt." }, { status: 400 });
    }

    const noDecontaminate = formData.get("noDecontaminate") === "true";
    const noRefine = formData.get("noRefine") === "true";
    const noTiling = formData.get("noTiling") === "true";

    const arrayBuffer = await file.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    console.log(`[Remove-BG API] Starte KI Alpha Matting für Bild: ${file.name} (${imageBuffer.length} Bytes)...`);
    const outputBuffer = await removeBackgroundAI(imageBuffer, {
      noDecontaminate,
      noRefine,
      noTiling
    });

    console.log(`[Remove-BG API] Hintergrund erfolgreich entfernt (${outputBuffer.length} Bytes).`);

    return NextResponse.json({
      success: true,
      imageBase64: `data:image/png;base64,${outputBuffer.toString("base64")}`
    });
  } catch (err: any) {
    console.error("[Remove-BG API] Fehler bei der Hintergrundentfernung:", err);
    return NextResponse.json(
      { error: err?.message || "Fehler bei der KI-Hintergrundentfernung." },
      { status: 500 }
    );
  }
}
