"""Numerically stable sigmoid activation, unletterboxing coordinate inversion, and guided filter edge refinement."""

from typing import Dict, Any
import numpy as np
import cv2


class Postprocessor:
    """Handles raw logit extraction, unpadding inversion, and structural edge refinement."""

    @staticmethod
    def stable_sigmoid(logits: np.ndarray) -> np.ndarray:
        """
        Calculates numerically stable sigmoid activation on logits to prevent overflow/NaN.

        Formula:
            sigma(z) = 1 / (1 + exp(-z)) for z >= 0
            sigma(z) = exp(z) / (1 + exp(z)) for z < 0

        Args:
            logits: NumPy array of any shape containing raw model output logits.

        Returns:
            np.ndarray of same shape, dtype=np.float32, values in [0.0, 1.0].
        """
        z = np.asarray(logits, dtype=np.float32)
        out = np.empty_like(z)

        pos_mask = z >= 0
        neg_mask = ~pos_mask

        # For z >= 0: 1 / (1 + exp(-z))
        out[pos_mask] = 1.0 / (1.0 + np.exp(-z[pos_mask]))

        # For z < 0: exp(z) / (1 + exp(z))
        exp_neg = np.exp(z[neg_mask])
        out[neg_mask] = exp_neg / (1.0 + exp_neg)

        return np.clip(out, 0.0, 1.0)

    @staticmethod
    def unletterbox(raw_alpha: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
        """
        Reverses the letterbox transformation by slicing padding offsets and rescaling back to native resolution.

        Args:
            raw_alpha: 2D or 3D probability map of shape (target_h, target_w) or (1, target_h, target_w).
            meta: Dictionary returned by Preprocessor.letterbox containing:
                orig_shape: (orig_h, orig_w)
                pad_offsets: (pad_x, pad_y)
                scaled_shape: (new_h, new_w)

        Returns:
            np.ndarray of shape (orig_h, orig_w), dtype=np.float32, values in [0.0, 1.0].
        """
        arr = np.squeeze(raw_alpha)
        if arr.ndim != 2:
            raise ValueError(f"Expected 2D probability map after squeeze, got shape: {arr.shape}")

        orig_h, orig_w = meta["orig_shape"]
        pad_x, pad_y = meta["pad_offsets"]
        new_h, new_w = meta["scaled_shape"]

        # Crop out the active unpadded region
        cropped = arr[pad_y : pad_y + new_h, pad_x : pad_x + new_w]

        # Bilinear resize back to exact native resolution (orig_w, orig_h)
        unletterboxed = cv2.resize(
            cropped,
            (orig_w, orig_h),
            interpolation=cv2.INTER_LINEAR,
        )

        return np.clip(unletterboxed, 0.0, 1.0).astype(np.float32)

    @staticmethod
    def refine_guided(
        alpha: np.ndarray,
        guide_bgr: np.ndarray,
        radius: int = 4,
        eps: float = 1e-4,
    ) -> np.ndarray:
        """
        Executes edge-preserving alpha matte smoothing using cv2.ximgproc.guidedFilter
        guided by the native high-resolution luminance.

        Args:
            alpha: 2D float32 alpha map of shape (H, W), values in [0.0, 1.0].
            guide_bgr: Native resolution BGR image of shape (H, W, 3), uint8.
            radius: Filter kernel radius (default 4).
            eps: Regularization parameter (default 1e-4).

        Returns:
            np.ndarray of shape (H, W), dtype=np.float32, refined and clipped to [0.0, 1.0].
        """
        # Convert guide image to normalized float32 grayscale luminance [0.0, 1.0]
        guide_gray = cv2.cvtColor(guide_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        src_alpha = np.ascontiguousarray(alpha, dtype=np.float32)

        try:
            refined = cv2.ximgproc.guidedFilter(
                guide=guide_gray,
                src=src_alpha,
                radius=radius,
                eps=eps,
            )
            return np.clip(refined, 0.0, 1.0).astype(np.float32)
        except Exception as err:
            # Fallback if ximgproc is not compiled with guidedFilter
            # Bilateral / edge-preserving smoothing fallback
            blurred = cv2.bilateralFilter(
                (src_alpha * 255.0).astype(np.uint8),
                d=radius * 2 + 1,
                sigmaColor=50,
                sigmaSpace=50,
            )
            return (blurred.astype(np.float32) / 255.0).clip(0.0, 1.0)
