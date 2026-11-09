import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { TTS_TIMEOUT_MS, createTtsEngine } from "../lib/tts-engine.js";

const logger = { log: () => {} };

function makeProc() {
  const emitter = new EventEmitter();
  const stdin = {
    written: "",
    ended: false,
    destroyed: false,
    write(chunk) {
      this.written += String(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
  };
  Object.assign(emitter, {
    stdin,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
  });
  emitter.kill = function () {
    this.killed = true;
    return true;
  };
  return emitter;
}

function jsonAudioResponse(bytes, status = 200) {
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => bytes };
}

function makeDeps({ exist = [], fetchImpl } = {}) {
  const calls = { fetch: [], spawn: [], write: [], rm: [], toasts: [] };
  const procs = [];
  const deps = {
    fetch: (url, options) => {
      calls.fetch.push([url, options]);
      if (fetchImpl) return fetchImpl(url, options);
      return Promise.resolve(jsonAudioResponse(Buffer.from("ID3data")));
    },
    spawn: (cmd, args, opts) => {
      const proc = makeProc();
      calls.spawn.push([cmd, args, opts]);
      procs.push(proc);
      return proc;
    },
    existsSync: (p) => exist.some((e) => p === e || p.endsWith("/" + e)),
    tmpDir: "/tmp/tts-test",
    writeFile: (p, buf) => {
      calls.write.push([p, buf]);
      return Promise.resolve();
    },
    rmFile: (p) => {
      calls.rm.push(p);
      return Promise.resolve();
    },
  };
  return { deps, calls, procs };
}

function withToast(config, calls) {
  return { ...config, toast: (message, variant) => calls.toasts.push([message, variant]) };
}

const baseConfig = {
  ttsEndpoint: "http://tts.test/v1/",
  ttsModel: "Qwen/Qwen-TTS-12Hz-0.6B-Base",
  getVoice: () => "Serena",
};

function drain() {
  return new Promise((r) => setImmediate(r));
}

test("sends POST to /audio/speech with model, voice, input, response_format", async () => {
  const { deps, calls, procs } = makeDeps({ exist: ["mpv"] });
  const engine = createTtsEngine(
    withToast({ ...baseConfig, ttsExtra: { speed: 1.2 } }, calls),
    logger,
    deps,
  );
  const p = engine.speak("hello world");
  await drain();
  const [url, options] = calls.fetch[0];
  assert.equal(url, "http://tts.test/v1/audio/speech");
  assert.equal(options.method, "POST");
  assert.match(options.headers["Content-Type"], /application\/json/);
  assert.deepEqual(JSON.parse(options.body), {
    model: "Qwen/Qwen-TTS-12Hz-0.6B-Base",
    voice: "Serena",
    input: "hello world",
    response_format: "mp3",
    speed: 1.2,
  });
  procs[0].emit("close");
  await p;
});

test("omits response_format when ttsResponseFormat is null", async () => {
  const { deps, calls, procs } = makeDeps({ exist: ["mpv"] });
  const engine = createTtsEngine(
    withToast({ ...baseConfig, ttsResponseFormat: null }, calls),
    logger,
    deps,
  );
  const p = engine.speak("hello");
  await drain();
  const body = JSON.parse(calls.fetch[0][1].body);
  assert.equal("response_format" in body, false);
  procs[0].emit("close");
  await p;
});

test("sends Authorization from ttsApiKey; direct beats env", async () => {
  const { deps: deps1, calls: calls1, procs: procs1 } = makeDeps({ exist: ["mpv"] });
  process.env.VOICE_TTS_KEY = "env";
  try {
    const e1 = createTtsEngine(
      withToast({ ...baseConfig, ttsApiKey: "direct" }, calls1),
      logger,
      deps1,
    );
    const p1 = e1.speak("one");
    await drain();
    assert.equal(calls1.fetch[0][1].headers.Authorization, "Bearer direct");
    procs1[0].emit("close");
    await p1;

    const { deps: deps2, calls: calls2, procs: procs2 } = makeDeps({ exist: ["mpv"] });
    const e2 = createTtsEngine(
      withToast({ ...baseConfig, ttsApiKeyEnv: "VOICE_TTS_KEY" }, calls2),
      logger,
      deps2,
    );
    const p2 = e2.speak("two");
    await drain();
    assert.equal(calls2.fetch[0][1].headers.Authorization, "Bearer env");
    procs2[0].emit("close");
    await p2;
  } finally {
    delete process.env.VOICE_TTS_KEY;
  }
});

test("non-2xx toasts with status and does not spawn", async () => {
  const { deps, calls } = makeDeps({
    fetchImpl: () => Promise.resolve(jsonAudioResponse(Buffer.from("nope"), 422)),
  });
  const engine = createTtsEngine(withToast(baseConfig, calls), logger, deps);
  await engine.speak("hello");
  assert.ok(
    calls.toasts.some(([m, v]) => m === "TTS request failed (HTTP 422)" && v === "warning"),
  );
  assert.equal(calls.spawn.length, 0);
});

test("network error toasts without throwing", async () => {
  const { deps, calls } = makeDeps({ fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")) });
  const engine = createTtsEngine(withToast(baseConfig, calls), logger, deps);
  await engine.speak("x");
  assert.ok(
    calls.toasts.some(([m, v]) => m === "TTS request failed: ECONNREFUSED" && v === "warning"),
  );
});

test("aborts after the configured timeout", async () => {
  assert.equal(TTS_TIMEOUT_MS, 120000);
  const hang = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const { deps, calls } = makeDeps({ fetchImpl: hang });
  const engine = createTtsEngine(withToast(baseConfig, calls), logger, deps, 50);
  const p = engine.speak("x");
  // AbortSignal.timeout uses an unref'd timer; a ref'd timer keeps the event
  // loop alive past the 50ms abort in this isolated test process.
  await new Promise((r) => setTimeout(r, 200));
  await p;
  assert.ok(calls.toasts.some(([m, v]) => m === "TTS request failed: aborted" && v === "warning"));
});

test("writes audio to temp file and plays with mpv, removing the file on close", async () => {
  const { deps, calls, procs } = makeDeps({ exist: ["mpv"] });
  const engine = createTtsEngine(withToast(baseConfig, calls), logger, deps);
  const p = engine.speak("hello world");
  await drain();
  const [file, bytes] = calls.write[0];
  assert.ok(file.startsWith("/tmp/tts-test/tts-"));
  assert.ok(file.endsWith(".mp3"));
  assert.equal(bytes.toString(), "ID3data");
  assert.deepEqual(calls.spawn[0], [
    "mpv",
    ["--really-quiet", "--no-video", file],
    { stdio: "ignore" },
  ]);
  procs[0].emit("close");
  assert.deepEqual(calls.rm, [file]);
  await p;
});

test("falls back ffplay -> sox(wav) -> aplay; toasts when none available", async () => {
  // ffplay only
  {
    const { deps, calls, procs } = makeDeps({ exist: ["ffplay"] });
    const engine = createTtsEngine(withToast(baseConfig, calls), logger, deps);
    const p = engine.speak("one");
    await drain();
    const [file] = calls.write[0];
    assert.deepEqual(calls.spawn[0], [
      "ffplay",
      ["-nodisp", "-autoexit", "-loglevel", "quiet", file],
      { stdio: "ignore" },
    ]);
    procs[0].emit("close");
    await p;
  }
  // sox only, wav response
  {
    const { deps, calls, procs } = makeDeps({ exist: ["sox"] });
    const engine = createTtsEngine(
      withToast({ ...baseConfig, ttsResponseFormat: "wav" }, calls),
      logger,
      deps,
    );
    const p = engine.speak("two");
    await drain();
    const [file] = calls.write[0];
    assert.ok(file.endsWith(".wav"));
    assert.deepEqual(calls.spawn[0], ["sox", [file, "-"], { stdio: "ignore" }]);
    procs[0].emit("close");
    await p;
  }
  // nothing available
  {
    const { deps, calls } = makeDeps();
    const engine = createTtsEngine(withToast(baseConfig, calls), logger, deps);
    await engine.speak("three");
    assert.ok(
      calls.toasts.some(
        ([m, v]) => m === "No audio player found (install mpv or ffmpeg)" && v === "warning",
      ),
    );
    assert.equal(calls.spawn.length, 0);
  }
});

test("stop() kills a playing player and reports state", async () => {
  const { deps, calls, procs } = makeDeps({ exist: ["mpv"] });
  const engine = createTtsEngine(withToast(baseConfig, calls), logger, deps);
  const p = engine.speak("hello");
  await drain();
  assert.equal(engine.stop(), true);
  assert.equal(procs[0].killed, true);
  assert.equal(engine.stop(), false);
  procs[0].emit("close");
  await p;
});

test("piper mode: spawns piper + play, pipes raw audio", async () => {
  const voice = "/voices/en.onnx";
  const { deps, calls, procs } = makeDeps({ exist: [voice, "piper"] });
  const engine = createTtsEngine(withToast({ getVoice: () => voice }, calls), logger, deps);
  const p = engine.speak("hello world");
  await drain();
  assert.deepEqual(calls.spawn[0], [
    "play",
    ["-t", "raw", "-r", "22050", "-e", "signed", "-b", "16", "-c", "1", "-q", "-"],
    { stdio: ["pipe", "ignore", "pipe"] },
  ]);
  assert.deepEqual(calls.spawn[1], [
    "piper",
    ["-m", voice, "--output_raw"],
    { stdio: ["pipe", "pipe", "pipe"] },
  ]);
  const [playProc, piperProc] = procs;
  assert.equal(piperProc.stdin.written, "hello world\n");
  assert.equal(piperProc.stdin.ended, true);
  piperProc.stdout.emit("data", Buffer.from("rawaudio"));
  assert.equal(playProc.stdin.written, "rawaudio");
  piperProc.emit("close", 0);
  assert.equal(playProc.stdin.ended, true);
  playProc.emit("close", 0);
  await p;
});

test("piper mode: missing binary or model toasts and does not spawn", async () => {
  const voice = "/voices/x.onnx";
  {
    const { deps, calls } = makeDeps({ exist: [voice] });
    const engine = createTtsEngine(withToast({ getVoice: () => voice }, calls), logger, deps);
    await engine.speak("hello");
    assert.ok(
      calls.toasts.some(([m, v]) => m === "Piper binary not found on PATH" && v === "warning"),
    );
    assert.equal(calls.spawn.length, 0);
  }
  {
    const { deps, calls } = makeDeps({ exist: ["piper"] });
    const engine = createTtsEngine(withToast({ getVoice: () => voice }, calls), logger, deps);
    await engine.speak("hello");
    assert.ok(
      calls.toasts.some(([m, v]) => m === "Voice model not found: " + voice && v === "warning"),
    );
    assert.equal(calls.spawn.length, 0);
  }
});

test("http mode: missing ttsModel toasts and does not fetch", async () => {
  const { deps, calls } = makeDeps({ exist: ["mpv"] });
  const noModel = { ...baseConfig };
  delete noModel.ttsModel;
  const engine = createTtsEngine(withToast(noModel, calls), logger, deps);
  await engine.speak("hello");
  assert.equal(calls.fetch.length, 0);
  assert.ok(calls.toasts.some(([m, v]) => m === "TTS model not configured" && v === "warning"));
});

test("a new speak stops the previously playing audio", async () => {
  const { deps, calls, procs } = makeDeps({ exist: ["mpv"] });
  const engine = createTtsEngine(withToast({ ...baseConfig }, calls), logger, deps);
  const p1 = engine.speak("first");
  await drain();
  const p2 = engine.speak("second");
  await drain();
  assert.equal(procs[0].killed, true, "first player must be killed before the second starts");
  assert.equal(procs.length, 2);
  procs[0].emit("close");
  procs[1].emit("close");
  await p1;
  await p2;
});

test("200 with body-read failure toasts and does not throw", async () => {
  const { deps, calls } = makeDeps({
    exist: ["mpv"],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        throw new Error("socket closed");
      },
    }),
  });
  const engine = createTtsEngine(withToast({ ...baseConfig }, calls), logger, deps);
  await engine.speak("hello");
  assert.equal(calls.write.length, 0);
  assert.equal(calls.spawn.length, 0);
  assert.ok(
    calls.toasts.some(([m, v]) => m.startsWith("TTS: failed to save audio") && v === "warning"),
  );
});
