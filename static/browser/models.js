// Picks where each request runs: the free cloud model (default, instant) or an open-source model inside
// the browser (WebGPU, unlimited, offline after one download). If the cloud cannot be reached, requests
// move to the in-browser model automatically. The WebLLM library is only loaded when first needed.

import * as cloud from "./cloud.js";

export const CLOUD = "GPT-OSS-20B";
export const FALLBACK = "Qwen3.5-4B";
export const MODELS = [
  { name: CLOUD, label: "GPT-OSS 20B · máy chủ miễn phí, dùng ngay", provider: "cloud", strong: true },
  { name: "Qwen3.5-9B", label: "Qwen3.5 9B · trong trình duyệt (tải ~6.4 GB)", provider: "local" },
  { name: "Qwen3.5-4B", label: "Qwen3.5 4B · trong trình duyệt (tải ~3.9 GB)", provider: "local" },
  { name: "Qwen2.5-Coder-7B-Instruct", label: "Qwen2.5 Coder 7B · trong trình duyệt (tải ~5.1 GB)", provider: "local" },
  { name: "Qwen3.5-2B", label: "Qwen3.5 2B · trong trình duyệt, máy yếu (tải ~2.2 GB)", provider: "local" },
];
const CLOUD_RETRY_MS = 5 * 60_000; // after a cloud failure, stay on the local model this long

let localModule = null;
let cloudDownUntil = 0;
let gpu = null;

const local = () => (localModule ||= import("./llm.js"));

export async function hasWebGPU() {
  if (gpu === null) {
    try { gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { gpu = false; }
  }
  return gpu;
}

export const isStrong = (name) => name === CLOUD;

export function stop() {
  if (localModule) localModule.then((m) => m.stop());
}

/** Load a local model, yielding {status} while it downloads. */
async function* loadLocal(name, signal) {
  const llm = await local();
  let latest = null, done = false, error = null, wake = null;
  llm.load(name, (text, fraction) => { latest = Math.round((fraction || 0) * 100); if (wake) wake(); })
    .then(() => { done = true; }, (e) => { error = e; done = true; })
    .finally(() => wake && wake());
  while (!done) {
    await new Promise((r) => { wake = r; setTimeout(r, 500); });
    wake = null;
    if (signal && signal.aborted) throw new DOMException("stopped", "AbortError");
    if (latest !== null && !done) yield { status: `Đang nạp model ${name} vào trình duyệt: ${latest}% (chỉ tải lần đầu)` };
  }
  if (error) throw error;
}

/**
 * One completion as a stream of parts: {text}, {thinking}, {usage}, {wait: s}, {status}, {notice}.
 * opts: model, schema, maxTokens, temperature, think, effort ("low" | "medium" | "high"), signal.
 */
export async function* chat(messages, opts = {}) {
  let model = opts.model || CLOUD;
  if (model === CLOUD && Date.now() >= cloudDownUntil) {
    try {
      yield* cloud.chat(messages, opts);
      return;
    } catch (e) {
      if (!(e instanceof cloud.CloudUnavailable) || !(await hasWebGPU())) throw e;
      cloudDownUntil = Date.now() + CLOUD_RETRY_MS;
      yield { notice: `${e.message} Chuyển sang model chạy trong trình duyệt (${FALLBACK}).` };
    }
  }
  if (model === CLOUD) {
    if (!(await hasWebGPU())) throw new Error("Máy chủ AI miễn phí đang không phản hồi và trình duyệt này không chạy được model offline (thiếu WebGPU). Hãy thử lại sau ít phút.");
    model = FALLBACK;
  }
  yield* loadLocal(model, opts.signal);
  yield* (await local()).chat(messages, opts);
}
