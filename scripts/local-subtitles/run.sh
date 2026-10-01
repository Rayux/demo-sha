#!/bin/bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
task_data="${KAGE_SUBTITLES_DIR:-$task_root/.local-subtitles}"
export KAGE_SUBTITLES_DIR="$task_data"
export KAGE_SUBTITLES_PYTHON="${KAGE_SUBTITLES_PYTHON:-$task_data/venv/bin/python}"
export KAGE_WHISPER_MODEL="${KAGE_WHISPER_MODEL:-$task_data/model}"
export HF_HUB_OFFLINE=1
export HF_HUB_DISABLE_TELEMETRY=1
if [[ ! -x "$KAGE_SUBTITLES_PYTHON" ]]; then
  echo 'Run bash scripts/local-subtitles/setup.sh first.' >&2
  exit 1
fi
exec node "$task_root/scripts/local-subtitles/server.mjs"
