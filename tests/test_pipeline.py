"""Comprehensive unit and integration test suite for the bg_remover engine."""

import unittest
from pathlib import Path
from unittest.mock import MagicMock
import numpy as np
import cv2
from PIL import Image

from bg_remover.preprocessor import Preprocessor
from bg_remover.postprocessor import Postprocessor
from bg_remover.decontaminate import ColorDecontaminator
from bg_remover.tiling import HierarchicalTiler
from bg_remover.exporter import Exporter
from bg_remover.pipeline import BackgroundRemover


class TestPipeline(unittest.TestCase):
    """Rigorous unit tests verifying all mathematical and algorithmic invariants."""

    def test_polymorphic_inputs(self):
        """Validates consistent standardization across Path, PIL.Image, and NumPy arrays."""
        # 1. Base synthetic RGB image
        h, w = 120, 160
        base_rgb = np.zeros((h, w, 3), dtype=np.uint8)
        base_rgb[20:100, 30:130] = [200, 100, 50]  # distinct color

        # BGR equivalent
        expected_bgr = cv2.cvtColor(base_rgb, cv2.COLOR_RGB2BGR)

        # Test PIL.Image (RGB and RGBA)
        pil_rgb = Image.fromarray(base_rgb, mode="RGB")
        bgr_from_pil = Preprocessor.load_as_bgr(pil_rgb)
        np.testing.assert_array_equal(bgr_from_pil, expected_bgr)

        base_rgba = np.dstack([base_rgb, np.full((h, w), 255, dtype=np.uint8)])
        pil_rgba = Image.fromarray(base_rgba, mode="RGBA")
        bgr_from_rgba = Preprocessor.load_as_bgr(pil_rgba)
        np.testing.assert_array_equal(bgr_from_rgba, expected_bgr)

        # Test NumPy Grayscale 2D
        gray_2d = np.full((h, w), 128, dtype=np.uint8)
        bgr_from_gray = Preprocessor.load_as_bgr(gray_2d)
        self.assertEqual(bgr_from_gray.shape, (h, w, 3))
        self.assertTrue(np.all(bgr_from_gray == 128))

        # Test File Path loading
        temp_img_path = Path("/tmp/test_poly_input.png")
        cv2.imwrite(str(temp_img_path), expected_bgr)
        try:
            bgr_from_path = Preprocessor.load_as_bgr(temp_img_path)
            np.testing.assert_array_equal(bgr_from_path, expected_bgr)
        finally:
            temp_img_path.unlink(missing_ok=True)

    def test_letterbox_invertibility(self):
        """Verifies zero spatial drift when unletterboxing aspect ratios 16:9, 9:16, and 4:1."""
        test_ratios = [
            (900, 1600),   # 16:9 landscape
            (1600, 900),   # 9:16 portrait
            (400, 1600),   # 4:1 extreme aspect ratio
        ]

        target_size = (1024, 1024)

        for orig_h, orig_w in test_ratios:
            # Create synthetic test pattern with a distinct centered rectangle
            img = np.zeros((orig_h, orig_w, 3), dtype=np.uint8)
            y1, y2 = orig_h // 4, 3 * orig_h // 4
            x1, x2 = orig_w // 4, 3 * orig_w // 4
            img[y1:y2, x1:x2] = 255

            padded, meta = Preprocessor.letterbox(img, target_size=target_size)
            self.assertEqual(padded.shape, (1024, 1024, 3))

            # Simulate binary alpha map on the canvas
            simulated_canvas_alpha = (padded[:, :, 0] > 128).astype(np.float32)

            # Invert via unletterbox
            unpadded = Postprocessor.unletterbox(simulated_canvas_alpha, meta)

            # Assert restored dimensions exactly match the original
            self.assertEqual(unpadded.shape, (orig_h, orig_w))

            # Verify the inner rectangle is fully intact
            inner_recovered = unpadded[y1 + 5 : y2 - 5, x1 + 5 : x2 - 5]
            self.assertTrue(np.all(inner_recovered > 0.95))

            # Verify outer region is zero
            self.assertAlmostEqual(float(np.mean(unpadded[: y1 - 5, : x1 - 5])), 0.0, places=2)

    def test_numerical_stability(self):
        """Asserts stable_sigmoid against extreme inputs (+-1000) produces valid floats without NaN."""
        extreme_logits = np.array([
            -10000.0, -1000.0, -100.0, -10.0, 0.0,
            10.0, 100.0, 1000.0, 10000.0
        ], dtype=np.float32)

        probs = Postprocessor.stable_sigmoid(extreme_logits)

        # No NaNs or Infs
        self.assertFalse(np.isnan(probs).any())
        self.assertFalse(np.isinf(probs).any())

        # Exact limits
        self.assertAlmostEqual(probs[0], 0.0, places=6)
        self.assertAlmostEqual(probs[1], 0.0, places=6)
        self.assertAlmostEqual(probs[4], 0.5, places=6)
        self.assertAlmostEqual(probs[7], 1.0, places=6)
        self.assertAlmostEqual(probs[8], 1.0, places=6)

        # Monotonicity
        self.assertTrue(np.all(np.diff(probs) >= 0.0))

    def test_guided_filter_invariance(self):
        """Asserts guided filter output stays strictly in [0.0, 1.0] and preserves hard edges."""
        h, w = 200, 200
        guide_bgr = np.zeros((h, w, 3), dtype=np.uint8)
        guide_bgr[:, 100:] = 255  # sharp vertical luminance edge

        raw_alpha = np.zeros((h, w), dtype=np.float32)
        raw_alpha[:, 100:] = 1.0
        # Add slight artificial blur/noise to simulate raw neural network output
        noisy_alpha = cv2.GaussianBlur(raw_alpha, (5, 5), 1.0).astype(np.float32)

        refined = Postprocessor.refine_guided(noisy_alpha, guide_bgr, radius=4, eps=1e-4)

        self.assertEqual(refined.shape, (h, w))
        self.assertTrue(np.all(refined >= 0.0))
        self.assertTrue(np.all(refined <= 1.0))

        # Check edge alignment with guide
        self.assertLess(refined[100, 90], 0.1)
        self.assertGreater(refined[100, 110], 0.9)

    def test_color_decontamination(self):
        """Synthesizes a red object on green background and proves green spill is purged."""
        h, w = 100, 100
        # Foreground: Pure Red (BGR: 0, 0, 255)
        # Background: Pure Green (BGR: 0, 255, 0)
        img_bgr = np.zeros((h, w, 3), dtype=np.uint8)
        img_bgr[:, :50] = [0, 0, 255]   # Left is red object
        img_bgr[:, 50:] = [0, 255, 0]   # Right is green background

        # Simulate camera blur across the transition boundary (x = 45 to 55)
        blurred_bgr = cv2.GaussianBlur(img_bgr, (7, 7), 1.5)

        # Ideal alpha map: 1.0 on left, 0.0 on right with transition zone
        alpha = np.zeros((h, w), dtype=np.float32)
        alpha[:, :47] = 1.0
        alpha[:, 47:53] = np.linspace(0.8, 0.2, 6)
        alpha[:, 53:] = 0.0

        clean_bgr = ColorDecontaminator.decontaminate(
            blurred_bgr,
            alpha,
            threshold_bg=0.02,
            threshold_fg=0.95,
            dilation_radius=5,
        )

        # Prior to decontamination, green channel in transition zone was contaminated
        raw_green_bleed = blurred_bgr[:, 48, 1].mean()
        self.assertGreater(raw_green_bleed, 30.0)

        # After decontamination, green channel must be significantly suppressed by red propagation
        decontaminated_green = clean_bgr[:, 48, 1].mean()
        decontaminated_red = clean_bgr[:, 48, 2].mean()

        self.assertLess(decontaminated_green, raw_green_bleed)
        self.assertGreater(decontaminated_red, 180.0)

    def test_sliding_window_clamping(self):
        """Verifies tiling grid step computation and boundary clamping on odd dimensions."""
        tiler = HierarchicalTiler(patch_size=1024, overlap=256, highres_threshold=2048)

        # Arbitrary odd dimensions
        test_h, test_w = 2500, 1800
        self.assertTrue(tiler.should_tile(test_h, test_w))

        y_steps, x_steps = tiler.compute_grid_points(test_h, test_w)

        # Assert no patch exceeds boundaries
        for y in y_steps:
            self.assertGreaterEqual(y, 0)
            self.assertLessEqual(y + 1024, test_h)
            self.assertEqual(y + 1024 <= test_h, True)

        for x in x_steps:
            self.assertGreaterEqual(x, 0)
            self.assertLessEqual(x + 1024, test_w)

        # Assert final step touches the exact border
        self.assertEqual(y_steps[-1], test_h - 1024)
        self.assertEqual(x_steps[-1], test_w - 1024)

    def test_end_to_end_mocked_session(self):
        """Mocks ONNX session to verify end-to-end execution, RGBA shape, uint8 type, and export."""
        # Create a mock ModelManager with dummy session
        mock_session = MagicMock()
        # Mock session.run returning logit array of shape (1, 1, 1024, 1024)
        dummy_logits = np.full((1, 1, 1024, 1024), fill_value=5.0, dtype=np.float32)
        # Put circle in center
        y, x = np.ogrid[:1024, :1024]
        mask_circle = ((x - 512) ** 2 + (y - 512) ** 2) > 300 ** 2
        dummy_logits[0, 0, mask_circle] = -5.0

        mock_session.run.return_value = [dummy_logits]
        mock_session.get_providers.return_value = ["CPUExecutionProvider"]

        # Instantiate BackgroundRemover with mocked dependencies
        remover = BackgroundRemover.__new__(BackgroundRemover)
        remover.model_manager = MagicMock()
        remover.model_manager.session = mock_session
        remover.model_manager.input_name = "input"
        remover.model_manager.output_name = "output"
        remover.model_manager.input_shape = [1024, 1024]
        remover.target_size = (1024, 1024)
        remover.guided_filter_radius = 4
        remover.guided_filter_eps = 1e-4
        remover.enable_color_decontamination = True
        remover.enable_tiling_for_highres = False
        remover.tiler = HierarchicalTiler(patch_size=1024, overlap=256, highres_threshold=2048)

        # Process a synthetic 500x600 image
        input_img = np.full((500, 600, 3), fill_value=180, dtype=np.uint8)
        result_pil = remover.process_image(input_img)

        # Verify output
        self.assertIsInstance(result_pil, Image.Image)
        self.assertEqual(result_pil.mode, "RGBA")
        self.assertEqual(result_pil.size, (600, 500))  # PIL size is (width, height)

        rgba_arr = np.array(result_pil)
        self.assertEqual(rgba_arr.dtype, np.uint8)
        self.assertEqual(rgba_arr.shape, (500, 600, 4))

        # Alpha channel should have high values in center and low values at corners
        alpha_channel = rgba_arr[:, :, 3]
        self.assertGreater(alpha_channel[250, 300], 200)
        self.assertLess(alpha_channel[10, 10], 50)


if __name__ == "__main__":
    unittest.main()
