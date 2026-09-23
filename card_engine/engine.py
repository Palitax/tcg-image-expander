"""TCG Card Homography & Multimodal Grounding Engine."""

import io
import os
import json
from pathlib import Path
from typing import Tuple, Union, Optional, Dict, Any
import cv2
import numpy as np
from PIL import Image, ImageOps

from .schemas import CardCorners, CardAnalysisResult


class TCGStreamEngine:
    """
    Production-grade TCG Card extraction engine.
    Uses multimodal spatial grounding (Gemini Vision) and mathematical homography (cv2.warpPerspective)
    to extract cards with 100% planar fidelity, eliminating sleeve overhangs and preserving all borders.
    """

    def __init__(self, gemini_api_key: Optional[str] = None):
        self.api_key = gemini_api_key or os.environ.get("GEMINI_API_KEY")
        self._genai_client = None

        # Lokale TCG-Set-Datenbank
        self.set_database: Dict[str, str] = {
            "M1": "Mega Brave",
            "M1S": "Mega Brave",
            "M1B": "Mega Symphonia",
            "M2": "Inferno X",
            "M2A": "Mega Dream ex",
            "M3": "Nihil Zero",
            "M4": "Ninja Spinner",
            "M5": "Abyss Eye",
            "M6": "Storm Emeralda",
            "SV1S": "Scarlet ex",
            "SV1V": "Violet ex",
            "SV1A": "Triplet Beat",
            "SV2D": "Clay Burst",
            "SV2P": "Snow Hazard",
            "SV2A": "Pokémon Card 151",
            "SV3": "Ruler of the Black Flame",
            "SV3A": "Raging Surf",
            "SV4K": "Ancient Roar",
            "SV4M": "Future Flash",
            "SV4A": "Shiny Treasure ex",
            "SV5K": "Wild Force",
            "SV5M": "Cyber Judge",
            "SV5A": "Crimson Haze",
            "SV6": "Mask of Change",
            "SV6A": "Night Wanderer",
            "SV7": "Stellar Miracle",
            "SV7A": "Paradise Dragona",
            "SV8": "Supercharged Breaker",
            "SV8A": "Terastal Festival",
            "SV9": "Battle Partners",
            "SV9A": "Heat Wave Arena",
            "SV10": "The Glory of Team Rocket",
            "OP05": "Awakening of the New Era",
            "OP-05": "Awakening of the New Era",
            "OP06": "Wings of the Captain",
            "OP-06": "Wings of the Captain",
        }

    def _get_client(self):
        if self._genai_client is None:
            if not self.api_key:
                raise ValueError("Kein Gemini API-Key vorhanden.")
            from google import genai
            self._genai_client = genai.Client(api_key=self.api_key.strip())
        return self._genai_client

    # ========================================================
    # 1. Bild-Normalisierung & EXIF-Ausrichtung
    # ========================================================
    @staticmethod
    def normalize_input_image(image_input: Union[str, Path, bytes, Image.Image, np.ndarray]) -> np.ndarray:
        """Lädt das Bild, korrigiert die Orientierung via EXIF und liefert ein 3-Kanal BGR-Array."""
        if isinstance(image_input, np.ndarray):
            if image_input.ndim == 2:
                return cv2.cvtColor(image_input, cv2.COLOR_GRAY2BGR)
            if image_input.ndim == 3:
                if image_input.shape[2] == 4:
                    return cv2.cvtColor(image_input, cv2.COLOR_BGRA2BGR)
                return image_input
            raise ValueError(f"Ungültiges NumPy-Bildformat: {image_input.shape}")

        if isinstance(image_input, (str, Path)):
            pil_img = Image.open(str(image_input))
        elif isinstance(image_input, bytes):
            pil_img = Image.open(io.BytesIO(image_input))
        elif isinstance(image_input, Image.Image):
            pil_img = image_input
        else:
            raise ValueError(f"Nicht unterstützter Bildtyp: {type(image_input)}")

        # EXIF-Ausrichtung korrigieren (Handy- und Scanner-Uploads)
        pil_img = ImageOps.exif_transpose(pil_img)
        if pil_img.mode != "RGB":
            pil_img = pil_img.convert("RGB")

        rgb_arr = np.array(pil_img, dtype=np.uint8)
        return cv2.cvtColor(rgb_arr, cv2.COLOR_RGB2BGR)

    # ========================================================
    # 2. Gemini Multimodal Grounding & Analyse
    # ========================================================
    def analyze_card_with_gemini(self, image_bgr: np.ndarray) -> CardAnalysisResult:
        """Führt OCR, 4-Punkt-Grounding und Szenenextraktion in einem strukturierten Gemini-Call aus."""
        client = self._get_client()
        from google.genai import types

        # BGR -> JPEG Bytes
        # Optimiere Bildgröße für ultraschnelle Vision-Inferenz (max 1600px)
        h, w = image_bgr.shape[:2]
        max_dim = max(h, w)
        if max_dim > 1600:
            scale = 1600.0 / max_dim
            analysis_img = cv2.resize(image_bgr, (int(round(w * scale)), int(round(h * scale))), interpolation=cv2.INTER_AREA)
        else:
            analysis_img = image_bgr

        # BGR -> JPEG Bytes
        success, buffer = cv2.imencode(".jpg", analysis_img, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not success:
            raise RuntimeError("Konnte Bild nicht als JPEG für Gemini enkodieren.")
        image_bytes = buffer.tobytes()

        system_instruction = (
            "Du bist ein ultra-präziser Computer-Vision-Experte für Trading Card Games (Pokémon, One Piece, Magic etc.).\n"
            "Deine Aufgabe ist es, die Sammelkarte im Bild pixelgenau zu lokalisieren und zu analysieren:\n\n"
            "1. OCR & METADATEN:\n"
            "   - card_name: Offizieller englischer Kartenname (z.B. 'ミルホッグ' -> 'Watchog', 'ワンパチ' -> 'Yamper', 'ヌイコグマ' -> 'Stufful', 'ユキカブリ' -> 'Snover', 'エリキテル' -> 'Helioptile', 'ピカチュウ' -> 'Pikachu').\n"
            "     WICHTIG BEI JAPANISCHEN KARTEN:\n"
            "     Der eigentliche Kartenname steht ganz oben im Header in großer Schrift rechts neben dem Entwicklungsstufen-Symbol (z.B. '1進化 ミルホッグ' -> der Kartenname ist 'ミルホッグ' = 'Watchog').\n"
            "     Verwechsle den Namen NIEMALS mit dem kleinen Vorentwicklungs-Text darunter (z.B. 'ミネズミから進化' -> 'ミネズミ' ist Patrat und NICHT der Name dieser Karte)!\n"
            "     Übersetze den japanischen Pokémon-Namen immer in den offiziellen englischen TCG-Namen (z.B. 'ミルホッグ' -> 'Watchog').\n"
            "   - collector_number: Exakte Sammlernummer (z.B. '095/083', '086/080', '075/063', '070/063', '067/063', '083/080', '195/193'). Niemals 'N/A' eintragen, wenn nicht vorhanden leer lassen ('').\n"
            "   - set_code: Set-Kürzel unten links (z.B. 'M4', 'M1S', 'M1', 'M2', 'SV5a', 'SV4K', 'OP05').\n"
            "     WICHTIG: Falls ein einzelner Buchstabe als Regulationszeichen in einer Box/Klammer steht (z.B. [J], [I], [H], [G]), ignoriere diesen Buchstaben in der Box VOLLSTÄNDIG und lies das eigentliche Set-Kürzel direkt daneben (z.B. bei '[J] M4 095/083 AR' ist das Set-Kürzel 'M4', die Sammlernummer '095/083' und die Seltenheit 'AR')! Niemals 'N/A' eintragen, wenn nicht vorhanden leer lassen ('').\n"
            "   - set_name: Offizieller englischer Set-Name (z.B. 'Ninja Spinner', 'Mega Brave', 'Inferno X', 'Crimson Haze', 'Ancient Roar', '151'). Niemals 'N/A' eintragen, wenn nicht vorhanden leer lassen ('').\n"
            "   - WICHTIG BEI KARTENRÜCKSEITEN:\n"
            "     Falls das Bild die RÜCKSEITE einer Sammelkarte zeigt (z.B. klassische Pokémon-Rückseite mit blauem Wirbel/Pokéball, One Piece Rücken, Magic-Rückseite):\n"
            "     Setze is_card_back=True, card_name='Card Back', collector_number='', set_code='', set_name=''! Niemals 'N/A' eintragen!\n\n"
            "2. SCENE PROMPT (STRIKT CHARAKTER- UND POKÉMON-FREI! ARTWORK PERFEKT FORTSETZEN!):\n"
            "   - scene_prompt: Eine detailreiche, bildhafte Beschreibung AUSSCHLIESSLICH der Umgebung, Kulisse, Natur, Raum, Atmosphäre, Beleuchtung, Farbpalette und des Kunststils, die das Karten-Artwork nahtlos nach außen in 360 Grad fortsetzt.\n"
            "   - Halte den exakten Malstil (z.B. digital anime painting, vibrant neon glow, painterly brush textures, watercolor wash, dark cinematic moody atmosphere) und die genauen Farbtöne fest (z.B. deep midnight indigo sky, glowing hot pink neon radio tower lattice, luminous cyan accents, silhouette city rooftops).\n"
            "   - STRIKT VERBOTEN: Erwähne NIEMALS das Pokémon, Charaktere, Lebewesen, Figuren, Menschen, Gesichter, Bälle oder Pokémon-Gegenstände! Die beschriebene Szene muss 100% menschen- und pokémonleer sein.\n\n"
            "3. ARTWORK-BEREICH (illustration_box & is_full_art):\n"
            "   - is_full_art: Setze auf True, falls das Artwork die gesamte Karte einnimmt (Full Art, Art Rare / AR, SAR, SIR, Character Rare). Bei Vintage- oder normalen Karten mit separatem Bildrahmen setze auf False.\n"
            "   - illustration_box: Bounding Box [ymin, xmin, ymax, xmax] im Bereich 0-1000 des Artwork-Bereichs. Bei Full Art fast die gesamte Karte (z.B. [40, 40, 960, 960]), bei Standardkarten nur das obere Bildfenster.\n\n"
            "4. 4-PUNKT KEYPOINT GROUNDING (EXTREM WICHTIG!):\n"
            "   - Die Karte befindet sich meist in einer transparenten Plastikhülle (Penny Sleeve), einem Toploader oder liegt auf einem Scannerbett.\n"
            "   - IGNORIERE DAS TRANSPARENTE PLASTIK, DIE SCHWEISSNÄHTE UND DEN ÜBERSTAND AM BODEN VOLLSTÄNDIG!\n"
            "   - Finde die 4 exakten Eckpunkte der PHYSISCHEN PAPPE (der eigentlichen gedruckten Karte inklusive des gesamten äußeren Silber- oder Gelbrandes).\n"
            "   - Gib die Koordinaten normalisiert im Bereich 0 bis 1000 als [y, x] an:\n"
            "     - top_left: [y, x] (obere linke Ecke der Pappe)\n"
            "     - top_right: [y, x] (obere rechte Ecke der Pappe)\n"
            "     - bottom_right: [y, x] (untere rechte Ecke der Pappe, direkt an der Unterkante des gedruckten Silberrandes unter dem Copyright)\n"
            "     - bottom_left: [y, x] (untere linke Ecke der Pappe, direkt an der Unterkante des gedruckten Silberrandes)"
        )

        models = [
            "gemini-2.5-flash",
            "gemini-2.0-flash",
            "gemini-1.5-flash",
            "gemini-2.5-pro",
            "gemini-1.5-pro"
        ]
        last_err = None

        def _clean_tcg_field(val: Optional[str]) -> str:
            if not val:
                return ""
            s = val.strip()
            if s.lower() in ("n/a", "na", "none", "null", "undefined", "-", "?"):
                return ""
            return s

        for model_name in models:
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=[
                        types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
                        "Lokalisiere die 4 Ecken der Papierkarte und extrahiere die Daten."
                    ],
                    config=types.GenerateContentConfig(
                        system_instruction=system_instruction,
                        response_mime_type="application/json",
                        response_schema=CardAnalysisResult,
                        temperature=0.1
                    )
                )
                if response.text:
                    parsed = CardAnalysisResult.model_validate_json(response.text)
                    # Felder bereinigen
                    parsed.collector_number = _clean_tcg_field(parsed.collector_number)
                    parsed.set_code = _clean_tcg_field(parsed.set_code)
                    if parsed.set_name:
                        parsed.set_name = _clean_tcg_field(parsed.set_name)
                    
                    # Fallback auf lokale Set-Datenbank falls set_name fehlt
                    if parsed.set_code and not parsed.set_name:
                        norm_code = parsed.set_code.strip().upper().replace("-", "")
                        if norm_code in self.set_database:
                            parsed.set_name = self.set_database[norm_code]

                    # Kartenrückseite-Schutz:
                    # Eine Karte ist NUR DANN eine Rückseite, wenn KEINE Sammlernummer und KEIN Set-Code vorhanden sind!
                    is_explicit_back_name = any(
                        x in parsed.card_name.lower() for x in ["card back", "pokémon card back", "pokemon card back", "rückseite"]
                    )
                    has_front_identifiers = bool(parsed.collector_number or parsed.set_code)

                    if has_front_identifiers:
                        # Hat Sammlernummer oder Set-Kürzel -> Garantiert eine Vorderseite!
                        parsed.is_card_back = False
                        if is_explicit_back_name:
                            parsed.card_name = ""
                    elif parsed.is_card_back or is_explicit_back_name:
                        # Reale Kartenrückseite ohne Sammlernummer/Set-Kürzel
                        parsed.is_card_back = True
                        parsed.card_name = "Pokémon Card Back"
                        parsed.collector_number = ""
                        parsed.set_code = ""
                        parsed.set_name = ""
                    
                    return parsed
            except Exception as err:
                last_err = err
                continue

        raise RuntimeError(f"Gemini Grounding fehlgeschlagen: {last_err}")

    # ========================================================
    # 3. Computer Vision Fallback (falls kein API-Key verfügbar)
    # ========================================================
    @staticmethod
    def detect_corners_cv_fallback(image_bgr: np.ndarray) -> CardCorners:
        """Erkennt die 4 Kartenecken mittels OpenCV Konturfindung, falls Gemini offline ist."""
        orig_h, orig_w = image_bgr.shape[:2]
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blurred, 30, 100)

        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        edges_dilated = cv2.dilate(edges, kernel, iterations=2)

        contours, _ = cv2.findContours(edges_dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contours = sorted(contours, key=cv2.contourArea, reverse=True)

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < (orig_w * orig_h * 0.2):
                continue
            peri = cv2.arcLength(cnt, True)
            pts = None
            for eps in [0.02, 0.03, 0.04, 0.05, 0.06, 0.07]:
                approx = cv2.approxPolyDP(cnt, eps * peri, True)
                if len(approx) == 4:
                    pts = approx.reshape(4, 2)
                    break
            if pts is None:
                rect = cv2.minAreaRect(cnt)
                pts = cv2.boxPoints(rect).astype(np.int32)

            # Sortiere Punkte: TL, TR, BR, BL
            s = pts.sum(axis=1)
            diff = np.diff(pts, axis=1)
            tl = pts[np.argmin(s)]
            br = pts[np.argmax(s)]
            tr = pts[np.argmin(diff)]
            bl = pts[np.argmax(diff)]
            return CardCorners(
                top_left=[int(round(tl[1] * 1000 / orig_h)), int(round(tl[0] * 1000 / orig_w))],
                top_right=[int(round(tr[1] * 1000 / orig_h)), int(round(tr[0] * 1000 / orig_w))],
                bottom_right=[int(round(br[1] * 1000 / orig_h)), int(round(br[0] * 1000 / orig_w))],
                bottom_left=[int(round(bl[1] * 1000 / orig_h)), int(round(bl[0] * 1000 / orig_w))]
            )

        # Letzter Ausweich-Zuschnitt: 95% Zentrum
        return CardCorners(
            top_left=[50, 50],
            top_right=[50, 950],
            bottom_right=[950, 950],
            bottom_left=[950, 50]
        )

    # ========================================================
    # 4. Mathematische Homographie & Vektor-Stanze
    # ========================================================
    @staticmethod
    def extract_and_flatten_card(
        image_bgr: np.ndarray,
        corners: CardCorners,
        target_width: int = 750,
        is_small_japanese_game: bool = False,
        edge_padding_px: int = 0,
        vertical_offset_px: int = 0,
        bottom_trim_px: int = 0,
        top_padding_px: int = 0
    ) -> np.ndarray:
        """
        Warped die 4 Eckpunkte per Homographie auf ein planares Rechteck (63:88 mm TCG-Verhältnis)
        und stanzt saubere, anti-aliaste abgerundete Ecken aus.
        Rückgabe: 4-Kanal BGRA mit 100% transparentem Hintergrund.
        """
        orig_h, orig_w = image_bgr.shape[:2]

        def to_px(pt: list) -> list:
            # pt ist [y, x] im Bereich [0..1000]
            y_norm, x_norm = pt[0], pt[1]
            return [float(x_norm) * orig_w / 1000.0, float(y_norm) * orig_h / 1000.0]

        tl = to_px(corners.top_left)
        tr = to_px(corners.top_right)
        br = to_px(corners.bottom_right)
        bl = to_px(corners.bottom_left)

        # Feinjustierungen anwenden falls vorhanden
        if vertical_offset_px:
            tl[1] += vertical_offset_px
            tr[1] += vertical_offset_px
            br[1] += vertical_offset_px
            bl[1] += vertical_offset_px
        if bottom_trim_px:
            br[1] -= bottom_trim_px
            bl[1] -= bottom_trim_px
        if top_padding_px:
            tl[1] -= top_padding_px
            tr[1] -= top_padding_px
        if edge_padding_px:
            tl[0] -= edge_padding_px
            bl[0] -= edge_padding_px
            tr[0] += edge_padding_px
            br[0] += edge_padding_px

        src_pts = np.array([tl, tr, br, bl], dtype=np.float32)

        # Standard-TCG Seitenverhältnis: 63mm x 88mm = 1:1.396825
        # Yu-Gi-Oh / Kleines Format: 59mm x 86mm = 1:1.4576
        target_ratio = 1.4576 if is_small_japanese_game else (88.0 / 63.0)
        target_height = int(round(target_width * target_ratio))

        dst_pts = np.array([
            [0, 0],
            [target_width - 1, 0],
            [target_width - 1, target_height - 1],
            [0, target_height - 1]
        ], dtype=np.float32)

        # 1. Homographie-Matrix berechnen und anwenden
        M = cv2.getPerspectiveTransform(src_pts, dst_pts)
        warped_bgr = cv2.warpPerspective(
            image_bgr,
            M,
            (target_width, target_height),
            flags=cv2.INTER_LANCZOS4
        )

        # 2. Vektormaske für abgerundete Die-Cut Ecken (Radius ~3.6% der Breite)
        radius = max(4, int(round(target_width * 0.036)))
        alpha_mask = np.zeros((target_height, target_width), dtype=np.uint8)

        # Kreuzförmiges Rechteck + 4 abgerundete Kreisecken
        cv2.rectangle(alpha_mask, (radius, 0), (target_width - radius, target_height), 255, -1)
        cv2.rectangle(alpha_mask, (0, radius), (target_width, target_height - radius), 255, -1)
        cv2.circle(alpha_mask, (radius, radius), radius, 255, -1)
        cv2.circle(alpha_mask, (target_width - radius, radius), radius, 255, -1)
        cv2.circle(alpha_mask, (radius, target_height - radius), radius, 255, -1)
        cv2.circle(alpha_mask, (target_width - radius, target_height - radius), radius, 255, -1)

        # Subpixel-Kantenglättung (Anti-Aliasing)
        alpha_mask = cv2.GaussianBlur(alpha_mask, (3, 3), 0)

        # 3. Zu 4-Kanal BGRA zusammensetzen
        b, g, r = cv2.split(warped_bgr)
        bgra = cv2.merge([b, g, r, alpha_mask])
        return bgra

    @staticmethod
    def auto_detect_adf_tcg_crop(image_bgr: np.ndarray, is_small: bool = False) -> Tuple[int, int, int, int]:
        """
        Automatische Kantenerkennung für Epson DS-530 ADF-Scans.
        Arretiert die physikalische TCG-Größe (1118 x 1560 px) und ermittelt
        per Sobel-Gradientenanalyse (erste signifikante Kante von außen) die Einzugsverschiebung (X, Y).
        """
        h, w = image_bgr.shape[:2]
        target_ratio = 1.4576 if is_small else (88.0 / 63.0)
        nominal_w = int(round(w * 0.9007))  # 1170px bei 1299px Scanbreite
        nominal_h = int(round(nominal_w * target_ratio))  # 1634px

        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)

        # 1. Y-Suche (horizontale Kante des oberen Kartenrands)
        mid_gray_y = gray[:, int(w * 0.25):int(w * 0.75)]
        sobel_y = np.abs(cv2.Sobel(mid_gray_y, cv2.CV_64F, 0, 1, ksize=3))
        profile_y = np.mean(sobel_y, axis=1)

        top_candidates = np.where(profile_y[25:160] > 55)[0]
        top_y = (25 + int(top_candidates[0])) if len(top_candidates) > 0 else 36

        # 2. X-Suche (vertikale Kante des linken Kartenrands)
        mid_gray_x = gray[int(h * 0.25):int(h * 0.75), :]
        sobel_x = np.abs(cv2.Sobel(mid_gray_x, cv2.CV_64F, 1, 0, ksize=3))
        profile_x = np.mean(sobel_x, axis=0)

        left_candidates = np.where(profile_x[25:160] > 55)[0]
        left_x = (25 + int(left_candidates[0])) if len(left_candidates) > 0 else 54

        # Begrenzungen absichern
        left_x = max(0, min(w - nominal_w, left_x))
        top_y = max(0, min(h - nominal_h, top_y))

        return left_x, top_y, nominal_w, nominal_h

    # ========================================================
    # 5. Vollständiger Verarbeitungsaufruf
    # ========================================================
    def process_card(
        self,
        image_input: Union[str, Path, bytes, Image.Image, np.ndarray],
        target_width: int = 750,
        edge_padding_px: int = 0,
        vertical_offset_px: int = 0,
        bottom_trim_px: int = 0,
        top_padding_px: int = 0,
        crop_box: Optional[Tuple[float, float, float, float]] = None
    ) -> Tuple[np.ndarray, CardAnalysisResult]:
        """
        Führt den gesamten Prozess aus:
        1. EXIF-Orientierung
        2. Gemini 4-Punkt Grounding & OCR (oder direkt crop_box aus Live-Visier / ADF Auto-Snap)
        3. Homographie & Vektor-Stanzung
        Rückgabe: (bgra_cutout_card, metadata_result)
        """
        image_bgr = self.normalize_input_image(image_input)
        orig_h, orig_w = image_bgr.shape[:2]

        if crop_box is not None:
            # Explizite Stanzrahmen-Koordinaten (x, y, width, height) aus dem Web-Interface
            bx, by, bw, bh = crop_box
            # Falls normalisiert in [0..1], auf Pixel skalieren
            if bw <= 1.0 and bh <= 1.0:
                bx = bx * orig_w
                by = by * orig_h
                bw = bw * orig_w
                bh = bh * orig_h

            corners = CardCorners(
                top_left=[int(round(by * 1000.0 / orig_h)), int(round(bx * 1000.0 / orig_w))],
                top_right=[int(round(by * 1000.0 / orig_h)), int(round((bx + bw) * 1000.0 / orig_w))],
                bottom_right=[int(round((by + bh) * 1000.0 / orig_h)), int(round((bx + bw) * 1000.0 / orig_w))],
                bottom_left=[int(round((by + bh) * 1000.0 / orig_h)), int(round(bx * 1000.0 / orig_w))]
            )
            try:
                analysis = self.analyze_card_with_gemini(image_bgr)
                analysis.corners = corners
            except Exception as e:
                import sys
                print(f"[card_engine] Gemini Analyse bei manuellem CropBox fehlgeschlagen: {e}", file=sys.stderr)
                analysis = CardAnalysisResult(
                    card_name="Sammelkarte",
                    collector_number="",
                    set_code="",
                    scene_prompt="",
                    corners=corners
                )
        elif 1150 <= orig_w <= 1450 and 1650 <= orig_h <= 1950:
            # Vollautomatischer TCG Auto-Snap für Epson DS-530 ADF-Scans
            bx, by, bw, bh = self.auto_detect_adf_tcg_crop(image_bgr)
            corners = CardCorners(
                top_left=[int(round(by * 1000.0 / orig_h)), int(round(bx * 1000.0 / orig_w))],
                top_right=[int(round(by * 1000.0 / orig_h)), int(round((bx + bw) * 1000.0 / orig_w))],
                bottom_right=[int(round((by + bh) * 1000.0 / orig_h)), int(round((bx + bw) * 1000.0 / orig_w))],
                bottom_left=[int(round((by + bh) * 1000.0 / orig_h)), int(round(bx * 1000.0 / orig_w))]
            )
            try:
                analysis = self.analyze_card_with_gemini(image_bgr)
                analysis.corners = corners
            except Exception as e:
                import sys
                print(f"[card_engine] Gemini Analyse bei ADF-Scan fehlgeschlagen: {e}", file=sys.stderr)
                analysis = CardAnalysisResult(
                    card_name="Sammelkarte",
                    collector_number="",
                    set_code="",
                    scene_prompt="",
                    corners=corners
                )
        else:
            try:
                analysis = self.analyze_card_with_gemini(image_bgr)
            except Exception as e:
                import sys
                print(f"[card_engine] Gemini Analyse fehlgeschlagen, nutze CV Fallback: {e}", file=sys.stderr)
                # Fallback auf CV falls API fehlschlägt
                corners = self.detect_corners_cv_fallback(image_bgr)
                analysis = CardAnalysisResult(
                    card_name="Unbekannte Karte",
                    collector_number="",
                    set_code="",
                    scene_prompt="",
                    corners=corners
                )

        is_small = getattr(analysis, "is_small_japanese_game", False)
        bgra_card = self.extract_and_flatten_card(
            image_bgr,
            analysis.corners,
            target_width=target_width,
            is_small_japanese_game=is_small,
            edge_padding_px=edge_padding_px,
            vertical_offset_px=vertical_offset_px,
            bottom_trim_px=bottom_trim_px,
            top_padding_px=top_padding_px
        )

        return bgra_card, analysis
