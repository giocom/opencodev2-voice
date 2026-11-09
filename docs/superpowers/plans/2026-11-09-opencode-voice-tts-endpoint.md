# Custom STT/TTS Server Support (opencode-voice fork) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork of `@renjfk/opencode-voice` whose TTS speaks through a user-configured OpenAI-compatible TTS server (Qwen-TTS) and whose STT uses the user's faster-whisper server, all configured via `cli.json` options and/or `~/.config/opencode/voice.json`.

**Architecture:** One new module `lib/tts-engine.js` owns synthesis+playback for both modes: **http** (new: `POST {ttsEndpoint}/audio/speech` → temp file → `mpv`/`ffplay`/`sox` playback) and **piper** (upstream behavior, moved verbatim). `lib/tts.js` keeps all command/event/dialog logic and delegates `speak`/`stop` to the engine. A small `lib/config.js` merges `~/.config/opencode/voice.json` under `context.options` so the plugin works installed as a local directory (where `cli.json` object-form options are unverified).

**Tech Stack:** Plain ESM JavaScript, Node 18+ globals (`fetch`, `FormData`, `Blob`), zero runtime dependencies, `node:test` + `node:assert/strict`, `oxlint`/`oxfmt` (upstream's `npm run check`), OpenCode V2 TUI plugin SDK (`@opencode/plugin/tui`, devDependency only).

**Spec:** `docs/superpowers/specs/2026-11-09-opencode-voice-tts-endpoint-design.md`

## Global Constraints

- Code style: double quotes, semicolons, 2-space indent (match existing files); `npm run check` (oxlint + oxfmt) must pass before every commit.
- No new runtime dependencies; `@opencode/plugin` stays a devDependency.
- Preserve `LICENSE` (MIT) and add upstream attribution to README.
- Package name `opencode-voice-local`, version `0.2.0`; plugin `id` stays `"opencode-voice"` (storage/keybind continuity).
- Node 18+ only (upstream already relies on global `fetch`/`FormData`).
- Test style: `node:test`, stub `globalThis.fetch` or inject `deps`; no new test framework. Run with `node --test`.
- TTS request timeout: 120000 ms (`AbortSignal.timeout(120000)`).
- Commit after each task with `git -C /root/opencode-voice`.

## Review Focus

Failure modes the spec implies that no single test fully pins; each is exercised by the named task's tests (add the listed assertion when implementing):

1. **TTS server rejects `response_format` (400/422)** — user must be able to omit it via `ttsResponseFormat: null` and see a warning toast with the HTTP status (not a silent failure). → Task 2 tests "omits response_format when null" + "non-2xx toasts status".
2. **TTS server requires auth, no key configured** — 401 must produce a warning toast, never an unhandled rejection. → Task 2 test "non-2xx toasts status".
3. **Long text, slow synthesis (>120s)** — abort fires, error toast shown, TUI not blocked. → Task 2 test "aborts after 120s" (use a fake clock/short constant for the test; keep 120000 in production code via a module-level `TTS_TIMEOUT_MS = 120000`).
4. **No audio player on PATH (headless TUI machine)** — first speak warns "No audio player found (install mpv or ffmpeg)"; no crash, subsequent speaks retry. → Task 2 test "no player toasts".
5. **Plugin reload while audio plays** — cleanup stops the player; no orphan `mpv`/`sox` process. → Task 4: `index.js` cleanup returns a function calling `engine.stop()` (verify in code review; engine `stop()` unit-tested in Task 2).

---

### Task 1: Fork baseline + config module

**Files:**

- Modify: `package.json` (name/version/description/keywords)
- Create: `lib/config.js`
- Create: `test/config.test.js`

**Interfaces:**

- Consumes: nothing (first task on the fork baseline).
- Produces:
  - `loadVoiceConfig(contextOptions = {}): object` — reads `process.env.VOICE_CONFIG` path, else `~/.config/opencode/voice.json`; returns `{ ...fileData, ...contextOptions }` with empty-string keys in `contextOptions` dropped. File missing → `{...contextOptions}`. Invalid JSON → `console.warn` + `{...contextOptions}` (never throws).
  - `resolveApiKey({ apiKey, apiKeyEnv }: { apiKey?: string, apiKeyEnv?: string }): string | null` — returns `apiKey` if non-empty, else `process.env[apiKeyEnv]` if `apiKeyEnv` set and non-empty, else `null`.

- [ ] **Step 1: Rename package**

Edit `package.json`: `"name": "opencode-voice-local"`, `"version": "0.2.0"`, description: `"Speech-to-text and text-to-speech for OpenCode. STT via any OpenAI-compatible endpoint (whisper.cpp optional); TTS via Piper or any OpenAI-compatible /audio/speech server, with LLM normalization."` Keep `"license": "MIT"`, `"type": "module"`, `"files": ["index.js", "lib"]`, devDependencies unchanged.

- [ ] **Step 2: Write the failing test** `test/config.test.js`

```js
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /root/opencode-voice && node --test test/config.test.js`
Expected: FAIL — `Cannot find module '../lib/config.js'`

- [ ] **Step 4: Implement `lib/config.js`**

Two exported functions per the Interfaces block. Read the file with `fs.readFileSync(file, "utf8")`, `JSON.parse` in try/catch (on error: `console.warn("[opencode-voice] invalid voice config " + file + ": " + err.message)`). Default path: `path.join(os.homedir(), ".config", "opencode", "voice.json")`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /root/opencode-voice && node --test test/config.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
cd /root/opencode-voice
git add package.json lib/config.js test/config.test.js
git commit -m "feat: fork baseline (opencode-voice-local 0.2.0) + voice.json config loader"
```

---

### Task 2: TTS engine (http + piper modes)

**Files:**

- Create: `lib/tts-engine.js`
- Create: `test/tts-engine.test.js`

**Interfaces:**

- Consumes: nothing from earlier tasks (standalone module; `resolveApiKey` from Task 1 is used here).
- Produces:
  - `createTtsEngine(config, logger, deps = {}): { speak(text: string): Promise<void>, stop(): boolean }`
  - `config` (all optional except `toast`):
    - `ttsEndpoint?: string` — presence switches to http mode
    - `ttsModel?: string`
    - `getVoice(): string` — current voice; http mode returns a voice name (e.g. `"Serena"`), piper mode returns the onnx model path
    - `ttsApiKey?: string`, `ttsApiKeyEnv?: string` (resolved via `resolveApiKey`)
    - `ttsResponseFormat?: string | null` — `undefined` → default `"mp3"`; `null`/empty → omit `response_format` from the request body
    - `ttsExtra?: object` — spread into the request body after the standard fields
    - `toast(message: string, variant?: string): void` — default `() => {}`
  - 4th optional parameter `timeoutMs = TTS_TIMEOUT_MS` (testability; production calls omit it)
  - `deps` (defaults: `globalThis.fetch`, `node:child_process.spawn`, `node:fs`, `os.tmpdir()`):
    - `fetch?(url, options)`, `spawn?(cmd, args, opts)`, `existsSync?(p): boolean` (used for the piper PATH scan AND the piper voice-model path check), `tmpDir?: string`, `writeFile?(p, buf): Promise`, `rmFile?(p): Promise`
  - http behavior: `POST {endpoint with trailing / stripped}/audio/speech`; JSON body `{ model, voice: getVoice(), input: text, response_format?, ...ttsExtra }`; `Content-Type: application/json`; `Authorization: Bearer <key>` only when a key resolves; `signal: AbortSignal.timeout(TTS_TIMEOUT_MS)` with `TTS_TIMEOUT_MS = 120000`. Non-2xx → `toast("TTS request failed (HTTP " + status + ")", "warning")`. Network/abort error → `toast("TTS request failed: " + err.message, "warning")`. 200 → `await res.arrayBuffer()` → temp file `tts-<Date.now()>.<ext>` (ext from `response_format`: `"wav"`→`wav`, `"pcm"`→`pcm`, else `mp3`) → play with the first available player: `mpv` (`["--really-quiet", "--no-video", file]`) → `ffplay` (`["-nodisp", "-autoexit", "-loglevel", "quiet", file]`) → if ext is `wav`: `sox` (`[file, "-"]`) then `aplay` (`[file]`); none → `toast("No audio player found (install mpv or ffmpeg)", "warning")`. Player runs via `spawn(cmd, args, { stdio: "ignore" })`, tracked in a single `playerProc`; on close → `rmFile(file)`; `stop()` → kill if playing, return whether it was.
  - piper behavior (no `ttsEndpoint`): exact upstream pipeline — spawn `play` (`["-t","raw","-r","22050","-e","signed","-b","16","-c","1","-q","-"]`, stdio `["pipe","ignore","pipe"]`), spawn `piper` (`["-m", getVoice(), "--output_raw"]`), pipe piper stdout→play stdin, write `text + "\n"` to piper stdin and end; checks `piperOnPath()` (scan `PATH` for `piper` via `deps.existsSync`) and `fs.existsSync(getVoice())`, toasting `"Piper binary not found on PATH"` / `"Voice model not found: <path>"` when missing; same `stop()`/close semantics as upstream.

- [ ] **Step 1: Write the failing test** `test/tts-engine.test.js`

Use a `makeDeps()` factory: fake `fetch` capturing calls, `spawn` returning fake child-process objects built from `EventEmitter` with a writable `stdin` (`{ write, end, destroyed: false }`), `existsSync: (p) => p === "/bin/mpv" || <per-test set>`, `tmpDir`, `writeFile`/`rmFile` recording calls. Helper `jsonAudioResponse(bytes, status = 200)` returns `{ ok, status, arrayBuffer: async () => bytes }`.

Tests (one per bullet; each asserts the bolded behavior):

1. `sends POST to /audio/speech with model, voice, input, response_format` — `ttsEndpoint: "http://tts.test/v1/"` (trailing slash), `ttsModel: "Qwen/Qwen-TTS-12Hz-0.6B-Base"`, `getVoice: () => "Serena"`, `ttsExtra: { speed: 1.2 }` → fetch called with `http://tts.test/v1/audio/speech`, body `{ model: "Qwen/Qwen-TTS-12Hz-0.6B-Base", voice: "Serena", input: "hello world", response_format: "mp3", speed: 1.2 }`.
2. `omits response_format when ttsResponseFormat is null` → body has no `response_format` key.
3. `sends Authorization from ttsApiKey` (and: `direct beats env` — set `process.env.VOICE_TTS_KEY = "env"`; `ttsApiKey: "direct"` → header `Bearer direct`).
4. `non-2xx toasts with status and does not spawn` — `jsonAudioResponse("nope", 422)` → `toasts` contains `"TTS request failed (HTTP 422)"`, `spawnCalls` empty.
5. `network error toasts without throwing` — `fetch` rejects `new Error("ECONNREFUSED")` → `await engine.speak("x")` resolves; toast `"TTS request failed: ECONNREFUSED"`.
6. `aborts after the configured timeout` — `fetch` returns a promise that honors `options.signal` (`signal.addEventListener("abort", () => reject(new Error("aborted")))`); override the module's timeout for the test by exporting `TTS_TIMEOUT_MS` and a test-only `createTtsEngine(config, logger, deps, timeoutMs = TTS_TIMEOUT_MS)` parameter; pass `50` → resolves with toast containing `"aborted"`.
7. `writes audio to temp file and plays with mpv, removing the file on close` — 200 with `Buffer.from("ID3data")` → `writeFile` called with a path ending `.mp3` containing `ID3data`; `spawnCalls[0]` is `["mpv", ["--really-quiet","--no-video", <file>], { stdio: "ignore" }]`; emit `close` on the fake proc → `rmFile` called with the same path.
8. `falls back ffplay → sox(wav) → aplay; toasts when none available` — three sub-cases via `existsSync` setup (ffplay only; sox only with 200 response `response_format: "wav"` → `["sox", [file, "-"]]`; nothing → toast `"No audio player found (install mpv or ffmpeg)"`, no spawn).
9. `stop() kills a playing player and reports state` — after speak with fake mpv proc: `stop()` returns `true`, `proc.killed === true` (set in fake `kill`); a second `stop()` returns `false`.
10. `piper mode: spawns piper + play, pipes raw audio` — config without `ttsEndpoint`, `getVoice: () => "/voices/en.onnx"`, `existsSync` true for `/bin/piper` and the voice → `spawnCalls` contains `["piper", ["-m","/voices/en.onnx","--output_raw"]]` and `["play", ["-t","raw","-r","22050","-e","signed","-b","16","-c","1","-q","-"]]`; fake piper stdin receives `hello world\n` then `end()`.
11. `piper mode: missing binary or model toasts and does not spawn` — `existsSync` false → toasts `"Piper binary not found on PATH"`; then binary present, voice missing → `"Voice model not found: /voices/x.onnx"`; `spawnCalls` empty.
12. `http mode: missing ttsModel toasts "TTS model not configured" and does not fetch` — config without `ttsModel` → no fetch call, toast recorded.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/opencode-voice && node --test test/tts-engine.test.js`
Expected: FAIL — `Cannot find module '../lib/tts-engine.js'`

- [ ] **Step 3: Implement `lib/tts-engine.js`**

Single module: `TTS_TIMEOUT_MS` constant (exported), `createTtsEngine` with `let playerProc`/`piperProc`/`playProc` per engine instance, `stop()` shared. Import `resolveApiKey` from `./config.js`, `spawn` from `node:child_process`, `fs`/`os`/`path` for defaults. Keep both mode branches in one `speak` via `const httpMode = Boolean(config.ttsEndpoint)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/opencode-voice && node --test test/tts-engine.test.js`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
cd /root/opencode-voice
git add lib/tts-engine.js test/tts-engine.test.js
git commit -m "feat: TTS engine with OpenAI-compatible HTTP mode and moved Piper mode"
```

---

### Task 3: Wire engine into `lib/tts.js`

**Files:**

- Modify: `lib/tts.js` (delete lines owning the piper pipeline; `registerTTS` gains a `config` param; `speak`/`stopSpeech` delegate; voice resolution + `/tts-voice` dialog become config-driven)
- Modify: `index.js` (create the engine once, pass it in; cleanup stops the engine)
- Create: `test/tts.test.js`

**Interfaces:**

- Consumes: `createTtsEngine` (Task 2), `loadVoiceConfig` (Task 1, used in `index.js`).
- Produces:
  - `registerTTS(api, kv, complete, prompts, logger, config = {}, engine = null): command[]` — `config` is the merged voice config (flat, per spec); `engine` is the TTS engine built by `index.js` (optional: when null, `registerTTS` builds its own from `config` so the module stays self-contained for tests). Existing `speak(text)`/`stopSpeech()` bodies replaced by `engine.speak(text)` / `engine.stop()`; all commands/events/dialogs otherwise unchanged.
  - `resolveVoice(config, kv): string` — http mode (`config.ttsEndpoint` set): `kv.get("tts.voice") || config.ttsVoice || "default"`; piper mode: existing `TTS_VOICES` key→`path.join(VOICES_DIR, file)` logic (default key `"ryan"`).
  - `ttsVoicesFor(config): { label: string, value: string }[]` — http mode: `config.ttsVoices` (strings → `{label: s, value: s}`; objects pass through) when non-empty, else `config.ttsVoice ? [{label: config.ttsVoice, value: config.ttsVoice}] : []`; piper mode: `Object.entries(TTS_VOICES).map(([value, {label}]) => ({label, value}))`.
  - `index.js` `setup`: `const voiceConfig = loadVoiceConfig(options)`; `index.js` builds the engine: `const engine = createTtsEngine({ ...voiceConfig, getVoice: () => resolveVoice(voiceConfig, kv), toast: (m, v) => context.ui.toast.show({ message: m, variant: v }) }, logger)`; then `registerSTT(api, kv, complete, prompts, voiceConfig, logger)` (replaces the raw `options` arg — `sttEndpoint`/`sttModel`/keys live in the merged config) and `registerTTS(api, kv, complete, prompts, logger, voiceConfig, engine)`; cleanup: `return () => { engine.stop(); api.event.dispose(); }` (stops any playing audio on plugin reload). `resolveVoice` is imported by `index.js` from `./lib/tts.js`.
- The `/tts-voice` dialog command's options list switches from the hard-coded `TTS_VOICES` map to `ttsVoicesFor(config)`; selecting stores `kv.set("tts.voice", value)` as before. The `tts.mode` toggle toast keeps the voice label (looked up in `ttsVoicesFor(config)`).

- [ ] **Step 1: Write the failing test** `test/tts.test.js`

```js
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
```

Note: `piper mode` tests depend on `TTS_VOICES`/`VOICES_DIR` remaining in `lib/tts.js` (they do — only the spawn pipeline moves to the engine).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/opencode-voice && node --test test/tts.test.js`
Expected: FAIL — `resolveVoice` is not exported

- [ ] **Step 3: Refactor `lib/tts.js`**

- Add `config = {}` and `engine = null` params to `registerTTS` (engine optional: `engine ?? createTtsEngine(...)` default keeps the module self-contained for tests).
- Replace the `speak(text)` body (upstream lines 148–243) with `return engine.speak(text)`; replace `stopSpeech()` with `return engine.stop()`.
- Delete the now-unused imports/consts: `PIPER_RATE/PIPER_BITS/PIPER_CHANNELS`, `piperProc`/`playProc`, `killProcs`, `piperOnPath` (keep `VOICES_DIR`, `TTS_VOICES`, `DEFAULT_TTS_VOICE` — used by `resolveVoice`/`ttsVoicesFor`).
- Add `resolveVoice` and `ttsVoicesFor` per Interfaces; use them in the `/tts-voice` command and the `tts.mode` toast.

- [ ] **Step 4: Wire `index.js`**

Per the Interfaces block: import `loadVoiceConfig` (`./lib/config.js`), `createTtsEngine` (`./lib/tts-engine.js`), `resolveVoice` (`./lib/tts.js`); build `voiceConfig`, `engine`; pass to `registerSTT` (replaces the raw `options` arg) and `registerTTS`; cleanup function calls `engine.stop()` then `api.event.dispose()`.

- [ ] **Step 5: Run the full suite**

Run: `cd /root/opencode-voice && npm test && npm run check`
Expected: ALL PASS (config, tts-engine, tts, llm-client, stt, dialog-api tests) and lint/fmt clean

- [ ] **Step 6: Commit**

```bash
cd /root/opencode-voice
git add lib/tts.js index.js test/tts.test.js
git commit -m "refactor: tts.js delegates to TTS engine; index.js merges voice.json + cli.json options"
```

---

### Task 4: Direct API keys (STT/LLM) + smoke test

**Files:**

- Modify: `lib/stt.js` (`transcribeApi` + `getApiModels` key resolution; read `sttApiKey` from opts near line 613)
- Modify: `lib/llm-client.js` (accept direct `apiKey` option)
- Modify: `test/llm-client.test.js` (extend existing file with key tests)

**Interfaces:**

- Consumes: `resolveApiKey` (Task 1).
- Produces: `lib/stt.js` module-scope `sttApiKey` (direct value from opts; `sttApiKey || resolveApiKey({apiKeyEnv: sttApiKeyEnv})` in both `transcribeApi` and `getApiModels`); `lib/llm-client.js` `createClient` config gains `apiKey` (`cfg.apiKey` from `pluginOptions?.apiKey`), `complete()` uses `resolveApiKey({ apiKey: cfg.apiKey, apiKeyEnv: cfg.apiKeyEnv })` for the header.

- [ ] **Step 1: Write the failing tests**

No new `test/stt.test.js` cases: the STT change is a 2-line key resolution reusing `resolveApiKey`, already unit-tested in Task 1 (`test/config.test.js`); it is verified by the full suite + code review. The LLM client needs new coverage because its `complete()` gains the direct-key path. In `test/llm-client.test.js` (follow the existing `globalThis.fetch` stub pattern from that file):

```js
test("direct apiKey option is sent as Bearer header, beating apiKeyEnv", async () => {
  process.env.VOICE_LLM_KEY = "env-key";
  const captured = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    captured.push(options);
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "ok" } }] };
      },
    };
  };
  try {
    const client = createClient({
      endpoint: "https://llm.test/v1",
      model: "m",
      apiKey: "direct",
      apiKeyEnv: "VOICE_LLM_KEY",
      retries: 0,
    });
    await client.complete({ prompt: "hi" });
    assert.equal(captured[0].headers.Authorization, "Bearer direct");
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.VOICE_LLM_KEY;
  }
});
test("no key configured sends no Authorization header", async () => {
  const captured = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    captured.push(options);
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "ok" } }] };
      },
    };
  };
  try {
    const client = createClient({ endpoint: "https://llm.test/v1", model: "m", retries: 0 });
    await client.complete({ prompt: "hi" });
    assert.equal(captured[0].headers.Authorization, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /root/opencode-voice && node --test test/llm-client.test.js`
Expected: FAIL on the new tests (direct `apiKey` unsupported → header `Bearer env-key` or missing)

- [ ] **Step 3: Implement**

`lib/stt.js`: near the existing `sttApiKeyEnv` read (≈line 613) add `sttApiKey = opts?.sttApiKey || null;`; in `transcribeApi` (≈line 492) and `getApiModels` (≈line 456) compute `const apiKey = sttApiKey || (sttApiKeyEnv ? process.env[sttApiKeyEnv] : null);` (reuse `resolveApiKey` by importing it). `lib/llm-client.js`: add `apiKey: pluginOptions?.apiKey ?? null` in `getConfig()`; in `complete()` replace `const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : null;` with `const apiKey = resolveApiKey({ apiKey: cfg.apiKey, apiKeyEnv: cfg.apiKeyEnv });` (import from `./config.js`).

- [ ] **Step 4: Run full suite + smoke test**

Run:

```bash
cd /root/opencode-voice && npm test && npm run check
node --input-type=module -e "const m = await import('/root/opencode-voice/index.js'); if (typeof m.default !== 'object' || !m.default) throw new Error('bad export'); console.log('SMOKE OK')"
```

Expected: ALL PASS + `SMOKE OK` (the TUI entry imports cleanly outside the TUI)

- [ ] **Step 5: Commit**

```bash
cd /root/opencode-voice
git add lib/stt.js lib/llm-client.js test/llm-client.test.js
git commit -m "feat: direct apiKey option for STT and LLM clients (beats apiKeyEnv)"
```

---

### Task 5: README, install, user config

**Files:**

- Modify: `README.md` (full rewrite), `.gitignore` (add `dist/`, `package-lock.json` stays tracked — upstream has one, keep)
- Create: `~/.config/opencode/cli.json` (merge — read existing first; add the plugin entry if absent)
- Create: `~/.config/opencode/voice.json`
- Create (build output, gitignored): `dist/opencode-voice-local-0.2.0.tgz` via `npm pack`

**Interfaces:**

- Consumes: everything from Tasks 1–4.
- Produces: the installed, ready-to-use plugin.

- [ ] **Step 1: Rewrite `README.md`**

Sections: (1) fork notice — fork of `@renjfk/opencode-voice` (MIT, upstream attribution + link), version 0.2.0; (2) what it does (STT/TTS/commands list — keep the upstream command table); (3) install: **local directory** — `~/.config/opencode/cli.json` `{"plugins": ["/root/opencode-voice"]}` (package.json `name` + `exports["./tui"]` make it load like a published package); alternative: `opencode plugin add github:<user>/opencode-voice` or `npm pack` → tgz on other machines; (4) audio player requirement — `mpv` (preferred) or `ffmpeg` (ffplay) or `sox`+`aplay` (wav only) on PATH of the machine running the TUI; (5) configuration — full options table from the spec (`endpoint`, `model`, `apiKey`/`apiKeyEnv`, `sttEndpoint`, `sttModel`, `sttApiKey`/`sttApiKeyEnv`, `ttsEndpoint`, `ttsModel`, `ttsVoice`, `ttsVoices`, `ttsApiKey`/`ttsApiKeyEnv`, `ttsResponseFormat`, `ttsExtra`) with a worked example for the user's servers (STT `http://101.160.146.9000/v1` + `Systran/faster-whisper-small`; TTS `http://101.160.146.8001/v1` + `Qwen/Qwen-TTS-12Hz-0.6B-Base` + voice `Serena`); (6) `voice.json` location (`~/.config/opencode/voice.json`, `VOICE_CONFIG` override) and merge rule (cli.json options win).

- [ ] **Step 2: Create `~/.config/opencode/voice.json`**

Read the existing file first (create if absent; never overwrite an existing one without merging). Content (user fills the two keys + LLM fields):

```jsonc
{
  // LLM normalization (required; any OpenAI-compatible /chat/completions)
  "endpoint": "<fill in>",
  "model": "<fill in>",
  // STT — user's faster-whisper server
  "sttEndpoint": "http://101.160.146.9000/v1",
  "sttModel": "Systran/faster-whisper-small",
  "sttApiKey": "<fill in>",
  // TTS — user's Qwen-TTS server
  "ttsEndpoint": "http://101.160.146.8001/v1",
  "ttsModel": "Qwen/Qwen-TTS-12Hz-0.6B-Base",
  "ttsVoice": "Serena",
  "ttsApiKey": "<fill in>",
}
```

(Note: JSONC comments are not valid JSON — ship the file as plain JSON without comments; put the field hints in the README instead.)

- [ ] **Step 3: Register the plugin in `~/.config/opencode/cli.json`**

Read existing; if `plugins` array exists, add `"/root/opencode-voice"`; else create `{"plugins": ["/root/opencode-voice"]}`.

- [ ] **Step 4: Pack + final verification**

```bash
cd /root/opencode-voice && npm pack
cd /root/opencode-voice && npm test && npm run check && node --input-type=module -e "await import('/root/opencode-voice/index.js'); console.log('SMOKE OK')"
ls ~/.config/opencode/cli.json ~/.config/opencode/voice.json dist/*.tgz
```

Expected: all green, `SMOKE OK`, three files listed.

- [ ] **Step 5: Commit**

```bash
cd /root/opencode-voice
git add README.md .gitignore
git commit -m "docs: README for local install, voice.json config, and Qwen-TTS/faster-whisper example"
```

- [ ] **Step 6: Hand over to user**

Tell the user: fill `<fill in>` values (STT key, TTS key, LLM endpoint/model) in `~/.config/opencode/voice.json`; start `opencode` (TUI) on the machine with audio + a player (mpv recommended); test `/stt-record` (Ctrl+R) and `/tts-speak` (Leader+S), `/tts-mode` (Leader+V).
