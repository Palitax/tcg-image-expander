import { NextRequest, NextResponse } from "next/server";
import {
  saveCalibration,
  matchCalibrations,
  exportAllCalibrations,
  importCalibrationsList,
  CardCalibrationRecord
} from "@/utils/calibrationStorage";

export async function GET() {
  try {
    const list = await exportAllCalibrations();
    return NextResponse.json({
      success: true,
      count: list.length,
      calibrations: list
    });
  } catch (error: unknown) {
    console.error("Fehler beim Abrufen der Kalibrierungen:", error);
    return NextResponse.json(
      { error: "Fehler beim Laden der Kalibrierungen" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "match") {
      const items = body.items || [];
      const matched = await matchCalibrations(items);
      return NextResponse.json({
        success: true,
        matched
      });
    }

    if (action === "save") {
      const calibration: CardCalibrationRecord = body.calibration;
      if (!calibration || (!calibration.fileHash && !calibration.fallbackKey)) {
        return NextResponse.json(
          { error: "Ungültige Kalibrierungsdaten" },
          { status: 400 }
        );
      }
      await saveCalibration(calibration);
      return NextResponse.json({ success: true });
    }

    if (action === "export") {
      const list = await exportAllCalibrations();
      return NextResponse.json({
        success: true,
        calibrations: list
      });
    }

    if (action === "import") {
      const calibrations: CardCalibrationRecord[] = body.calibrations || [];
      const importedCount = await importCalibrationsList(calibrations);
      return NextResponse.json({
        success: true,
        importedCount
      });
    }

    return NextResponse.json(
      { error: "Ungültige Aktion angegeben" },
      { status: 400 }
    );
  } catch (error: unknown) {
    console.error("Fehler im Kalibrierungs-Endpunkt:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Interner Serverfehler" },
      { status: 500 }
    );
  }
}
