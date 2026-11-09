// Text-to-speech: LLM normalization, synthesis via the TTS engine
// (OpenAI-compatible HTTP or Piper), playback via mpv/ffplay/sox/aplay.

import path from "node:path";
import os from "node:os";
import { createTtsEngine } from "./tts-engine.js";
import { getSessionTitle } from "./session.js";

const VOICES_DIR = path.join(os.homedir(), ".local", "share", "piper-voices");

const TTS_VOICES = {
  ryan: { label: "Ryan (high)", file: "en_US-ryan-high.onnx" },
  bryce: { label: "Bryce (medium)", file: "en_US-bryce-medium.onnx" },
};
const DEFAULT_TTS_VOICE = "ryan";

// ---- System prompts ----

const SYSTEM_AUTO = `You are a text-to-speech narrator for a coding assistant CLI. Your job is to convert the assistant's markdown output into natural spoken text that is useful and pleasant to listen to.

You have three modes depending on the content complexity:

1. NARRATE - For simple explanations, short answers, and conversational responses. Convert to natural spoken text, normalizing code references for speech.
   - camelCase/PascalCase identifiers: split into words (parseConfig -> "parse config")
   - File paths: use just the filename (src/utils/helpers.ts -> "helpers dot ts")
   - Short code snippets in backticks: read them naturally
   - Keep the narrative flow intact

2. SUMMARIZE - For responses with significant code blocks, multiple file changes, or complex technical details. Provide a brief spoken summary of what was done and tell the user to check the screen.
   - Mention what was changed and why
   - Do not try to describe code blocks verbatim
   - End with something like "check the details on your screen" or "take a look at the output for the specifics"

3. NOTIFY - For very short confirmations, status updates, or acknowledgments. Keep it to one brief sentence.

Choose the appropriate mode based on the content. Most responses with code blocks should use SUMMARIZE mode. Simple Q&A or short explanations use NARRATE. Build results, "done", confirmations use NOTIFY.

Output ONLY the spoken text. Nothing else. No mode labels. No commentary.`;

const SYSTEM_MANUAL = `You are a text-to-speech reader for a coding assistant. The user has explicitly requested this text be read aloud. Read the prose content faithfully and in detail.

Rules:
- Read all prose text naturally and completely
- Code identifiers: split camelCase/PascalCase/snake_case into words (parseConfig -> "parse config", my_variable -> "my variable")
- File paths: read just the filename with extension (src/utils/helpers.ts -> "helpers dot ts")
- Line references: keep as is ("line 42")
- URLs: say "a link" or just the domain name
- Code blocks: skip entirely, just say "code block" or "code snippet"
- Error codes: expand naturally (ECONNREFUSED -> "connection refused")
- Shell commands: read them naturally (npm test -> "npm test")
- List items: read each item
- Remove markdown formatting but preserve all the informational content
- Do NOT summarize. Do NOT say "check the screen". Read everything that is prose.
- Output ONLY the spoken text`;

// ---- Session helpers ----

async function getTurnAssistantText(api) {
  const route = api.route.current;
  if (route.name !== "session") return null;

  const sessionID = route.params.sessionID;
  const messages = api.state.session.messages(sessionID);
  if (!messages || messages.length === 0) return null;

  // Collect the assistant messages of the current turn (since the last user
  // message). V2 messages carry their full projected content.
  const assistant = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "user") break;
    if (messages[i].type === "assistant") assistant.unshift(messages[i]);
  }
  if (assistant.length === 0) return null;

  const allText = [];
  for (const message of assistant) {
    const text = (message.content || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("\n\n")
      .trim();
    if (text) allText.push(text);
  }

  if (allText.length === 0) return null;

  return {
    lastMessageID: assistant[assistant.length - 1].id,
    text: allText.join("\n\n"),
  };
}

// ---- Voice resolution ----

// http mode: kv("tts.voice") → ttsVoice option → "default" (voice names as-is);
// piper mode: kv key → onnx path under VOICES_DIR (ryan default).
export function resolveVoice(config, kv) {
  if (config.ttsEndpoint) {
    return kv.get("tts.voice") || config.ttsVoice || "default";
  }
  const key = kv.get("tts.voice", DEFAULT_TTS_VOICE);
  const entry = TTS_VOICES[key] || TTS_VOICES[DEFAULT_TTS_VOICE];
  return path.join(VOICES_DIR, entry.file);
}

// Options for the /tts-voice dialog: http mode lists ttsVoices (strings or
// {label,value}) or the single ttsVoice; piper mode lists the Piper table.
export function ttsVoicesFor(config) {
  if (!config.ttsEndpoint) {
    return Object.entries(TTS_VOICES).map(([value, { label }]) => ({ label, value }));
  }
  const voices = Array.isArray(config.ttsVoices) ? config.ttsVoices : [];
  if (voices.length > 0) {
    return voices.map((v) => (typeof v === "string" ? { label: v, value: v } : v));
  }
  return config.ttsVoice ? [{ label: config.ttsVoice, value: config.ttsVoice }] : [];
}

// ---- Public API for TUI plugin ----

export function registerTTS(api, kv, complete, prompts, logger, config = {}, engine = null) {
  const client = api.client;
  const systemAuto = prompts?.ttsAuto || SYSTEM_AUTO;
  const systemManual = prompts?.ttsManual || SYSTEM_MANUAL;

  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  // The engine owns synthesis + playback; when index.js does not build one,
  // build a self-contained one so this module stays testable on its own.
  const activeEngine =
    engine ??
    createTtsEngine(
      {
        ...config,
        getVoice: () => resolveVoice(config, kv),
        toast: (message, variant) => toast(message, variant),
      },
      logger,
    );

  async function normalizeForSpeech(text, systemPrompt) {
    logger?.log?.("TTS", `Normalizing speech chars=${text.length}`, "debug");
    return complete({
      system: systemPrompt,
      prompt: `Convert for text-to-speech:\n\n${text}`,
      config: { maxTokens: 4096 },
    });
  }

  // ---- Audio pipeline (delegated to the TTS engine) ----

  function speak(text) {
    return activeEngine.speak(text);
  }

  // ---- Session-prefixed announcements ----

  async function speakWithSessionPrefix(sessionID, message, suffix) {
    const sessionTitle = await getSessionTitle(client, sessionID);
    const parts = [];
    if (sessionTitle) parts.push(`Session: ${sessionTitle}.`);
    parts.push(message);
    if (suffix) parts.push(suffix);
    await speak(parts.join(" "));
  }

  function stopSpeech() {
    return activeEngine.stop();
  }

  // ---- Auto mode ----

  // V2 never emits the V1 `session.status`/`session.idle` pair; the live
  // signals are `session.execution.started` and
  // `session.execution.succeeded`/`interrupted`/`failed`. Busy state is
  // tracked per session, and only the session this TUI is currently showing
  // is ever spoken: on the shared server every instance receives every
  // event, and without the gate each TUI would speak every completion,
  // permission, and question.
  let lastSpokenMessageID = null;
  const busySessions = new Set();

  function showingSession(sessionID) {
    const route = api.route.current;
    // Not looking at a session: keep V1's fall-through so single-window
    // setups still hear attention events from anywhere.
    if (route.name !== "session") return true;
    return route.params.sessionID === sessionID;
  }

  // Permission prompts and forms from subagent sessions are displayed under
  // their parent in the session view, so they must announce while the parent
  // (or any ancestor) is shown, not only when the subagent itself is open.
  function showingSessionFamily(sessionID) {
    const route = api.route.current;
    if (route.name !== "session") return true;
    if (!sessionID) return false;
    if (route.params.sessionID === sessionID) return true;
    const root = api.state.session.root;
    if (!root) return false;
    return root(sessionID) === root(route.params.sessionID);
  }

  async function speakTurnCompletion(sessionID) {
    if (kv.get("tts.mode", "off") !== "on") return;
    if (!busySessions.delete(sessionID)) return;
    if (!showingSession(sessionID)) return;

    const result = await getTurnAssistantText(api);
    if (!result || !result.text) return;

    if (result.lastMessageID === lastSpokenMessageID) return;
    lastSpokenMessageID = result.lastMessageID;

    toast("Normalizing response...");
    const llmResult = await normalizeForSpeech(result.text, systemAuto);
    if (!llmResult.text) {
      logger?.log?.("TTS", `Auto normalization failed: ${llmResult.error}`, "warn");
      toast(`TTS normalization failed: ${llmResult.error}`, "warning");
      return;
    }

    logger?.log?.("TTS", `Auto normalization succeeded chars=${llmResult.text.length}`, "debug");
    await speakWithSessionPrefix(sessionID, llmResult.text, "Ready for your input.");
  }

  api.event.on("session.execution.started", (event) => {
    const sessionID = event.properties?.sessionID;
    if (sessionID) busySessions.add(sessionID);
  });

  api.event.on("session.execution.succeeded", (event) => {
    void speakTurnCompletion(event.properties?.sessionID);
  });

  api.event.on("session.execution.interrupted", (event) => {
    void speakTurnCompletion(event.properties?.sessionID);
  });

  api.event.on("session.execution.failed", (event) => {
    // A failed execution ends the busy cycle without an announcement.
    busySessions.delete(event.properties?.sessionID);
  });

  api.event.on("permission.asked", async (event) => {
    if (kv.get("tts.mode", "off") !== "on") return;
    if (!showingSessionFamily(event.properties?.sessionID)) return;
    await speakWithSessionPrefix(
      event.properties?.sessionID,
      "Permission requested. Please check your screen.",
    );
  });

  api.event.on("question.asked", async (event) => {
    if (kv.get("tts.mode", "off") !== "on") return;
    if (!showingSessionFamily(event.properties?.sessionID)) return;
    await speakWithSessionPrefix(
      event.properties?.sessionID,
      "A question needs your answer. Please check your screen.",
    );
  });

  // ---- Manual mode ----

  async function speakLastResponse() {
    const result = await getTurnAssistantText(api);
    if (!result || !result.text) {
      toast("No assistant response to speak", "warning");
      return;
    }

    toast("Normalizing response...");
    const llmResult = await normalizeForSpeech(result.text, systemManual);
    if (!llmResult.text) {
      logger?.log?.("TTS", `Manual normalization failed: ${llmResult.error}`, "warn");
      toast(`TTS normalization failed: ${llmResult.error}`, "warning");
      return;
    }

    logger?.log?.("TTS", `Manual normalization succeeded chars=${llmResult.text.length}`, "debug");
    toast("Speaking last response");
    await speak(llmResult.text);
  }

  // ---- Commands ----

  return [
    {
      title: "TTS: speak last response",
      value: "tts.speak-last",
      description: "Read the last assistant response aloud (detailed)",
      keybind: "<leader>s",
      slash: { name: "tts-speak" },
      onSelect() {
        speakLastResponse();
      },
    },
    {
      title: "TTS: toggle",
      value: "tts.mode",
      description: "Toggle auto text-to-speech on/off",
      keybind: "<leader>v",
      slash: { name: "tts-mode" },
      onSelect() {
        const current = kv.get("tts.mode", "off");
        const next = current === "on" ? "off" : "on";
        kv.set("tts.mode", next);
        if (next === "off") stopSpeech();
        const voiceValue =
          kv.get("tts.voice") ||
          (config.ttsEndpoint ? config.ttsVoice || "default" : DEFAULT_TTS_VOICE);
        const label = ttsVoicesFor(config).find((v) => v.value === voiceValue)?.label ?? voiceValue;
        toast(next === "on" ? `TTS on (${label})` : "TTS off");
      },
    },
    {
      title: "TTS: stop playback",
      value: "tts.stop",
      description: "Stop current TTS playback",
      keybind: "escape",
      slash: { name: "tts-stop" },
      onSelect() {
        // Returning false when nothing is playing lets Escape fall through to
        // the next handler (session interrupt) instead of being swallowed by
        // a global layer that owns the key at all times.
        if (!stopSpeech()) return false;
        toast("TTS stopped");
      },
    },
    {
      title: "TTS: select voice",
      value: "tts.voice",
      description: "Choose TTS voice",
      slash: { name: "tts-voice" },
      onSelect() {
        const current =
          kv.get("tts.voice") ||
          (config.ttsEndpoint ? config.ttsVoice || "default" : DEFAULT_TTS_VOICE);
        const voices = ttsVoicesFor(config);
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select voice",
            current,
            options: voices.map((v) => ({
              title: v.label,
              value: v.value,
              onSelect() {
                kv.set("tts.voice", v.value);
                toast(`Voice: ${v.label}`);
                api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
  ];
}
