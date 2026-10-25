// Picks where each request runs. Everything runs on servers, nothing is downloaded into the browser:
// - "cloud" (default) and "free:<id>": free hosted models, instant, no account (cloud.js);
// - "puter:<id>": frontier models and the Qwen family through Puter, after the visitor signs in with a free
//   Puter account (puter.js). If Puter fails, requests fall back to the free models.
// The Puter library is only loaded when first needed.

import * as cloud from "./cloud.js";
import * as puter from "./puter.js";

export const CLOUD = "cloud";
export const MODELS = [
  { name: CLOUD, label: "Tự động", note: "Model miễn phí mạnh nhất còn lượt (MiniMax M2.7, GPT-OSS 20B…)", provider: "cloud", strong: true },
  ...cloud.FREE_MODELS.map((m) => ({ name: `free:${m.id}`, label: m.label, note: m.note, provider: "cloud", strong: true, free: m.id })),
  ...puter.QWEN_MODELS.map((m) => ({ name: `puter:${m.id}`, label: m.label, note: m.note, provider: "qwen", strong: true, puter: m.id })),
  ...puter.MODELS.map((m) => ({ name: `puter:${m.id}`, label: m.label, note: m.note, provider: "puter", strong: true, puter: m.id })),
];
const byName = new Map(MODELS.map((m) => [m.name, m]));

export const isStrong = (name) => !!(byName.get(name) || {}).strong;
export const { signIn: puterSignIn, signOut: puterSignOut, signedIn: puterSignedIn } = puter;

/** Live availability for the model menu: ms until each free model can answer, and the Puter sign-in state. */
export function status() {
  return { free: cloud.status(), puter: puter.signedIn() };
}

// Requests stop through their AbortSignal; nothing else to interrupt.
export function stop() {}

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
  if (info.puter) {
    yield* viaPuter(messages, opts, info);
    return;
  }
  try {
    yield* cloud.chat(messages, { ...opts, pin: info.free || null });
  } catch (e) {
    if (!(e instanceof cloud.CloudUnavailable)) throw e;
    throw new Error(`${e.message} Hãy thử lại sau ít phút, hoặc mở menu model để chọn Qwen / model hàng đầu qua Puter (đăng nhập miễn phí).`);
  }
}
