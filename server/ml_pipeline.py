from __future__ import annotations

import os
import inspect
import tempfile
import threading
from dataclasses import dataclass
from importlib.util import find_spec
from typing import Any

try:
    from .mask_utils import Box, bbox_from_mask, box_to_dict, encode_rle, normalize_box, rect_mask
except ImportError:  # pragma: no cover - allows `python server/app.py`
    from mask_utils import Box, bbox_from_mask, box_to_dict, encode_rle, normalize_box, rect_mask


class PipelineUnavailable(RuntimeError):
    pass


@dataclass
class Detection:
    label: str
    score: float | None
    box: Box
    mask: list[int]

    def to_json(self, instance_id: str, width: int, height: int) -> dict:
        box = self.box if self.box.width and self.box.height else bbox_from_mask(self.mask, width, height)
        return {
            "id": instance_id,
            "label": self.label,
            "score": self.score,
            "bbox": box_to_dict(box),
            "mask": encode_rle(self.mask),
        }


class NullPipeline:
    name = "none"
    available = False
    message = "ML backend is not configured"
    setup_hint = "Run `npm run setup:ml:cuda` or `npm run setup:ml:cpu`."

    def detect(self, image_bytes: bytes, width: int, height: int, prompts: str, threshold: float) -> list[Detection]:
        return []

    def segment_box(self, image_bytes: bytes, width: int, height: int, raw_box: dict) -> Detection:
        box = normalize_box(raw_box, width, height)
        return Detection("manual box", None, box, rect_mask(width, height, box))


class SamGroundingPipeline:
    name = "sam_grounding"
    available = True

    def __init__(self) -> None:
        self._model_lock = threading.RLock()
        self.device = os.environ.get("MASK_IMAGE_DEVICE", "cuda")
        self.sam2_config = os.environ.get("MASK_IMAGE_SAM2_CONFIG", "")
        self.sam2_checkpoint = os.environ.get("MASK_IMAGE_SAM2_CHECKPOINT", "")
        self.gdino_config = os.environ.get("MASK_IMAGE_GDINO_CONFIG", "")
        self.gdino_checkpoint = os.environ.get("MASK_IMAGE_GDINO_CHECKPOINT", "")
        if not self.sam2_config or not self.sam2_checkpoint:
            raise PipelineUnavailable("SAM2 config/checkpoint are required")
        self._load_optional_modules()
        self.sam_predictor = self._load_sam2()
        self.grounding_model = self._load_grounding_dino() if self.gdino_config and self.gdino_checkpoint else None
        if self.grounding_model is None:
            self.message = "SAM2 ready; GroundingDINO not configured, manual boxes only"
        else:
            self.message = "SAM2 and GroundingDINO ready"

    def _load_optional_modules(self) -> None:
        try:
            import numpy as np  # noqa: F401
            from PIL import Image  # noqa: F401
            import torch  # noqa: F401
        except Exception as exc:  # pragma: no cover - depends on optional local setup
            raise PipelineUnavailable(f"Missing ML dependency: {exc}") from exc

    def _load_sam2(self) -> Any:
        try:
            from sam2.build_sam import build_sam2
            from sam2.sam2_image_predictor import SAM2ImagePredictor
        except Exception as exc:  # pragma: no cover - depends on optional local setup
            raise PipelineUnavailable(f"Could not import SAM2: {exc}") from exc
        model = build_sam2(self.sam2_config, self.sam2_checkpoint, device=self.device)
        return SAM2ImagePredictor(model)

    def _load_grounding_dino(self) -> Any:
        try:
            from groundingdino.util.inference import load_model
        except Exception as exc:  # pragma: no cover - depends on optional local setup
            raise PipelineUnavailable(f"Could not import GroundingDINO: {exc}") from exc
        return load_model(self.gdino_config, self.gdino_checkpoint, device=self.device)

    def _open_image(self, image_bytes: bytes):
        import numpy as np
        from PIL import Image

        with tempfile.NamedTemporaryFile(suffix=".png", delete=True) as handle:
            handle.write(image_bytes)
            handle.flush()
            image = Image.open(handle.name).convert("RGB")
        return image, np.array(image)

    def _segment_boxes(self, image_array, boxes: list[Box], width: int, height: int) -> list[list[int]]:
        import numpy as np

        with self._model_lock:
            self.sam_predictor.set_image(image_array)
            masks: list[list[int]] = []
            for box in boxes:
                xyxy = np.array([box.x, box.y, box.x + box.width, box.y + box.height])
                raw_masks, scores, _ = self.sam_predictor.predict(box=xyxy, multimask_output=True)
                best_index = int(np.argmax(scores)) if len(scores) else 0
                bool_mask = raw_masks[best_index].reshape(height, width).astype(bool)
                masks.append([1 if value else 0 for value in bool_mask.reshape(-1)])
            return masks

    def detect(self, image_bytes: bytes, width: int, height: int, prompts: str, threshold: float) -> list[Detection]:
        if self.grounding_model is None:
            return []
        import torch
        from groundingdino.util.inference import load_image, predict

        with tempfile.NamedTemporaryFile(suffix=".png", delete=True) as handle:
            handle.write(image_bytes)
            handle.flush()
            image_source, image_tensor = load_image(handle.name)
            boxes, logits, phrases = predict(
                model=self.grounding_model,
                image=image_tensor,
                caption=prompts,
                box_threshold=threshold,
                text_threshold=threshold,
                device=self.device,
            )
        if isinstance(boxes, torch.Tensor):
            boxes = boxes.detach().cpu().numpy()
        if isinstance(logits, torch.Tensor):
            logits = logits.detach().cpu().numpy()

        parsed_boxes: list[Box] = []
        for box in boxes:
            cx, cy, bw, bh = [float(v) for v in box]
            parsed_boxes.append(
                normalize_box(
                    {
                        "x": (cx - bw / 2) * width,
                        "y": (cy - bh / 2) * height,
                        "width": bw * width,
                        "height": bh * height,
                    },
                    width,
                    height,
                )
            )
        _, image_array = self._open_image(image_bytes)
        masks = self._segment_boxes(image_array, parsed_boxes, width, height)
        detections: list[Detection] = []
        for index, box in enumerate(parsed_boxes):
            label = str(phrases[index]) if index < len(phrases) else "detected figure"
            score = float(logits[index]) if index < len(logits) else None
            detections.append(Detection(label, score, box, masks[index]))
        return detections

    def segment_box(self, image_bytes: bytes, width: int, height: int, raw_box: dict) -> Detection:
        box = normalize_box(raw_box, width, height)
        _, image_array = self._open_image(image_bytes)
        mask = self._segment_boxes(image_array, [box], width, height)[0]
        return Detection("manual SAM box", None, bbox_from_mask(mask, width, height), mask)


class HfGroundedSamPipeline:
    name = "hf_grounded_sam"
    available = True

    def __init__(self) -> None:
        self._model_lock = threading.RLock()
        self.device = os.environ.get("MASK_IMAGE_DEVICE", "cuda" if self._cuda_available() else "cpu")
        self.detector_model_id = os.environ.get("MASK_IMAGE_GDINO_MODEL", "IDEA-Research/grounding-dino-tiny")
        self.sam_model_id = os.environ.get("MASK_IMAGE_SAM2_MODEL", "facebook/sam2-hiera-tiny")
        self._load_optional_modules()
        self.processor, self.detector = self._load_detector()
        self.sam_predictor = self._load_sam2()
        self.message = f"HF GroundingDINO + SAM2 ready on {self.device}"
        self.setup_hint = ""

    def _cuda_available(self) -> bool:
        try:
            import torch

            return bool(torch.cuda.is_available())
        except Exception:
            return False

    def _load_optional_modules(self) -> None:
        missing = [
            module
            for module in ("numpy", "PIL", "torch", "transformers", "sam2")
            if find_spec(module) is None
        ]
        if missing:
            raise PipelineUnavailable(f"Missing ML dependency: {', '.join(missing)}")

    def _load_detector(self) -> tuple[Any, Any]:
        try:
            from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor
        except Exception as exc:  # pragma: no cover - depends on optional local setup
            raise PipelineUnavailable(f"Could not import Transformers detector: {exc}") from exc
        local_only = os.environ.get("MASK_IMAGE_LOCAL_FILES_ONLY", "").lower() in {"1", "true", "yes"}
        processor = AutoProcessor.from_pretrained(self.detector_model_id, local_files_only=local_only)
        detector = AutoModelForZeroShotObjectDetection.from_pretrained(self.detector_model_id, local_files_only=local_only)
        detector.to(self.device)
        detector.eval()
        return processor, detector

    def _load_sam2(self) -> Any:
        try:
            from sam2.sam2_image_predictor import SAM2ImagePredictor
        except Exception as exc:  # pragma: no cover - depends on optional local setup
            raise PipelineUnavailable(f"Could not import SAM2: {exc}") from exc
        local_only = os.environ.get("MASK_IMAGE_LOCAL_FILES_ONLY", "").lower() in {"1", "true", "yes"}
        try:
            return SAM2ImagePredictor.from_pretrained(self.sam_model_id, device=self.device, local_files_only=local_only)
        except TypeError:
            predictor = SAM2ImagePredictor.from_pretrained(self.sam_model_id)
            if hasattr(predictor, "model") and hasattr(predictor.model, "to"):
                predictor.model.to(self.device)
            return predictor

    def _open_image(self, image_bytes: bytes):
        import numpy as np
        from PIL import Image

        with tempfile.NamedTemporaryFile(suffix=".png", delete=True) as handle:
            handle.write(image_bytes)
            handle.flush()
            image = Image.open(handle.name).convert("RGB")
        return image, np.array(image)

    def _segment_boxes(self, image_array, boxes: list[Box], width: int, height: int) -> list[list[int]]:
        import numpy as np
        import torch

        with self._model_lock:
            self.sam_predictor.set_image(image_array)
            masks: list[list[int]] = []
            for box in boxes:
                xyxy = np.array([box.x, box.y, box.x + box.width, box.y + box.height])
                with torch.inference_mode():
                    raw_masks, scores, _ = self.sam_predictor.predict(box=xyxy, multimask_output=True)
                scores_array = np.asarray(scores)
                best_index = int(np.argmax(scores_array)) if scores_array.size else 0
                bool_mask = np.asarray(raw_masks[best_index]).reshape(height, width).astype(bool)
                masks.append([1 if value else 0 for value in bool_mask.reshape(-1)])
            return masks

    def detect(self, image_bytes: bytes, width: int, height: int, prompts: str, threshold: float) -> list[Detection]:
        import torch

        image, image_array = self._open_image(image_bytes)
        inputs = self.processor(images=image, text=prompts, return_tensors="pt")
        inputs = {key: value.to(self.device) if hasattr(value, "to") else value for key, value in inputs.items()}
        with torch.inference_mode():
            outputs = self.detector(**inputs)

        post_process = self.processor.post_process_grounded_object_detection
        post_process_kwargs = {
            "outputs": outputs,
            "input_ids": inputs.get("input_ids"),
            "text_threshold": threshold,
            "target_sizes": [(height, width)],
        }
        if "box_threshold" in inspect.signature(post_process).parameters:
            post_process_kwargs["box_threshold"] = threshold
        else:
            post_process_kwargs["threshold"] = threshold
        results = post_process(**post_process_kwargs)[0]
        boxes_raw = results.get("boxes", [])
        scores_raw = results.get("scores", [])
        labels_raw = results.get("text_labels", results.get("labels", []))
        boxes_list = boxes_raw.detach().cpu().tolist() if hasattr(boxes_raw, "detach") else list(boxes_raw)
        scores_list = scores_raw.detach().cpu().tolist() if hasattr(scores_raw, "detach") else list(scores_raw)
        labels_list = list(labels_raw)

        boxes: list[Box] = []
        for xyxy in boxes_list:
            x1, y1, x2, y2 = [float(value) for value in xyxy]
            boxes.append(normalize_box({"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}, width, height))
        masks = self._segment_boxes(image_array, boxes, width, height) if boxes else []
        detections: list[Detection] = []
        for index, box in enumerate(boxes):
            label = str(labels_list[index]) if index < len(labels_list) else "detected figure"
            score = float(scores_list[index]) if index < len(scores_list) else None
            detections.append(Detection(label, score, box, masks[index]))
        return detections

    def segment_box(self, image_bytes: bytes, width: int, height: int, raw_box: dict) -> Detection:
        box = normalize_box(raw_box, width, height)
        _, image_array = self._open_image(image_bytes)
        mask = self._segment_boxes(image_array, [box], width, height)[0]
        return Detection("manual SAM box", None, bbox_from_mask(mask, width, height), mask)


_PIPELINE: NullPipeline | SamGroundingPipeline | HfGroundedSamPipeline | None = None
_PIPELINE_LOCK = threading.RLock()


def _missing_ml_dependencies() -> list[str]:
    return [module for module in ("numpy", "PIL", "torch", "transformers", "sam2") if find_spec(module) is None]


def get_pipeline() -> NullPipeline | SamGroundingPipeline | HfGroundedSamPipeline:
    global _PIPELINE
    with _PIPELINE_LOCK:
        if _PIPELINE is not None:
            return _PIPELINE
        requested = os.environ.get("MASK_IMAGE_PIPELINE", "auto").strip().lower()
        if requested in {"auto", "hf", "hf_grounded_sam", "grounded_sam_hf"}:
            missing = _missing_ml_dependencies()
            if requested == "auto" and missing:
                pipeline = NullPipeline()
                pipeline.message = f"Automatic detection is disabled. Missing ML dependency: {', '.join(missing)}"
                _PIPELINE = pipeline
            else:
                try:
                    _PIPELINE = HfGroundedSamPipeline()
                except Exception as exc:
                    pipeline = NullPipeline()
                    pipeline.message = f"ML pipeline failed to initialize: {exc}"
                    _PIPELINE = pipeline
        elif requested in {"sam", "sam2", "sam_grounding", "grounded_sam"}:
            try:
                _PIPELINE = SamGroundingPipeline()
            except Exception as exc:
                pipeline = NullPipeline()
                pipeline.message = f"ML pipeline failed to initialize: {exc}"
                _PIPELINE = pipeline
        else:
            _PIPELINE = NullPipeline()
        return _PIPELINE


def get_pipeline_status() -> dict:
    with _PIPELINE_LOCK:
        if _PIPELINE is not None:
            return {
                "pipeline": _PIPELINE.name,
                "available": _PIPELINE.available,
                "message": getattr(_PIPELINE, "message", ""),
                "setupHint": getattr(_PIPELINE, "setup_hint", ""),
                "loaded": _PIPELINE.available,
            }
        requested = os.environ.get("MASK_IMAGE_PIPELINE", "auto").strip().lower()
        missing = _missing_ml_dependencies()
        if requested in {"auto", "hf", "hf_grounded_sam", "grounded_sam_hf"} and missing:
            return {
                "pipeline": "none",
                "available": False,
                "message": f"Automatic detection is disabled. Missing ML dependency: {', '.join(missing)}",
                "setupHint": NullPipeline.setup_hint,
                "loaded": False,
            }
        return {
            "pipeline": requested,
            "available": True,
            "message": "ML backend will load on first detection",
            "setupHint": "",
            "loaded": False,
        }
