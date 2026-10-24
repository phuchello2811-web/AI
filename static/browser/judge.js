// In-browser judge with the same results as sandbox.py (run_tests / stress_test), so the agent and the
// UI treat both backends alike. Programs run in workers; a worker that overruns the time limit is
// terminated and replaced, which is how TLE and infinite loops are handled.

import { ioFiles, outputsMatch, truncate } from "./runtime.js";

// WebAssembly and Pyodide run slower than native code, so the measured time gets this much slack.
const BROWSER_SLOWDOWN = 2;

class WorkerSlot {
  constructor(url) {
    this.url = url;
    this.worker = null;
    this.seq = 0;
  }
  call(message, transfer = [], timeoutMs = 0, onProgress = null) {
    if (!this.worker) this.worker = new Worker(this.url, { type: "module" });
    const id = ++this.seq;
    return new Promise((resolve) => {
      let timer = null;
      const done = (value) => {
        clearTimeout(timer);
        this.worker && this.worker.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = ({ data }) => {
        if (data.id !== id) return;
        if (data.progress) return onProgress && onProgress(data.progress);
        done(data);
      };
      this.worker.addEventListener("message", onMessage);
      this.worker.onerror = (e) => { this.reset(); done({ error: `Worker lỗi: ${e.message || "không tải được"}` }); };
      if (timeoutMs) timer = setTimeout(() => { this.reset(); done({ timeout: true }); }, timeoutMs);
      this.worker.postMessage({ id, ...message }, transfer);
    });
  }
  reset() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}

const slots = {
  compile: new WorkerSlot(new URL("./compile-worker.js", import.meta.url)),
  native: new WorkerSlot(new URL("./run-worker.js", import.meta.url)),
  python: new WorkerSlot(new URL("./py-worker.js", import.meta.url)),
};
const compiled = new Map(); // language + source -> WebAssembly.Module, so stress tests compile once

export const LANGUAGES = ["cpp", "c", "python"];
const ALIASES = { "c++": "cpp", cc: "cpp", cxx: "cpp", py: "python", python3: "python" };

export function normalizeLanguage(language) {
  const lang = ALIASES[(language || "").trim().toLowerCase()] || (language || "").trim().toLowerCase();
  if (!LANGUAGES.includes(lang)) throw new Error(`Unsupported language '${language}'. Use one of: ${LANGUAGES.join(", ")}`);
  return lang;
}

/** A compiled (or interpreted) program; `onStatus(text)` reports slow first-time downloads. */
async function prepare(language, code, onStatus) {
  const lang = normalizeLanguage(language);
  const prog = { lang, code, ...ioFiles(code) };
  if (lang === "python") return prog;
  const key = lang + "\0" + code;
  if (!compiled.has(key)) {
    let shown = false;
    const res = await slots.compile.call({ language: lang, code }, [], 0, ({ done, total }) => {
      if (total && done < total) {
        shown = true;
        onStatus && onStatus(`đang tải trình biên dịch C++ (chỉ lần đầu) ${Math.round(done / 1048576)}/${Math.round(total / 1048576)} MB…`);
      } else if (shown) onStatus && onStatus("đang biên dịch…");
    });
    if (res.error) return { ...prog, compileError: res.error };
    compiled.set(key, await WebAssembly.compile(res.wasm));
  }
  prog.module = compiled.get(key);
  return prog;
}

async function execute(prog, stdin, timeLimit, args = []) {
  const opts = { stdin, args, inputFile: prog.inputFile, outputFile: prog.outputFile };
  const wallMs = (timeLimit * BROWSER_SLOWDOWN * 2 + 1) * 1000;
  const r = prog.lang === "python"
    ? await slots.python.call({ code: prog.code, opts }, [], wallMs + 15000) // + Pyodide start-up on first use
    : await slots.native.call({ module: prog.module, opts }, [], wallMs);
  if (r.timeout) return { status: "TLE", time: wallMs / 1000, stdout: "", stderr: "" };
  if (r.error) return { status: "RE", time: 0, stdout: "", stderr: r.error, exit_code: 1 };
  let status = "OK";
  if (r.exit_code !== 0) status = "RE";
  else if (r.time > timeLimit * BROWSER_SLOWDOWN) status = "TLE";
  return { status, time: +r.time.toFixed(3), exit_code: r.exit_code, stdout: r.stdout, stderr: r.stderr };
}

/** Run code on each test {input, expected_output|null}; result shaped like sandbox.run_tests. */
export async function runTests(language, code, tests, timeLimit = 2, onStatus) {
  timeLimit = Math.max(0.1, Math.min(Number(timeLimit) || 2, 10));
  const prog = await prepare(language, code, onStatus);
  if (prog.compileError) return { verdict: "CE", compile_error: prog.compileError, tests: [] };
  const results = [];
  const list = tests && tests.length ? tests : [{ input: "" }];
  for (let i = 0; i < list.length; i++) {
    const r = await execute(prog, list[i].input || "", timeLimit);
    const expected = list[i].expected_output;
    let verdict = r.status;
    if (verdict === "OK" && expected != null) verdict = outputsMatch(r.stdout, expected) ? "AC" : "WA";
    const item = { test: i + 1, verdict, time: r.time, stdout: truncate(r.stdout) };
    if (r.stderr) item.stderr = truncate(r.stderr, 1000);
    if (verdict === "WA") item.expected_output = truncate(expected);
    results.push(item);
  }
  const bad = results.filter((r) => r.verdict !== "AC" && r.verdict !== "OK");
  return {
    verdict: bad.length ? bad[0].verdict : results.every((r) => r.verdict === "AC") ? "AC" : "OK",
    passed: results.length - bad.length, total: results.length, tests: results,
  };
}

/** Random-test `solution` against `brute` with a Python generator taking the seed as argv[1] (sandbox.stress_test). */
export async function stressTest(generatorCode, solution, brute, iterations = 150, timeLimit = 2, budgetSeconds = 45, onStatus) {
  iterations = Math.max(1, Math.min(iterations | 0, 2000));
  const progs = {};
  for (const [name, [lang, code]] of Object.entries({
    generator: ["python", generatorCode], solution: [solution.language, solution.code], brute: [brute.language, brute.code],
  })) {
    progs[name] = await prepare(lang, code, onStatus);
    if (progs[name].compileError) return { result: "CE", program: name, compile_error: progs[name].compileError };
  }
  const deadline = performance.now() + budgetSeconds * 1000;
  for (let seed = 1; seed <= iterations; seed++) {
    if (performance.now() > deadline) return { result: "BUDGET_EXHAUSTED", iterations_passed: seed - 1 };
    if (onStatus && seed % 10 === 1) onStatus(`đang chạy test ngẫu nhiên ${seed}/${iterations}…`);
    const gen = await execute(progs.generator, "", 10, [String(seed)]);
    if (gen.status !== "OK") return { result: "GENERATOR_FAILED", seed, stderr: truncate(gen.stderr) };
    const input = gen.stdout;
    const ref = await execute(progs.brute, input, timeLimit * 5);
    if (ref.status !== "OK" || !ref.stdout.trim()) {
      return { result: "BRUTE_FAILED", seed, input: truncate(input), status: ref.status,
               stderr: truncate(ref.stderr || "lời giải trâu không in ra gì") };
    }
    const got = await execute(progs.solution, input, timeLimit);
    if (got.status !== "OK" || !outputsMatch(got.stdout, ref.stdout)) {
      return {
        result: got.status === "OK" ? "MISMATCH" : got.status, seed, input: truncate(input),
        expected_output: truncate(ref.stdout), solution_output: truncate(got.stdout), stderr: truncate(got.stderr, 1000),
      };
    }
  }
  return { result: "ALL_PASSED", iterations_passed: iterations };
}

/** Fetch and start the compiler and Pyodide ahead of time (both are cached by the browser afterwards). */
export async function warmup() {
  await runTests("cpp", "int main() { return 0; }", [{ input: "" }], 2);
  await runTests("python", "pass", [{ input: "" }], 2);
}

/**
 * Speed check on the largest input: run `generatorCode` (Python, seed in argv[1]) to build one maximum-size
 * test, then run the solution on it. Returns {result: "OK" | "TLE" | "RE" | "CE" | "GENERATOR_FAILED", time, size}.
 */
export async function perfTest(generatorCode, solution, timeLimit = 2, onStatus) {
  const gen = await prepare("python", generatorCode, onStatus);
  onStatus && onStatus("đang sinh test lớn nhất…");
  const made = await execute(gen, "", 20, ["1"]);
  if (made.status !== "OK" || !made.stdout.trim()) {
    return { result: "GENERATOR_FAILED", stderr: truncate(made.stderr || "generator không in ra gì") };
  }
  const prog = await prepare(solution.language, solution.code, onStatus);
  if (prog.compileError) return { result: "CE", compile_error: prog.compileError };
  onStatus && onStatus(`đang chạy lời giải trên test ${Math.round(made.stdout.length / 1024)} KB…`);
  const r = await execute(prog, made.stdout, timeLimit);
  return { result: r.status, time: r.time, size: made.stdout.length, stderr: truncate(r.stderr || "", 1000),
           input_head: truncate(made.stdout, 300) };
}
