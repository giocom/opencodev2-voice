import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "voice.json");

function dropEmptyStrings(options) {
  const out = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === "") continue;
    out[key] = value;
  }
  return out;
}

export function loadVoiceConfig(contextOptions = {}) {
  const options = dropEmptyStrings(contextOptions);
  const file = process.env.VOICE_CONFIG || DEFAULT_CONFIG_PATH;
  let data = {};
  try {
    const raw = fs.readFileSync(file, "utf8");
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.warn("[opencode-voice] invalid voice config " + file + ": " + err.message);
    }
  } catch (err) {
    if (err.code !== "ENOENT")
      console.warn("[opencode-voice] cannot read voice config " + file + ": " + err.message);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) data = {};
  return { ...data, ...options };
}

export function resolveApiKey({ apiKey, apiKeyEnv } = {}) {
  if (typeof apiKey === "string" && apiKey !== "") return apiKey;
  if (typeof apiKeyEnv === "string" && apiKeyEnv !== "") {
    const envValue = process.env[apiKeyEnv];
    if (envValue) return envValue;
  }
  return null;
}
