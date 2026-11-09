# OpenCode Voice: Custom STT/TTS Server Support — Design

Date: 2026-11-09
Status: Approved (user confirmed 2026-11-09, option A — fork)

## Intent

The user runs their own OpenAI-compatible STT and TTS servers on the LAN
(faster-whisper-small on port 9000, Qwen-TTS on port 8001) and wants OpenCode
V2 to use them for voice input (STT) and voice output (TTS) instead of the
upstream plugin's built-in whisper.cpp (STT) and Piper (TTS).

## Decided approach (user's choice)

**A. Fork `@renjfk/opencode-voice` (MIT, v0.1.0 main == npm v1.0.0 code) and
replace only the TTS synthesis path** with a call to the user's OpenAI-compatible
TTS endpoint. STT already supports this server via the existing `sttEndpoint`
option (multipart `POST /audio/transcriptions`, standard OpenAI field layout) —
no STT code changes. LLM normalization reuses the existing OpenAI-compatible
`endpoint`/`model` client. All keybindings, dialogs, and event handling stay.

## Goals

- Voice recording (Ctrl+R) transcribes through the user's STT server
  (`sttEndpoint`, model `Systran/faster-whisper-small`).
- Assistant responses are spoken through the user's TTS server
  (`ttsEndpoint`, model `Qwen/Qwen-TTS-12Hz-0.6B-Base`, voice `Serena`).
- One plugin package; config via `cli.json` plugin options and/or a local
  config file; no publishing required (local directory install).

## Non-goals

- No changes to STT flow, LLM normalization logic, or keybindings.
- No voice-listing from the TTS server (static config only).
- No OpenRouter-specific STT path changes (keep as-is).

## Constraints

- OpenCode V2 TUI-only plugin (`./tui` part, loaded from `cli.json`);
  package must stay a plain ESM package with `@opencode/plugin` devDependency.
- The TTS server is OpenAI-compatible: `POST {base}/audio/speech` with JSON
  `{model, voice, input, ...}` returning audio bytes (mp3 by default).
- Audio playback happens on the machine running the TUI: requires one of
  `mpv`, `ffmpeg`(ffplay), or `sox` on PATH.
- MIT license of the fork base must be preserved (LICENSE kept).

## Configuration surface

Flat options (same names in both sources; `cli.json` options win on conflict):

| Key                                                    | Source | Meaning                                                                    |
| ------------------------------------------------------ | ------ | -------------------------------------------------------------------------- |
| `endpoint`, `model`, `apiKeyEnv`, `apiKey`             | both   | LLM normalization client (OpenAI-compatible `/chat/completions`)           |
| `sttEndpoint`, `sttModel`, `sttApiKeyEnv`, `sttApiKey` | both   | STT server (existing option; direct `sttApiKey` added)                     |
| `ttsEndpoint`, `ttsModel`, `ttsVoice`                  | both   | TTS server + default voice (new)                                           |
| `ttsVoices`                                            | both   | optional list for the `/tts-voice` dialog: `string[]` or `{label,value}[]` |
| `ttsApiKeyEnv`, `ttsApiKey`                            | both   | TTS auth (new; `ttsApiKey` direct value wins)                              |
| `ttsResponseFormat`                                    | both   | request `response_format`; default `mp3`; `null`/omitted → field not sent  |
| `ttsExtra`                                             | both   | extra JSON params merged into the TTS request body                         |

Config file: `~/.config/opencode/voice.json` (override path via `VOICE_CONFIG`
env var). File missing → options only; invalid JSON → warn log, options only.

## TTS engine (new `lib/tts-engine.js`)

`createTtsEngine(config, logger, deps?)` → `{ speak(text): Promise<void>, stop(): boolean }`

- `config.ttsEndpoint` set → **http mode**:
  `POST {ttsEndpoint}/audio/speech` (trailing slash normalized), JSON body
  `{model, voice, input: text, response_format?, ...ttsExtra}`, `Authorization:
Bearer <key>` when a key is configured; 120s abort timeout.
  Non-2xx or network error → warning toast + log, never throw.
  200 → audio bytes to a temp file (`tts-<ts>.<ext>`) → play with the first
  available of `mpv` → `ffplay` → (wav only) `sox`/`aplay`; none available →
  warning toast "no audio player". `stop()` kills the player (returns whether
  one was playing); temp file removed on player close.
- else → **piper mode**: existing upstream behavior (piper binary + sox `play`
  pipe), moved here from `lib/tts.js` unchanged in behavior.

`lib/tts.js` keeps all command/event/dialog logic; `speak`/`stopSpeech` delegate
to the engine. Voice in http mode: `kv("tts.voice")` → `ttsVoice` option →
`"default"`. The `/tts-voice` dialog lists `ttsVoices` (http) or the Piper
voice table (piper).

## Install

- Plugin lives in this git repo; installed as a **local directory** entry in
  `~/.config/opencode/cli.json`: `{"plugins": ["/root/opencode-voice"]}`
  (package.json `name` + `exports["./tui"]` make it load like a published
  package).
- Endpoints/keys in `~/.config/opencode/voice.json` (keys not committed to
  the repo; the checked-in file is a template without secrets).
- `npm pack` produces a portable tgz for other machines.

## My calls (defaults the user can override when reading this doc)

- Fork package name `opencode-voice-local`, version `0.2.0`; plugin `id`
  stays `opencode-voice` (keeps keybind/storage continuity).
- Direct `*ApiKey` options (vs env-var-only upstream) because the config file
  already holds the other values; `apiKey`/`sttApiKey`/`ttsApiKey` win over
  the `*ApiKeyEnv` forms.
- TTS request timeout 120s (STT upstream uses 60s; TTS synthesis of long
  normalized text is slower).
- `ttsResponseFormat` default `mp3` (the user's Qwen-TTS server's likely
  default); set `null` to omit the field if the server rejects it.
- Audio player preference `mpv` → `ffplay` → `sox`/`aplay` (wav only).
