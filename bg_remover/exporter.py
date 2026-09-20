"""RGBA channel merging, PIL conversion, and lossless PNG/WebP export."""

from pathlib import Path
from typing import Union
import numpy as np
import cv2
from PIL import Image


class Exporter:
    """Handles channel assembly and optimized disk serialization."""

    @staticmethod
    def to_rgba(image_bgr: np.ndarray, alpha: np.ndarray) -> np.ndarray:
        """
        Merges 3-channel BGR and 1-channel alpha into a 4-channel BGRA uint8 array.

        Args:
            image_bgr: NumPy array of shape (H, W, 3), dtype=np.uint8.
            alpha: NumPy array of shape (H, W), float32 in [0.0, 1.0] or uint8 in [0, 255].

        Returns:
            np.ndarray of shape (H, W, 4), dtype=np.uint8, BGRA layout.
        """
        if image_bgr.ndim != 3 or image_bgr.shape[2] != 3:
            raise ValueError(f"Expected 3-channel BGR image, got shape: {image_bgr.shape}")

        if np.issubdtype(alpha.dtype, np.floating):
            alpha_uint8 = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
        else:
            alpha_uint8 = np.clip(alpha, 0, 255).astype(np.uint8)

        if alpha_uint8.shape[:2] != image_bgr.shape[:2]:
            raise ValueError(
                f"Dimension mismatch between image ({image_bgr.shape[:2]}) "
                f"and alpha ({alpha_uint8.shape[:2]})."
            )

        b, g, r = cv2.split(image_bgr)
        return cv2.merge([b, g, r, alpha_uint8])

    @staticmethod
    def to_pil(bgra: np.ndarray) -> Image.Image:
        """
        Converts a 4-channel BGRA NumPy array into a PIL.Image in RGBA mode.

        Args:
            bgra: np.ndarray of shape (H, W, 4), dtype=np.uint8.

        Returns:
            PIL.Image.Image in 'RGBA' mode.
        """
        if bgra.ndim != 3 or bgra.shape[2] != 4:
            raise ValueError(f"Expected 4-channel BGRA array, got shape: {bgra.shape}")

        rgba = cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGBA)
        return Image.fromarray(rgba, mode="RGBA")

    @staticmethod
    def save(output_path: Union[str, Path], image_rgba: Image.Image) -> None:
        """
        Saves an RGBA PIL Image with optimal lossless compression settings.

        Args:
            output_path: Target file path (.png, .webp, .jpg, etc.).
            image_rgba: PIL.Image instance.
        """
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        ext = path.suffix.lower()

        if ext == ".png":
            image_rgba.save(path, format="PNG", optimize=True)
        elif ext == ".webp":
            image_rgba.save(path, format="WEBP", lossless=True, quality=100)
        elif ext in [".jpg", ".jpeg"]:
            # Flatten onto solid white background for lossy JPEG formats
            bg = Image.new("RGB", image_rgba.size, (255, 255, 255))
            if image_rgba.mode == "RGBA":
                bg.paste(image_rgba, mask=image_rgba.split()[3])
            else:
                bg.paste(image_rgba)
            bg.save(path, format="JPEG", quality=95)
        else:
            image_rgba.save(path)
