import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_STOP_GRACE_MS = 3_000;

function getScriptsDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Owns the long-lived Python Whisper server and its line-oriented request queue.
 * Other children (notably ffmpeg) remain owned by the media/pipeline modules.
 */
export class TranscriptionClient {
  constructor(options, dependencies = {}) {
    this.options = options;
    this.activeChildren = dependencies.activeChildren ?? null;
    this.stderr = dependencies.stderr ?? process.stderr;
    this.spawn = dependencies.spawn ?? spawn;
    this.spawnSync = dependencies.spawnSync ?? spawnSync;
    this.process = null;
    this.ready = false;
    this.readyPromise = null;
    this.pending = [];
    this.responseBuffer = "";
  }

  isRunning() {
    return this.process !== null;
  }

  async start() {
    if (this.ready && this.process) return;
    if (this.readyPromise && this.process) return this.readyPromise;

    const scriptsDir = getScriptsDir();
    const serverPath = path.join(scriptsDir, "transcribe_server.py");
    const candidates = process.platform === "win32"
      ? ["python", "py"]
      : ["python3", "python"];

    let proc = null;
    let lastErr = null;
    for (const pyExe of candidates) {
      const probe = this.spawnSync(pyExe, ["--version"], { stdio: "ignore" });
      if (probe.error || probe.status !== 0) {
        lastErr = probe.error ?? new Error(`${pyExe} --version exited ${probe.status}`);
        continue;
      }
      proc = this.spawn(pyExe, [
        serverPath,
        "--model", this.options.model,
        "--device", this.options.device,
        "--compute-type", this.options.computeType,
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: scriptsDir,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      this.activeChildren?.add(proc);
      proc.once("close", () => this.activeChildren?.delete(proc));
      break;
    }
    if (!proc) {
      throw new Error(`Cannot find Python executable (tried: ${candidates.join(", ")}): ${lastErr?.message}`);
    }

    this.process = proc;
    this.ready = false;
    this.responseBuffer = "";
    this.readyPromise = new Promise((resolve, reject) => {
      proc.stderr.on("data", (chunk) => {
        const msg = chunk.toString();
        this.stderr.write(msg);
        if (proc === this.process && !this.ready && msg.includes("[server] model loaded")) {
          this.ready = true;
          resolve();
        }
      });
      proc.once("error", (err) => {
        if (proc === this.process && !this.ready) {
          reject(new Error(`transcribe_server spawn error: ${err.message}`));
        }
      });
      proc.once("close", (code) => {
        if (proc !== this.process) return;
        const wasReady = this.ready;
        this.process = null;
        this.ready = false;
        this.readyPromise = null;
        const err = new Error(`transcribe_server exited (code ${code})`);
        if (!wasReady) reject(err);
        this.#resolvePendingWithError(err.message);
      });
    });

    proc.stdout.on("data", (chunk) => {
      if (proc !== this.process) return;
      this.responseBuffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = this.responseBuffer.indexOf("\n")) !== -1) {
        const line = this.responseBuffer.slice(0, newlineIndex).trim();
        this.responseBuffer = this.responseBuffer.slice(newlineIndex + 1);
        if (!line || this.pending.length === 0) continue;
        const resolver = this.pending.shift();
        try {
          resolver(JSON.parse(line));
        } catch {
          resolver({ error: `parse error: ${line.slice(0, 200)}` });
        }
      }
    });
    proc.stdin.on("error", () => {});

    return this.readyPromise;
  }

  async restart(reason = "transcribe server restarting") {
    this.close(reason);
    return this.start();
  }

  transcribe(wavPath, overrides = {}) {
    if (!this.process) throw new Error("transcribe server not running");

    const options = { ...this.options, ...overrides };
    const request = {
      wav_path: wavPath,
      model: options.model,
      language: options.language,
      device: options.device,
      compute_type: options.computeType,
      no_simplify: !options.simplify,
    };

    return new Promise((resolve, reject) => {
      const resolver = (result) => {
        clearTimeout(timer);
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      };
      const timer = setTimeout(() => {
        this.#removePending(resolver);
        this.close("Transcription timeout");
        reject(new Error("Transcription timeout"));
      }, options.transcribeTimeoutMs);

      this.pending.push(resolver);
      try {
        this.process.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.#removePending(resolver);
        reject(new Error(`write to server failed: ${err.message}`));
      }
    });
  }

  close(reason = "transcribe server stopped") {
    if (!this.process) return;
    const proc = this.process;
    this.#resolvePendingWithError(reason);
    this.responseBuffer = "";
    try {
      proc.stdin.write(`${JSON.stringify({ stop: true })}\n`);
      proc.stdin.end();
    } catch {}
    const stopTimer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }, DEFAULT_STOP_GRACE_MS);
    stopTimer.unref?.();
    this.process = null;
    this.ready = false;
    this.readyPromise = null;
  }

  terminate(reason = "transcribe server terminated") {
    if (!this.process) return;
    const proc = this.process;
    this.#resolvePendingWithError(reason);
    this.responseBuffer = "";
    try {
      proc.kill("SIGTERM");
    } catch {}
    this.process = null;
    this.ready = false;
    this.readyPromise = null;
  }

  #removePending(resolver) {
    const index = this.pending.indexOf(resolver);
    if (index !== -1) this.pending.splice(index, 1);
  }

  #resolvePendingWithError(reason) {
    while (this.pending.length) this.pending.shift()({ error: reason });
  }
}
