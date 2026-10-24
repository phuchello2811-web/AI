// Compiles C/C++ to WebAssembly with Clang built for WebAssembly (~105 MB, downloaded once and cached).
import { runClang } from "https://cdn.jsdelivr.net/npm/@yowasp/clang@22.0.0-git20542-10/gen/bundle.js";
import { compileNative } from "./runtime.js";

const downloads = new Map();

self.onmessage = async ({ data: { id, language, code } }) => {
  const progress = (e) => {
    downloads.set(e.source, [e.doneLength, e.totalLength]);
    let done = 0, total = 0;
    for (const [d, t] of downloads.values()) { done += d; total += t; }
    self.postMessage({ id, progress: { done, total } });
  };
  try {
    const result = await compileNative(runClang, language, code, progress);
    self.postMessage({ id, ...result }, result.wasm ? [result.wasm.buffer] : []);
  } catch (e) {
    self.postMessage({ id, error: `Trình biên dịch gặp lỗi: ${e && e.message || e}` });
  }
};
