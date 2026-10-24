// The whole app inside the browser: answers the same /api/... requests as server.py, with
// conversations stored in IndexedDB, the model running on WebGPU (llm.js) and code judged in
// WebAssembly (judge.js). Used on GitHub Pages and whenever no local server is running.

import * as llm from "./llm.js";
import * as judge from "./judge.js";
import { createAgent, createKnowledge, EFFORTS } from "./agent.js";

const [prompts, knowledgeEntries] = await Promise.all([
  fetch(new URL("../prompts.json", import.meta.url)).then((r) => r.json()),
  fetch(new URL("../knowledge.json", import.meta.url)).then((r) => r.json()),
]);
const knowledge = createKnowledge(knowledgeEntries);

/* ---------- IndexedDB conversation store ---------- */

const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open("codemaster", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("convs", { keyPath: "id" });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function tx(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction("convs", mode);
    const req = fn(t.objectStore("convs"));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}
const getConv = (id) => tx("readonly", (s) => s.get(id));
const putConv = (conv) => tx("readwrite", (s) => s.put({ ...conv, updated: Date.now() }));

const siteUrls = new Map(); // conversation id -> blob: URL of its generated page

function siteUrl(conv) {
  if (!conv.site) return null;
  if (!siteUrls.has(conv.id)) siteUrls.set(conv.id, URL.createObjectURL(new Blob([conv.site], { type: "text/html;charset=utf-8" })));
  return siteUrls.get(conv.id);
}

const agent = createAgent({
  llm, judge, knowledge, prompts,
  saveSite(conv, html) {
    conv.site = html;
    if (siteUrls.has(conv.id)) URL.revokeObjectURL(siteUrls.get(conv.id));
    siteUrls.delete(conv.id);
    return siteUrl(conv);
  },
});

class HttpError extends Error {}
const fail = (msg) => { throw new HttpError(msg); };

/* ---------- the /api routes ---------- */

export async function request(path, { method = "GET", body } = {}) {
  const data = body ? JSON.parse(body) : {};
  let m;
  if (path === "/api/health") return health();
  if (path === "/api/knowledge") return knowledgeEntries.map(({ id, title, body }) => ({ id, title, body }));
  if (path === "/api/run" && method === "POST") {
    let lang;
    try { lang = judge.normalizeLanguage(data.language); } catch (e) { fail(e.message); }
    return judge.runTests(lang, data.code, (data.tests || []).length ? data.tests : [{ input: "" }], data.time_limit || 2);
  }
  if (path === "/api/conversations") {
    if (method === "POST") {
      const conv = { id: crypto.randomUUID().replace(/-/g, ""), title: "Cuộc trò chuyện mới", messages: [], events: [], state: {} };
      await putConv(conv);
      return { id: conv.id, title: conv.title };
    }
    const all = await tx("readonly", (s) => s.getAll());
    return all.map(({ id, title, updated }) => ({ id, title, updated })).sort((a, b) => b.updated - a.updated);
  }
  if ((m = path.match(/^\/api\/conversations\/(\w+)(\/files)?$/))) {
    if (method === "DELETE") {
      await tx("readwrite", (s) => s.delete(m[1]));
      return { ok: true };
    }
    const conv = (await getConv(m[1])) || fail("conversation not found");
    if (m[2]) return conv.site ? [{ path: "index.html", content: conv.site }] : [];
    return { id: conv.id, title: conv.title, events: conv.events, preview_url: siteUrl(conv) };
  }
  fail(`Không có API ${method} ${path}`);
}

async function health() {
  const gpu = await llm.probeGPU();
  const models = gpu ? await Promise.all(llm.MODELS.map(async (m) => ({
    name: m.name, label: `${m.label} (${m.size})`, cached: await llm.isCached(m.name),
    capabilities: m.thinking ? ["completion", "thinking"] : ["completion"],
  }))) : [];
  return { browser: true, webgpu: !!gpu, ollama: !!gpu, models, languages: judge.LANGUAGES };
}

/** One chat turn as an async stream of UI events (the SSE events of server.py's /api/chat). */
export async function* chat(body, signal) {
  if (!(body.mode in prompts.system)) fail("bad mode");
  if (!(body.effort in EFFORTS)) fail("bad effort");
  if (body.images && body.images.length) fail("Model chạy trong trình duyệt chưa đọc được ảnh. Hãy dán đề dạng chữ.");
  const conv = (await getConv(body.conversation_id)) || fail("conversation not found");
  conv.messages.push({ role: "user", content: body.text });
  conv.events.push({ type: "user", text: body.text, images: 0 });
  if (conv.events.length === 1) conv.title = (body.text.trim().split("\n")[0] || "Cuộc trò chuyện mới").slice(0, 60);
  yield { type: "title", title: conv.title };
  await putConv(conv);

  const record = (ev) => { if (ev.type !== "tool_status") conv.events.push(ev); return ev; };
  try {
    yield* loadModel(body.model, record);
    for await (const ev of agent.runTurn(conv, { mode: body.mode, think: body.think, effort: body.effort, signal })) {
      if (signal && signal.aborted) break;
      yield record(ev);
    }
  } catch (e) {
    if (!(signal && signal.aborted)) yield record({ type: "error", message: String(e && e.message || e) });
  } finally {
    conv.events.push({ type: "done" });
    await putConv(conv);
  }
  yield { type: "done" };
}

/** Load the chosen model, showing download progress on a tool card the first time. */
async function* loadModel(name, record) {
  const info = llm.MODELS.find((m) => m.name === name) || fail(`Không có model ${name}`);
  let latest = null, wake = null, done = false, error = null;
  const started = llm.load(name, (text, fraction) => { latest = { text, fraction }; if (wake) wake(); })
    .then(() => { done = true; }, (e) => { error = e; done = true; })
    .finally(() => wake && wake());
  let card = false;
  while (!done) {
    await new Promise((r) => { wake = r; setTimeout(r, 400); });
    wake = null;
    if (!latest || done) continue;
    if (!card) {
      card = true;
      yield record({ type: "tool_start", id: "model", name: "load_model" });
    }
    const pct = Math.round((latest.fraction || 0) * 100);
    yield { type: "tool_status", id: "model", text: `${info.label} ${info.size} · ${pct}% (chỉ tải lần đầu)` };
    latest = null;
  }
  await started;
  if (error) throw error;
  if (card) yield record({ type: "tool_result", id: "model", name: "load_model", output: { model: info.label } });
}

export function stop() {
  llm.stop();
}
