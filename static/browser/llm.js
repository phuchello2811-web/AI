// Open-source models running in the browser on the visitor's GPU (WebGPU) via WebLLM. Weights are
// downloaded once from Hugging Face and cached by the browser; nothing is sent to any server.

import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.85";

export const MODELS = [
  { name: "Qwen3.5-4B", label: "Qwen3.5 4B · cân bằng", size: "~3.9 GB", thinking: true },
  { name: "Qwen3.5-9B", label: "Qwen3.5 9B · mạnh nhất", size: "~6.4 GB", thinking: true },
  { name: "Qwen2.5-Coder-7B-Instruct", label: "Qwen2.5 Coder 7B · chuyên code", size: "~5.1 GB", thinking: false },
  { name: "Qwen3.5-2B", label: "Qwen3.5 2B · máy yếu", size: "~2.2 GB", thinking: true },
  { name: "Qwen2.5-Coder-1.5B-Instruct", label: "Qwen2.5 Coder 1.5B · rất nhẹ", size: "~1.6 GB", thinking: false },
];
export const CONTEXT_TOKENS = 8192;

let gpu = null;     // { f16: bool } once probed, false if WebGPU is unavailable
let engine = null;
let loadedId = null;

export async function probeGPU() {
  if (gpu !== null) return gpu;
  try {
    const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
    gpu = adapter ? { f16: adapter.features.has("shader-f16") } : false;
  } catch {
    gpu = false;
  }
  return gpu;
}

function modelId(name) {
  return `${name}-${gpu && gpu.f16 ? "q4f16_1" : "q4f32_1"}-MLC`;
}

export async function isCached(name) {
  try { return await webllm.hasModelInCache(modelId(name)); } catch { return false; }
}

/** Load (or switch to) a model; `onProgress(text, fraction)` reports the download. */
export async function load(name, onProgress) {
  await probeGPU();
  if (!gpu) throw new Error("Trình duyệt này chưa hỗ trợ WebGPU. Hãy dùng Chrome hoặc Edge bản mới trên máy tính.");
  const id = modelId(name);
  if (engine && loadedId === id) return;
  const initProgressCallback = (r) => onProgress && onProgress(r.text, r.progress);
  const chatOpts = { context_window_size: CONTEXT_TOKENS };
  if (!engine) {
    const worker = new Worker(new URL("./llm-worker.js", import.meta.url), { type: "module" });
    engine = await webllm.CreateWebWorkerMLCEngine(worker, id, { initProgressCallback }, chatOpts);
  } else {
    engine.setInitProgressCallback(initProgressCallback);
    await engine.reload(id, chatOpts);
  }
  loadedId = id;
}

export function stop() {
  if (engine) engine.interruptGenerate();
}

/**
 * Stream one completion. Yields {thinking}, {text} and finally {usage}; Qwen's <think>...</think>
 * block arrives inside the content and is split out here.
 */
export async function* chat(messages, { temperature = 0.6, think = false, schema = null, maxTokens = 0, signal } = {}) {
  const request = { messages, stream: true, stream_options: { include_usage: true }, temperature };
  if (maxTokens) request.max_tokens = maxTokens;
  // Quantized Qwen models can fall into endless repetition; Qwen recommends a presence penalty.
  if (!schema) request.presence_penalty = 0.5;
  request.extra_body = { enable_thinking: !!think && !schema };
  if (schema) request.response_format = { type: "json_object", schema: JSON.stringify(schema) };
  const onAbort = () => stop();
  signal && signal.addEventListener("abort", onAbort);
  let buf = "", inThink = false, started = false;
  // Leading blank lines of each part are dropped, so an empty <think></think> block shows nothing.
  const emit = (out) => {
    if (!started) out = out.replace(/^\s+/, "");
    if (!out) return null;
    started = true;
    return inThink ? { thinking: out } : { text: out };
  };
  try {
    for await (const chunk of await engine.chat.completions.create(request)) {
      const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
      if (delta) {
        buf += delta;
        // Emit everything except a possibly incomplete tag at the end of the buffer.
        while (buf) {
          const tag = inThink ? "</think>" : "<think>";
          const at = buf.indexOf(tag);
          if (at >= 0) {
            const part = emit(buf.slice(0, at));
            if (part) yield part;
            buf = buf.slice(at + tag.length);
            inThink = !inThink;
            started = false;
            continue;
          }
          const keep = partialTagLength(buf, tag);
          const part = emit(buf.slice(0, buf.length - keep));
          if (part) yield part;
          buf = buf.slice(buf.length - keep);
          break;
        }
      }
      if (chunk.usage) {
        const extra = chunk.usage.extra || {};
        yield { usage: { input: chunk.usage.prompt_tokens || 0, output: chunk.usage.completion_tokens || 0,
                         speed: Math.round((extra.decode_tokens_per_s || 0) * 10) / 10 } };
      }
    }
    const part = buf && emit(buf);
    if (part) yield part;
  } finally {
    signal && signal.removeEventListener("abort", onAbort);
  }
}

function partialTagLength(text, tag) {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (tag.startsWith(text.slice(-n))) return n;
  }
  return 0;
}
