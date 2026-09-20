"""Central orchestrator for end-to-end background removal and alpha matting."""

from pathlib import Path
from typing import Union, Optional, Tuple
import numpy as np
from PIL import Image

from .model_manager import ModelManager
from .preprocessor import Preprocessor
from .postprocessor import Postprocessor
from .decontaminate import ColorDecontaminator
from .tiling import HierarchicalTiler
from .exporter import Exporter


class BackgroundRemover:
    """
    Production-grade high-precision background removal and alpha matting engine.
    Executes the strict 6-stage computer vision matting pipeline.
    """

    def __init__(
        self,
        model_path: Optional[Union[str, Path]] = None,
        use_gpu: bool = True,
        guided_filter_radius: int = 4,
        guided_filter_eps: float = 1e-4,
        enable_color_decontamination: bool = True,
        enable_tiling_for_highres: bool = True,
        highres_threshold: int = 2048,
    ):
        """
        Initializes the background removal engine and underlying hardware acceleration session.

        Args:
            model_path: Optional custom path to ONNX model file. If None, auto-downloads RMBG-1.4.
            use_gpu: Whether to attempt hardware execution providers (TensorRT -> CUDA -> CoreML).
            guided_filter_radius: Kernel radius for structural edge smoothing (default 4).
            guided_filter_eps: Regularization parameter for guided filter (default 1e-4).
            enable_color_decontamination: Whether to purge background color bleed and halos.
            enable_tiling_for_highres: Whether to execute sliding-window hierarchical tiling on >2048px images.
            highres_threshold: Dimension threshold in pixels to trigger hierarchical tiling.
        """
        self.model_manager = ModelManager(model_path=model_path, use_gpu=use_gpu)
        self.guided_filter_radius = guided_filter_radius
        self.guided_filter_eps = guided_filter_eps
        self.enable_color_decontamination = enable_color_decontamination
        self.enable_tiling_for_highres = enable_tiling_for_highres

        target_h, target_w = self.model_manager.input_shape
        self.target_size: Tuple[int, int] = (target_h, target_w)

        self.tiler = HierarchicalTiler(
            patch_size=target_w,
            overlap=256,
            highres_threshold=highres_threshold,
        )

    def _infer_single_pass(self, bgr_image: np.ndarray) -> np.ndarray:
        """Runs standard model inference on an image via letterboxing, inference, and unletterboxing."""
        padded, meta = Preprocessor.letterbox(bgr_image, target_size=self.target_size)
        tensor = Preprocessor.normalize(padded)

        outputs = self.model_manager.session.run(
            [self.model_manager.output_name],
            {self.model_manager.input_name: tensor},
        )

        raw_probs = Postprocessor.stable_sigmoid(outputs[0])
        alpha_matte = Postprocessor.unletterbox(raw_probs, meta)
        return alpha_matte

    def get_alpha_mask(
        self,
        image: Union[np.ndarray, Image.Image, str, Path],
    ) -> np.ndarray:
        """
        Executes the pipeline up to edge refinement and returns the refined 2D float32 alpha matte.

        Args:
            image: File path, pathlib.Path, PIL.Image, or NumPy array.

        Returns:
            np.ndarray: 2D array of shape (H, W), dtype=np.float32, values in [0.0, 1.0].
        """
        # 1. Input parsing and color standardization
        image_bgr = Preprocessor.load_as_bgr(image)

        # 2. Global low-res inference pass
        base_alpha = self._infer_single_pass(image_bgr)

        # 3. Hierarchical tiling for high-resolution images
        orig_h, orig_w = image_bgr.shape[:2]
        if self.enable_tiling_for_highres and self.tiler.should_tile(orig_h, orig_w):
            alpha = self.tiler.refine_highres(
                image_bgr,
                base_alpha,
                infer_patch_fn=self._infer_single_pass,
            )
        else:
            alpha = base_alpha

        # 4. Structural edge refinement via Guided Filter
        if self.guided_filter_radius > 0:
            alpha = Postprocessor.refine_guided(
                alpha,
                image_bgr,
                radius=self.guided_filter_radius,
                eps=self.guided_filter_eps,
            )

        return alpha

    def process_image(
        self,
        image: Union[np.ndarray, Image.Image, str, Path],
    ) -> Image.Image:
        """
        Executes the complete end-to-end background removal and color decontamination pipeline.

        Returns:
            PIL.Image in RGBA mode with background removed, halo-free decontaminated edges,
            and exact aspect ratio preservation.
        """
        # 1. Input parsing and color standardization
        image_bgr = Preprocessor.load_as_bgr(image)

        # 2-4. Extract refined alpha matte
        alpha = self.get_alpha_mask(image_bgr)

        # 5. Color Decontamination / Despill
        if self.enable_color_decontamination:
            clean_bgr = ColorDecontaminator.decontaminate(image_bgr, alpha)
        else:
            clean_bgr = image_bgr

        # 6. Compositing & Export: ALWAYS composite clean_bgr with alpha
        bgra = Exporter.to_rgba(clean_bgr, alpha)
        return Exporter.to_pil(bgra)
