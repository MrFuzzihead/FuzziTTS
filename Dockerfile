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
 && python3 -m piper.download_voices en_US-amy-low --download-dir /app/models

COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=8080 PIPER_MODEL_DIR=/app/models
EXPOSE 8080
CMD ["node", "server.js"]

