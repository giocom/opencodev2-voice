import assert from "node:assert/strict";
import test from "node:test";

import { resolveVoice, ttsVoicesFor } from "../lib/tts.js";

const kv = (state) => ({
  get: (key, fallback) => (key in state ? state[key] : fallback),
  set: () => {},
});

test("http mode: kv voice > ttsVoice > default", () => {
  const config = { ttsEndpoint: "http://t/v1", ttsVoice: "Serena" };
  assert.equal(resolveVoice(config, kv({ "tts.voice": "Minji" })), "Minji");
  assert.equal(resolveVoice(config, kv({})), "Serena");
  assert.equal(resolveVoice({ ttsEndpoint: "http://t/v1" }, kv({})), "default");
});

test("piper mode: maps kv key to onnx path with ryan default", () => {
  const config = {};
  assert.match(resolveVoice(config, kv({ "tts.voice": "bryce" })), /bryce.*\.onnx$/);
  assert.match(resolveVoice(config, kv({})), /ryan.*\.onnx$/);
});

test("http mode voice dialog: strings, objects, and single fallback", () => {
  assert.deepEqual(
    ttsVoicesFor({
      ttsEndpoint: "http://t/v1",
      ttsVoices: ["Serena", { label: "Custom", value: "c1" }],
    }),
    [
      { label: "Serena", value: "Serena" },
      { label: "Custom", value: "c1" },
    ],
  );
  assert.deepEqual(ttsVoicesFor({ ttsEndpoint: "http://t/v1", ttsVoice: "Serena" }), [
    { label: "Serena", value: "Serena" },
  ]);
  assert.deepEqual(ttsVoicesFor({ ttsEndpoint: "http://t/v1" }), []);
});

test("piper mode voice dialog: existing TTS_VOICES table", () => {
  assert.deepEqual(ttsVoicesFor({}), [
    { label: "Ryan (high)", value: "ryan" },
    { label: "Bryce (medium)", value: "bryce" },
  ]);
});
