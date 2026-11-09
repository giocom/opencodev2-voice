import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadOpenCodeProviders,
  loadVoiceConfig,
  resolveApiKey,
  resolveLlmTarget,
} from "../lib/config.js";

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

test("loadOpenCodeProviders: parses provider options and resolves {env:VAR} apiKey", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
  const file = path.join(dir, "opencode.json");
  process.env.VOICE_OC_TEST_KEY = "env-key";
  fs.writeFileSync(
    file,
    JSON.stringify({
      provider: {
        litellm: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://10.11.60.145:4000", apiKey: "{env:VOICE_OC_TEST_KEY}" },
        },
        openai: { options: { baseURL: "https://api.openai.com/v1", apiKey: "static" } },
        broken: { models: {} },
      },
    }),
  );
  try {
    assert.deepEqual(loadOpenCodeProviders(file), {
      litellm: { baseURL: "http://10.11.60.145:4000", apiKey: "env-key" },
      openai: { baseURL: "https://api.openai.com/v1", apiKey: "static" },
      broken: {},
    });
  } finally {
    delete process.env.VOICE_OC_TEST_KEY;
  }
});

test("loadOpenCodeProviders: missing or invalid file returns empty map without throwing", () => {
  assert.deepEqual(
    loadOpenCodeProviders(path.join(os.tmpdir(), "voice-none", "opencode.json")),
    {},
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
  const file = path.join(dir, "opencode.json");
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(loadOpenCodeProviders(file), {});
});

test("resolveLlmTarget: endpoint/model/apiKey for a known provider with baseURL", () => {
  const providers = { litellm: { baseURL: "http://10.11.60.145:4000", apiKey: "sk-dummy" } };
  assert.deepEqual(
    resolveLlmTarget({ providerID: "litellm", modelID: "Qwen3.8-27B-VLLM" }, providers),
    { endpoint: "http://10.11.60.145:4000", model: "Qwen3.8-27B-VLLM", apiKey: "sk-dummy" },
  );
});

test("resolveLlmTarget: null for unknown provider, missing baseURL, or no current model", () => {
  const providers = {
    litellm: { baseURL: "http://10.11.60.145:4000", apiKey: "sk-dummy" },
    local: { apiKey: "sk-x" },
  };
  assert.equal(resolveLlmTarget({ providerID: "anthropic", modelID: "claude" }, providers), null);
  assert.equal(resolveLlmTarget({ providerID: "local", modelID: "gpt" }, providers), null);
  assert.equal(resolveLlmTarget(undefined, providers), null);
});

test("resolveLlmTarget: provider without apiKey yields null apiKey", () => {
  const providers = { litellm: { baseURL: "http://10.11.60.145:4000" } };
  assert.deepEqual(
    resolveLlmTarget({ providerID: "litellm", modelID: "Qwen3.8-27B-VLLM" }, providers),
    { endpoint: "http://10.11.60.145:4000", model: "Qwen3.8-27B-VLLM", apiKey: null },
  );
});
