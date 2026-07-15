import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  isCudaRuntimeError,
  TranscriptionClient,
} from "../scripts/transcription/client.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

function makeClient(options, firstError) {
  const calls = [];
  const children = [];
  const client = new TranscriptionClient(options, {
    stderr: new PassThrough(),
    spawnSync: () => ({ status: 0 }),
    spawn: (_exe, args) => {
      calls.push(args);
      const child = fakeChild();
      children.push(child);
      setImmediate(() => {
        if (children.length === 1) {
          child.stderr.write(`${firstError}\n`);
          child.emit("close", 1);
        } else {
          child.stderr.write("[server] model loaded\n");
        }
      });
      return child;
    },
  });
  return { client, calls };
}

test("CUDA error detection excludes unrelated Python and dependency errors", () => {
  assert.equal(isCudaRuntimeError(new Error("cuDNN library not found")), true);
  assert.equal(isCudaRuntimeError(new Error("float16 is not supported on this GPU")), true);
  assert.equal(isCudaRuntimeError(new Error("Missing faster-whisper")), false);
  assert.equal(isCudaRuntimeError(new Error("Cannot find Python executable")), false);
});

test("default CUDA startup falls back to small on CPU int8", async (t) => {
  const { client, calls } = makeClient({
    model: "medium",
    modelExplicit: false,
    device: "cuda",
    deviceExplicit: false,
    computeType: "float16",
    computeTypeExplicit: false,
  }, "CUDA driver is unavailable");
  t.after(() => client.terminate());

  await client.start();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(-6), ["--model", "small", "--device", "cpu", "--compute-type", "int8"]);
  assert.deepEqual(
    {
      ...client.getRuntimeConfig(),
      fallback_reason: "<reason>",
    },
    {
      model: "small",
      device: "cpu",
      compute_type: "int8",
      fallback_reason: "<reason>",
    },
  );
  assert.match(client.getRuntimeConfig().fallback_reason, /CUDA driver/);
});

test("CPU fallback preserves an explicitly selected model", async (t) => {
  const { client, calls } = makeClient({
    model: "large-v3",
    modelExplicit: true,
    device: "cuda",
    deviceExplicit: false,
    computeType: "float16",
    computeTypeExplicit: false,
  }, "CUDA initialization failed");
  t.after(() => client.terminate());

  await client.start();

  assert.equal(calls[1][calls[1].indexOf("--model") + 1], "large-v3");
  assert.equal(client.getRuntimeConfig().device, "cpu");
});

test("an explicitly selected CUDA device is not silently overridden", async () => {
  const { client, calls } = makeClient({
    model: "medium",
    modelExplicit: false,
    device: "cuda",
    deviceExplicit: true,
    computeType: "float16",
    computeTypeExplicit: false,
  }, "CUDA initialization failed");

  await assert.rejects(client.start(), /CUDA initialization failed/);
  assert.equal(calls.length, 1);
});

test("a CUDA transcription error retries the same audio after CPU fallback", async (t) => {
  const calls = [];
  const client = new TranscriptionClient({
    model: "medium",
    modelExplicit: false,
    device: "cuda",
    deviceExplicit: false,
    computeType: "float16",
    computeTypeExplicit: false,
    language: "zh",
    simplify: true,
    transcribeTimeoutMs: 1_000,
  }, {
    stderr: new PassThrough(),
    spawnSync: () => ({ status: 0 }),
    spawn: (_exe, args) => {
      calls.push(args);
      const child = fakeChild();
      const callNumber = calls.length;
      child.stdin.on("data", (chunk) => {
        const request = JSON.parse(chunk.toString().trim());
        if (request.stop) return;
        setImmediate(() => {
          if (callNumber === 1) {
            child.stdout.write(`${JSON.stringify({ error: "CUDA out of memory" })}\n`);
          } else {
            child.stdout.write(`${JSON.stringify({
              transcript: "完成",
              segments: [],
              meta: { model: "small", device: "cpu", compute_type: "int8" },
            })}\n`);
          }
        });
      });
      setImmediate(() => child.stderr.write("[server] model loaded\n"));
      return child;
    },
  });
  t.after(() => client.terminate());

  await client.start();
  const result = await client.transcribe("audio.wav");

  assert.equal(calls.length, 2);
  assert.equal(result.transcript, "完成");
  assert.equal(result.meta.device, "cpu");
  assert.match(result.meta.fallback_reason, /CUDA out of memory/);
});
