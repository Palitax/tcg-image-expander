"""CLI interface for card_engine homography extraction."""

import argparse
import json
import sys
from pathlib import Path
import cv2

from .engine import TCGStreamEngine


def main():
    parser = argparse.ArgumentParser(description="TCG Card Grounding & Homography Extraction CLI")
    parser.add_argument("-i", "--input", required=True, help="Pfad zum Eingabebild")
    parser.add_argument("-o", "--output", required=True, help="Pfad zur Ausgabe (transparentes RGBA-PNG)")
    parser.add_argument("--json", help="Optionaler Pfad zur JSON-Metadaten-Ausgabe")
    parser.add_argument("--api-key", help="Google Gemini API-Key")
    parser.add_argument("--width", type=int, default=750, help="Zielbreite der freigestellten Karte (Standard: 750px)")
    parser.add_argument("--edge-padding", type=int, default=0, help="Rand-Padding in Pixeln")
    parser.add_argument("--vertical-offset", type=int, default=0, help="Vertikaler Versatz in Pixeln")
    parser.add_argument("--bottom-trim", type=int, default=0, help="Abschnitt am unteren Rand in Pixeln")
    parser.add_argument("--top-padding", type=int, default=0, help="Oberes Padding in Pixeln")
    parser.add_argument("--crop-box", help="Optionaler Stanzrahmen x,y,w,h in Pixeln oder [0..1] normalisiert")

    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.is_file():
        print(f"Fehler: Datei nicht gefunden: {input_path}", file=sys.stderr)
        sys.exit(1)

    crop_box = None
    if args.crop_box:
        try:
            parts = [float(p.strip()) for p in args.crop_box.split(",")]
            if len(parts) == 4:
                crop_box = (parts[0], parts[1], parts[2], parts[3])
        except Exception as e:
            print(f"Warnung: Ungültiges crop-box Format: {args.crop_box} ({e})", file=sys.stderr)

    try:
        engine = TCGStreamEngine(gemini_api_key=args.api_key)
        card_bgra, analysis = engine.process_card(
            input_path,
            target_width=args.width,
            edge_padding_px=args.edge_padding,
            vertical_offset_px=args.vertical_offset,
            bottom_trim_px=args.bottom_trim,
            top_padding_px=args.top_padding,
            crop_box=crop_box
        )

        # Speichere transparentes PNG
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        success = cv2.imwrite(str(output_path), card_bgra)
        if not success:
            raise RuntimeError(f"Konnte Bild nicht speichern: {output_path}")

        # Speichere Metadaten falls gewünscht
        if args.json:
            json_path = Path(args.json)
            json_path.parent.mkdir(parents=True, exist_ok=True)
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(analysis.model_dump(), f, ensure_ascii=False, indent=2)

        # Gib Zusammenfassung auf stdout aus
        print(json.dumps({
            "status": "success",
            "card_name": analysis.card_name,
            "collector_number": analysis.collector_number,
            "set_code": analysis.set_code,
            "set_name": getattr(analysis, "set_name", "") or "",
            "corners": analysis.corners.model_dump(),
            "width": card_bgra.shape[1],
            "height": card_bgra.shape[0]
        }, ensure_ascii=False))

    except Exception as err:
        print(f"Fehler bei der Homographie-Freistellung: {err}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
