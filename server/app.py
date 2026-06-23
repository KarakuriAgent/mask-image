from __future__ import annotations

import argparse
import json
import mimetypes
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

try:
    from .mask_utils import data_url_to_bytes
    from .ml_pipeline import get_pipeline, get_pipeline_status
except ImportError:  # pragma: no cover - allows `python server/app.py`
    from mask_utils import data_url_to_bytes
    from ml_pipeline import get_pipeline, get_pipeline_status


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DIR = ROOT / "public"
MAX_BODY_BYTES = 80 * 1024 * 1024


class AppHandler(BaseHTTPRequestHandler):
    server_version = "MaskImage/0.1"

    def do_GET(self) -> None:
        if self.path == "/api/status":
            self.send_json(get_pipeline_status())
            return
        self.serve_static()

    def do_POST(self) -> None:
        if self.path == "/api/detect":
            self.handle_detect()
            return
        if self.path == "/api/segment-box":
            self.handle_segment_box()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY_BYTES:
            raise ValueError("Request body is too large")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def handle_detect(self) -> None:
        try:
            payload = self.read_json()
            image_bytes = data_url_to_bytes(payload["imageDataUrl"])
            width = int(payload["width"])
            height = int(payload["height"])
            prompts = str(payload.get("prompts") or "person . anime character . human figure . body")
            threshold = float(payload.get("threshold", 0.3))
            pipeline = get_pipeline()
            detections = pipeline.detect(image_bytes, width, height, prompts, threshold)
            self.send_json(
                {
                    "instances": [
                        detection.to_json(f"det-{index + 1}", width, height)
                        for index, detection in enumerate(detections)
                    ],
                    "pipeline": pipeline.name,
                    "available": pipeline.available,
                    "message": getattr(pipeline, "message", ""),
                    "setupHint": getattr(pipeline, "setup_hint", ""),
                }
            )
        except Exception as exc:
            traceback.print_exc()
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def handle_segment_box(self) -> None:
        try:
            payload = self.read_json()
            image_bytes = data_url_to_bytes(payload["imageDataUrl"])
            width = int(payload["width"])
            height = int(payload["height"])
            pipeline = get_pipeline()
            detection = pipeline.segment_box(image_bytes, width, height, payload["box"])
            self.send_json(
                {
                    "instance": detection.to_json("manual-1", width, height),
                    "message": getattr(pipeline, "message", ""),
                }
            )
        except Exception as exc:
            traceback.print_exc()
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def serve_static(self) -> None:
        path = unquote(self.path.split("?", 1)[0])
        if path == "/":
            path = "/index.html"
        relative = path.lstrip("/")
        candidate = (PUBLIC_DIR / relative).resolve()
        if PUBLIC_DIR not in candidate.parents and candidate != PUBLIC_DIR:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content = candidate.read_bytes()
        mime, _ = mimetypes.guess_type(str(candidate))
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", mime or "application/octet-stream")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    print(f"Mask Image running on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
