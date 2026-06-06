// piper-tts-cc — Piper TTS transcoder for ComputerCraft speakers.
//
// Pipeline:  text → piper (raw s16le @ model rate) → ffmpeg (48 kHz mono,
//            dfpwm / pcm_u8 / pcm_s8) → HTTP response body.

import express from "express";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 8080);
const PIPER_BIN = process.env.PIPER_BIN || "piper";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const MODEL_DIR = process.env.PIPER_MODEL_DIR || "./models";
const MAX_TEXT = Number(process.env.MAX_TEXT || 1000);

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

const app = express();
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/say", (req, res) => {
  const text = String(req.query.text ?? "").slice(0, MAX_TEXT);
  const lang = String(req.query.lang ?? "en");
  const voice = req.query.voice ? String(req.query.voice) : undefined;
  const format = String(req.query.format ?? "dfpwm");

  if (!text) return res.status(400).end("missing text");
  if (!FORMAT_ARGS[format]) return res.status(400).end("bad format");

  const model = resolveModel(lang, voice);
  if (!model) return res.status(404).end(`no voice for ${lang}${voice ? "/" + voice : ""}`);
  const rate = modelSampleRate(model);

  // Piper streams raw signed-16-bit mono PCM at the model's sample rate.
  const piper = spawn(PIPER_BIN, ["--model", model, "--output-raw"], {
    stdio: ["pipe", "pipe", "inherit"],
  });

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
  piper.stdout.pipe(ff.stdin);
  ff.stdout.pipe(res);

  const cleanup = () => { piper.kill("SIGKILL"); ff.kill("SIGKILL"); };
  req.on("close", cleanup);
  res.on("close", cleanup);
  piper.on("error", (e) => res.destroyed || res.destroy(e));
  ff.on("error", (e) => res.destroyed || res.destroy(e));

  piper.stdin.write(text + "\n");
  piper.stdin.end();
});

app.listen(PORT, () => console.log(`piper-tts-cc listening on :${PORT}`));


