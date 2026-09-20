"""Befehlszeilenschnittstelle (CLI) für hochpräzise Hintergrundentfernung im Batch- und Einzelbetrieb."""

import argparse
import sys
import time
from pathlib import Path
from typing import List
import logging
from tqdm import tqdm

from .pipeline import BackgroundRemover
from .exporter import Exporter

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("bg_remover")

SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif"}


def parse_args(args: List[str] = None) -> argparse.Namespace:
    """Parst Befehlszeilenargumente für die Hintergrundentfernungs-Engine."""
    parser = argparse.ArgumentParser(
        prog="bg-remover",
        description="Autonome High-Precision Background Removal & Alpha Matting Engine",
    )
    parser.add_argument(
        "-i", "--input",
        required=True,
        type=Path,
        help="Pfad zur Eingabedatei oder zum Quellverzeichnis mit Bildern.",
    )
    parser.add_argument(
        "-o", "--output",
        required=True,
        type=Path,
        help="Pfad zur Zieldatei (.png, .webp) oder zum Ausgabeverzeichnis.",
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=None,
        help="Optionaler benutzerdefinierter Pfad zu einem ONNX-Modell.",
    )
    parser.add_argument(
        "--cpu",
        action="store_true",
        help="Erzwingt CPUExecutionProvider (deaktiviert GPU/CoreML/TensorRT).",
    )
    parser.add_argument(
        "--no-decontaminate",
        action="store_true",
        help="Deaktiviert die Farbentkontaminierung (Despill) an Übergangsrändern.",
    )
    parser.add_argument(
        "--no-refine",
        action="store_true",
        help="Deaktiviert die Guided-Filter-Kantenverfeinerung.",
    )
    parser.add_argument(
        "--no-tiling",
        action="store_true",
        help="Deaktiviert das hierarchische Tiling für hochauflösende Bilder.",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=2048,
        help="Schwellenwert in Pixeln für die Aktivierung des hierarchischen Tilings (Standard: 2048).",
    )

    return parser.parse_args(args)


def collect_images(input_path: Path) -> List[Path]:
    """Sammelt alle unterstützten Bilddateien aus einer Datei oder einem Verzeichnis."""
    if input_path.is_file():
        if input_path.suffix.lower() in SUPPORTED_EXTENSIONS:
            return [input_path]
        raise ValueError(f"Nicht unterstütztes Dateiformat: {input_path.suffix}")

    if input_path.is_dir():
        files = [
            p for p in input_path.rglob("*")
            if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS
        ]
        return sorted(files)

    raise FileNotFoundError(f"Eingabepfad existiert nicht: {input_path}")


def main() -> None:
    args = parse_args()
    input_path = args.input
    output_path = args.output

    try:
        images = collect_images(input_path)
    except Exception as e:
        logger.error(f"Fehler beim Einlesen der Eingabebilder: {e}")
        sys.exit(1)

    if not images:
        logger.warning(f"Keine unterstützten Bilddateien in {input_path} gefunden.")
        sys.exit(0)

    logger.info(f"{len(images)} Bild(er) gefunden. Initialisiere BackgroundRemover...")

    remover = BackgroundRemover(
        model_path=args.model,
        use_gpu=not args.cpu,
        guided_filter_radius=0 if args.no_refine else 4,
        enable_color_decontamination=not args.no_decontaminate,
        enable_tiling_for_highres=not args.no_tiling,
        highres_threshold=args.threshold,
    )

    start_time = time.time()
    success_count = 0
    fail_count = 0

    is_batch = len(images) > 1 or input_path.is_dir()
    if is_batch:
        output_path.mkdir(parents=True, exist_ok=True)

    with tqdm(images, desc="Hintergrund entfernen", unit="Bild") as progress_bar:
        for img_path in progress_bar:
            try:
                # Bestimme Zielpfad
                if is_batch:
                    rel_path = img_path.relative_to(input_path) if input_path.is_dir() else img_path.name
                    target_file = output_path / rel_path
                    target_file = target_file.with_suffix(".png")
                else:
                    target_file = output_path
                    if target_file.suffix.lower() not in [".png", ".webp", ".jpg", ".jpeg"]:
                        target_file = target_file.with_suffix(".png")

                result_image = remover.process_image(img_path)
                Exporter.save(target_file, result_image)
                success_count += 1
            except Exception as item_err:
                fail_count += 1
                logger.error(f"Fehler bei {img_path.name}: {item_err}")

    elapsed = time.time() - start_time
    logger.info(
        f"Verarbeitung abgeschlossen: {success_count} erfolgreich, "
        f"{fail_count} fehlgeschlagen in {elapsed:.2f}s."
    )


if __name__ == "__main__":
    main()
