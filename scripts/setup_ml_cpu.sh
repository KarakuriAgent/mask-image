#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv"

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
"$VENV_DIR/bin/python" -m pip install -r "$ROOT_DIR/requirements-ml.txt"

cat <<'MSG'

ML setup finished.

Run:
  npm run serve

First detection may download model files from Hugging Face into the local cache.
Images are processed locally and are not uploaded by this app.
MSG
