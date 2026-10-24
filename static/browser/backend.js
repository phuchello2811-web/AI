// The whole app inside the browser: answers the same /api/... requests as server.py, with
// conversations stored in IndexedDB, the model in the free cloud or on WebGPU (models.js) and code
// judged in WebAssembly (judge.js). Used on GitHub Pages and whenever no local server is running.

import * as llm from "./models.js";
import * as judge from "./judge.js";
import { createAgent, createKnowledge, EFFORTS } from "./agent.js";

const [prompts, knowledgeEntries] = await Promise.all([
  fetch(new URL("../prompts.json", import.meta.url)).then((r) => r.json()),
  fetch(new URL("../knowledge.json", import.meta.url)).then((r) => r.json()),
]);
const knowledge = createKnowledge(knowledgeEntries);

/* ---------- IndexedDB conversation store ---------- */

const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open("codemaster", 2);
  req.onupgradeneeded = () => {
    const names = req.result.objectStoreNames;
    if (!names.contains("convs")) req.result.createObjectStore("convs", { keyPath: "id" });
    if (!names.contains("lessons")) req.result.createObjectStore("lessons", { keyPath: "id", autoIncrement: true });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function tx(mode, fn, store = "convs") {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}
const getConv = (id) => tx("readonly", (s) => s.get(id));
const putConv = (conv) => tx("readwrite", (s) => s.put({ ...conv, updated: Date.now() }));

const siteUrls = new Map(); // conversation id -> blob: URL of its generated page

// Generated pages run in a sandbox without our origin (so they cannot read this app's data); there
// localStorage throws. This stand-in keeps such pages working, in memory, only when the real one is blocked.
const STORAGE_SHIM = `<script>(function(){try{localStorage.length;return}catch(e){}function S(){var d={};return{`
  + `getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},`
  + `removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},`
  + `get length(){return Object.keys(d).length}}}try{Object.defineProperty(window,"localStorage",{value:S(),configurable:true});`
  + `Object.defineProperty(window,"sessionStorage",{value:S(),configurable:true})}catch(e){}})();<\/script>`;

/** Insert `code` at the start of <head> (or of the document). */
function inject(html, code) {
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + code) : code + html;
}

function siteUrl(conv) {
  if (!conv.site) return null;
  if (!siteUrls.has(conv.id)) siteUrls.set(conv.id, URL.createObjectURL(new Blob([inject(conv.site, STORAGE_SHIM)], { type: "text/html;charset=utf-8" })));
  return siteUrls.get(conv.id);
}

/** Run a generated page in a hidden sandboxed frame for a few seconds and collect its runtime errors. */
function checkSite(html) {
  const token = crypto.randomUUID();
  const probe = `<script>(function(){var E=[];function r(m){m=String(m).slice(0,300);if(E.indexOf(m)<0&&E.length<8){E.push(m);parent.postMessage({cmProbe:"${token}",errors:E},"*");}}`
    + `addEventListener("error",function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){r("Không tải được: "+(t.src||t.href));}else{r((e.message||"Lỗi")+(e.lineno?" (dòng "+e.lineno+")":""));}},true);`
    + `addEventListener("unhandledrejection",function(e){r("Promise bị từ chối: "+((e.reason&&e.reason.message)||e.reason));});`
    + `var ce=console.error;console.error=function(){r([].map.call(arguments,String).join(" "));ce.apply(console,arguments);};})();<\/script>`;
  const doc = inject(html, probe + STORAGE_SHIM);
  return new Promise((resolve) => {
    let errors = [];
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1280px;height:800px;border:0;visibility:hidden";
    const onMessage = (e) => { if (e.data && e.data.cmProbe === token) errors = e.data.errors; };
    addEventListener("message", onMessage);
    frame.srcdoc = doc;
    document.body.appendChild(frame);
    setTimeout(() => { removeEventListener("message", onMessage); frame.remove(); resolve(errors); }, 3500);
  });
}

// What the agent learned: a short note for every problem it solved and verified, recalled for similar ones.
const MAX_LESSONS = 200;
const memory = {
  all: () => tx("readonly", (s) => s.getAll(), "lessons"),
  async remember(lesson) {
    await tx("readwrite", (s) => s.add({ ...lesson, at: Date.now() }), "lessons");
    const keys = await tx("readonly", (s) => s.getAllKeys(), "lessons");
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_LESSONS))) await tx("readwrite", (s) => s.delete(key), "lessons");
  },
};

const agent = createAgent({
  llm, judge, knowledge, prompts, checkSite, memory,
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
  const gpu = await llm.hasWebGPU();
  const models = llm.MODELS.filter((m) => m.provider === "cloud" || gpu).map((m) => ({
    name: m.name, label: m.label, provider: m.provider, capabilities: ["completion"],
  }));
  return { browser: true, webgpu: gpu, ollama: true, models, languages: judge.LANGUAGES };
}

/** Download and start the C++ compiler and Python in the background, so the first judge run is instant. */
export function warmup() {
  return judge.warmup();
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

  // Live progress (status, tool_status) is shown but not stored.
  const record = (ev) => { if (ev.type !== "tool_status" && ev.type !== "status") conv.events.push(ev); return ev; };
  try {
    if (!llm.MODELS.some((m) => m.name === body.model)) fail(`Không có model ${body.model}`);
    for await (const ev of agent.runTurn(conv, { mode: body.mode, model: body.model, think: body.think, effort: body.effort, signal })) {
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

export function stop() {
  llm.stop();
}
