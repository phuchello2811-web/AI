// A strong open-weight model (OpenAI GPT-OSS 20B) served free by Pollinations.ai: usable the moment the
// page opens, no download and no account. Anonymous use allows one reply every 30 seconds per IP, so
// requests are spaced out here and retried when the service says to wait. A personal Pollinations key
// (saved in this browser only) removes the wait.

const ENDPOINT = "https://text.pollinations.ai/openai";
const FREE_GAP_MS = 31_000;
const MAX_ATTEMPTS = 6;
// The free tier ends every reply after ~1,400 tokens (reasoning included), so long answers are written in
// several replies: each one continues where the previous stopped.
const MAX_CONTINUATIONS = 6;
const CONTINUE = "Câu trả lời của bạn bị ngắt do giới hạn độ dài. Viết tiếp NGAY từ chỗ dừng: không chào, không tóm tắt, "
  + "không lặp lại phần đã viết. Nếu đang ở giữa một code block thì viết tiếp phần code còn lại (không mở lại ```) và nhớ đóng ``` ở cuối.";
const FROM_DRAFT = "Lượt trước bạn mới suy nghĩ xong một phần thì bị ngắt do giới hạn độ dài. Ghi chú suy nghĩ đó:\n\n{draft}\n\n"
  + "Dựa vào đó, viết NGAY câu trả lời cuối cùng theo đúng định dạng đã yêu cầu; chỉ suy nghĩ thêm thật ngắn.";

let nextFreeAt = 0; // when the next anonymous request may start

export class CloudUnavailable extends Error {}

export function getKey() {
  try { return localStorage.getItem("cm.pollenKey") || ""; } catch { return ""; }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal && signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("stopped", "AbortError")); }, { once: true });
});

/** Wait until `until`, yielding {wait: seconds left} once a second. */
async function* waitUntil(until, signal) {
  while (Date.now() < until) {
    yield { wait: Math.ceil((until - Date.now()) / 1000) };
    await sleep(Math.min(1000, until - Date.now()), signal);
  }
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
 * Throws CloudUnavailable when the service cannot be reached, so callers can fall back.
 */
export async function* chat(messages, opts = {}) {
  if (opts.schema) {
    yield* request(messages, opts);
    return;
  }
  let content = "", reasoning = "", convo = messages;
  for (let part = 0; ; part++) {
    const insideCode = (content.match(/```/g) || []).length % 2 === 1;
    const r = yield* request(convo, part ? { ...opts, effort: "low" } : opts, insideCode);
    content += r.content;
    reasoning += r.reasoning;
    if (r.finish !== "length" || part === MAX_CONTINUATIONS) return;
    // A few words of answer give the model nothing to continue from, so it starts over from its notes instead.
    const resume = content.length >= 400 || content.includes("```");
    convo = resume
      ? [...messages, { role: "assistant", content }, { role: "user", content: CONTINUE }]
      : [...messages, { role: "user", content: FROM_DRAFT.replace("{draft}", (reasoning + "\n" + content).slice(-8000)) }];
    if (!resume) content = "";
    yield { status: resume ? "Câu trả lời dài, AI đang viết tiếp…" : "AI đã suy nghĩ xong một phần, đang viết câu trả lời…" };
  }
}

/** One HTTP request; returns {finish, content, reasoning}. `dropFence` strips a reopened code fence. */
async function* request(messages, { schema = null, maxTokens = 0, effort = "medium", signal } = {}, dropFence = false) {
  const key = getKey();
  // With "high" reasoning, structured (JSON schema) replies come back empty; they need less thought anyway.
  if (schema && effort === "high") effort = "medium";
  const body = { model: "openai", messages, private: true, reasoning_effort: effort, stream: !schema };
  // Reasoning tokens count against max_tokens, so only short structured replies are capped; long answers
  // are protected from endless repetition by the agent's loop detector instead.
  if (maxTokens && schema) body.max_tokens = maxTokens + 2000;
  if (schema) body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema: strict(schema) } };
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;

  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!key) {
      yield* waitUntil(nextFreeAt, signal);
      nextFreeAt = Date.now() + FREE_GAP_MS;
    }
    let res;
    try {
      res = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastError = "không kết nối được";
      await sleep(2000 * (attempt + 1), signal);
      continue;
    }
    if (res.status === 402 || res.status === 429) {
      const msg = await res.text();
      const after = +(msg.match(/after (\d+)\s*s/i) || [])[1] || 30;
      nextFreeAt = Date.now() + (after + 1) * 1000;
      lastError = "đang giới hạn lượt";
      continue;
    }
    if (!res.ok) {
      lastError = `lỗi máy chủ ${res.status}`;
      if (res.status >= 500) { await sleep(3000 * (attempt + 1), signal); continue; }
      throw new CloudUnavailable(`Máy chủ AI miễn phí từ chối yêu cầu (${res.status}).`);
    }
    const started = performance.now();
    if (schema) {
      const data = await res.json();
      const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      if (msg.reasoning) yield { thinking: msg.reasoning };
      yield { text: msg.content || "" };
      yield { usage: usageOf(data.usage, started) };
      return { finish: data.choices && data.choices[0] && data.choices[0].finish_reason, content: msg.content || "", reasoning: msg.reasoning || "" };
    }
    return yield* readStream(res, started, dropFence);
  }
  throw new CloudUnavailable(`Máy chủ AI miễn phí không phản hồi (${lastError}).`);
}

function usageOf(usage, started) {
  const output = (usage && usage.completion_tokens) || 0;
  const seconds = (performance.now() - started) / 1000;
  return { input: (usage && usage.prompt_tokens) || 0, output, speed: seconds ? Math.round((output / seconds) * 10) / 10 : 0 };
}

async function* readStream(res, started, dropFence) {
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
      if (delta.reasoning) { chars += delta.reasoning.length; reasoning += delta.reasoning; yield { thinking: delta.reasoning }; }
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
  yield { usage: usageOf(usage || { completion_tokens: Math.round(chars / 4) }, started) };
  return { finish, content, reasoning };
}
