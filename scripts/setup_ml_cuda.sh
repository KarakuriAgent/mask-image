#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
CUDA_TAG="${1:-${PYTORCH_CUDA:-cu128}}"

case "$CUDA_TAG" in
  cu118|cu126|cu128) ;;
  *)
    echo "Unsupported CUDA tag: $CUDA_TAG" >&2
    echo "Use one of: cu118, cu126, cu128" >&2
    exit 2
    ;;
esac

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install --index-url "https://download.pytorch.org/whl/$CUDA_TAG" torch torchvision
"$VENV_DIR/bin/python" -m pip install -r "$ROOT_DIR/requirements-ml.txt"

"$VENV_DIR/bin/python" - <<'PY'
import torch
print("torch:", torch.__version__)
print("cuda available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("device:", torch.cuda.get_device_name(0))
PY

cat <<'MSG'

CUDA ML setup finished.

Run:
  npm run serve

If cuda available printed False, the NVIDIA driver is not visible to this environment.
You can retry with a different PyTorch CUDA wheel:
  npm run setup:ml:cuda -- cu126
  npm run setup:ml:cuda -- cu118
MSG
