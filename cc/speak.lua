-- Usage: speak "Hello world"
local tts = require "tts"
tts.endpoint = settings.get("tts.endpoint") or "http://localhost:8080/say"

local text = table.concat({ ... }, " ")
if text == "" then print("Usage: speak <text>") return end

local speaker = peripheral.find("speaker")
if not speaker then printError("No speaker attached") return end

local ok, err = tts.speak(speaker, text)
if not ok then printError("TTS failed: " .. tostring(err)) end

