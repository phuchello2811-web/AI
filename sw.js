// Service worker: lets CodeMaster open and work without a network (with a Qwen model downloaded in the
// browser). App files are fetched network-first, so updates show up as soon as there is a connection,
// with the cached copy as the offline fallback. Libraries from CDNs have a version in their URL and never
// change, so they are served from the cache after the first use (KaTeX, CodeMirror, the C++ compiler,
// Pyodide, WebLLM). AI requests, the local API and model weights (cached by WebLLM itself) are left alone.

const CACHE = "codemaster-v3";
const APP_SHELL = [
  "./", "./index.html", "./manifest.webmanifest",
  "./static/app.js", "./static/style.css", "./static/logo.svg", "./static/knowledge.json", "./static/prompts.json",
  "./static/browser/backend.js", "./static/browser/agent.js", "./static/browser/models.js", "./static/browser/cloud.js",
  "./static/browser/puter.js", "./static/browser/judge.js", "./static/browser/runtime.js", "./static/browser/ui-audit.js",
  "./static/browser/compile-worker.js", "./static/browser/run-worker.js", "./static/browser/py-worker.js",
  "./static/browser/llm.js", "./static/browser/llm-worker.js", "./static/browser/ocr.js",
];
// Libraries and fonts the page loads with <script>/<link> (fetched without CORS, so their responses are opaque).
const PAGE_LIBS = ["https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap", "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css", "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css", "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/material-darker.min.css", "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css", "https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js", "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js", "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js", "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js", "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js", "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/clike/clike.min.js", "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/python/python.min.js", "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/matchbrackets.min.js", "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/closebrackets.min.js"];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|esm\.run|unpkg\.com|fonts\.gstatic\.com|tessdata\.projectnaptha\.com)\//;
const FONTS_CSS = /^https:\/\/fonts\.googleapis\.com\//;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_SHELL).catch(() => {});
    await Promise.all(PAGE_LIBS.map(async (url) => {
      try { const request = new Request(url, { mode: "no-cors" }); await cache.put(request, await fetch(request)); } catch {}
    }));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (cacheable(response)) cache.put(request, response.clone());
    return response;
  } catch (e) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
    if (cached) return cached;
    if (request.mode === "navigate") return (await cache.match("./index.html")) || Response.error();
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (cacheable(response)) cache.put(request, response.clone());
  return response;
}

// Opaque (no-cors) responses from CDNs have status 0 but are the real file; they are fine to keep.
const cacheable = (response) => response.ok || response.type === "opaque";

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    // The Ollama server's API and site previews are live data, never cached.
    if (url.pathname.includes("/api/") || url.pathname.includes("/preview/")) return;
    event.respondWith(networkFirst(request));
  } else if (CDN.test(request.url)) {
    event.respondWith(cacheFirst(request));
  } else if (FONTS_CSS.test(request.url)) {
    event.respondWith(networkFirst(request));
  }
});
