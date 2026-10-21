"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const JUDGE_LANGS = { cpp: "cpp", "c++": "cpp", c: "c", python: "python", py: "python" };
const LANG_NAMES = { cpp: "C++", c: "C", python: "Python" };
const VERDICT_TEXT = {
  AC: "Đúng", WA: "Sai kết quả", TLE: "Quá thời gian", RE: "Lỗi khi chạy", CE: "Lỗi biên dịch", OK: "Chạy xong",
  ALL_PASSED: "Khớp toàn bộ", MISMATCH: "Lệch kết quả", BUDGET_EXHAUSTED: "Hết thời gian kiểm tra",
  GENERATOR_FAILED: "Generator lỗi", BRUTE_FAILED: "Brute lỗi", ERR: "Lỗi",
};

const state = { convId: null, controller: null, images: [], previewUrl: null, files: [] };
const els = {
  messages: $("#messages"), welcome: $("#welcome"), input: $("#input"), send: $("#sendBtn"),
  convList: $("#convList"), title: $("#chatTitle"), panel: $("#panel"), usage: $("#usage"),
  attachments: $("#attachments"), mode: $("#mode"), model: $("#model"), think: $("#think"),
};

marked.setOptions({ gfm: true, breaks: false });

/* ================= API ================= */

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function refreshStatus() {
  try {
    const h = await api("/api/health");
    state.models = h.models;
    const saved = loadPref("model");
    els.model.innerHTML = h.models.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join("");
    if (h.models.some((m) => m.name === saved)) els.model.value = saved;
    updateThinkToggle();
    $("#status").innerHTML = !h.ollama
      ? `<span class="dot" style="background:var(--bad)"></span>Ollama chưa chạy — gõ <code>brew services start ollama</code>`
      : h.models.length
        ? `<span class="dot" style="background:var(--ok)"></span>Offline · ${h.models.length} model trên máy`
        : `<span class="dot" style="background:var(--warn)"></span>Chưa có model — gõ <code>ollama pull qwen3:4b</code>`;
  } catch {
    $("#status").innerHTML = `<span class="dot" style="background:var(--bad)"></span>Mất kết nối server`;
  }
}

function loadPref(key) {
  try { return localStorage.getItem("cm." + key); } catch { return null; }
}
function savePref(key, value) {
  try { localStorage.setItem("cm." + key, value); } catch {}
}
function updateThinkToggle() {
  const m = (state.models || []).find((x) => x.name === els.model.value);
  const can = !!m && m.capabilities.includes("thinking");
  $("#thinkWrap").classList.toggle("hidden", !can);
}

async function refreshConversations() {
  const convs = await api("/api/conversations");
  els.convList.innerHTML = "";
  for (const c of convs) {
    const row = document.createElement("div");
    row.className = "conv" + (c.id === state.convId ? " active" : "");
    row.innerHTML = `<span>${esc(c.title)}</span><button class="icon-btn del" title="Xoá">🗑</button>`;
    row.onclick = () => openConversation(c.id);
    row.querySelector(".del").onclick = async (e) => {
      e.stopPropagation();
      if (!confirm("Xoá cuộc trò chuyện này?")) return;
      await api(`/api/conversations/${c.id}`, { method: "DELETE" });
      if (c.id === state.convId) newChat();
      refreshConversations();
    };
    els.convList.appendChild(row);
  }
}

/* ================= Chat rendering ================= */

function nearBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}
function scrollDown(force) {
  if (force || nearBottom()) els.messages.scrollTop = els.messages.scrollHeight;
}

function addUserMessage(text, imageCount) {
  els.welcome.classList.add("hidden");
  const div = document.createElement("div");
  div.className = "msg user";
  const imgs = imageCount ? `<span class="img-tag">🖼 ${imageCount} ảnh đính kèm</span>` : "";
  div.innerHTML = `<div class="bubble">${imgs}${esc(text)}</div>`;
  els.messages.appendChild(div);
  scrollDown(true);
}

function renderMarkdown(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  enhanceCode(el);
}

function enhanceCode(root) {
  root.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    if (pre.parentElement.classList.contains("code-block")) return;
    const lang = ((code.className.match(/language-([\w+#-]+)/) || [])[1] || "").toLowerCase();
    try { hljs.highlightElement(code); } catch {}
    const wrap = document.createElement("div");
    wrap.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    head.innerHTML = `<span class="lang">${esc(lang || "code")}</span>`;
    const copy = document.createElement("button");
    copy.textContent = "Sao chép";
    copy.onclick = () => {
      navigator.clipboard.writeText(code.textContent);
      copy.textContent = "Đã chép ✓";
      setTimeout(() => (copy.textContent = "Sao chép"), 1500);
    };
    head.appendChild(copy);
    if (JUDGE_LANGS[lang]) {
      const open = document.createElement("button");
      open.textContent = "▶ Mở trong trình chấm";
      open.onclick = () => openInJudge(JUDGE_LANGS[lang], code.textContent);
      head.appendChild(open);
    }
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  });
}

class Turn {
  constructor() {
    els.welcome.classList.add("hidden");
    const msg = document.createElement("div");
    msg.className = "msg ai";
    msg.innerHTML = `<div class="avatar">&lt;/&gt;</div><div class="ai-body"></div>`;
    els.messages.appendChild(msg);
    this.body = msg.querySelector(".ai-body");
    this.seg = null;          // current text or thinking segment
    this.tools = {};          // tool id -> card
    this.lastTool = null;
    this.tokens = { input: 0, output: 0, speed: 0 };
    this.pending = false;
    this.waiting = this.addWaiting();
  }

  addWaiting() {
    const w = document.createElement("div");
    w.className = "thinking live";
    w.innerHTML = `<summary>Đang xử lý…</summary>`;
    this.body.appendChild(w);
    return w;
  }
  clearWaiting() {
    if (this.waiting) { this.waiting.remove(); this.waiting = null; }
  }

  newText() {
    const el = document.createElement("div");
    el.className = "md cursor";
    this.body.appendChild(el);
    this.seg = { kind: "text", el, text: "" };
  }
  newThinking() {
    const el = document.createElement("details");
    el.className = "thinking live";
    el.innerHTML = `<summary>Đang suy nghĩ…</summary><div class="t-body"></div>`;
    this.body.appendChild(el);
    this.seg = { kind: "thinking", el, text: "" };
  }
  closeSeg() {
    if (!this.seg) return;
    if (this.seg.kind === "text") {
      renderMarkdown(this.seg.el, this.seg.text);
      this.seg.el.classList.remove("cursor");
    } else {
      this.seg.el.classList.remove("live");
      $("summary", this.seg.el).textContent = "Quá trình suy nghĩ";
    }
    this.seg = null;
  }
  scheduleRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      if (this.seg && this.seg.kind === "text") renderMarkdown(this.seg.el, this.seg.text);
      scrollDown();
    });
  }

  handle(ev, live = true) {
    if (ev.type !== "usage" && ev.type !== "title") this.clearWaiting();
    switch (ev.type) {
      case "block_start":
        this.closeSeg();
        ev.kind === "thinking" ? this.newThinking() : this.newText();
        break;
      case "thinking":
        if (!this.seg || this.seg.kind !== "thinking") { this.closeSeg(); this.newThinking(); }
        this.seg.text += ev.text;
        $(".t-body", this.seg.el).textContent = this.seg.text;
        break;
      case "text":
        if (!this.seg || this.seg.kind !== "text") { this.closeSeg(); this.newText(); }
        this.seg.text += ev.text;
        live ? this.scheduleRender() : null;
        break;
      case "tool_start":
        this.closeSeg();
        this.toolCard(ev.id, ev.name);
        break;
      case "tool_progress":
        if (this.lastTool) $(".t-sum", this.lastTool.el).textContent = `đang viết… ${(this.lastTool.chars += ev.chars).toLocaleString()} ký tự`;
        break;
      case "tool_call":
        this.toolCall(ev);
        break;
      case "tool_result":
        this.toolResult(ev, live);
        break;
      case "usage":
        this.tokens.input += ev.input; this.tokens.output += ev.output; this.tokens.speed = ev.speed || this.tokens.speed;
        break;
      case "notice":
      case "error":
        this.closeSeg();
        this.body.insertAdjacentHTML("beforeend", `<div class="alert ${ev.type}">${esc(ev.message || ev.text)}</div>`);
        break;
      case "done":
        this.finish();
        break;
    }
    if (live) scrollDown();
  }

  finish() {
    this.clearWaiting();
    this.closeSeg();
    for (const t of Object.values(this.tools)) {
      const sp = $(".spinner", t.el);
      if (sp) sp.outerHTML = `<span class="badge ERR">Dừng</span>`;
    }
    if (this.tokens.output) {
      this.body.insertAdjacentHTML("beforeend",
        `<div class="usage-line">${this.tokens.output.toLocaleString()} token viết ra · ${this.tokens.speed} token/giây</div>`);
    }
  }

  toolCard(id, name) {
    const titles = { run_code: "⚙️ Chạy thử code", stress_test: "🎲 Stress test", save_web_files: "💾 Lưu website", extract_tests: "📋 Lấy test mẫu từ đề" };
    const el = document.createElement("div");
    el.className = "tool";
    el.innerHTML = `<div class="tool-head"><div class="spinner"></div><span class="t-name">${titles[name] || esc(name)}</span><span class="t-sum">${name === "extract_tests" ? "đang đọc đề…" : "đang viết…"}</span></div><div class="tool-body"></div>`;
    $(".tool-head", el).onclick = () => el.classList.toggle("open");
    this.body.appendChild(el);
    this.tools[id] = { el, name, chars: 0 };
    this.lastTool = this.tools[id];
    return this.tools[id];
  }

  toolCall(ev) {
    const t = this.tools[ev.id] || this.toolCard(ev.id, ev.name);
    const inp = ev.input || {};
    const sum = $(".t-sum", t.el), body = $(".tool-body", t.el);
    t.input = inp;
    if (ev.name === "run_code") {
      sum.textContent = `${LANG_NAMES[inp.language] || inp.language} · ${(inp.tests || []).length} test — đang chạy…`;
      body.innerHTML = `<pre><code>${esc(inp.code)}</code></pre>`;
      const btn = document.createElement("button");
      btn.className = "btn ghost small";
      btn.textContent = "▶ Mở trong trình chấm (kèm test)";
      btn.onclick = () => openInJudge(inp.language, inp.code, inp.tests, inp.time_limit);
      body.appendChild(btn);
    } else if (ev.name === "stress_test") {
      sum.textContent = `${inp.iterations || 200} test ngẫu nhiên — đang chạy…`;
      body.innerHTML = `<b>Lời giải (${esc(inp.solution_language)})</b><pre><code>${esc(inp.solution_code)}</code></pre>
        <b>Brute force (${esc(inp.brute_language)})</b><pre><code>${esc(inp.brute_code)}</code></pre>
        <b>Generator</b><pre><code>${esc(inp.generator_code)}</code></pre>`;
    } else if (ev.name === "save_web_files") {
      const files = (inp.files || []).map((f) => f.path);
      sum.textContent = files.join(", ");
    }
  }

  toolResult(ev, live) {
    const t = this.tools[ev.id] || this.toolCard(ev.id, ev.name);
    const out = ev.output || {};
    const sum = $(".t-sum", t.el), body = $(".tool-body", t.el);
    const setBadge = (v, label) => {
      const sp = $(".spinner", t.el);
      const html = `<span class="badge ${esc(v)}">${esc(label || VERDICT_TEXT[v] || v)}</span>`;
      sp ? (sp.outerHTML = html) : null;
    };
    if (out.error) {
      setBadge("ERR");
      body.insertAdjacentHTML("beforeend", `<pre>${esc(out.error)}</pre>`);
      return;
    }
    if (ev.name === "extract_tests") {
      const n = out.tests.length;
      setBadge(n ? "OK" : "TLE", n ? `${n} test` : out.reused ? "dùng test cũ" : "không có");
      sum.textContent = n ? "" : out.reused ? "không thấy test mới, dùng lại test của đề trước" : "đề không có ví dụ input/output";
      body.innerHTML = out.tests.map((t, i) => `<b>Test ${i + 1}</b><pre>Input:\n${esc(t.input)}\nOutput:\n${esc(t.expected_output)}</pre>`).join("");
    } else if (ev.name === "run_code") {
      setBadge(out.verdict, out.verdict === "CE" ? "CE" : `${out.verdict} ${out.passed ?? 0}/${out.total ?? 0}`);
      sum.textContent = sum.textContent.replace(" — đang chạy…", "");
      body.insertAdjacentHTML("beforeend", renderJudge(out));
    } else if (ev.name === "stress_test") {
      setBadge(out.result);
      sum.textContent = out.result === "ALL_PASSED" ? `${out.iterations_passed} test ngẫu nhiên đều khớp` : `lệch ở seed ${out.seed ?? "?"}`;
      body.insertAdjacentHTML("beforeend", `<pre>${esc(JSON.stringify(out, null, 2))}</pre>`);
      if (out.result !== "ALL_PASSED") t.el.classList.add("open");
    } else if (ev.name === "save_web_files") {
      setBadge("OK", "Đã lưu");
      sum.textContent = `${out.saved.length} file · ${out.all_files.length} file trong dự án`;
      state.previewUrl = out.preview_url;
      if (live) showPreview(true);
    }
  }
}

function renderJudge(out) {
  if (out.verdict === "CE") return `<b>Lỗi biên dịch</b><pre>${esc(out.compile_error)}</pre>`;
  return (out.tests || []).map((t) => {
    let extra = "";
    if (t.verdict !== "AC" && t.verdict !== "OK" || t.stderr) {
      extra = `<pre>Output:\n${esc(t.stdout)}${t.expected_output != null ? `\nExpected:\n${esc(t.expected_output)}` : ""}${t.stderr ? `\nStderr:\n${esc(t.stderr)}` : ""}</pre>`;
    } else if (t.verdict === "OK") {
      extra = `<pre>${esc(t.stdout)}</pre>`;
    }
    return `<div class="test-row"><span>Test ${t.test}</span><span class="badge ${t.verdict}">${t.verdict}</span><span class="time">${t.time}s</span></div>${extra}`;
  }).join("");
}

/* ================= Conversations ================= */

function clearMessages() {
  [...els.messages.children].forEach((c) => c !== els.welcome && c.remove());
}

function newChat() {
  if (state.controller) return;
  state.convId = null;
  state.previewUrl = null;
  history.replaceState(null, "", location.pathname);
  clearMessages();
  els.welcome.classList.remove("hidden");
  els.title.textContent = "CodeMaster";
  refreshConversations();
  loadPreviewFiles();
  els.input.focus();
}

async function openConversation(id) {
  if (state.controller) return;
  const conv = await api(`/api/conversations/${id}`);
  state.convId = id;
  state.previewUrl = conv.preview_url;
  history.replaceState(null, "", "#c=" + id);
  clearMessages();
  els.title.textContent = conv.title;
  let turn = null;
  for (const ev of conv.events) {
    if (ev.type === "user") {
      if (turn) turn.finish();
      addUserMessage(ev.text, ev.images);
      turn = new Turn();
    } else if (turn) {
      turn.handle(ev, false);
      if (ev.type === "done") turn = null;
    }
  }
  if (turn) turn.finish();
  if (!conv.events.length) els.welcome.classList.remove("hidden");
  scrollDown(true);
  refreshConversations();
  $("#sidebar").classList.remove("open");
  if (!els.panel.classList.contains("hidden") && !$("#tab-preview").classList.contains("hidden")) showPreview();
}

/* ================= Sending ================= */

function setBusy(busy) {
  els.send.textContent = busy ? "■ Dừng" : "Gửi ➤";
  els.send.classList.toggle("danger", busy);
  els.send.classList.toggle("primary", !busy);
}

async function send(text) {
  text = text.trim();
  if (!text && !state.images.length) return;
  if (!els.model.value) return alert("Chưa có model nào. Mở Terminal và chạy: ollama pull qwen3:4b");
  if (!state.convId) {
    const c = await api("/api/conversations", { method: "POST" });
    state.convId = c.id;
    history.replaceState(null, "", "#c=" + c.id);
  }
  const images = state.images.map((im) => ({ media_type: im.media_type, data: im.data }));
  addUserMessage(text, images.length);
  els.input.value = "";
  autosize();
  state.images = [];
  renderAttachments();

  const turn = new Turn();
  state.controller = new AbortController();
  setBusy(true);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: state.convId, text, images, mode: els.mode.value, model: els.model.value, think: els.think.checked }),
      signal: state.controller.signal,
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.detail || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", finished = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!chunk.startsWith("data: ")) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (ev.type === "title") { els.title.textContent = ev.title; refreshConversations(); continue; }
        if (ev.type === "done") { if (!finished) turn.handle(ev); finished = true; continue; }
        turn.handle(ev);
        if (ev.type === "usage") els.usage.textContent = `${turn.tokens.speed} token/giây`;
      }
    }
    if (!finished) turn.finish();
  } catch (err) {
    if (err.name === "AbortError") turn.handle({ type: "notice", text: "Đã dừng." });
    else turn.handle({ type: "error", message: err.message });
    turn.finish();
  } finally {
    state.controller = null;
    setBusy(false);
    refreshConversations();
  }
}

/* ================= Attachments ================= */

function addImageFile(file) {
  if (!file.type.startsWith("image/")) return;
  if (file.size > 5 * 1024 * 1024) return alert("Ảnh quá lớn (tối đa 5MB).");
  const r = new FileReader();
  r.onload = () => {
    const url = r.result;
    state.images.push({ url, media_type: file.type, data: url.split(",")[1] });
    renderAttachments();
  };
  r.readAsDataURL(file);
}
function renderAttachments() {
  els.attachments.innerHTML = "";
  state.images.forEach((im, i) => {
    const d = document.createElement("div");
    d.className = "thumb";
    d.innerHTML = `<img src="${im.url}" alt="ảnh đính kèm"><button type="button" title="Bỏ">✕</button>`;
    d.querySelector("button").onclick = () => { state.images.splice(i, 1); renderAttachments(); };
    els.attachments.appendChild(d);
  });
}

/* ================= Judge panel ================= */

const editor = CodeMirror.fromTextArea($("#editor"), {
  theme: "material-darker", lineNumbers: true, mode: "text/x-c++src", indentUnit: 4, tabSize: 4,
  matchBrackets: true, autoCloseBrackets: true,
});
editor.setValue(`#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    long long a, b;
    cin >> a >> b;
    cout << a + b << "\\n";
}
`);
let tests = [{ input: "1 2", expected_output: "3" }];
const MODES = { cpp: "text/x-c++src", c: "text/x-csrc", python: "python" };

function renderTests() {
  const box = $("#tests");
  box.innerHTML = "";
  tests.forEach((t, i) => {
    const card = document.createElement("div");
    card.className = "test-card";
    card.innerHTML = `<textarea placeholder="Input test ${i + 1}" spellcheck="false"></textarea>
      <textarea placeholder="Output mong đợi (bỏ trống = chỉ xem output)" spellcheck="false"></textarea>
      <button class="icon-btn" title="Xoá test">✕</button>`;
    const [inp, exp] = card.querySelectorAll("textarea");
    inp.value = t.input; exp.value = t.expected_output ?? "";
    inp.oninput = () => (t.input = inp.value);
    exp.oninput = () => (t.expected_output = exp.value);
    card.querySelector("button").onclick = () => { tests.splice(i, 1); renderTests(); };
    box.appendChild(card);
  });
}

function openInJudge(lang, code, newTests, tl) {
  $("#judgeLang").value = lang;
  editor.setOption("mode", MODES[lang]);
  editor.setValue(code);
  if (newTests && newTests.length) tests = newTests.map((t) => ({ input: t.input, expected_output: t.expected_output ?? "" }));
  if (tl) $("#judgeTL").value = tl;
  renderTests();
  $("#judgeResult").innerHTML = "";
  showTab("judge");
}

async function runJudge() {
  const btn = $("#runBtn");
  btn.disabled = true;
  btn.textContent = "Đang chạy…";
  $("#judgeResult").innerHTML = `<div class="test-row"><div class="spinner"></div> Đang biên dịch và chạy…</div>`;
  try {
    const out = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({
        language: $("#judgeLang").value, code: editor.getValue(), time_limit: parseFloat($("#judgeTL").value) || 2,
        tests: tests.map((t) => ({ input: t.input, expected_output: t.expected_output === "" ? null : t.expected_output })),
      }),
    });
    const head = out.verdict === "CE" ? "" :
      `<div class="test-row"><b>Kết quả:</b><span class="badge ${out.verdict}">${out.verdict}</span><span>${out.passed}/${out.total} test</span></div>`;
    $("#judgeResult").innerHTML = head + renderJudge(out);
  } catch (e) {
    $("#judgeResult").innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ Chạy";
  }
}

/* ================= Preview panel ================= */

function showTab(name) {
  els.panel.classList.remove("hidden");
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("#tab-judge").classList.toggle("hidden", name !== "judge");
  $("#tab-preview").classList.toggle("hidden", name !== "preview");
  if (name === "judge") setTimeout(() => editor.refresh(), 0);
}

async function loadPreviewFiles() {
  state.files = state.convId ? await api(`/api/conversations/${state.convId}/files`).catch(() => []) : [];
  const sel = $("#fileSelect");
  sel.innerHTML = `<option value="">🌐 Xem trước</option>` + state.files.map((f) => `<option value="${esc(f.path)}">📄 ${esc(f.path)}</option>`).join("");
  if (!state.previewUrl && state.files.some((f) => f.path === "index.html")) state.previewUrl = `/preview/${state.convId}/index.html`;
}

async function showPreview(reload) {
  showTab("preview");
  await loadPreviewFiles();
  const has = !!state.previewUrl;
  $("#emptyPreview").classList.toggle("hidden", has);
  $("#previewFrame").classList.toggle("hidden", !has);
  $("#fileView").classList.add("hidden");
  $("#fileSelect").value = "";
  if (has) {
    $("#previewFrame").src = state.previewUrl + "?t=" + Date.now();
    $("#openTab").href = state.previewUrl;
  }
}

$("#fileSelect").onchange = (e) => {
  const path = e.target.value;
  if (!path) return showPreview();
  const f = state.files.find((x) => x.path === path);
  const view = $("#fileView");
  const code = $("code", view);
  code.className = "";
  code.textContent = f ? f.content : "";
  try { hljs.highlightElement(code); } catch {}
  view.classList.remove("hidden");
  $("#previewFrame").classList.add("hidden");
  $("#emptyPreview").classList.add("hidden");
};

/* ================= Wiring ================= */

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 260) + "px";
}

$("#composer").onsubmit = (e) => {
  e.preventDefault();
  if (state.controller) state.controller.abort();
  else send(els.input.value);
};
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!state.controller) send(els.input.value);
  }
});
els.input.addEventListener("input", autosize);
els.input.addEventListener("paste", (e) => {
  for (const item of e.clipboardData.items) if (item.kind === "file") addImageFile(item.getAsFile());
});
$("#fileInput").onchange = (e) => { [...e.target.files].forEach(addImageFile); e.target.value = ""; };

document.querySelectorAll(".starter").forEach((b) => (b.onclick = () => {
  els.input.value = b.dataset.prompt;
  els.mode.value = b.dataset.mode;
  savePref("mode", els.mode.value);
  autosize();
  els.input.focus();
}));
$("#newChat").onclick = newChat;
$("#toggleSidebar").onclick = () => $("#sidebar").classList.toggle("open");
$("#openJudge").onclick = () => showTab("judge");
$("#openPreview").onclick = () => showPreview();
$("#closePanel").onclick = () => els.panel.classList.add("hidden");
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => (t.dataset.tab === "preview" ? showPreview() : showTab("judge"))));
$("#reloadPreview").onclick = () => showPreview();
$("#judgeLang").onchange = (e) => editor.setOption("mode", MODES[e.target.value]);
$("#addTest").onclick = () => { tests.push({ input: "", expected_output: "" }); renderTests(); };
$("#runBtn").onclick = runJudge;
editor.setOption("extraKeys", { "Ctrl-Enter": runJudge, "Cmd-Enter": runJudge });

els.mode.value = loadPref("mode") || "cp";
els.think.checked = loadPref("think") === "1";
els.mode.onchange = () => savePref("mode", els.mode.value);
els.model.onchange = () => { savePref("model", els.model.value); updateThinkToggle(); };
els.think.onchange = () => savePref("think", els.think.checked ? "1" : "0");

renderTests();
refreshStatus();
refreshConversations();
if (location.hash.startsWith("#c=")) openConversation(location.hash.slice(3)).catch(() => newChat());
