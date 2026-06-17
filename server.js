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

let piperInstance;

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/say", (req, res) => {
  const text = String(req.query.text ?? "").slice(0, MAX_TEXT);
  const lang = String(req.query.lang ?? "en");
  const voice = req.query.voice ? String(req.query.voice) : undefined;
  const format = String(req.query.format ?? "dfpwm");

  if (!text) return res.status(400).end("missing text");
  if (!FORMAT_ARGS[format]) return res.status(400).end("bad format");

  // The resolver is still used if we needed to dynamically spawn, but now we use the warmed default.
  const model = resolveModel(lang, voice);
  if (!model) return res.status(404).end(`no voice for ${lang}${voice ? "/" + voice : ""}`);
  const rate = modelSampleRate(model);

  // ffmpeg still wraps the authenticated output of our long-lived piper process.
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
  piperInstance.stdout.pipe(ff.stdin);
  ff.stdout.pipe(res);

  const cleanup = () => ff.kill("SIGKILL");
  req.on("close", cleanup);
  res.on("close", cleanup);

  ff.on("error", (e) => res.destroyed || res.destroy(e));
  if (piperInstance && piperInstance.stderr) {
    /** @ts-ignore */
    piperInstance.stderr.on('data', (err) => console.error(`Piper error: ${err}`));
  }

  piperInstance.stdin.write(text + "\n");
  piperInstance.stdin.end();
});

app.listen(PORT, () => {
  const defaultModel = resolveModel("en", undefined);
  if (!defaultModel) {
    console.error("Could not resolve default model for warming");
    process.exit(1);
  }
  piperInstance = spawn(PIPER_BIN, ["--model", defaultModel, "--output-raw"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  console.log(`piper-tts-cc listening on :${PORT}`);
});
