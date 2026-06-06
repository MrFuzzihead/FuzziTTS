// FuzziTTS — optimised server.js
//
// Two changes vs the original that eliminate the 7-10 s latency:
//
//   1. PiperWorker — keeps one `piper --output-raw` process alive per model.
//      Every fresh spawn paid 4-8 s to load the ONNX model from disk.
//      With a warm worker that cost disappears entirely.
//
//   2. AudioCache — stores final encoded audio bytes in memory, keyed by
//      (text | lang | voice | format).  Reactor alarms, status messages and
//      any phrase the in-game computer repeats are served in < 1 ms.
//
// Utterance-completion detection
//   Piper synthesises a whole utterance in one batch and writes all PCM to
//   stdout in a tight burst, then goes silent waiting for the next stdin line.
//   We treat WORKER_DRAIN_MS (default 150 ms) of stdout silence as "done".
//   That is far shorter than the time Piper needs to synthesise the next line,
//   so there is no risk of cross-utterance contamination.
//
// Pipeline: text ─► PiperWorker (reused process, no model reload)
//                ─► raw s16le PCM Buffer
//                ─► ffmpeg  (resample + encode, still spawned per-request)
//                ─► encoded audio Buffer ─► AudioCache ─► HTTP response

import express                              from "express";
import { spawn }                            from "node:child_process";
import { readFileSync, accessSync, constants } from "node:fs";
import path                                 from "node:path";

// ── Configuration ──────────────────────────────────────────────────────────────
const PORT       = Number(process.env.PORT             || 8080);
const PIPER_BIN  =        process.env.PIPER_BIN        || "piper";
const FFMPEG_BIN =        process.env.FFMPEG_BIN       || "ffmpeg";
const MODEL_DIR  =        process.env.PIPER_MODEL_DIR  || "./models";
const MAX_TEXT   = Number(process.env.MAX_TEXT          || 1000);
const CACHE_MAX  = Number(process.env.CACHE_MAX         || 500);   // max entries
const CACHE_MB   = Number(process.env.CACHE_MB          || 64);    // max total MB
const DRAIN_MS   = Number(process.env.WORKER_DRAIN_MS   || 150);   // stdout silence → utterance done

// ── Voice / format maps ────────────────────────────────────────────────────────
const VOICES = {
  en:          "en_US-amy-low.onnx",
  "en/amy":    "en_US-amy-low.onnx",
  "en/lessac": "en_US-lessac-medium.onnx",
  "en/ryan":   "en_US-ryan-high.onnx",
  de:          "de_DE-thorsten-medium.onnx",
  fr:          "fr_FR-siwis-medium.onnx",
  es:          "es_ES-davefx-medium.onnx",
};

const FORMAT_ARGS = {
  dfpwm:  ["-f", "dfpwm"],
  pcm_u8: ["-f", "u8",  "-acodec", "pcm_u8"],
  pcm_s8: ["-f", "s8",  "-acodec", "pcm_s8"],
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveModel(lang, voice) {
  const key  = voice ? `${lang}/${voice}` : lang;
  const file = VOICES[key] || VOICES[lang];
  return file ? path.resolve(MODEL_DIR, file) : null;
}

function modelSampleRate(modelPath) {
  try {
    const cfg = JSON.parse(readFileSync(modelPath + ".json", "utf8"));
    return cfg?.audio?.sample_rate ?? 22050;
  } catch { return 22050; }
}

// ── Audio cache ───────────────────────────────────────────────────────────────
// Insertion-order FIFO with entry-count + byte-size limits. No extra deps.
const _cMap   = new Map();   // cacheKey → Buffer
let   _cBytes = 0;
const CACHE_MAX_BYTES = CACHE_MB * 1024 * 1024;

function cacheGet(key) { return _cMap.get(key); }

function cacheSet(key, buf) {
  if (_cMap.has(key)) return;
  while (_cMap.size >= CACHE_MAX || _cBytes + buf.length > CACHE_MAX_BYTES) {
    const oldest = _cMap.keys().next().value;
    if (!oldest) break;
    _cBytes -= _cMap.get(oldest).length;
    _cMap.delete(oldest);
  }
  _cMap.set(key, buf);
  _cBytes += buf.length;
}

// ── PiperWorker ───────────────────────────────────────────────────────────────
// Wraps a long-lived `piper --output-raw` process.
// Requests are serialised one-at-a-time through an internal queue.
// Public API:  synthesize(text) → Promise<Buffer>  (raw s16le PCM)

class PiperWorker {
  #model;
  #proc       = null;
  #queue      = [];
  #busy       = false;
  #chunks     = [];
  #timer      = null;
  #resolve    = null;
  #reject     = null;
  #restarting = false;

  constructor(modelPath) {
    this.#model = modelPath;
    this.#start();
  }

  // ── Process lifecycle ──────────────────────────────────────────────────────
  #start() {
    this.#restarting = false;
    this.#proc = spawn(PIPER_BIN, ["--model", this.#model, "--output-raw"], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.#proc.stdout.on("data", chunk => {
      if (!this.#resolve) return;
      this.#chunks.push(chunk);
      clearTimeout(this.#timer);
      // Each data event resets the silence timer. When it finally fires,
      // piper has finished this utterance and is waiting for the next line.
      this.#timer = setTimeout(() => this.#complete(), DRAIN_MS);
    });

    this.#proc.on("error", err => {
      console.error(`[piper:${path.basename(this.#model)}] error:`, err.message);
      this.#abort(err);
      this.#scheduleRestart();
    });

    this.#proc.on("exit", code => {
      // Piper should never exit while we own stdin; treat any exit as a fault.
      if (this.#resolve) this.#abort(new Error(`piper exited with code ${code}`));
      this.#scheduleRestart();
    });

    console.log(`[piper] worker ready — ${path.basename(this.#model)}`);
    this.#next(); // flush anything queued during a restart
  }

  #scheduleRestart() {
    if (this.#restarting) return;
    this.#restarting = true;
    this.#proc = null;
    setTimeout(() => this.#start(), 500);
  }

  // ── Request lifecycle ──────────────────────────────────────────────────────
  #abort(err) {
    clearTimeout(this.#timer);
    const reject  = this.#reject;
    this.#resolve = null;
    this.#reject  = null;
    this.#chunks  = [];
    this.#busy    = false;
    reject?.(err);
    // Do NOT call #next() — the process is dying. #start() will call it.
  }

  #complete() {
    const resolve = this.#resolve;
    const pcm     = Buffer.concat(this.#chunks);
    this.#resolve = null;
    this.#reject  = null;
    this.#chunks  = [];
    this.#busy    = false;
    resolve(pcm);
    this.#next();
  }

  #next() {
    if (this.#busy || this.#restarting || !this.#queue.length || !this.#proc) return;
    this.#busy = true;
    const { text, resolve, reject } = this.#queue.shift();
    this.#resolve = resolve;
    this.#reject  = reject;
    this.#proc.stdin.write(text + "\n");
  }

  // ── Public ─────────────────────────────────────────────────────────────────
  synthesize(text) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ text, resolve, reject });
      this.#next();
    });
  }
}

// ── Worker pool ───────────────────────────────────────────────────────────────
// One warm worker per model path, created lazily or pre-warmed at startup.
const _workers = new Map();

function getWorker(modelPath) {
  if (!_workers.has(modelPath)) {
    _workers.set(modelPath, new PiperWorker(modelPath));
  }
  return _workers.get(modelPath);
}

// ── ffmpeg (Buffer → Buffer) ───────────────────────────────────────────────────
// Still spawned per-request (~100-300 ms startup), but now that piper's
// 4-8 s cold-start is gone, this is a minor fraction of total latency.
// Output is fully buffered so it can be stored in the audio cache.
function transcode(pcmBuf, inputRate, format) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(inputRate), "-ac", "1", "-i", "pipe:0",
      "-ar", "48000", "-ac", "1",
      ...FORMAT_ARGS[format],
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "inherit"] });

    const out = [];
    ff.stdout.on("data", c => out.push(c));
    ff.stdout.on("end",  ()  => resolve(Buffer.concat(out)));
    ff.on("error", reject);
    ff.stdin.write(pcmBuf);
    ff.stdin.end();
  });
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();

app.get("/healthz", (_req, res) => res.json({
  ok: true,
  cache: { entries: _cMap.size, bytes: _cBytes },
}));

app.get("/say", async (req, res) => {
  const text   = String(req.query.text   ?? "").slice(0, MAX_TEXT);
  const lang   = String(req.query.lang   ?? "en");
  const voice  = req.query.voice  ? String(req.query.voice)  : undefined;
  const format = String(req.query.format ?? "dfpwm");

  if (!text)                return res.status(400).end("missing text");
  if (!FORMAT_ARGS[format]) return res.status(400).end("bad format");

  const model = resolveModel(lang, voice);
  if (!model) return res.status(404).end(`no voice for ${lang}${voice ? "/" + voice : ""}`);

  // Cache hit — return immediately
  const key = `${text}|${lang}|${voice ?? ""}|${format}`;
  const hit  = cacheGet(key);
  if (hit) {
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("x-cache", "HIT");
    return res.end(hit);
  }

  // Cache miss — synthesise, transcode, store, respond
  try {
    const rate  = modelSampleRate(model);
    const pcm   = await getWorker(model).synthesize(text);
    const audio = await transcode(pcm, rate, format);
    cacheSet(key, audio);
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("x-cache", "MISS");
    res.end(audio);
  } catch (err) {
    console.error("[say]", err.message);
    if (!res.headersSent) res.status(500).end("synthesis failed");
  }
});

// ── Startup + pre-warm ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`fuzzitts listening on :${PORT}`);

  // Start a worker for every voice model that has already been downloaded.
  // Piper loads the ONNX model when the process starts, so doing this at
  // boot means the first real request pays zero cold-start cost.
  const seen = new Set();
  for (const file of Object.values(VOICES)) {
    if (seen.has(file)) continue;
    seen.add(file);
    const mp = path.resolve(MODEL_DIR, file);
    try {
      accessSync(mp, constants.R_OK);
      getWorker(mp);
      console.log(`[warmup] pre-loading ${file}`);
    } catch {
      // Model not downloaded — will error on first request for that voice.
    }
  }
});