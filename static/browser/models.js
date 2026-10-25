// Picks where each request runs:
// - "cloud" (default) and "free:<id>": free hosted models, instant, no account (cloud.js);
// - "puter:<id>": frontier models and the Qwen family on Puter's servers, after the visitor signs in with a
//   free Puter account (puter.js). If Puter fails, requests fall back to the free models;
// - Qwen names: open-source Qwen models downloaded once into the browser (WebGPU, llm.js), for use offline.
//   When there is no network and one of them is already downloaded, requests switch to it automatically.
// The Puter and WebLLM libraries are only loaded when first needed.

import * as cloud from "./cloud.js";
import * as puter from "./puter.js";

export const CLOUD = "cloud";
const LOCAL_MODELS = [
  { name: "Qwen3.5-4B", label: "Qwen3.5 4B", note: "Tải ~3.9 GB một lần, sau đó dùng được khi mất mạng" },
  { name: "Qwen3.5-9B", label: "Qwen3.5 9B", note: "Tải ~6.4 GB, mạnh nhất khi offline, cần GPU tốt" },
  { name: "Qwen2.5-Coder-7B-Instruct", label: "Qwen2.5 Coder 7B", note: "Tải ~5.1 GB, chuyên code" },
  { name: "Qwen3.5-2B", label: "Qwen3.5 2B", note: "Tải ~2.2 GB, cho máy yếu" },
];
export const MODELS = [
  { name: CLOUD, label: "Tự động", note: "Model miễn phí mạnh nhất còn lượt (MiniMax M2.7, GPT-OSS 20B…)", provider: "cloud", strong: true },
  ...cloud.FREE_MODELS.map((m) => ({ name: `free:${m.id}`, label: m.label, note: m.note, provider: "cloud", strong: true, free: m.id })),
  ...puter.QWEN_MODELS.map((m) => ({ name: `puter:${m.id}`, label: m.label, note: m.note, provider: "qwen", strong: true, puter: m.id })),
  ...puter.MODELS.map((m) => ({ name: `puter:${m.id}`, label: m.label, note: m.note, provider: "puter", strong: true, puter: m.id })),
  ...LOCAL_MODELS.map((m) => ({ ...m, provider: "local" })),
];
const byName = new Map(MODELS.map((m) => [m.name, m]));

export const isStrong = (name) => !!(byName.get(name) || {}).strong;
export const { signIn: puterSignIn, signOut: puterSignOut, signedIn: puterSignedIn } = puter;

/** Live availability for the model menu: ms until each free model can answer, and the Puter sign-in state. */
export function status() {
  return { free: cloud.status(), puter: puter.signedIn() };
}

let localModule = null;
let gpu = null;
const local = () => (localModule ||= import("./llm.js"));

export async function hasWebGPU() {
  if (gpu === null) {
    try { gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { gpu = false; }
  }
  return gpu;
}

export function stop() {
  if (localModule) localModule.then((m) => m.stop());
}

/** Load an in-browser model, yielding {status} while it downloads (only the first time). */
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
    if (latest !== null && !done) yield { status: `Đang nạp ${name} vào trình duyệt: ${latest}% (chỉ tải lần đầu)` };
  }
  if (error) throw error;
}

/** An in-browser model that is already downloaded (never start a multi-GB download unasked), or null. */
async function cachedLocalModel() {
  if (!(await hasWebGPU())) return null;
  const llm = await local();
  for (const m of LOCAL_MODELS) if (await llm.isCached(m.name)) return m.name;
  return null;
}

async function* viaLocal(name, messages, opts) {
  yield* loadLocal(name, opts.signal);
  yield* (await local()).chat(messages, opts);
}

/** A Puter model other than `current`, for a second opinion. */
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
 * opts: model, schema, maxTokens, temperature, effort ("low" | "medium" | "high"), route, avoid, signal.
 */
export async function* chat(messages, opts = {}) {
  const info = byName.get(opts.model) || byName.get(CLOUD);
  if (info.provider === "local") {
    yield* viaLocal(info.name, messages, opts);
    return;
  }
  // No network at all: go straight to a downloaded Qwen if there is one.
  if (navigator.onLine === false) {
    const cached = await cachedLocalModel();
    if (cached) {
      yield { notice: `Không có mạng: dùng ${cached} đã tải sẵn trong trình duyệt.` };
      yield* viaLocal(cached, messages, opts);
      return;
    }
  }
  if (info.puter) {
    yield* viaPuter(messages, opts, info);
    return;
  }
  try {
    yield* cloud.chat(messages, { ...opts, pin: info.free || null });
  } catch (e) {
    if (!(e instanceof cloud.CloudUnavailable)) throw e;
    const cached = await cachedLocalModel();
    if (!cached) {
      throw new Error(`${e.message} Hãy thử lại sau ít phút, hoặc mở menu model để chọn Qwen / model hàng đầu qua Puter (đăng nhập miễn phí), hoặc tải một model Qwen về máy để dùng khi mất mạng.`);
    }
    yield { notice: `${e.message} Tạm dùng ${cached} đã tải sẵn trong trình duyệt.` };
    yield* viaLocal(cached, messages, opts);
  }
}
