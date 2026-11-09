import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadVoiceConfig, resolveApiKey } from "../lib/config.js";

function tempConfig(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cfg-"));
  const file = path.join(dir, "voice.json");
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

test("returns contextOptions when no config file exists", () => {
  process.env.VOICE_CONFIG = tempConfig();
  assert.deepEqual(loadVoiceConfig({ ttsEndpoint: "http://x/v1" }), {
    ttsEndpoint: "http://x/v1",
  });
  delete process.env.VOICE_CONFIG;
});

test("merges file under contextOptions; options win", () => {
  const file = tempConfig(
    JSON.stringify({ ttsEndpoint: "http://file/v1", ttsModel: "file-model" }),
  );
  process.env.VOICE_CONFIG = file;
  try {
    assert.deepEqual(loadVoiceConfig({ ttsEndpoint: "http://opts/v1" }), {
      ttsEndpoint: "http://opts/v1",
      ttsModel: "file-model",
    });
  } finally {
    delete process.env.VOICE_CONFIG;
  }
});

test("drops empty-string option keys", () => {
  const file = tempConfig(JSON.stringify({ ttsModel: "file-model" }));
  process.env.VOICE_CONFIG = file;
  try {
    assert.deepEqual(loadVoiceConfig({ ttsModel: "" }), { ttsModel: "file-model" });
  } finally {
    delete process.env.VOICE_CONFIG;
  }
});

test("invalid JSON falls back to contextOptions without throwing", () => {
  process.env.VOICE_CONFIG = tempConfig("{not json");
  assert.deepEqual(loadVoiceConfig({ endpoint: "http://x" }), { endpoint: "http://x" });
  delete process.env.VOICE_CONFIG;
});

test("resolveApiKey: direct wins, then env, else null", () => {
  process.env.VOICE_TEST_KEY = "env-key";
  assert.equal(resolveApiKey({ apiKey: "direct", apiKeyEnv: "VOICE_TEST_KEY" }), "direct");
  assert.equal(resolveApiKey({ apiKeyEnv: "VOICE_TEST_KEY" }), "env-key");
  assert.equal(resolveApiKey({ apiKey: "" }), null);
  assert.equal(resolveApiKey({}), null);
  delete process.env.VOICE_TEST_KEY;
});
