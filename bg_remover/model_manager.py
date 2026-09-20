"""Model downloading, caching, integrity checks, and ONNX Runtime session setup."""

from pathlib import Path
from typing import Optional, Union, Tuple, List
import logging
import requests
from tqdm import tqdm
import onnxruntime as ort

logger = logging.getLogger(__name__)

DEFAULT_MODEL_URL = "https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx"
DEFAULT_CACHE_DIR = Path.home() / ".cache" / "bg_remover" / "models"
DEFAULT_MODEL_FILENAME = "rmbg-1.4.onnx"


class ModelManager:
    """Manages downloading, caching, and ONNX Runtime session initialization."""

    def __init__(
        self,
        model_path: Optional[Union[str, Path]] = None,
        use_gpu: bool = True,
        model_url: str = DEFAULT_MODEL_URL,
        cache_dir: Path = DEFAULT_CACHE_DIR,
    ):
        self.model_url = model_url
        self.cache_dir = Path(cache_dir)
        self.use_gpu = use_gpu

        if model_path is not None:
            self.model_path = Path(model_path)
            if not self.model_path.is_file():
                raise FileNotFoundError(f"Custom model file not found: {self.model_path}")
        else:
            self.model_path = self._ensure_model_available()

        self.session, self.active_providers = self._init_session()
        self.input_name, self.output_name, self.input_shape = self._inspect_model()

    def _ensure_model_available(self) -> Path:
        """Downloads the default model if not present in the cache."""
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        local_path = self.cache_dir / DEFAULT_MODEL_FILENAME

        if local_path.is_file():
            # Validate existing file is not an empty stub or HTML error page
            if self._validate_file_integrity(local_path):
                return local_path
            logger.warning("Corrupted or invalid cache file detected. Re-downloading...")
            local_path.unlink(missing_ok=True)

        logger.info(f"Downloading model from {self.model_url} to {local_path}...")
        self._download_file(self.model_url, local_path)

        if not self._validate_file_integrity(local_path):
            local_path.unlink(missing_ok=True)
            raise ValueError(
                f"Downloaded model at {local_path} failed integrity check. "
                "The server may have returned an HTML error page or truncated payload."
            )

        return local_path

    @staticmethod
    def _validate_file_integrity(file_path: Path) -> bool:
        """Validates that the file exists, has meaningful size, and is binary (not HTML)."""
        if not file_path.is_file():
            return False

        size_bytes = file_path.stat().st_size
        # RMBG-1.4 is ~170MB; minimum expected binary size is > 10MB
        if size_bytes < 10 * 1024 * 1024:
            return False

        # Check first 512 bytes are not HTML/Text error responses
        try:
            with open(file_path, "rb") as f:
                header = f.read(512).lower()
                if b"<!doctype html" in header or b"<html" in header:
                    return False
        except Exception:
            return False

        return True

    @staticmethod
    def _download_file(url: str, dest_path: Path) -> None:
        """Downloads a remote URL with progress bar and atomic temporary write."""
        temp_path = dest_path.with_suffix(".tmp")
        response = requests.get(url, stream=True, allow_redirects=True, timeout=60)
        response.raise_for_status()

        total_size = int(response.headers.get("content-length", 0))
        chunk_size = 1024 * 1024  # 1MB chunks

        with open(temp_path, "wb") as f, tqdm(
            desc=dest_path.name,
            total=total_size,
            unit="iB",
            unit_scale=True,
            unit_divisor=1024,
        ) as bar:
            for chunk in response.iter_content(chunk_size=chunk_size):
                if chunk:
                    f.write(chunk)
                    bar.update(len(chunk))

        temp_path.replace(dest_path)

    def _get_preferred_providers(self) -> List[str]:
        """Determines the preferred execution providers based on hardware availability."""
        if not self.use_gpu:
            return ["CPUExecutionProvider"]

        available = ort.get_available_providers()
        hierarchy = [
            "TensorrtExecutionProvider",
            "CUDAExecutionProvider",
            "CoreMLExecutionProvider",
            "CPUExecutionProvider",
        ]
        preferred = [p for p in hierarchy if p in available]
        if not preferred:
            preferred = ["CPUExecutionProvider"]
        return preferred

    def _init_session(self) -> Tuple[ort.InferenceSession, List[str]]:
        """Initializes ONNX Runtime session with automatic fallback on provider failure."""
        providers = self._get_preferred_providers()
        session_opts = ort.SessionOptions()
        session_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        try:
            session = ort.InferenceSession(
                str(self.model_path),
                sess_options=session_opts,
                providers=providers,
            )
            active = session.get_providers()
            logger.info(f"Initialized ONNX session with providers: {active}")
            return session, active
        except Exception as err:
            logger.warning(
                f"Failed to initialize ONNX session with {providers}: {err}. "
                "Falling back to CPUExecutionProvider."
            )
            fallback_session = ort.InferenceSession(
                str(self.model_path),
                sess_options=session_opts,
                providers=["CPUExecutionProvider"],
            )
            return fallback_session, ["CPUExecutionProvider"]

    def _inspect_model(self) -> Tuple[str, str, List[int]]:
        """Extracts input/output node names and spatial dimensions."""
        inputs = self.session.get_inputs()
        outputs = self.session.get_outputs()

        if not inputs or not outputs:
            raise ValueError("ONNX model has no input or output nodes.")

        input_node = inputs[0]
        output_node = outputs[0]

        input_shape = list(input_node.shape)
        # Default spatial dimensions to 1024x1024 if dynamic or unknown
        spatial = [1024, 1024]
        if len(input_shape) == 4:
            h, w = input_shape[2], input_shape[3]
            spatial = [
                h if isinstance(h, int) and h > 0 else 1024,
                w if isinstance(w, int) and w > 0 else 1024,
            ]

        return input_node.name, output_node.name, spatial
