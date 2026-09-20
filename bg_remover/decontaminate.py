"""Color decontamination, despill, and edge defringing via pure foreground color propagation."""

import numpy as np
import cv2


class ColorDecontaminator:
    """Purges background color bleed and halos from semi-transparent transition pixels."""

    @staticmethod
    def decontaminate(
        image_bgr: np.ndarray,
        alpha: np.ndarray,
        threshold_bg: float = 0.02,
        threshold_fg: float = 0.98,
        dilation_radius: int = 5,
        max_iterations: int = 25,
    ) -> np.ndarray:
        """
        Eliminates background color bleed along semi-transparent transition boundaries by
        propagating 100% pure interior foreground colors outward and unmixing.

        Formula:
            F_corrected[i] = alpha[i] * I[i] + (1.0 - alpha[i]) * F_dilated[i]

        Args:
            image_bgr: Native resolution uint8 image array of shape (H, W, 3).
            alpha: Refined float32 alpha matte of shape (H, W), values in [0.0, 1.0].
            threshold_bg: Lower bound threshold for background cutoff (default 0.02).
            threshold_fg: Upper bound threshold for pure foreground (default 0.98).
            dilation_radius: Kernel size for elliptical structuring element (default 5).
            max_iterations: Maximum dilation propagation iterations (default 25).

        Returns:
            clean_bgr: np.ndarray of shape (H, W, 3), dtype=np.uint8, purged of edge halos.
        """
        if image_bgr.ndim != 3 or image_bgr.shape[2] != 3:
            raise ValueError(f"Expected 3-channel BGR image, got shape: {image_bgr.shape}")

        pure_fg = alpha >= threshold_fg
        transition = (alpha > threshold_bg) & (alpha < threshold_fg)

        # Early return if no transition region or no interior foreground exists
        if not np.any(transition) or not np.any(pure_fg):
            return image_bgr.copy()

        # Isolate clean interior foreground colors (zero out non-pure-foreground)
        fg_color = image_bgr.copy()
        fg_color[~pure_fg] = 0

        # Validity mask tracking known foreground color coverage
        valid_mask = pure_fg.astype(np.uint8)

        # Elliptical structuring element for isotropic color propagation
        k_size = max(3, dilation_radius if dilation_radius % 2 == 1 else dilation_radius + 1)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k_size, k_size))

        # Iteratively propagate foreground colors into the transition zone
        dilated_color = fg_color.copy()
        for _ in range(max_iterations):
            unfilled = transition & (valid_mask == 0)
            if not np.any(unfilled):
                break
            dilated_color = cv2.dilate(dilated_color, kernel)
            valid_mask = cv2.dilate(valid_mask, kernel)

        # Prepare float representations for high-precision blending
        clean_bgr = image_bgr.copy()
        alpha_3d = np.expand_dims(alpha, axis=2).astype(np.float32)
        orig_float = image_bgr.astype(np.float32)
        dilated_float = dilated_color.astype(np.float32)

        # For transition pixels: blend observed color with propagated clean foreground
        # F_clean = alpha * I + (1 - alpha) * F_dilated
        corrected_float = alpha_3d * orig_float + (1.0 - alpha_3d) * dilated_float
        corrected_uint8 = np.clip(corrected_float, 0, 255).astype(np.uint8)

        # Apply correction specifically to the transition zone
        clean_bgr[transition] = corrected_uint8[transition]

        return clean_bgr
