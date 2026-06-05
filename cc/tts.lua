-- tts.lua — speak text through a ComputerCraft speaker via a piper-tts-cc server.
local dfpwm = require "cc.audio.dfpwm"

local MAX_SAMPLES = 128 * 1024
local DFPWM_CHUNK = 16 * 1024
local SUPPORTED   = { dfpwm = true, pcm_u8 = true, pcm_s8 = true }

local tts = { endpoint = nil }

local function url_encode(s)
  return (s:gsub("[^%w%-_%.~]", function(c) return string.format("%%%02X", c:byte()) end))
end

local function append(url, k, v)
  return url .. (url:find("?", 1, true) and "&" or "?") .. k .. "=" .. url_encode(v)
end

function tts.url(text, opts)
  opts = opts or {}
  local endpoint = opts.endpoint or tts.endpoint
  assert(type(endpoint) == "string", "set tts.endpoint or opts.endpoint")
  local format = opts.format or "dfpwm"
  assert(SUPPORTED[format], "unsupported format " .. tostring(format))
  local url = append(endpoint, "text", text)
  url = append(url, "lang", opts.lang or "en")
  url = append(url, "format", format)
  if opts.voice then url = append(url, "voice", opts.voice) end
  return url
end

local function pcm_samples(str, format)
  local out = {}
  if format == "pcm_u8" then
    for i = 1, #str do out[i] = str:byte(i) - 128 end
  else -- pcm_s8
    for i = 1, #str do local b = str:byte(i); out[i] = b < 128 and b or b - 256 end
  end
  return out
end

function tts.stream(speaker, handle, opts)
  opts = opts or {}
  local format = opts.format or "dfpwm"
  local volume = opts.volume
  local read_size, decoder
  if format == "dfpwm" then
    read_size = math.min(opts.chunk_size or DFPWM_CHUNK, DFPWM_CHUNK)
    decoder = dfpwm.make_decoder()
  else
    read_size = math.min(opts.chunk_size or MAX_SAMPLES, MAX_SAMPLES)
  end
  while true do
    local chunk = handle.read(read_size)
    if not chunk or #chunk == 0 then break end
    local samples = format == "dfpwm"
      and decoder({ chunk:byte(1, #chunk) })
      or  pcm_samples(chunk, format)
    while not speaker.playAudio(samples, volume) do
      os.pullEvent("speaker_audio_empty")
    end
  end
  return true
end

function tts.speak(speaker, text, opts)
  opts = opts or {}
  assert(http, "HTTP API is disabled")
  local handle, err = http.get(tts.url(text, opts), nil, true)
  if not handle then return nil, err end
  local ok, res = pcall(tts.stream, speaker, handle, opts)
  handle.close()
  if not ok then return nil, res end
  return res
end

return tts

