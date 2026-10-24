// Frontier models (Claude, GPT, Gemini, Qwen3.8, DeepSeek, Kimi, GLM, MiniMax) through Puter.js. Puter uses a
// "user pays" model: each visitor signs in with a free Puter account that comes with a monthly allowance,
// so the site itself pays nothing. The Puter script is only loaded once someone picks one of these models.

const SCRIPT = "https://js.puter.com/v2/";
// Helper requests (reading the samples, writing test generators) use a cheap model to save the allowance.
export const HELPER_MODEL = "qwen3.8-flash";

export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Rất mạnh về lập trình; tốn hạn mức nhiều" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", note: "OpenAI, suy luận mạnh" },
  { id: "qwen3.8-max", label: "Qwen3.8 Max", note: "Alibaba, mạnh nhất dòng Qwen" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", note: "Suy luận toán và thuật toán, giá vừa" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "Google, nhanh, ngữ cảnh rất dài" },
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", note: "Moonshot, chuyên viết code" },
  { id: "glm-5.3", label: "GLM-5.3", note: "Zhipu, mạnh về code và web" },
  { id: "minimax-m3", label: "MiniMax M3", note: "Rẻ, mạnh, ngữ cảnh 1 triệu token" },
];

let loading = null;

export class PuterSignInNeeded extends Error {}

function load() {
  loading ||= new Promise((resolve, reject) => {
    if (window.puter) return resolve(window.puter);
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.onload = () => (window.puter ? resolve(window.puter) : reject(new Error("Puter.js không khởi động được.")));
    s.onerror = () => { loading = null; reject(new Error("Không tải được Puter.js (kiểm tra mạng).")); };
    document.head.appendChild(s);
  });
  return loading;
}

/** Whether the visitor is signed in, without loading Puter unless it already was. */
export function signedIn() {
  try { return !!(window.puter && window.puter.auth.isSignedIn()); } catch { return false; }
}

/** Must run from a click: opens Puter's sign-in window. */
export async function signIn() {
  const puter = await load();
  if (!puter.auth.isSignedIn()) await puter.auth.signIn();
  return puter.auth.isSignedIn();
}

export async function signOut() {
  const puter = await load();
  puter.auth.signOut();
}

/** Stream one answer from `model`: yields {thinking}, {text}, {usage}. */
export async function* chat(messages, { model, signal } = {}) {
  const puter = await load();
  if (!puter.auth.isSignedIn()) {
    throw new PuterSignInNeeded("Model này chạy qua Puter: hãy mở menu chọn model và bấm \"Đăng nhập Puter\" (miễn phí) trước.");
  }
  const started = performance.now();
  let chars = 0;
  const stream = await puter.ai.chat(messages, { model, stream: true });
  for await (const part of stream) {
    if (signal && signal.aborted) throw new DOMException("stopped", "AbortError");
    if (!part) continue;
    const thought = part.reasoning || (part.type === "reasoning" ? part.text : "");
    if (thought) { chars += thought.length; yield { thinking: thought }; continue; }
    const text = typeof part === "string" ? part : part.text;
    if (text) { chars += text.length; yield { text }; }
  }
  const seconds = (performance.now() - started) / 1000;
  const label = (MODELS.find((m) => m.id === model) || { label: model }).label;
  yield { usage: { input: 0, output: Math.round(chars / 4), speed: seconds ? Math.round(chars / 4 / seconds) : 0, model: label } };
}
