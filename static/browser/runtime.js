// Compile and run contestant code inside the browser, mirroring sandbox.py: C/C++ is compiled to
// WebAssembly by Clang (itself running as WebAssembly) and run under a WASI shim. Libraries are passed
// in by the caller so this file works the same in a browser worker and in Node tests.

const HEADERS = [
  "cassert", "cctype", "cerrno", "cfloat", "climits", "cmath", "cstdio", "cstdlib", "cstring", "ctime",
  "cstdint", "cinttypes", "cstddef", "algorithm", "array", "bitset", "chrono", "complex", "deque",
  "functional", "iomanip", "iostream", "istream", "ostream", "sstream", "fstream", "iterator", "limits",
  "list", "map", "memory", "numeric", "queue", "random", "ratio", "set", "stack", "string", "tuple",
  "type_traits", "unordered_map", "unordered_set", "utility", "valarray", "vector", "optional", "variant",
  "string_view", "bit", "numbers",
];
// <bits/stdc++.h> and the GCC-only helpers contestants rely on (libc++ has neither).
const STDCXX_SHIM = `#pragma once
${HEADERS.map((h) => `#include <${h}>`).join("\n")}
inline int __lg(unsigned long long x) { return 63 - __builtin_clzll(x); }
inline int __lg(long long x) { return __lg((unsigned long long)x); }
inline int __lg(unsigned long x) { return __lg((unsigned long long)x); }
inline int __lg(long x) { return __lg((unsigned long long)x); }
inline int __lg(unsigned x) { return __lg((unsigned long long)x); }
inline int __lg(int x) { return __lg((unsigned long long)x); }
template <class T> T __gcd(T a, T b) { while (b) { T t = a % b; a = b; b = t; } return a; }
`;

const STACK_BYTES = 64 << 20;
const MAX_OUTPUT_CHARS = 3000;
const INPUT_FILE_RE = /["']([\w-]+\.(?:inp|in))["']/i;
const OUTPUT_FILE_RE = /["']([\w-]+\.(?:out|ans))["']/i;

export function ioFiles(code) {
  return { inputFile: (code.match(INPUT_FILE_RE) || [])[1], outputFile: (code.match(OUTPUT_FILE_RE) || [])[1] };
}

export function truncate(text, limit = MAX_OUTPUT_CHARS) {
  return text.length <= limit ? text : text.slice(0, limit) + `\n...[truncated, ${text.length - limit} more chars]`;
}

/** Token-wise comparison, ignoring whitespace; numbers compared with tolerance (as sandbox.outputs_match). */
export function outputsMatch(actual, expected, eps = 1e-6) {
  const a = actual.split(/\s+/).filter(Boolean), e = expected.split(/\s+/).filter(Boolean);
  if (a.length !== e.length) return false;
  return a.every((x, i) => {
    if (x === e[i]) return true;
    const fx = Number(x), fy = Number(e[i]);
    return x.trim() !== "" && e[i].trim() !== "" && Number.isFinite(fx) && Number.isFinite(fy)
      && Math.abs(fx - fy) <= eps * Math.max(1, Math.abs(fy));
  });
}

/** Compile C/C++ with @yowasp/clang's runClang; returns {wasm} or {error}. */
export async function compileNative(runClang, language, code, fetchProgress) {
  const cpp = language === "cpp";
  const file = cpp ? "main.cpp" : "main.c";
  const args = [cpp ? "clang++" : "clang", cpp ? "-std=c++17" : "-std=c11", "-O2", "-fno-exceptions",
    "-Wno-everything", "-I", "inc", file, "-o", "main.wasm", `-Wl,-z,stack-size=${STACK_BYTES}`, "-lm"];
  let stderr = "";
  const dec = new TextDecoder();
  try {
    const out = await runClang(args, { [file]: code, inc: { bits: { "stdc++.h": STDCXX_SHIM } } }, {
      stderr: (bytes) => { if (bytes) stderr += dec.decode(bytes, { stream: true }); },
      fetchProgress,
    });
    return { wasm: out["main.wasm"] };
  } catch (e) {
    if (e && "code" in e) return { error: truncate(stderr.replace(/\/tmp\/[\w.-]+\.o/g, "main.o") || e.message) };
    throw e;
  }
}

/** Run a compiled WASI module once. `shim` is @bjorn3/browser_wasi_shim. */
export function runWasi(shim, module, { stdin = "", args = [], inputFile, outputFile }) {
  const { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory } = shim;
  const enc = new TextEncoder(), dec = new TextDecoder();
  let stdout = "", stderr = "";
  const files = inputFile ? [[inputFile, new File(enc.encode(stdin))]] : [];
  const dir = new PreopenDirectory(".", files);
  const fds = [
    new OpenFile(new File(enc.encode(stdin))),
    new ConsoleStdout((b) => { if (stdout.length < 1 << 24) stdout += dec.decode(b, { stream: true }); }),
    new ConsoleStdout((b) => { if (stderr.length < 1 << 16) stderr += dec.decode(b, { stream: true }); }),
    dir,
  ];
  const wasi = new WASI(["main", ...args], [], fds, { debug: false });
  const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport });
  const start = performance.now();
  let exitCode;
  try {
    exitCode = wasi.start(instance);
  } catch (e) {
    // Traps: out-of-bounds access, stack overflow, abort() (e.g. a failed assert or a would-be exception).
    exitCode = 134;
    stderr += (stderr ? "\n" : "") + String(e && e.message || e);
  }
  const time = (performance.now() - start) / 1000;
  const outFile = outputFile && dir.dir.contents.get(outputFile);
  if (outFile) stdout = dec.decode(outFile.data);
  return { exit_code: exitCode, time, stdout, stderr };
}
