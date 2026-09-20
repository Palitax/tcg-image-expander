"""Polymorphic input loading, aspect-ratio-preserving letterbox padding, and tensor normalization."""

from pathlib import Path
from typing import Union, Tuple, Dict, Any
import numpy as np
import cv2
from PIL import Image

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class Preprocessor:
    """Handles image ingestion, letterbox transformations, and ImageNet normalization."""

    @staticmethod
    def load_as_bgr(image_input: Union[str, Path, np.ndarray, Image.Image]) -> np.ndarray:
        """
        Loads and standardizes polymorphic input into a 3-channel uint8 BGR NumPy array.

        Args:
            image_input: File path, pathlib.Path, PIL.Image, or NumPy array.

        Returns:
            np.ndarray of shape (H, W, 3), dtype=np.uint8, in BGR color space.
        """
        if isinstance(image_input, (str, Path)):
            path_obj = Path(image_input)
            if not path_obj.is_file():
                raise FileNotFoundError(f"Image file not found: {path_obj}")
            img_bgr = cv2.imread(str(path_obj), cv2.IMREAD_COLOR)
            if img_bgr is None:
                raise ValueError(f"Failed to decode image from path: {path_obj}")
            return img_bgr

        if isinstance(image_input, Image.Image):
            # Convert PIL image modes cleanly
            if image_input.mode == "RGBA":
                rgb_img = image_input.convert("RGB")
            elif image_input.mode == "L":
                rgb_img = image_input.convert("RGB")
            elif image_input.mode != "RGB":
                rgb_img = image_input.convert("RGB")
            else:
                rgb_img = image_input

            rgb_arr = np.array(rgb_img, dtype=np.uint8)
            return cv2.cvtColor(rgb_arr, cv2.COLOR_RGB2BGR)

        if isinstance(image_input, np.ndarray):
            arr = image_input.copy()
            if arr.dtype != np.uint8:
                # If float in [0, 1], scale to uint8
                if np.issubdtype(arr.dtype, np.floating):
                    arr = np.clip(arr * 255.0, 0, 255).astype(np.uint8)
                else:
                    arr = np.clip(arr, 0, 255).astype(np.uint8)

            if arr.ndim == 2:
                # 2D Grayscale -> 3-channel BGR
                return cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)

            if arr.ndim == 3:
                channels = arr.shape[2]
                if channels == 1:
                    return cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)
                if channels == 3:
                    # Standard OpenCV BGR assumption
                    return arr
                if channels == 4:
                    # Drop alpha channel, assume BGRA
                    return cv2.cvtColor(arr, cv2.COLOR_BGRA2BGR)

            raise ValueError(f"Unsupported numpy image shape: {arr.shape}")

        raise TypeError(f"Unsupported image input type: {type(image_input)}")

    @staticmethod
    def letterbox(
        image_bgr: np.ndarray,
        target_size: Tuple[int, int] = (1024, 1024),
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        """
        Isotropically scales and pads an image with neutral gray (128) to target dimensions.

        Args:
            image_bgr: Source BGR image of shape (orig_h, orig_w, 3).
            target_size: Desired model input size as (target_h, target_w).

        Returns:
            Tuple containing:
                - Padded BGR image of shape (target_h, target_w, 3), dtype=np.uint8.
                - Metadata dictionary containing:
                    orig_shape: (orig_h, orig_w)
                    pad_offsets: (pad_x, pad_y)
                    scaled_shape: (new_h, new_w)
                    scale: float scale factor
        """
        orig_h, orig_w = image_bgr.shape[:2]
        target_h, target_w = target_size

        if orig_h == 0 or orig_w == 0:
            raise ValueError(f"Invalid image dimensions: {orig_w}x{orig_h}")

        scale = min(target_w / orig_w, target_h / orig_h)
        new_w = max(1, int(round(orig_w * scale)))
        new_h = max(1, int(round(orig_h * scale)))

        # Bilinear resize to intermediate dimensions
        resized = cv2.resize(image_bgr, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

        # Create neutral gray canvas (128)
        canvas = np.full((target_h, target_w, 3), fill_value=128, dtype=np.uint8)

        # Compute symmetric padding offsets
        pad_x = (target_w - new_w) // 2
        pad_y = (target_h - new_h) // 2

        # Paste resized image into canvas center
        canvas[pad_y : pad_y + new_h, pad_x : pad_x + new_w] = resized

        meta = {
            "orig_shape": (orig_h, orig_w),
            "pad_offsets": (pad_x, pad_y),
            "scaled_shape": (new_h, new_w),
            "scale": scale,
        }
        return canvas, meta

    @staticmethod
    def normalize(padded_bgr: np.ndarray) -> np.ndarray:
        """
        Applies BGR->RGB conversion, [0.0, 1.0] scaling, ImageNet Z-score normalization,
        and packs into NCHW contiguous float32 tensor memory.

        Args:
            padded_bgr: Canvas image of shape (target_h, target_w, 3), dtype=np.uint8.

        Returns:
            np.ndarray of shape (1, 3, target_h, target_w), dtype=np.float32, contiguous.
        """
        # BGR -> RGB
        rgb = cv2.cvtColor(padded_bgr, cv2.COLOR_BGR2RGB)

        # Scale intensity to [0.0, 1.0]
        float_rgb = rgb.astype(np.float32) / 255.0

        # Apply ImageNet normalization: (X - mu) / sigma
        normalized = (float_rgb - IMAGENET_MEAN) / IMAGENET_STD

        # HWC -> CHW
        chw = np.transpose(normalized, (2, 0, 1))

        # Add batch dimension: (1, 3, H, W)
        nchw = np.expand_dims(chw, axis=0)

        return np.ascontiguousarray(nchw, dtype=np.float32)
