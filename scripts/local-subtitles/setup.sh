#!/bin/bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
task_data="${KAGE_SUBTITLES_DIR:-$task_root/.local-subtitles}"
task_python="${KAGE_SETUP_PYTHON:-python3}"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'This local transcription setup requires an Apple Silicon Mac.' >&2
  exit 1
fi
mkdir -p "$task_data"
export PIP_CACHE_DIR="$task_data/cache/pip"
export HF_HOME="$task_data/cache/huggingface"
export HF_HUB_DISABLE_TELEMETRY=1
if [[ ! -x "$task_data/venv/bin/python" ]]; then
  "$task_python" -m venv "$task_data/venv"
fi
"$task_data/venv/bin/python" -m pip install --upgrade pip
"$task_data/venv/bin/python" -m pip install 'mlx-whisper==0.4.3' 'imageio-ffmpeg==0.6.0'
"$task_data/venv/bin/python" -m pip install --upgrade yt-dlp
echo 'Downloading the free Whisper model (about 1.6 GB). Setup needs the internet; transcription runs offline.'
KAGE_SETUP_MODEL_DIR="$task_data/model" KAGE_SETUP_CACHE_DIR="$task_data/cache" \
  "$task_data/venv/bin/python" - <<'PY'
import os
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="mlx-community/whisper-large-v3-turbo",
    revision="a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb",
    local_dir=os.environ["KAGE_SETUP_MODEL_DIR"],
    cache_dir=os.environ["KAGE_SETUP_CACHE_DIR"],
    allow_patterns=["config.json", "weights.safetensors"],
)
PY
"$task_data/venv/bin/python" "$task_root/scripts/local-subtitles/worker.py" --check --model "$task_data/model"
echo 'Ready. Start with: bash scripts/local-subtitles/run.sh'
