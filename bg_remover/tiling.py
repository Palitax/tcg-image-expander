"""Hierarchical tiling and 2D cosine window blending for ultra-high-resolution images."""

from typing import Callable, List, Tuple
import numpy as np


class HierarchicalTiler:
    """Manages high-resolution sliding-window tile inference and seamless blending."""

    def __init__(
        self,
        patch_size: int = 1024,
        overlap: int = 256,
        highres_threshold: int = 2048,
    ):
        self.patch_size = patch_size
        self.overlap = overlap
        self.stride = patch_size - overlap
        self.highres_threshold = highres_threshold
        self.cosine_window = self._generate_2d_cosine_window(patch_size)

    @staticmethod
    def _generate_2d_cosine_window(size: int) -> np.ndarray:
        """
        Constructs a 2D Cosine / Hanning window weight matrix to prevent seam artifacts:
            W(y, x) = sin(pi * (y + 0.5) / size) * sin(pi * (x + 0.5) / size)
        """
        grid = (np.arange(size, dtype=np.float32) + 0.5) / size
        window_1d = np.sin(np.pi * grid).astype(np.float32)
        return np.outer(window_1d, window_1d).astype(np.float32)

    def should_tile(self, height: int, width: int) -> bool:
        """Checks if image dimensions exceed the high-resolution threshold."""
        return max(height, width) > self.highres_threshold

    def compute_grid_points(self, orig_h: int, orig_w: int) -> Tuple[List[int], List[int]]:
        """
        Calculates clamped grid step positions ensuring full coverage of borders.
        Every extracted patch is strictly (patch_size, patch_size).
        """
        if orig_w <= self.patch_size:
            x_steps = [0]
        else:
            raw_x = list(range(0, orig_w - self.patch_size, self.stride)) + [orig_w - self.patch_size]
            x_steps = sorted(list(set(max(0, min(x, orig_w - self.patch_size)) for x in raw_x)))

        if orig_h <= self.patch_size:
            y_steps = [0]
        else:
            raw_y = list(range(0, orig_h - self.patch_size, self.stride)) + [orig_h - self.patch_size]
            y_steps = sorted(list(set(max(0, min(y, orig_h - self.patch_size)) for y in raw_y)))

        return y_steps, x_steps

    def refine_highres(
        self,
        image_bgr: np.ndarray,
        base_alpha: np.ndarray,
        infer_patch_fn: Callable[[np.ndarray], np.ndarray],
    ) -> np.ndarray:
        """
        Executes selective hierarchical matting on the Trimap transition boundary.

        Args:
            image_bgr: Native high-resolution BGR image of shape (H, W, 3), uint8.
            base_alpha: Upscaled global base alpha matte of shape (H, W), float32.
            infer_patch_fn: Callable that accepts a (patch_size, patch_size, 3) BGR array
                            and returns a (patch_size, patch_size) float32 alpha map.

        Returns:
            np.ndarray: Blended refined alpha map of shape (H, W), float32, in [0.0, 1.0].
        """
        orig_h, orig_w = image_bgr.shape[:2]

        if not self.should_tile(orig_h, orig_w):
            return base_alpha

        # Compute Trimap: Transition zone is 0.05 <= alpha <= 0.95
        transition_mask = (base_alpha >= 0.05) & (base_alpha <= 0.95)
        if not np.any(transition_mask):
            return base_alpha

        y_steps, x_steps = self.compute_grid_points(orig_h, orig_w)

        canvas_alpha = np.zeros((orig_h, orig_w), dtype=np.float32)
        canvas_weights = np.zeros((orig_h, orig_w), dtype=np.float32)

        p_size = self.patch_size
        window = self.cosine_window

        for y in y_steps:
            for x in x_steps:
                patch_trans = transition_mask[y : y + p_size, x : x + p_size]
                # Selective inference: Only process patch if it intersects with transition band
                if not np.any(patch_trans):
                    continue

                patch_img = image_bgr[y : y + p_size, x : x + p_size]
                if patch_img.shape[0] != p_size or patch_img.shape[1] != p_size:
                    # Pad if image is smaller than patch size
                    pad_h = p_size - patch_img.shape[0]
                    pad_w = p_size - patch_img.shape[1]
                    patch_img = np.pad(patch_img, ((0, pad_h), (0, pad_w), (0, 0)), mode="reflect")
                    patch_raw = infer_patch_fn(patch_img)
                    patch_alpha = patch_raw[: orig_h - y, : orig_w - x]
                    curr_window = window[: orig_h - y, : orig_w - x]
                else:
                    patch_alpha = infer_patch_fn(patch_img)
                    curr_window = window

                curr_h, curr_w = patch_alpha.shape[:2]
                canvas_alpha[y : y + curr_h, x : x + curr_w] += patch_alpha * curr_window
                canvas_weights[y : y + curr_h, x : x + curr_w] += curr_window

        # Normalize and composite back over the global base alpha
        has_weight = canvas_weights > 1e-6
        refined_alpha = base_alpha.copy()
        refined_alpha[has_weight] = (
            canvas_alpha[has_weight] / canvas_weights[has_weight]
        )

        return np.clip(refined_alpha, 0.0, 1.0).astype(np.float32)
