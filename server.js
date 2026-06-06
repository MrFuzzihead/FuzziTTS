// piper-tts-cc — Piper TTS transcoder for ComputerCraft speakers.
//
// Pipeline:  text → pooled piper (WAV @ model rate) → ffmpeg (48 kHz mono,
//            dfpwm / pcm_u8 / pcm_s8) → HTTP response body.
// Piper processes are kept warm (ONNX model loaded once at startup) and
// reused across requests; only ffmpeg is spawned per call.

import express from "express";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 8080);
const PIPER_BIN = process.env.PIPER_BIN || "piper";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const MODEL_DIR = process.env.PIPER_MODEL_DIR || "./models";
const MAX_TEXT = Number(process.env.MAX_TEXT || 1000);
const PIPER_POOL_SIZE = Math.max(1, Number(process.env.PIPER_POOL_SIZE || 2));
const PIPER_QUEUE_TIMEOUT_MS = Number(process.env.PIPER_QUEUE_TIMEOUT_MS || 30000);
const SYNTHESIZE_TIMEOUT_MS = Number(process.env.SYNTHESIZE_TIMEOUT_MS || 30000);

// Map "lang" or "lang/voice" → Piper model filename (relative to MODEL_DIR).
// Download voices from https://huggingface.co/rhasspy/piper-voices
const VOICES = {
  en: "en_US-amy-low.onnx",
  "en/amy": "en_US-amy-low.onnx",
  "en/lessac": "en_US-lessac-medium.onnx",
  "en/ryan": "en_US-ryan-high.onnx",
  de: "de_DE-thorsten-medium.onnx",
  fr: "fr_FR-siwis-medium.onnx",
  es: "es_ES-davefx-medium.onnx",
};

// Speaker-ready encodings. All resample to 48 kHz mono first.
const FORMAT_ARGS = {
  dfpwm: ["-f", "dfpwm"],
  pcm_u8: ["-f", "u8", "-acodec", "pcm_u8"],
  pcm_s8: ["-f", "s8", "-acodec", "pcm_s8"],
};

function resolveModel(lang, voice) {
  const key = voice ? `${lang}/${voice}` : lang;
  const file = VOICES[key] || VOICES[lang];
  return file ? path.resolve(MODEL_DIR, file) : null;
}

// Piper ships "<model>.onnx.json" next to each model; read its sample rate.
function modelSampleRate(modelPath) {
  try {
    const cfg = JSON.parse(readFileSync(modelPath + ".json", "utf8"));
    return cfg?.audio?.sample_rate || 22050;
  } catch {
    return 22050;
  }
}

// Per-voice piper pool.
//   all:   every spawned piper process for this voice (free + busy)
//   free:  subset currently idle and ready to be acquired
//   queue: HTTP handlers waiting for a free piper
const pools = new Map();

function getPool(modelPath) {
  let p = pools.get(modelPath);
  if (!p) { p = { all: [], free: [], queue: [] }; pools.set(modelPath, p); }
  return p;
}

function spawnPiper(modelPath) {
  // -f -       : write a complete WAV to stdout per input line
  // --json-input : stdin lines are {"text":"..."}\n
  // -q         : silence spdlog's per-utterance "Real-time factor" noise
  // Piper's C++ binary loops on `while (getline(cin, line))` and stays alive
  // between utterances, so the ONNX model loads exactly once per process.
  const p = spawn(
    PIPER_BIN,
    ["-q", "-m", modelPath, "-f", "-", "--json-input"],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  p._piperAlive = true;
  p.on("exit",  () => { p._piperAlive = false; });
  p.on("error", () => { p._piperAlive = false; }); // spawn failed (e.g., ENOENT)
  p.stdin.on("error", () => {}); // swallow EPIPE if the peer died
  return p;
}

async function acquirePiper(modelPath) {
  const pool = getPool(modelPath);
  // 1. Hand out a free live piper if one is available.
  while (pool.free.length > 0) {
    const proc = pool.free.shift();
    if (proc._piperAlive) return proc;
    pool.all = pool.all.filter((p) => p !== proc);
  }
  // 2. Spawn a replacement if we still have headroom in the pool.
  const liveCount = pool.all.reduce((n, p) => n + (p._piperAlive ? 1 : 0), 0);
  if (liveCount < PIPER_POOL_SIZE) {
    const proc = spawnPiper(modelPath);
    pool.all.push(proc);
    return proc;
  }
  // 3. Otherwise queue until a sibling releases its piper.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = pool.queue.findIndex((w) => w.resolve === resolve);
      if (i >= 0) pool.queue.splice(i, 1);
      reject(new Error("piper queue timeout"));
    }, PIPER_QUEUE_TIMEOUT_MS);
    pool.queue.push({
      resolve: (proc) => { clearTimeout(timer); resolve(proc); },
      reject:  (err)  => { clearTimeout(timer); reject(err);  },
    });
  });
}

function releasePiper(modelPath, proc) {
  const pool = pools.get(modelPath);
  if (!pool) return;
  if (!proc._piperAlive) {
    pool.all = pool.all.filter((p) => p !== proc);
    return;
  }
  if (pool.queue.length > 0) {
    pool.queue.shift().resolve(proc);
  } else {
    pool.free.push(proc);
  }
}

// Read exactly n bytes from a paused-mode Readable stream.
function readExactly(stream, n) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;

    const tryRead = () => {
      while (received < n) {
        const chunk = stream.read();
        if (chunk === null) return;
        const remaining = n - received;
        if (chunk.length <= remaining) {
          chunks.push(chunk);
          received += chunk.length;
        } else {
          chunks.push(chunk.subarray(0, remaining));
          received = n;
          stream.unshift(chunk.subarray(remaining));
          break;
        }
      }
      if (received === n) {
        cleanup();
        resolve(Buffer.concat(chunks, n));
      }
    };
    const onEnd   = () => { cleanup(); reject(new Error(`EOF after ${received}/${n} bytes`)); };
    const onError = (e) => { cleanup(); reject(e); };
    const cleanup = () => {
      stream.off("readable", tryRead);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    stream.on("readable", tryRead);
    stream.on("end", onEnd);
    stream.on("error", onError);
    tryRead();
  });
}

// Walk a RIFF/WAVE header, skipping chunks until "data", and return the size
// of that chunk. Caller then reads that many PCM bytes with readExactly.
async function readWavHeader(stream) {
  const riff = await readExactly(stream, 12);
  if (
    riff.toString("ascii", 0, 4) !== "RIFF" ||
    riff.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("piper output is not RIFF/WAVE");
  }
  while (true) {
    const hdr = await readExactly(stream, 8);
    const id = hdr.toString("ascii", 0, 4);
    const size = hdr.readUInt32LE(4);
    if (id === "data") return size;
    // RIFF spec: odd-sized chunks have a trailing pad byte.
    const skip = size + (size & 1);
    if (skip > 0) await readExactly(stream, skip);
  }
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

async function synthesizePcm(proc, text) {
  // The pipe kernel-buffers this until piper reaches its `getline(cin, ...)`
  // loop, so we don't need to wait for the model to finish loading.
  proc.stdin.write(JSON.stringify({ text }) + "\n");

  return withTimeout(
    (async () => {
      const dataLength = await readWavHeader(proc.stdout);
      return readExactly(proc.stdout, dataLength);
    })(),
    SYNTHESIZE_TIMEOUT_MS,
    "piper synthesis",
  ).catch((e) => {
    // Mark the worker dead so releasePiper drops it; a fresh one is spawned
    // on the next acquire. Kill it now to free its RAM.
    try { proc.kill("SIGKILL"); } catch {}
    proc._piperAlive = false;
    throw e;
  });
}

const app = express();
let startupReady = false;

app.get("/healthz", (_req, res) => {
  if (!startupReady) {
    return res.status(503).json({ ok: false, reason: "warming up" });
  }
  const defaultModel = path.resolve(MODEL_DIR, VOICES.en);
  const pool = pools.get(defaultModel);
  if (!pool || !pool.all.some((p) => p._piperAlive)) {
    return res.status(503).json({ ok: false, reason: "default voice unavailable" });
  }
  return res.json({ ok: true });
});

app.get("/say", async (req, res) => {
  const text = String(req.query.text ?? "").slice(0, MAX_TEXT);
  const lang = String(req.query.lang ?? "en");
  const voice = req.query.voice ? String(req.query.voice) : undefined;
  const format = String(req.query.format ?? "dfpwm");

  if (!text) return res.status(400).end("missing text");
  if (!FORMAT_ARGS[format]) return res.status(400).end("bad format");

  const model = resolveModel(lang, voice);
  if (!model) {
    return res.status(404).end(`no voice for ${lang}${voice ? "/" + voice : ""}`);
  }
  const rate = modelSampleRate(model);

  let proc;
  try {
    proc = await acquirePiper(model);
  } catch (e) {
    return res.status(503).end(`piper unavailable: ${e.message}`);
  }

  // If the client gave up while we were queued, give the worker back and bail.
  if (res.writableEnded || res.destroyed) {
    releasePiper(model, proc);
    return;
  }

  let pcm;
  try {
    pcm = await synthesizePcm(proc, text);
  } catch (e) {
    return res.status(500).end(`synthesize failed: ${e.message}`);
  } finally {
    releasePiper(model, proc);
  }

  // ffmpeg resamples to 48 kHz mono and re-encodes to the requested format.
  const ff = spawn(
    FFMPEG_BIN,
    [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", "pipe:0",
      "-ar", "48000", "-ac", "1",
      ...FORMAT_ARGS[format],
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );

  res.setHeader("content-type", "application/octet-stream");
  ff.stdout.pipe(res);

  const cleanup = () => { try { ff.kill("SIGKILL"); } catch {} };
  req.on("close", cleanup);
  res.on("close", cleanup);
  ff.on("error", (e) => res.destroyed || res.destroy(e));
  ff.stdin.end(pcm);
});

function prewarmPools() {
  const seen = new Set();
  for (const file of Object.values(VOICES)) {
    const p = path.resolve(MODEL_DIR, file);
    if (seen.has(p)) continue;
    seen.add(p);
    const pool = getPool(p);
    for (let i = 0; i < PIPER_POOL_SIZE; i++) {
      const proc = spawnPiper(p);
      pool.all.push(proc);
      pool.free.push(proc);
    }
  }
  startupReady = true;
  console.log(`prewarmed ${seen.size} voice pool(s) x ${PIPER_POOL_SIZE}`);
}

function shutdown() {
  for (const pool of pools.values()) {
    for (const proc of pool.all) {
      try { proc.kill("SIGTERM"); } catch {}
    }
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen(PORT, () => {
  console.log(`piper-tts-cc listening on :${PORT}`);
  prewarmPools();
});
