# opencode-voice-local

> **Fork of [`@renjfk/opencode-voice`](https://github.com/renjfk/opencode-voice)
> (MIT, upstream: renjfk) — version 0.2.0.**
>
> What this fork adds:
>
> - **Self-hosted TTS**: any OpenAI-compatible `POST /audio/speech` server
>   (e.g. [Qwen-TTS](https://huggingface.co/Qwen/Qwen3-TTS)) instead of
>   Piper-only. Piper still works when no `ttsEndpoint` is configured.
> - **Direct API key options** — `apiKey` (LLM), `sttApiKey`, `ttsApiKey` —
>   which beat the `*ApiKeyEnv` environment-variable forms.
> - **A config file** — `~/.config/opencode/voice.json` (override the path with
>   the `VOICE_CONFIG` env var), merged under the `cli.json` plugin options
>   (options win on conflict).
>
> STT through an OpenAI-compatible transcription server (e.g.
> [faster-whisper](https://huggingface.co/Systran/faster-whisper-small) served
> with an OpenAI-compatible API) already worked upstream and is unchanged.

Speech-to-text and text-to-speech plugin for [OpenCode](https://opencode.ai/):
record voice prompts, have them transcribed and normalized by an LLM, and hear
assistant responses spoken aloud (auto or on demand).

## Install

The plugin is a TUI-only package, so it is registered in
`~/.config/opencode/cli.json` (not the server-side `opencode.json`).

**Local directory** (this repo, no npm publish needed — the package `name` and
`exports["./tui"]` make it load like a published package):

```json
{
  "plugins": ["/root/opencode-voice"]
}
```

**Other machines:** `npm pack` in this repo produces a tgz you can copy
anywhere, or publish the fork to npm / a git host and use the object form:

```json
{
  "plugins": [
    {
      "package": "opencode-voice-local",
      "options": { "ttsEndpoint": "http://10.11.60.146:8001/v1" }
    }
  ]
}
```

> [!NOTE]
> **Clobbering default keybinds.** This plugin uses `ctrl+r` for voice
> recording, but OpenCode assigns it to session rename by default. If that
> matters to you, add `"keybinds": { "session_rename": "none" }` to cli.json.

## Prerequisites

On the machine running the OpenCode TUI:

- **STT**: `sox` (mic capture) and either an OpenAI-compatible transcription
  server (`sttEndpoint`) or a local `whisper-cli` build (upstream's
  whisper.cpp instructions still apply).
- **TTS (HTTP mode)**: an audio player on PATH — `mpv` (preferred) or
  `ffmpeg` (for `ffplay`) or `sox` + `aplay` (wav files only). The plugin
  picks the first one it finds: `mpv` → `ffplay` → `sox`/`aplay`.
- **TTS (Piper mode, optional)**: `piper` on PATH and voice models under
  `~/.local/share/piper-voices/` — only needed when no `ttsEndpoint` is set.
- **LLM**: auto-resolved from the model the TUI is currently using (see
  "LLM auto-resolution" below). Only needed explicitly when the current
  provider is not OpenAI-compatible or is missing `baseURL` in its `opencode.json`
  entry.

## Verify your servers without the TUI

```bash
node e2e-check.mjs ["test phrase"]
```

Synthesizes the phrase on your TTS server (plays it through your audio
player), feeds that exact audio to your STT server, and prints the
transcription — a TTS→STT round-trip using the plugin's own code paths.

## Commands

`leader` is `ctrl+x` by default (`leader+s` = `ctrl+x` then `s`).

### Speech-to-text

| Command         | Keybind    | Description                            |
| --------------- | ---------- | -------------------------------------- |
| `/stt-record`   | `ctrl+r`   | Start/stop recording + transcribe      |
| `/stt-submit`   | `leader+r` | Stop recording, transcribe, and submit |
| `/stt-stop`     |            | Cancel recording                       |
| `/stt-model`    |            | Select whisper model                   |
| `/stt-language` |            | Select transcription language          |
| `/stt-mic`      |            | Select microphone                      |

### Text-to-speech

| Command      | Keybind    | Description              |
| ------------ | ---------- | ------------------------ |
| `/tts-speak` | `leader+s` | Read last response aloud |
| `/tts-mode`  | `leader+v` | Toggle auto TTS on/off   |
| `/tts-stop`  | `escape`   | Stop playback            |
| `/tts-voice` |            | Select TTS voice         |

## Configuration

Options live in `~/.config/opencode/voice.json` and/or the `cli.json` plugin
options (object form with `"options"`). The two are **merged, with cli.json
options winning** on conflict. Set `VOICE_CONFIG` to point the config file
elsewhere.

### Worked example (self-hosted faster-whisper + Qwen-TTS)

`~/.config/opencode/voice.json` — the LLM (normalization) is auto-resolved
from the model the TUI is currently using, so no LLM fields are needed here:

```json
{
  "sttEndpoint": "http://10.11.60.146:9000/v1",
  "sttModel": "Systran/faster-whisper-small",
  "sttApiKey": "sk-...",
  "ttsEndpoint": "http://10.11.60.146:8001/v1",
  "ttsModel": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
  "ttsVoice": "Serena",
  "ttsApiKey": "sk-..."
}
```

### Full option reference

| Option                                                                       | Meaning                                                                                                                                            |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`, `model` _(optional)_                                             | LLM normalization — auto-resolved from the current TUI model (see "LLM auto-resolution"); explicit values win                                      |
| `apiKey` / `apiKeyEnv` _(optional)_                                          | LLM key: direct value wins, else the named environment variable; both beat the auto-resolved provider key (omit all for unauthenticated endpoints) |
| `sttEndpoint` _(optional)_                                                   | OpenAI-compatible transcription server base URL (adds `/audio/transcriptions`)                                                                     |
| `sttModel` _(optional)_                                                      | Model name for the STT API (default `whisper-large-v3-turbo`; change at runtime via `/stt-model`)                                                  |
| `sttApiKey` / `sttApiKeyEnv` _(optional)_                                    | STT key: direct value wins, else env var                                                                                                           |
| `ttsEndpoint` _(optional)_                                                   | OpenAI-compatible speech server base URL (adds `/audio/speech`). **Unset = Piper mode**                                                            |
| `ttsModel` _(optional)_                                                      | Model name for the TTS API (required in HTTP mode)                                                                                                 |
| `ttsVoice` _(optional)_                                                      | Default voice name in HTTP mode (default `"default"`); change at runtime via `/tts-voice`                                                          |
| `ttsVoices` _(optional)_                                                     | `/tts-voice` dialog list: `string[]` or `{label, value}[]` (HTTP mode only)                                                                        |
| `ttsApiKey` / `ttsApiKeyEnv` _(optional)_                                    | TTS key: direct value wins, else env var                                                                                                           |
| `ttsResponseFormat` _(optional)_                                             | Request `response_format`; default `mp3`; set to `null` to omit the field if your server rejects it                                                |
| `ttsExtra` _(optional)_                                                      | Extra JSON params merged into the TTS request body (after the standard fields)                                                                     |
| `sttLanguage` _(optional)_                                                   | Spoken language for local whisper (default `auto`)                                                                                                 |
| `trimSilence` _(optional)_                                                   | Trim leading silence from recordings (default `true`)                                                                                              |
| `tmpDir` _(optional)_                                                        | Directory for the STT recording file (default `/tmp`)                                                                                              |
| `maxTokens`, `reasoningEffort`, `chatTemplateKwargs`, `retries` _(optional)_ | LLM client tuning (upstream defaults)                                                                                                              |
| `sttPrompt`, `ttsAutoPrompt`, `ttsManualPrompt` _(optional)_                 | Paths to custom LLM system prompt files (markdown)                                                                                                 |

OpenRouter note: when `sttEndpoint` points at `https://openrouter.ai/api/v1`,
the plugin automatically uses OpenRouter's JSON/base64 transcription request
format instead of multipart upload.

### LLM auto-resolution

For each LLM call (STT normalization or TTS speech conversion) the plugin
reads the model the TUI is currently using (`context.app.model.current()`)
and looks up that provider's OpenAI-compatible options — `baseURL` and
`apiKey`, including the `{env:VAR}` syntax — in
`~/.config/opencode/opencode.json` (falls back to `opencode.jsonc`). The
request then goes to that provider's endpoint with the session's model name,
so switching models in the TUI changes the normalization model automatically.

Explicit values win, per key: an `endpoint`, `model`, `apiKey`, or
`apiKeyEnv` set in `voice.json` or the `cli.json` `options` object overrides
the auto-resolved value for that key. If the current provider is not
OpenAI-compatible (no `baseURL` in its entry), set `endpoint`/`model`
explicitly — otherwise normalization fails, STT falls back to the raw
transcript, and TTS stays silent.

## How it works

**STT:** `sox` records from your microphone → the recording is transcribed by
your STT server (or local `whisper-cli`) → an LLM normalizes the text
(punctuation, filler words, homophones) → an editable review dialog opens
prefilled with the transcript (Enter sends it, Esc cancels), or
`/stt-submit` sends it directly. If normalization fails, the raw
transcription is used so you never lose your input.

**TTS:** when a turn finishes (or on manual trigger), an LLM converts the
response to natural spoken text (narrate / summarize / notify), then:

- **HTTP mode** — the TTS server synthesizes audio (`POST /audio/speech`,
  120 s timeout), it is written to a temp file and played with the first
  available player (`mpv` → `ffplay` → `sox`/`aplay`). Failures surface as a
  warning toast and never interrupt the session.
- **Piper mode** (no `ttsEndpoint`) — upstream behavior: `piper` piped into
  sox `play`.

**Auto TTS** (`/tts-mode`): speaks assistant responses at turn end, permission
requests, and questions — only for the session the TUI is showing.

## Logging

Set `OPENCODE_VOICE_DEBUG=1` and the plugin appends to
`~/.local/state/opencode-voice/debug.log` (routine = `debug`, recoverable =
`warn`, failures = `error`).

## License

This project is licensed under the [MIT License](LICENSE), including the
upstream [`@renjfk/opencode-voice`](https://github.com/renjfk/opencode-voice)
code this fork builds on.
