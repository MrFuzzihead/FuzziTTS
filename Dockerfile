FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl python3 python3-pip \
 && pip3 install --no-cache-dir --break-system-packages piper-tts \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Default voice (model + config). Use piper's own downloader so the files land
# with the exact names/format piper expects (a raw curl from HF returns an LFS
# pointer, not the real model, which makes piper fail with "Unable to find voice").
# Add more voices by appending their names, e.g. `... en_US-amy-low en_US-ryan-high`.
RUN mkdir -p models \
 && python3 -m piper.download_voices en_US-amy-low --download-dir /app/models \
 && test -s /app/models/en_US-amy-low.onnx \
 && test -s /app/models/en_US-amy-low.onnx.json

COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

# Self-healing startup: downloads the default voice if it's missing at runtime
# (e.g. an empty ./models volume mounted over the baked-in model).
COPY docker-entrypoint.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

ENV PORT=8080 PIPER_MODEL_DIR=/app/models DEFAULT_VOICE=en_US-amy-low
EXPOSE 8080
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]

