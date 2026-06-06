#!/bin/sh
# Ensure the default Piper voice exists before starting the server.
# This self-heals the common failure modes:
#   - a stale image built before the model was added
#   - an empty ./models volume mounted over the baked-in model
set -e

MODEL_DIR="${PIPER_MODEL_DIR:-/app/models}"
DEFAULT_VOICE="${DEFAULT_VOICE:-en_US-amy-low}"

MODEL="${MODEL_DIR}/${DEFAULT_VOICE}.onnx"
CONFIG="${MODEL}.json"

# Piper needs BOTH the model and its "<model>.onnx.json" config. Re-download if
# either is missing (e.g. only the .onnx was placed in the folder by hand).
if [ ! -s "${MODEL}" ] || [ ! -s "${CONFIG}" ]; then
  echo "[entrypoint] '${DEFAULT_VOICE}' model and/or config missing in ${MODEL_DIR}; downloading..."
  mkdir -p "${MODEL_DIR}"
  python3 -m piper.download_voices "${DEFAULT_VOICE}" --download-dir "${MODEL_DIR}" --force-redownload
fi

echo "[entrypoint] voices present in ${MODEL_DIR}:"
ls -l "${MODEL_DIR}"

exec "$@"

