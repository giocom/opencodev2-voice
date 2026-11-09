// One-off E2E check against the real STT + TTS servers (no TUI needed).
//
// Run on a machine that can reach both servers (an audio player is needed
// for the playback step, the TTS server's output is played through it):
//
//   node e2e-check.mjs ["test phrase"]
//
// Flow: synthesize a phrase on the TTS server -> feed that exact audio to
// the STT server -> print the transcription. If the transcription is close
// to the phrase, the whole pipeline works.
//
// Uses the plugin's own TTS engine code (lib/tts-engine.js) with real
// fetch/spawn; the STT request is the same multipart shape lib/stt.js sends
// (file / model / response_format=json, Bearer key).
import fs from "node:fs";

import { loadVoiceConfig } from "./lib/config.js";
import { createTtsEngine } from "./lib/tts-engine.js";

const phrase = process.argv[2] || "안녕하세요 TTS 테스트";
const config = loadVoiceConfig();
if (!config.ttsEndpoint || !config.sttEndpoint) {
  console.error("e2e: voice.json must set both ttsEndpoint and sttEndpoint");
  process.exit(1);
}
console.log(`e2e: phrase = "${phrase}"`);
console.log(
  `e2e: TTS -> ${config.ttsEndpoint} (model ${config.ttsModel}, voice ${config.ttsVoice || "default"})`,
);
console.log(`e2e: STT -> ${config.sttEndpoint} (model ${config.sttModel})`);

// 1) TTS: the plugin's engine with real fetch/spawn. Capture the audio
// bytes so step 2 can transcribe exactly what was synthesized/played.
let audio = null;
let fileExt = "mp3";
const engine = createTtsEngine(
  {
    ...config,
    getVoice: () => config.ttsVoice || "default",
    toast: (message, variant) => console.log(`e2e: toast[${variant || "info"}] ${message}`),
  },
  { log: (scope, message, level) => console.log(`e2e: log[${level || "info"}] ${message}`) },
  {
    writeFile: async (p, buf) => {
      audio = Buffer.from(buf);
      fileExt = p.split(".").pop();
      return fs.promises.writeFile(p, buf);
    },
  },
);
await engine.speak(phrase);
if (!audio) {
  console.error("e2e: FAILED - TTS returned no audio (see the toast above)");
  process.exit(1);
}
console.log(`e2e: TTS ok - ${audio.length} bytes of audio`);

// 2) STT: multipart POST, same shape as lib/stt.js.
const mime = fileExt === "wav" ? "audio/wav" : fileExt === "pcm" ? "audio/L16" : "audio/mpeg";
const form = new FormData();
form.append("file", new Blob([audio], { type: mime }), "audio.wav");
form.append("model", config.sttModel);
form.append("response_format", "json");
const headers = {};
const key = config.sttApiKey || (config.sttApiKeyEnv ? process.env[config.sttApiKeyEnv] : null);
if (key) headers["Authorization"] = "Bearer " + key;
const res = await fetch(config.sttEndpoint.replace(/\/+$/, "") + "/audio/transcriptions", {
  method: "POST",
  headers,
  body: form,
});
if (!res.ok) {
  console.error(`e2e: FAILED - STT HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  process.exit(1);
}
const data = await res.json();
const text = (data.text || "").trim();
console.log(`e2e: STT transcription: "${text}"`);
if (!text) {
  console.error("e2e: FAILED - STT returned an empty transcription");
  process.exit(1);
}
console.log("e2e: PASS - TTS and STT servers both work (compare the transcription to the phrase)");
