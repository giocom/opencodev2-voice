// TTS engine behind one speak/stop interface.
//
// Two modes, selected by presence of `ttsEndpoint`:
//  - http:  POST {endpoint}/audio/speech (OpenAI-compatible), stream the
//           audio bytes to a temp file and play with mpv/ffplay/sox/aplay.
//  - piper: the upstream pipeline, moved here verbatim (piper -> raw PCM ->
//           sox `play`).
//
// `deps` exists so tests can stub fetch/spawn/fs without touching the
// process; production callers omit it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveApiKey } from "./config.js";

export const TTS_TIMEOUT_MS = 120000;

const PIPER_RATE = 22050;
const PIPER_BITS = 16;
const PIPER_CHANNELS = 1;

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

function extensionFor(format) {
  if (format === "wav") return "wav";
  if (format === "pcm") return "pcm";
  return "mp3";
}

export function createTtsEngine(config, logger, deps = {}, timeoutMs = TTS_TIMEOUT_MS) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const spawnImpl = deps.spawn || spawn;
  const existsSync = deps.existsSync || fs.existsSync;
  const tmpDir = deps.tmpDir || os.tmpdir();
  const writeFile = deps.writeFile || ((p, buf) => fs.promises.writeFile(p, buf));
  const rmFile = deps.rmFile || ((p) => fs.promises.unlink(p).catch(() => {}));
  const toast = config.toast || (() => {});
  const httpMode = Boolean(config.ttsEndpoint);

  let playerProc = null;
  let piperProc = null;
  let playProc = null;

  function onPath(name) {
    const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    return dirs.some((dir) => existsSync(path.join(dir, name)));
  }

  function stop() {
    let wasPlaying = false;
    if (playerProc) {
      try {
        playerProc.kill("SIGKILL");
      } catch {}
      playerProc = null;
      wasPlaying = true;
    }
    if (piperProc) {
      try {
        piperProc.kill("SIGKILL");
      } catch {}
      piperProc = null;
      wasPlaying = true;
    }
    if (playProc) {
      try {
        playProc.kill("SIGKILL");
      } catch {}
      playProc = null;
      wasPlaying = true;
    }
    return wasPlaying;
  }

  async function speakHttp(text) {
    if (!config.ttsModel) {
      logger?.log?.("TTS", "TTS model not configured", "warn");
      toast("TTS model not configured", "warning");
      return;
    }
    const url = stripTrailingSlash(config.ttsEndpoint) + "/audio/speech";
    const body = {
      model: config.ttsModel,
      voice: config.getVoice(),
      input: text,
    };
    const format = config.ttsResponseFormat === undefined ? "mp3" : config.ttsResponseFormat;
    if (format !== null && format !== "") body.response_format = format;
    if (config.ttsExtra) Object.assign(body, config.ttsExtra);
    const headers = { "Content-Type": "application/json" };
    const key = resolveApiKey({ apiKey: config.ttsApiKey, apiKeyEnv: config.ttsApiKeyEnv });
    if (key) headers.Authorization = "Bearer " + key;

    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      logger?.log?.("TTS", `TTS request failed: ${err.message}`, "warn");
      toast("TTS request failed: " + err.message, "warning");
      return;
    }
    if (res.status < 200 || res.status >= 300) {
      logger?.log?.("TTS", `TTS request failed (HTTP ${res.status})`, "warn");
      toast("TTS request failed (HTTP " + res.status + ")", "warning");
      return;
    }

    const ext = extensionFor(body.response_format);
    const file = path.join(tmpDir, "tts-" + Date.now() + "." + ext);
    try {
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      logger?.log?.("TTS", `TTS: failed to save audio: ${err.message}`, "warn");
      toast("TTS: failed to save audio: " + err.message, "warning");
      return;
    }

    const candidates = [];
    candidates.push({ cmd: "mpv", args: ["--really-quiet", "--no-video", file] });
    candidates.push({ cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", file] });
    if (ext === "wav") {
      candidates.push({ cmd: "sox", args: [file, "-"] });
      candidates.push({ cmd: "aplay", args: [file] });
    }
    const player = candidates.find((c) => onPath(c.cmd));
    if (!player) {
      logger?.log?.("TTS", "No audio player found", "warn");
      toast("No audio player found (install mpv or ffmpeg)", "warning");
      await rmFile(file);
      return;
    }

    await new Promise((resolve) => {
      const proc = spawnImpl(player.cmd, player.args, { stdio: "ignore" });
      playerProc = proc;
      proc.on("close", (code) => {
        if (code !== 0 && code !== null) {
          logger?.log?.("TTS", `${player.cmd} exited code=${code}`, "warn");
        } else {
          logger?.log?.("TTS", "playback finished", "debug");
        }
        if (playerProc === proc) playerProc = null;
        void rmFile(file);
        resolve();
      });
      proc.on("error", (err) => {
        logger?.log?.("TTS", `${player.cmd} error: ${err.message}`, "error");
        if (playerProc === proc) playerProc = null;
        void rmFile(file);
        resolve();
      });
    });
  }

  async function speakPiper(text) {
    const line = text.replace(/\n/g, " ").trim();
    if (!line) return;

    if (!onPath("piper")) {
      logger?.log?.("TTS", "Piper binary not found on PATH", "warn");
      toast("Piper binary not found on PATH", "warning");
      return;
    }
    const voiceModel = config.getVoice();
    if (!existsSync(voiceModel)) {
      logger?.log?.("TTS", `Voice model not found: ${voiceModel}`, "warn");
      toast("Voice model not found: " + voiceModel, "warning");
      return;
    }

    logger?.log?.("TTS", `Speak requested chars=${line.length} voice=${voiceModel}`, "debug");

    await new Promise((resolve) => {
      let piperStderr = "";
      let playStderr = "";
      playProc = spawnImpl(
        "play",
        [
          "-t",
          "raw",
          "-r",
          String(PIPER_RATE),
          "-e",
          "signed",
          "-b",
          String(PIPER_BITS),
          "-c",
          String(PIPER_CHANNELS),
          "-q",
          "-",
        ],
        { stdio: ["pipe", "ignore", "pipe"] },
      );

      piperProc = spawnImpl("piper", ["-m", voiceModel, "--output_raw"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      piperProc.stderr.on("data", (chunk) => {
        piperStderr += chunk.toString();
      });
      playProc.stderr.on("data", (chunk) => {
        playStderr += chunk.toString();
      });

      piperProc.stdout.on("data", (chunk) => {
        if (playProc?.stdin && !playProc.stdin.destroyed) {
          playProc.stdin.write(chunk);
        }
      });

      piperProc.on("close", (code) => {
        if (code !== 0 && code !== null) {
          logger?.log?.("TTS", `piper exited code=${code} stderr=${piperStderr.trim()}`, "error");
        }
        if (playProc?.stdin && !playProc.stdin.destroyed) {
          playProc.stdin.end();
        }
      });

      playProc.on("close", (code) => {
        if (code !== 0 && code !== null) {
          logger?.log?.("TTS", `play exited code=${code} stderr=${playStderr.trim()}`, "error");
        } else {
          logger?.log?.("TTS", "playback finished", "debug");
        }
        piperProc = null;
        playProc = null;
        resolve();
      });

      piperProc.on("error", (err) => {
        logger?.log?.("TTS", `piper error: ${err.message}`, "error");
        stop();
        resolve();
      });
      playProc.on("error", (err) => {
        logger?.log?.("TTS", `play error: ${err.message}`, "error");
        stop();
        resolve();
      });

      if (piperProc?.stdin && !piperProc.stdin.destroyed) {
        piperProc.stdin.write(line + "\n");
        piperProc.stdin.end();
      }
    });
  }

  function speak(text) {
    if (!text) return Promise.resolve();
    stop();
    if (httpMode) return speakHttp(text);
    return speakPiper(text);
  }

  return { speak, stop };
}
