FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl python3 python3-pip \
 && pip3 install --no-cache-dir --break-system-packages piper-tts \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Default voice (model + config). Add more voices the same way.
RUN mkdir -p models \
 && BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/low \
 && curl -L -o models/en_US-amy-low.onnx      $BASE/en_US-amy-low.onnx \
 && curl -L -o models/en_US-amy-low.onnx.json $BASE/en_US-amy-low.onnx.json

COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=8080 PIPER_MODEL_DIR=/app/models
EXPOSE 8080
CMD ["node", "server.js"]

