// FuzziTTS — optimized server.js
//
// Fix vs previous optimized version:
//   The old PiperWorker used `--output-raw` and declared an utterance done
//   after 150 ms of stdout silence.  Piper splits text on sentence boundaries
//   and synthesises each sentence in a separate burst, so the silence timer
//   fired between sentences — cutting off "Hello! How are you doing today?"
//   after "Hello!" and producing a hard click that manifested as degraded
//   audio quality in pcm_u8.
//
//   The new worker uses `--output-dir`.  Piper writes exactly ONE .wav file
//   per stdin line, containing the full audio for all internal sentences.
//   Completion is detected by polling until the file reaches the byte count
//   declared in its own WAV header — correct and timer-free.
//
// Two optimizations retained from the previous version:
//   1. PiperWorker — one persistent piper process per model (no ONNX reload).
//   2. AudioCache  — repeated phrases served from memory in < 1 ms.
//
// Pipeline: text ─► PiperWorker (warm piper, --output-dir)
//                ─► WAV file on disk ─► raw s16le PCM Buffer
//                ─► ffmpeg (resample + encode)
//                ─► encoded audio Buffer ─► AudioCache ─► HTTP response

import express                                                   from "express";
import { spawn }                                                  from "node:child_process";
import { readFileSync, accessSync, mkdtempSync, readdirSync,
  unlinkSync, openSync, readSync, closeSync,
  existsSync, statSync, constants }                        from "node:fs";
import path                                                       from "node:path";
import os                                                         from "node:os";

// ── Configuration ──────────────────────────────────────────────────────────────
const PORT       = Number(process.env.PORT             || 8080);
const PIPER_BIN  =        process.env.PIPER_BIN        || "piper";
const FFMPEG_BIN =        process.env.FFMPEG_BIN       || "ffmpeg";
const MODEL_DIR  =        process.env.PIPER_MODEL_DIR  || "./models";
const MAX_TEXT   = Number(process.env.MAX_TEXT          || 1000);
const CACHE_MAX  = Number(process.env.CACHE_MAX         || 500);    // max entries
const CACHE_MB   = Number(process.env.CACHE_MB          || 64);     // max total MB

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

// ── WAV helper ────────────────────────────────────────────────────────────────
// Standard PCM WAV layout (44-byte header):
//   0  RIFF  (4)
//   4  file_size - 8  (uint32 LE)
//   8  WAVE  (4)
//   12 fmt   (4)
//   16 16    (uint32 LE — fmt chunk size)
//   20 1     (uint16 LE — PCM format)
//   22 channels (uint16 LE)
//   24 sample_rate (uint32 LE)
//   28 byte_rate   (uint32 LE)
//   32 block_align (uint16 LE)
//   34 bits_per_sample (uint16 LE)
//   36 data  (4)
//   40 data_size (uint32 LE)   ← we read this
//   44 <PCM samples begin>
//
// Returns the expected total file size once the header is readable, or -1 if
// the file doesn't exist yet or the header is incomplete.
function wavExpectedSize(filePath) {
  try {
    const fd  = openSync(filePath, "r");
    const hdr = Buffer.alloc(8);
    const n   = readSync(fd, hdr, 0, 8, 36);  // read "data" id + size at offset 36
    closeSync(fd);
    if (n < 8 || hdr.slice(0, 4).toString("ascii") !== "data") return -1;
    return 44 + hdr.readUInt32LE(4);           // total = header + data
  } catch { return -1; }
}

// ── PiperWorker ───────────────────────────────────────────────────────────────
// Wraps a long-lived `piper --output-dir` process.
// Piper writes one .wav file per stdin line; the file contains complete audio
// for ALL internal sentences in that line.  We poll (every 20 ms) until the
// file size matches the byte count in its WAV header, then read + delete it.
// Requests are serialised one-at-a-time so file numbering stays in sync.
// Public API:  synthesize(text) → Promise<Buffer>  (raw s16le PCM)

class PiperWorker {
  #model;
  #outDir;
  #proc       = null;
  #queue      = [];
  #busy       = false;
  #counter    = 0;
  #resolve    = null;
  #reject     = null;
  #pollTimer  = null;
  #restarting = false;

  constructor(modelPath) {
    this.#model  = modelPath;
    this.#outDir = mkdtempSync(path.join(os.tmpdir(), "fuzzitts-"));
    this.#start();
  }

  // ── Process lifecycle ──────────────────────────────────────────────────────
  #start() {
    this.#restarting = false;
    this.#counter    = 0;

    // Remove any .wav files left over from a previous (crashed) process so
    // file numbering starts clean.
    try {
      for (const f of readdirSync(this.#outDir))
        if (f.endsWith(".wav")) unlinkSync(path.join(this.#outDir, f));
    } catch { /* ignore */ }

    this.#proc = spawn(PIPER_BIN, [
      "--model",      this.#model,
      "--output-dir", this.#outDir,
    ], { stdio: ["pipe", "inherit", "inherit"] });

    this.#proc.on("error", err => {
      console.error(`[piper:${path.basename(this.#model)}] error:`, err.message);
      this.#abort(err);
      this.#scheduleRestart();
    });

    this.#proc.on("exit", code => {
      if (this.#resolve) this.#abort(new Error(`piper exited with code ${code}`));
      this.#scheduleRestart();
    });

    console.log(`[piper] worker ready — ${path.basename(this.#model)}`);
    this.#next();  // flush anything queued during a restart
  }

  #scheduleRestart() {
    if (this.#restarting) return;
    this.#restarting = true;
    this.#proc = null;
    clearTimeout(this.#pollTimer);
    setTimeout(() => this.#start(), 500);
  }

  // ── Request lifecycle ──────────────────────────────────────────────────────
  #abort(err) {
    clearTimeout(this.#pollTimer);
    const reject = this.#reject;
    this.#resolve = null;
    this.#reject  = null;
    this.#busy    = false;
    reject?.(err);
  }

  // Poll every 20 ms until the WAV file for this utterance is fully written.
  // Phase 1: wait for the file + readable header  → get expectedSize
  // Phase 2: wait for file.size >= expectedSize   → read PCM, clean up, resolve
  #poll(filePath, expectedSize, attempts = 0) {
    const MAX_ATTEMPTS = 500;  // 500 × 20 ms = 10 s hard timeout
    if (attempts > MAX_ATTEMPTS) {
      this.#abort(new Error(`timeout waiting for ${path.basename(filePath)}`));
      if (!this.#restarting) this.#next();
      return;
    }

    this.#pollTimer = setTimeout(() => {
      try {
        if (expectedSize < 0) expectedSize = wavExpectedSize(filePath);
        if (expectedSize < 0) { this.#poll(filePath, -1, attempts + 1); return; }

        const actual = existsSync(filePath) ? statSync(filePath).size : 0;
        if (actual < expectedSize) { this.#poll(filePath, expectedSize, attempts + 1); return; }

        // File complete — strip 44-byte WAV header to get raw s16le PCM.
        const pcm = readFileSync(filePath).slice(44);
        try { unlinkSync(filePath); } catch { /* ignore */ }

        const resolve = this.#resolve;
        this.#resolve = null;
        this.#reject  = null;
        this.#busy    = false;
        resolve(pcm);
        this.#next();
      } catch {
        // Transient I/O error; retry next poll tick.
        this.#poll(filePath, expectedSize, attempts + 1);
      }
    }, 20);
  }

  #next() {
    if (this.#busy || this.#restarting || !this.#queue.length || !this.#proc) return;
    this.#busy = true;
    const { text, resolve, reject } = this.#queue.shift();
    const filePath = path.join(this.#outDir, `${this.#counter++}.wav`);

    this.#resolve = resolve;
    this.#reject  = reject;
    this.#proc.stdin.write(text + "\n");
    this.#poll(filePath, -1);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  synthesize(text) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ text, resolve, reject });
      this.#next();
    });
  }
}

// ── Worker pool ───────────────────────────────────────────────────────────────
const _workers = new Map();

function getWorker(modelPath) {
  if (!_workers.has(modelPath)) _workers.set(modelPath, new PiperWorker(modelPath));
  return _workers.get(modelPath);
}

// ── ffmpeg (Buffer → Buffer) ───────────────────────────────────────────────────
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

  const key = `${text}|${lang}|${voice ?? ""}|${format}`;
  const hit  = cacheGet(key);
  if (hit) {
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("x-cache", "HIT");
    return res.end(hit);
  }

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
  const seen = new Set();
  for (const file of Object.values(VOICES)) {
    if (seen.has(file)) continue;
    seen.add(file);
    const mp = path.resolve(MODEL_DIR, file);
    try {
      accessSync(mp, constants.R_OK);
      getWorker(mp);
      console.log(`[warmup] pre-loading ${file}`);
    } catch { /* model not downloaded */ }
  }
});