"""Pydantic schemas for structured Gemini card detection and grounding."""

from typing import List, Optional
from pydantic import BaseModel, Field


class CardCorners(BaseModel):
    """Normalized [y, x] coordinates of the 4 outer cardboard corners in [0, 1000]."""
    top_left: List[int] = Field(description="[y, x] Koordinaten der oberen linken Ecke der Pappe im Bereich 0-1000")
    top_right: List[int] = Field(description="[y, x] Koordinaten der oberen rechten Ecke der Pappe im Bereich 0-1000")
    bottom_right: List[int] = Field(description="[y, x] Koordinaten der unteren rechten Ecke der Pappe im Bereich 0-1000")
    bottom_left: List[int] = Field(description="[y, x] Koordinaten der unteren linken Ecke der Pappe im Bereich 0-1000")


class CardAnalysisResult(BaseModel):
    """Complete multimodal analysis result from Gemini Vision."""
    card_name: str = Field(description="Offizieller englischer Kartenname (z.B. 'Stufful', 'Snover', 'Charcadet')")
    collector_number: str = Field(description="Karten-Sammlernummer (z.B. '075/063', '067/063', '083/080')")
    set_code: str = Field(description="Set-Identifikator (z.B. 'M1S', 'M2', 'SV6', 'OP-05')")
    scene_prompt: str = Field(
        description="Vollständiger, detaillierter Prompt der Umgebung, des Artworks, Lichts und Stils für Imagen 3 (ohne Text, Charaktere oder Pokémon)"
    )
    corners: CardCorners = Field(
        description="Die 4 exakten Eckpunkte der physischen Pappe. Transparente Hüllen (Penny Sleeves), Toploader oder Überhänge müssen strikt ignoriert werden!"
    )
    is_small_japanese_game: Optional[bool] = Field(
        default=False,
        description="True für kleine japanische Spiele wie Yu-Gi-Oh (59x86mm), False für Standard-Karten wie Pokémon/MTG/One Piece (63x88mm)"
    )
    illustration_box: Optional[List[int]] = Field(
        default=None,
        description="Bounding Box [ymin, xmin, ymax, xmax] normalisiert 0-1000 des Artwork-Bereichs. Bei Full-Art/AR/SAR/SIR-Karten erstreckt sich das Artwork fast über die gesamte Karte (z.B. [40, 40, 960, 960]). Bei Vintage/Standard-Karten ist es das obere Illustrationsfenster."
    )
    is_full_art: Optional[bool] = Field(
        default=False,
        description="True, falls das Artwork die gesamte Karte ausfüllt (Full Art, Art Rare, SAR, Special Illustration Rare), False bei traditionellen Karten mit separatem Illustrationsrahmen."
    )
