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

const OPENCODE_CONFIG_NAMES = ["opencode.json", "opencode.jsonc"];

function resolveEnvKey(value) {
  if (typeof value !== "string") return null;
  if (value.startsWith("{env:") && value.endsWith("}"))
    return process.env[value.slice(5, -1)] || null;
  return value || null;
}

export function loadOpenCodeProviders(explicitPath) {
  const candidates = explicitPath
    ? [explicitPath]
    : OPENCODE_CONFIG_NAMES.map((name) => path.join(os.homedir(), ".config", "opencode", name));
  for (const file of candidates) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") continue;
      console.warn("[opencode-voice] invalid opencode config " + file + ": " + err.message);
      continue;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    const providers = {};
    for (const [id, def] of Object.entries(data.provider ?? {})) {
      const options = def?.options && typeof def.options === "object" ? def.options : {};
      providers[id] = {};
      if (options.baseURL) providers[id].baseURL = options.baseURL;
      const key = resolveEnvKey(options.apiKey);
      if (key) providers[id].apiKey = key;
    }
    return providers;
  }
  return {};
}

export function resolveLlmTarget(current, providers) {
  if (!current || !current.providerID || !current.modelID) return null;
  const provider = providers[current.providerID];
  if (!provider || !provider.baseURL) return null;
  return { endpoint: provider.baseURL, model: current.modelID, apiKey: provider.apiKey ?? null };
}

export function resolveApiKey({ apiKey, apiKeyEnv } = {}) {
  if (typeof apiKey === "string" && apiKey !== "") return apiKey;
  if (typeof apiKeyEnv === "string" && apiKeyEnv !== "") {
    const envValue = process.env[apiKeyEnv];
    if (envValue) return envValue;
  }
  return null;
}
