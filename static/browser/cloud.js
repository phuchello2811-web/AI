// Free hosted open-weight models, usable the moment the page opens: no download, no account. Several free
// services are pooled; each request goes to the strongest one that has quota left, and a service that is
// rate-limited is skipped until it reopens (long blocks are remembered in this browser). Optional personal
// keys (saved in this browser only) lift the free limits.
//
// Measured limits of the anonymous tiers (October 2026):
// - Pollinations (GPT-OSS 20B): 1 reply per 30 s per IP, ~1,400 tokens per reply (reasoning included).
// - LLM7 (MiniMax M2.7, GPT-OSS 20B, Codestral): a small daily token quota per IP, 3,072 tokens per reply.

const POLLINATIONS = "https://text.pollinations.ai/openai";
const LLM7 = "https://api.llm7.io/v1/chat/completions";

const PROVIDERS = {
  minimax: { label: "MiniMax M2.7", url: LLM7, model: "minimax-m2.7", keyPref: "llm7Key" },
  "gpt-oss": { label: "GPT-OSS 20B", url: POLLINATIONS, model: "openai", keyPref: "pollenKey", gapMs: 31_000,
               schema: true, effort: true, extra: { private: true } },
  "gpt-oss-llm7": { label: "GPT-OSS 20B", url: LLM7, model: "gpt-oss:20b", keyPref: "llm7Key", effort: true },
  nemotron: { label: "Nemotron 3 Nano 30B", url: LLM7, model: "nemotron-3-nano:30b", keyPref: "llm7Key" },
  codestral: { label: "Codestral", url: LLM7, model: "codestral-latest", keyPref: "llm7Key" },
  "mistral-nemo": { label: "Mistral Nemo", url: LLM7, model: "mistral-Nemo-Instruct-2407", keyPref: "llm7Key" },
};
/** Models people can pick by name in the model menu (besides "auto"). */
export const FREE_MODELS = [
  { id: "minimax", label: "MiniMax M2.7", note: "Mạnh nhất trong nhóm miễn phí, ít lượt mỗi ngày" },
  { id: "gpt-oss", label: "GPT-OSS 20B", note: "Model suy luận của OpenAI, 1 câu mỗi 30 giây" },
  { id: "nemotron", label: "Nemotron 3 Nano 30B", note: "Model suy luận của NVIDIA" },
  { id: "codestral", label: "Codestral", note: "Chuyên code, trả lời nhanh" },
  { id: "mistral-nemo", label: "Mistral Nemo", note: "Nhẹ, nhanh, hợp hỏi đáp ngắn" },
];
// Strongest first. The main answer may use MiniMax; helper requests leave its small daily quota alone.
const ROUTES = {
  main: ["minimax", "gpt-oss", "gpt-oss-llm7", "nemotron", "codestral", "mistral-nemo"],
  helper: ["gpt-oss", "gpt-oss-llm7", "nemotron", "codestral", "mistral-nemo"],
};
const ACCEPTABLE_WAIT_MS = 35_000; // wait this long for a stronger model rather than drop to a weaker one
const LONG_BLOCK_MS = 10 * 60_000; // blocks longer than this (daily quotas) are remembered across reloads
// Quotas reopen at uneven times, so a long block is retried after at most this long.
const MAX_BLOCK_MS = 3 * 3600_000;
const MAX_ATTEMPTS = 8;
// Free tiers cut replies short, so long answers are written in several replies, each continuing the last.
const MAX_CONTINUATIONS = 6;
const CONTINUE = "Câu trả lời của bạn bị ngắt do giới hạn độ dài. Viết tiếp NGAY từ chỗ dừng: không chào, không tóm tắt, "
  + "không lặp lại phần đã viết. Nếu đang ở giữa một code block thì viết tiếp phần code còn lại (không mở lại ```) và nhớ đóng ``` ở cuối.";
const FROM_DRAFT = "Lượt trước bạn mới suy nghĩ xong một phần thì bị ngắt do giới hạn độ dài. Ghi chú suy nghĩ đó:\n\n{draft}\n\n"
  + "Dựa vào đó, viết NGAY câu trả lời cuối cùng theo đúng định dạng đã yêu cầu; chỉ suy nghĩ thêm thật ngắn.";

const state = {}; // provider id -> { nextAt }
const pref = (key) => { try { return localStorage.getItem("cm." + key) || ""; } catch { return ""; } };
const blockKey = (id) => `blocked.${id}`;

function readyAt(id) {
  const remembered = +pref(blockKey(id)) || 0;
  return Math.max((state[id] && state[id].nextAt) || 0, remembered);
}

function block(id, ms) {
  ms = Math.min(ms, MAX_BLOCK_MS);
  const until = Date.now() + ms;
  state[id] = { nextAt: Math.max(until, readyAt(id)) };
  if (ms > LONG_BLOCK_MS) try { localStorage.setItem("cm." + blockKey(id), String(until)); } catch {}
}

export class CloudUnavailable extends Error {}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal && signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("stopped", "AbortError")); }, { once: true });
});

/** When each pickable model can answer again (0 = now), for the model menu. */
export function status() {
  return Object.fromEntries(FREE_MODELS.map((m) => [m.id, Math.max(0, readyAt(m.id) - Date.now())]));
}

/**
 * The provider to use next: the strongest one ready soon enough, else the one ready soonest. `pin` puts one
 * provider first; `avoid` skips providers with that label (to get a second opinion from another model).
 */
function pick(route, pin, avoid) {
  const now = Date.now();
  let order = ROUTES[route];
  if (pin && PROVIDERS[pin]) order = [pin, ...order.filter((id) => id !== pin)];
  const others = order.filter((id) => PROVIDERS[id].label !== avoid);
  const open = (others.length ? others : order).filter((id) => readyAt(id) - now < LONG_BLOCK_MS);
  if (!open.length) return null;
  return open.find((id) => readyAt(id) - now <= ACCEPTABLE_WAIT_MS)
    || open.reduce((a, b) => (readyAt(a) <= readyAt(b) ? a : b));
}

// OpenAI strict JSON schemas need every object closed and every property required.
function strict(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = Array.isArray(schema) ? schema.map(strict) : Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, strict(v)]));
  if (out.type === "object" && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

/**
 * Stream one answer: yields {thinking}, {text}, {usage}, {status}, and {wait: s} while queued. Answers cut
 * off by the length limit are continued in follow-up requests and stitched together.
 * opts.route: "main" (default) or "helper". Throws CloudUnavailable when no service can answer.
 */
export async function* chat(messages, opts = {}) {
  if (opts.schema) {
    yield* request(messages, { ...opts, route: "helper" });
    return;
  }
  let content = "", reasoning = "", convo = messages;
  for (let part = 0; ; part++) {
    const insideCode = (content.match(/```/g) || []).length % 2 === 1;
    const r = yield* request(convo, part ? { ...opts, effort: "low" } : opts, insideCode);
    content += r.content;
    reasoning += r.reasoning;
    // Some services close the stream without a finish reason; an unclosed code block or no answer means cut off too.
    const unfinished = (content.match(/```/g) || []).length % 2 === 1 || !content.trim();
    const cut = r.finish === "length" || (r.finish !== "stop" && unfinished);
    if (!cut || part === MAX_CONTINUATIONS) return;
    // A few words of answer give the model nothing to continue from, so it starts over from its notes instead.
    const resume = content.length >= 400 || content.includes("```");
    convo = resume
      ? [...messages, { role: "assistant", content }, { role: "user", content: CONTINUE }]
      : [...messages, { role: "user", content: FROM_DRAFT.replace("{draft}", (reasoning + "\n" + content).slice(-8000)) }];
    if (!resume) content = "";
    yield { status: resume ? "Câu trả lời dài, AI đang viết tiếp…" : "AI đã suy nghĩ xong một phần, đang viết câu trả lời…" };
  }
}

/** Services without strict JSON schemas get the schema as an instruction instead. */
export function withSchemaInstruction(messages, schema) {
  const note = `\n\nTrả lời CHỈ bằng một đối tượng JSON hợp lệ (không thêm chữ nào khác) theo JSON Schema sau:\n${JSON.stringify(schema)}`;
  const out = messages.map((m) => ({ ...m }));
  const sys = out.find((m) => m.role === "system");
  if (sys) sys.content += note; else out.unshift({ role: "system", content: note.trim() });
  return out;
}

/** One reply from the best available service; returns {finish, content, reasoning}. */
async function* request(messages, { schema = null, maxTokens = 0, effort = "medium", route = "main", pin = null, avoid = null, signal } = {}, dropFence = false) {
  // Structured replies must fit in one short reply (reasoning included), so they think briefly.
  if (schema) effort = "low";
  let lastError = "", substituted = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const id = pick(route, pin, avoid);
    if (!id) break;
    const p = PROVIDERS[id];
    if (pin && id !== pin && PROVIDERS[pin] && !substituted) {
      substituted = true;
      yield { notice: `${PROVIDERS[pin].label} đang hết lượt miễn phí, tạm dùng ${p.label} cho câu trả lời này.` };
    }
    const key = pref(p.keyPref);
    while (Date.now() < readyAt(id)) {
      yield { wait: Math.ceil((readyAt(id) - Date.now()) / 1000) };
      await sleep(Math.min(1000, readyAt(id) - Date.now()), signal);
    }
    if (p.gapMs && !key) state[id] = { nextAt: Date.now() + p.gapMs };

    const body = { model: p.model, messages, stream: !schema, ...(p.extra || {}) };
    if (p.effort) body.reasoning_effort = effort;
    if (schema) {
      if (p.schema) body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema: strict(schema) } };
      else body.messages = withSchemaInstruction(messages, schema);
      // Reasoning counts against max_tokens, so only short structured replies are capped.
      if (maxTokens) body.max_tokens = maxTokens + 2000;
    }
    const headers = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;

    let res;
    try {
      res = await fetch(p.url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastError = `${p.label}: không kết nối được`;
      block(id, 60_000);
      continue;
    }
    if (res.status === 402 || res.status === 429) {
      const msg = await res.text();
      let after = 0;
      try { after = +JSON.parse(msg).error.retry_after || 0; } catch {}
      after = after || +(msg.match(/after (\d+)\s*s/i) || [])[1] || 30;
      block(id, (after + 1) * 1000);
      lastError = `${p.label}: hết lượt miễn phí`;
      continue;
    }
    if (!res.ok) {
      lastError = `${p.label}: lỗi ${res.status}`;
      block(id, res.status >= 500 ? 60_000 : 5 * 60_000);
      continue;
    }
    const started = performance.now();
    if (schema) {
      const data = await res.json();
      const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      const thought = msg.reasoning || msg.reasoning_content || "";
      if (thought) yield { thinking: thought };
      yield { text: msg.content || "" };
      yield { usage: usageOf(data.usage, started, p.label) };
      return { finish: data.choices && data.choices[0] && data.choices[0].finish_reason, content: msg.content || "", reasoning: thought };
    }
    return yield* readStream(res, started, dropFence, p.label);
  }
  throw new CloudUnavailable(`Các máy chủ AI miễn phí đang hết lượt hoặc không phản hồi (${lastError || "không còn máy chủ nào mở"}).`);
}

function usageOf(usage, started, model) {
  const output = (usage && usage.completion_tokens) || 0;
  const seconds = (performance.now() - started) / 1000;
  return { input: (usage && usage.prompt_tokens) || 0, output, model,
           speed: seconds ? Math.round((output / seconds) * 10) / 10 : 0 };
}

async function* readStream(res, started, dropFence, model) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", usage = null, chars = 0, finish = null, content = "", reasoning = "";
  // When continuing inside a code block, hold the first line back to drop a reopened ``` fence.
  let head = dropFence ? "" : null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      const thought = delta.reasoning || delta.reasoning_content;
      if (thought) { chars += thought.length; reasoning += thought; yield { thinking: thought }; }
      if (delta.content) {
        chars += delta.content.length;
        let text = delta.content;
        if (head !== null) {
          head += text;
          if (!head.includes("\n") && head.length < 40) continue;
          text = head.replace(/^\s*```[\w+#-]*[ \t]*\n/, "");
          head = null;
        }
        content += text;
        if (text) yield { text };
      }
    }
  }
  if (head) { content += head; yield { text: head }; }
  // Without a usage chunk, estimate tokens from characters (about 4 per token).
  yield { usage: usageOf(usage || { completion_tokens: Math.round(chars / 4) }, started, model) };
  return { finish, content, reasoning };
}
