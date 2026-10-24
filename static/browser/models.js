// Picks where each request runs:
// - "cloud" (default) and "free:<id>": free hosted models, instant, no account (cloud.js);
// - "puter:<id>": frontier models through Puter, after the visitor signs in with a free Puter account (puter.js);
// - Qwen names: open-source models inside the browser (WebGPU, unlimited, offline after one download).
// If the free cloud cannot answer, requests move to the in-browser model; if Puter fails, to the free cloud.
// The WebLLM and Puter libraries are only loaded when first needed.

import * as cloud from "./cloud.js";
import * as puter from "./puter.js";

export const CLOUD = "cloud";
export const FALLBACK = "Qwen3.5-4B";
const LOCAL_MODELS = [
  { name: "Qwen3.5-9B", label: "Qwen3.5 9B", note: "Tải ~6.4 GB, cần GPU mạnh" },
  { name: "Qwen3.5-4B", label: "Qwen3.5 4B", note: "Tải ~3.9 GB" },
  { name: "Qwen2.5-Coder-7B-Instruct", label: "Qwen2.5 Coder 7B", note: "Tải ~5.1 GB, chuyên code" },
  { name: "Qwen3.5-2B", label: "Qwen3.5 2B", note: "Tải ~2.2 GB, cho máy yếu" },
];
export const MODELS = [
  { name: CLOUD, label: "Tự động", note: "Model miễn phí mạnh nhất còn lượt (MiniMax M2.7, GPT-OSS 20B…)", provider: "cloud", strong: true },
  ...cloud.FREE_MODELS.map((m) => ({ name: `free:${m.id}`, label: m.label, note: m.note, provider: "cloud", strong: true, free: m.id })),
  ...puter.MODELS.map((m) => ({ name: `puter:${m.id}`, label: m.label, note: m.note, provider: "puter", strong: true, puter: m.id })),
  ...LOCAL_MODELS.map((m) => ({ ...m, provider: "local" })),
];
const byName = new Map(MODELS.map((m) => [m.name, m]));
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

export const isStrong = (name) => !!(byName.get(name) || {}).strong;
export const { signIn: puterSignIn, signOut: puterSignOut, signedIn: puterSignedIn } = puter;

/** Live availability for the model menu: ms until each free model can answer, and the Puter sign-in state. */
export function status() {
  return { free: cloud.status(), puter: puter.signedIn() };
}

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

/** A Puter model other than `label`, for a second opinion. */
function otherPuterModel(current) {
  return ["deepseek-v4-pro", "gpt-5.6-terra", "qwen3.8-max"].find((id) => id !== current);
}

async function* viaPuter(messages, opts, info) {
  const helper = opts.route === "helper" || opts.schema;
  let model = helper ? puter.HELPER_MODEL : info.puter;
  if (!helper && opts.avoid && opts.avoid === info.label) model = otherPuterModel(info.puter);
  const msgs = opts.schema ? cloud.withSchemaInstruction(messages, opts.schema) : messages;
  try {
    yield* puter.chat(msgs, { model, signal: opts.signal });
  } catch (e) {
    if (e instanceof puter.PuterSignInNeeded || (opts.signal && opts.signal.aborted)) throw e;
    yield { notice: `Puter báo lỗi (${(e && e.message) || e}). Chuyển sang model miễn phí.` };
    yield* cloud.chat(messages, opts);
  }
}

/**
 * One completion as a stream of parts: {text}, {thinking}, {usage}, {wait: s}, {status}, {notice}.
 * opts: model, schema, maxTokens, temperature, think, effort ("low" | "medium" | "high"), route, avoid, signal.
 */
export async function* chat(messages, opts = {}) {
  const info = byName.get(opts.model) || byName.get(CLOUD);
  if (info.provider === "puter") {
    yield* viaPuter(messages, opts, info);
    return;
  }
  let model = info.name;
  if (info.provider === "cloud" && Date.now() >= cloudDownUntil) {
    try {
      yield* cloud.chat(messages, { ...opts, pin: info.free || null });
      return;
    } catch (e) {
      if (!(e instanceof cloud.CloudUnavailable) || !(await hasWebGPU())) throw e;
      cloudDownUntil = Date.now() + CLOUD_RETRY_MS;
      yield { notice: `${e.message} Chuyển sang model chạy trong trình duyệt (${FALLBACK}).` };
    }
  }
  if (info.provider === "cloud") {
    if (!(await hasWebGPU())) throw new Error("Máy chủ AI miễn phí đang không phản hồi và trình duyệt này không chạy được model offline (thiếu WebGPU). Hãy thử lại sau ít phút.");
    model = FALLBACK;
  }
  yield* loadLocal(model, opts.signal);
  yield* (await local()).chat(messages, opts);
}
