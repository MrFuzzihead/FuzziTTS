# FuzziTTS

A self-hosted **text-to-speech bridge** that lets ComputerCraft / CC:Tweaked
speakers talk. It wraps [Piper](https://github.com/rhasspy/piper) (a free,
offline, neural TTS engine) behind a tiny HTTP service that returns audio in a
format the in-game speaker can play directly.

> **TL;DR** — Run the service, whitelist its host in your CC config, then in Lua:
> ```lua
> local tts = require "tts"
> tts.endpoint = "http://localhost:8080/say"
> tts.speak(peripheral.find("speaker"), "Hello from ComputerCraft")
> ```

---

## Why this exists

CC:Tweaked speakers can only ingest **raw 8-bit PCM** (48 kHz, mono) or
**DFPWM** — there is no in-game MP3/Opus/WAV decoder. This service sits between
the in-game computer and Piper to **synthesize → resample → re-encode** into a
speaker-ready stream.

```
┌────────────┐   HTTP GET    ┌──────────────────────────────┐
│ CC computer│ ────────────▶ │  FuzziTTS service            │
│  (Lua)     │   /say?text=  │                              │
│            │               │   piper  → raw s16le PCM     │
│  speaker.  │ ◀──────────── │   ffmpeg → 48 kHz mono       │
│  playAudio │  raw bytes    │           → dfpwm / pcm_*    │
└────────────┘               └──────────────────────────────┘
```

## Repository layout

| Path                 | Purpose                                                            |
|----------------------|--------------------------------------------------------------------|
| `server.js`          | Node + Express HTTP service (text → Piper → ffmpeg → audio).       |
| `package.json`       | Node project manifest / dependencies.                              |
| `Dockerfile`         | Container image bundling Node, ffmpeg, Piper, and a default voice. |
| `docker-compose.yml` | One-command build/run with healthcheck and optional model volume.  |
| `cc/tts.lua`         | Installable ComputerCraft client library.                          |
| `cc/speak.lua`       | Optional `speak <text>` CLI program for in-game use.               |
| `PIPER_TTS_CC.md`    | Full design spec, HTTP contract, and reference details.            |

## Quick start

### Docker (easiest)

```bash
docker build -t fuzzitts .
docker run --rm -p 8080:8080 fuzzitts
curl "http://localhost:8080/say?text=hello%20world&format=dfpwm" --output hello.dfpwm
```

### Docker Compose

```bash
docker compose up -d --build      # builds, runs detached, restarts on failure
docker compose logs -f            # follow logs
docker compose down               # stop and remove
```

Compose works out of the box with the voice baked into the image. To manage
voices from the host, uncomment the `volumes:` bind mount in
`docker-compose.yml` (and populate `./models` first — see the comments there).
Config can be overridden via env vars or a `.env` file, e.g. `PORT` and
`MAX_TEXT`.

### Local

```bash
# 1. ffmpeg (>= 5.1 for the native dfpwm encoder)
#    Windows: winget install Gyan.FFmpeg
#    macOS:   brew install ffmpeg
#    Debian:  sudo apt-get install -y ffmpeg

# 2. Piper
pip install piper-tts

# 3. A voice (model + its .onnx.json config) into ./models
mkdir models
$BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/low"
curl -L -o models/en_US-amy-low.onnx      "$BASE/en_US-amy-low.onnx"
curl -L -o models/en_US-amy-low.onnx.json "$BASE/en_US-amy-low.onnx.json"

# 4. Start
npm install
npm start
```

## HTTP contract

|                     |                                                      |
|---------------------|------------------------------------------------------|
| `GET /say?text=...` | Synthesize text. Optional `lang`, `voice`, `format`. |
| `GET /healthz`      | Liveness probe → `200 {"ok":true}`.                  |

`format` is one of `dfpwm` (default), `pcm_u8`, or `pcm_s8`. All output is
48 kHz mono. See [`PIPER_TTS_CC.md`](./PIPER_TTS_CC.md) for the full contract,
configuration options, and troubleshooting.

## In-game setup

1. **Whitelist the host** in the mod config `http_whitelist` (e.g. `localhost`).
2. Install the client onto a computer:
   ```
   wget <raw-url>/cc/tts.lua tts.lua
   ```
3. Speak:
   ```lua
   local tts = require "tts"
   tts.endpoint = "http://localhost:8080/say"
   local speaker = peripheral.find("speaker")
   assert(tts.speak(speaker, "Reactor temperature nominal", { voice = "ryan" }))
   ```

## Configuration

| Env var           | Default    | Meaning                    |
|-------------------|------------|----------------------------|
| `PORT`            | `8080`     | HTTP listen port           |
| `PIPER_BIN`       | `piper`    | Piper executable           |
| `FFMPEG_BIN`      | `ffmpeg`   | ffmpeg executable          |
| `PIPER_MODEL_DIR` | `./models` | Where `.onnx` models live  |
| `MAX_TEXT`        | `1000`     | Max characters per request |

## License

MIT — see [`LICENSE`](./LICENSE). Note that Piper voice models carry their own
licenses (mostly permissive, some non-commercial); check each model card on
Hugging Face before redistributing.

