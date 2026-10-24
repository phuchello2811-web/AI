// The coding agent for the in-browser version: the same workflow as agent.py (analyse → look up
// knowledge → solve → judge samples → stress-test → fix → rethink), emitting the same UI events.
// Dependencies are injected so the workflow can be tested outside the browser.

export const NEW_PROBLEM_CHARS = 150;
export const EFFORTS = {
  fast: { analyze: false, kb: 2, fixRounds: 2, stress: false, rethink: false },
  deep: { analyze: true, kb: 3, fixRounds: 3, stress: false, rethink: false },
  max: { analyze: true, kb: 3, fixRounds: 3, stress: true, rethink: true },
};
const STRESS_ITERATIONS = 150;
const STRESS_BUDGET_SECONDS = 45;
const HISTORY_CHARS = 14000; // ~8K-token context minus the system prompt and the reply
// Caps for the helper calls: small models sometimes repeat themselves until the context is full.
const MAX_TOKENS = { extract: 800, analyze: 700, generator: 600, brute: 1000, reply: 4096 };

const FORMATS = ["stdin", "file_io", "multiple_cases_case_x", "interactive", "function_grader"];
const TEST_SCHEMA = {
  type: "object",
  properties: {
    tests: {
      type: "array",
      items: { type: "object", properties: { input: { type: "string" }, output: { type: "string" } }, required: ["input", "output"] },
    },
  },
  required: ["tests"],
};
const CODE_BLOCK_RE = /```([\w+#-]*)[^\n]*\n([\s\S]*?)```/g;
const CODE_LANGS = { cpp: "cpp", "c++": "cpp", cc: "cpp", c: "c", python: "python", py: "python", python3: "python" };
// Small models often claim "several answers accepted"; only believe it when the statement says so.
const ANY_ANSWER_RE = /\bany\b|bất k[ỳì]|nào cũng|nhiều đáp án|multiple (?:answers|solutions)/i;
const TIME_LIMIT_RE = /(\d+(?:[.,]\d+)?)\s*(?:giây|s\b|sec|second)/i;

/* ---------------- knowledge lookup (port of knowledge.py) ---------------- */

export function normalize(text) {
  return text.toLowerCase().replace(/đ/g, "d").normalize("NFD").replace(/\p{Mn}/gu, "").replace(/\s+/g, " ");
}

const NUM = String.raw`(10\s*\^\s*\{?\d+\}?|\d+(?:[.,]\d+)?\s*(?:(?:[·*x×.]|\\cdot)\s*10\s*\^\s*\{?\d+\}?|e\d+)?)`;
const BOUND_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_])([A-Za-z][\p{L}\p{N}_]{0,2}|\|[a-z][\p{L}\p{N}_]{0,2}\|)\s*(?:≤|<=|<|\\le)\s*` + NUM, "gu");
const SIZE_VARS = new Set(["n", "m", "q", "k", "t", "|s|"]);

function parseNumber(text) {
  text = text.replace(/\s/g, "");
  let m = text.match(/^10\^\{?(\d+)\}?$/);
  if (m) return 10 ** +m[1];
  m = text.match(/^(\d+(?:[.,]\d+)?)(?:(?:[·*x×.]|\\cdot)10\^\{?(\d+)\}?|e(\d+))?$/);
  if (!m) return 0;
  const exp = m[2] || m[3];
  return parseFloat(m[1].replace(",", ".")) * (exp ? 10 ** +exp : 1);
}

export function bounds(statement) {
  let size = 0, value = 0;
  for (const m of statement.replace(/\u2009/g, " ").matchAll(BOUND_RE)) {
    const x = parseNumber(m[2]);
    if (SIZE_VARS.has(m[1].toLowerCase())) size = Math.max(size, x);
    else value = Math.max(value, x);
  }
  return [size, value];
}

const fmt = (x) => (x >= 1e6 ? x.toExponential() : String(x));

export function constraintHint(statement) {
  const [n, value] = bounds(statement);
  if (n <= 0) {
    return value >= 1e9 ? `Giá trị tới ${fmt(value)} ⇒ không duyệt từng giá trị: cần O(√X), O(log X) hoặc công thức.` : "";
  }
  const target = n <= 11 ? "O(n!) hoặc vét cạn" : n <= 25 ? "O(2^n · n) — bitmask" : n <= 45 ? "O(2^(n/2)) — meet in the middle"
    : n <= 500 ? "O(n^3)" : n <= 5000 ? "O(n^2)" : n <= 1e6 ? "O(n log n) hoặc O(n √n)" : n <= 1e8 ? "O(n)"
    : "O(√n), O(log n) hoặc công thức (không duyệt từng giá trị)";
  return `Kích thước lớn nhất n ≈ ${fmt(n)} ⇒ độ phức tạp mục tiêu: ${target}.`;
}

function boundTopics(statement) {
  const [n, value] = bounds(statement);
  if (n > 0 && n <= 25) return ["dp_bitmask"];
  if (n > 25 && n <= 45) return ["meet_middle"];
  if (n >= 1e12 || (!n && value >= 1e12)) return ["matrix_expo", "number_theory", "binary_search"];
  return [];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createKnowledge(entries) {
  const keyRes = new Map(entries.map((e) => [e.id, e.keys.map((k) => [k.split(" ").length,
    new RegExp(`(?<![a-z0-9])${escapeRe(normalize(k))}(?![a-z0-9])`)])]));
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    entries, byId, ids: entries.map((e) => e.id),
    retrieve(text, topics = [], k = 3, minScore = 2) {
      const norm = normalize(text);
      const chosen = new Set([...(topics || []), ...boundTopics(text)]);
      return entries
        .map((e) => [keyRes.get(e.id).reduce((s, [w, re]) => s + (re.test(norm) ? w : 0), 0) + (chosen.has(e.id) ? 6 : 0), e])
        .filter(([score]) => score >= minScore)
        .sort((a, b) => b[0] - a[0])
        .slice(0, k)
        .map(([, e]) => e);
    },
  };
}

function knowledgePrompt(entries) {
  if (!entries.length) return "";
  return "Kiến thức tham khảo (chỉ dùng phần liên quan):\n\n" + entries.map((e) => `### ${e.title}\n${e.body}`).join("\n\n");
}

/* ---------------- helpers ---------------- */

/** True when the end of `text` is one short chunk repeated over and over ("0, 0, 0, ..."). */
export function isLooping(text) {
  const tail = text.slice(-400);
  if (tail.length < 400) return false;
  for (let p = 1; p <= 80; p++) {
    let i = 0;
    while (i + p < tail.length && tail[i] === tail[i + p]) i++;
    if (i + p >= tail.length) return true;
  }
  return false;
}

export function lastCodeBlock(text, langs) {
  const blocks = [...text.matchAll(CODE_BLOCK_RE)].reverse();
  for (const [, lang, body] of blocks) if (langs[lang.toLowerCase()]) return [langs[lang.toLowerCase()], body];
  return null;
}

function trimHistory(messages, systemChars) {
  const budget = Math.max(4000, HISTORY_CHARS - systemChars);
  const kept = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    total += messages[i].content.length;
    if (kept.length && total > budget) break;
    kept.unshift({ role: messages[i].role, content: messages[i].content });
  }
  while (kept.length > 1 && kept[0].role !== "user") kept.shift();
  return kept;
}

function testsLookReal(test, statement) {
  const words = new Set(statement.split(/\s+/));
  const tokens = [...test.input.split(/\s+/), ...test.output.split(/\s+/)].filter(Boolean);
  return test.output.trim() !== "" && tokens.every((t) => words.has(t));
}

function timeLimitOf(analysis, statement) {
  let tl = analysis.time_limit_seconds;
  if (typeof tl !== "number" || tl <= 0) {
    const m = statement.match(TIME_LIMIT_RE);
    tl = m ? parseFloat(m[1].replace(",", ".")) : 2;
  }
  return Math.max(0.5, Math.min(tl, 10));
}

function failureFeedback(result, tests, analysis) {
  if (result.verdict === "CE") return `Code bị lỗi biên dịch:\n\`\`\`\n${result.compile_error}\n\`\`\`\nHãy sửa lỗi và viết lại TOÀN BỘ code.`;
  const bad = result.tests.find((t) => t.verdict !== "AC" && t.verdict !== "OK");
  const test = tests[bad.test - 1];
  const lines = [`Chạy thử: ${result.passed}/${result.total} test mẫu đúng. Test ${bad.test} bị ${bad.verdict}.`,
    `Input:\n\`\`\`\n${test.input}\`\`\``];
  if (bad.verdict === "TLE") {
    lines.push("Code chạy quá thời gian. Kiểm tra vòng lặp vô hạn, hoặc cần thuật toán nhanh hơn"
      + (analysis.target_complexity ? ` (mục tiêu ${analysis.target_complexity}).` : "."));
  } else {
    lines.push(`Output mong đợi:\n\`\`\`\n${test.expected_output}\n\`\`\``, `Output của bạn:\n\`\`\`\n${bad.stdout}\n\`\`\``);
  }
  if (bad.stderr) lines.push(`Stderr:\n\`\`\`\n${bad.stderr}\n\`\`\``);
  lines.push("Trước khi sửa: trace code trên input này từng bước để tìm đúng chỗ sai. Nếu lỗi nằm ở chính "
    + "thuật toán (không phải cài đặt), hãy đổi thuật toán. Sau đó viết lại TOÀN BỘ code.");
  return lines.join("\n");
}

function stressFeedback(result) {
  if (result.result === "CE") return `Code bị lỗi biên dịch:\n\`\`\`\n${result.compile_error}\n\`\`\`\nHãy sửa lỗi và viết lại TOÀN BỘ code.`;
  const lines = [`Stress test (so với lời giải trâu trên test nhỏ ngẫu nhiên) tìm ra test sai (seed ${result.seed}):`,
    `Input:\n\`\`\`\n${result.input}\`\`\``];
  if (result.result === "MISMATCH") {
    lines.push(`Output của lời giải trâu:\n\`\`\`\n${result.expected_output}\n\`\`\``,
      `Output của bạn:\n\`\`\`\n${result.solution_output}\n\`\`\``,
      "Lời giải trâu cũng có thể sai: hãy tự tính đáp án đúng bằng tay trên test nhỏ này trước. "
      + "Nếu code của bạn đúng, chỉ trả lời một câu bắt đầu bằng \"BRUTE SAI\" và không viết code.");
  } else {
    lines.push(`Code của bạn bị ${result.result} trên test nhỏ này` + (result.result === "TLE" ? " (có thể là vòng lặp vô hạn)." : "."));
    if (result.stderr) lines.push(`Stderr:\n\`\`\`\n${result.stderr}\n\`\`\``);
  }
  lines.push("Nếu code sai: tìm nguyên nhân gốc, giải thích ngắn gọn, rồi viết lại TOÀN BỘ code.");
  return lines.join("\n");
}

/** Await `start(onStatus)` while yielding its latest status text as tool_status events (at most ~2/s). */
async function* withStatus(id, start) {
  let latest = null, wake = null, done = false, result;
  start((text) => { latest = text; if (wake) wake(); }).then((r) => { result = r; done = true; if (wake) wake(); });
  while (!done) {
    if (latest !== null) {
      yield { type: "tool_status", id, text: latest };
      latest = null;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    await new Promise((r) => { wake = r; });
    wake = null;
  }
  return result;
}

/** A generator prints a test from the seed; small models sometimes write a solver instead. */
function generatorOk(code) {
  return !!code && code[0] === "python" && code[1].includes("sys.argv") && !code[1].includes("input(") && !code[1].includes("stdin");
}

/* ---------------- the agent ---------------- */

/**
 * deps: llm.chat(messages, opts) async iterator of {text|thinking|usage}; judge.runTests / judge.stressTest
 * (results shaped like sandbox.py); knowledge (createKnowledge); prompts (static/prompts.json);
 * saveSite(conv, html) -> preview url.
 */
export function createAgent({ llm, judge, knowledge, prompts, saveSite }) {
  const analysisSchema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      format: { type: "string", enum: FORMATS },
      time_limit_seconds: { type: "number" },
      target_complexity: { type: "string" },
      observations: { type: "array", items: { type: "string" } },
      edge_cases: { type: "array", items: { type: "string" } },
      unique_answer: { type: "boolean" },
      topics: { type: "array", items: { type: "string", enum: knowledge.ids } },
    },
    required: ["summary", "format", "time_limit_seconds", "target_complexity", "observations", "edge_cases", "unique_answer", "topics"],
  };

  let lastLooped = false; // whether the latest streamReply was cut off for repeating itself

  async function* streamReply(system, messages, think, signal) {
    const request = [{ role: "system", content: system }, ...trimHistory(messages, system.length)];
    let text = "", current = null, thinkingTail = "", looped = false;
    for await (const part of llm.chat(request, { think, temperature: 0.6, maxTokens: MAX_TOKENS.reply, signal })) {
      if (looped) continue; // draining the interrupted stream
      thinkingTail = (thinkingTail + (part.thinking || "")).slice(-400);
      if (isLooping(text) || isLooping(thinkingTail)) {
        looped = true;
        llm.stop();
        continue;
      }
      if (part.thinking) {
        if (current !== "thinking") { current = "thinking"; yield { type: "block_start", kind: "thinking" }; }
        yield { type: "thinking", text: part.thinking };
      }
      if (part.text) {
        if (current !== "text") { current = "text"; yield { type: "block_start", kind: "text" }; }
        text += part.text;
        yield { type: "text", text: part.text };
      }
      if (part.usage) yield { type: "usage", ...part.usage };
    }
    lastLooped = looped;
    if (looped) yield { type: "notice", text: "AI bị lặp lại một đoạn nên đã dừng câu trả lời này." };
    return looped ? text.slice(0, -400) : text;
  }

  async function* quiet(messages, toolId, opts) {
    let text = "", reported = 0;
    for await (const part of llm.chat(messages, opts)) {
      if (!part.text) continue;
      text += part.text;
      if (text.length - reported >= 200) {
        yield { type: "tool_progress", id: toolId, chars: text.length - reported };
        reported = text.length;
      }
    }
    return text;
  }

  async function extractTests(statement, signal) {
    let raw = "";
    for await (const part of llm.chat([{ role: "system", content: prompts.extract }, { role: "user", content: statement }],
      { schema: TEST_SCHEMA, temperature: 0, maxTokens: MAX_TOKENS.extract, signal })) raw += part.text || "";
    let tests;
    try { tests = JSON.parse(raw).tests || []; } catch { return []; }
    return tests.filter((t) => t && typeof t.input === "string" && typeof t.output === "string" && testsLookReal(t, statement))
      .slice(0, 10).map((t) => ({ input: t.input.trim() + "\n", expected_output: t.output.trim() }));
  }

  async function* analyze(statement, signal) {
    const hint = constraintHint(statement);
    const request = [{ role: "system", content: prompts.analyze },
      { role: "user", content: statement + (hint ? `\n\n(Gợi ý: ${hint})` : "") }];
    const raw = yield* quiet(request, "analyze", { schema: analysisSchema, temperature: 0.2, maxTokens: MAX_TOKENS.analyze, signal });
    let a;
    try { a = JSON.parse(raw); } catch { return {}; }
    if (!a || typeof a !== "object") return {};
    a.topics = (a.topics || []).filter((t) => knowledge.byId.has(t)).slice(0, 4);
    for (const key of ["observations", "edge_cases"]) a[key] = (a[key] || []).map(String).slice(0, 4);
    return a;
  }

  function cpSystem(analysis, entries, hint) {
    const parts = [prompts.system.cp, prompts.browser_cpp];
    const rule = prompts.format_rules[analysis.format];
    if (rule) parts.push(rule);
    const notes = [];
    if (hint) notes.push(hint);
    if (analysis.target_complexity) notes.push(`Độ phức tạp mục tiêu (phân tích sơ bộ): ${analysis.target_complexity}`);
    for (const [label, key] of [["Quan sát", "observations"], ["Trường hợp biên cần kiểm tra", "edge_cases"]]) {
      if (analysis[key] && analysis[key].length) notes.push(`${label}:\n` + analysis[key].map((x) => `- ${x}`).join("\n"));
    }
    if (notes.length) parts.push("Preliminary analysis (verify it, do not trust blindly):\n" + notes.join("\n"));
    if (entries.length) parts.push(knowledgePrompt(entries));
    return parts.join("\n\n");
  }

  async function* judgeRun(lang, source, tests, timeLimit, id) {
    yield { type: "tool_start", id, name: "run_code" };
    yield { type: "tool_call", id, name: "run_code", input: { language: lang, code: source, tests, time_limit: timeLimit } };
    const result = yield* withStatus(id, (onStatus) => judge.runTests(lang, source, tests, timeLimit, onStatus));
    yield { type: "tool_result", id, name: "run_code", output: result };
    return result;
  }

  /** Ask for the generator and the brute force separately; returns the helpers or null. */
  async function* writeStressHelpers(statement, lang, source, id, signal) {
    async function* ask(messages, maxTokens) {
      const reply = yield* quiet(messages, id, { temperature: 0.3, maxTokens, signal });
      messages.push({ role: "assistant", content: reply });
      return lastCodeBlock(reply, CODE_LANGS);
    }
    const request = [{ role: "system", content: prompts.stress_generator }, { role: "user", content: `Problem:\n${statement}` }];
    let gen = yield* ask(request, MAX_TOKENS.generator);
    if (!generatorOk(gen)) {
      request.push({ role: "user", content: prompts.stress_generator_retry });
      gen = yield* ask(request, MAX_TOKENS.generator);
      if (!generatorOk(gen)) return null;
    }
    const brute = yield* ask([{ role: "system", content: prompts.stress_brute },
      { role: "user", content: `Problem:\n${statement}\n\nSolution:\n\`\`\`${lang}\n${source}\`\`\`` }], MAX_TOKENS.brute);
    return brute ? { generator: gen[1], brute_language: brute[0], brute: brute[1] } : null;
  }

  async function* stress(state, lang, source, timeLimit, id, signal) {
    yield { type: "tool_start", id, name: "stress_test" };
    let helpers = state.stress;
    if (!helpers) {
      helpers = yield* writeStressHelpers(state.statement || "", lang, source, id, signal);
      if (!helpers) {
        yield { type: "tool_result", id, name: "stress_test", output: { error: "AI không viết được generator/brute force hợp lệ, bỏ qua stress test." } };
        return null;
      }
    }
    yield { type: "tool_call", id, name: "stress_test", input: {
      iterations: STRESS_ITERATIONS, solution_language: lang, solution_code: source,
      brute_language: helpers.brute_language, brute_code: helpers.brute, generator_code: helpers.generator } };
    const result = yield* withStatus(id, (onStatus) => judge.stressTest(helpers.generator, { language: lang, code: source },
      { language: helpers.brute_language, code: helpers.brute }, STRESS_ITERATIONS, timeLimit, STRESS_BUDGET_SECONDS, onStatus));
    yield { type: "tool_result", id, name: "stress_test", output: result };
    if (result.result === "GENERATOR_FAILED" || result.result === "BRUTE_FAILED" || (result.result === "CE" && result.program !== "solution")) {
      state.stress = null;
      yield { type: "notice", text: "Generator hoặc lời giải trâu do AI viết bị lỗi nên bỏ qua stress test." };
      return null;
    }
    state.stress = helpers;
    return result;
  }

  async function* solveProblem(conv, think, effort, signal) {
    const cfg = EFFORTS[effort] || EFFORTS.deep;
    const { messages, state } = conv;
    const text = messages[messages.length - 1].content;
    if (text.length > NEW_PROBLEM_CHARS) {
      Object.assign(state, { statement: text, analysis: {}, kb: [], stress: null });
      yield { type: "tool_start", id: "extract", name: "extract_tests" };
      const tests = await extractTests(text, signal);
      if (tests.length) state.tests = tests;
      yield { type: "tool_result", id: "extract", name: "extract_tests", output: { tests, reused: !tests.length && !!(state.tests || []).length } };
      if (cfg.analyze) {
        yield { type: "tool_start", id: "analyze", name: "analyze_problem" };
        state.analysis = yield* analyze(text, signal);
        yield { type: "tool_result", id: "analyze", name: "analyze_problem",
          output: Object.keys(state.analysis).length ? state.analysis : { error: "Không phân tích được đề, tiếp tục giải trực tiếp." } };
      }
      const entries = knowledge.retrieve(text, state.analysis.topics, cfg.kb);
      state.kb = entries.map((e) => e.id);
      if (entries.length) {
        yield { type: "tool_start", id: "kb", name: "knowledge" };
        yield { type: "tool_result", id: "kb", name: "knowledge", output: { topics: entries.map((e) => ({ id: e.id, title: e.title })) } };
      }
    }

    const statement = state.statement || text;
    const analysis = state.analysis || {};
    const entries = (state.kb || []).map((id) => knowledge.byId.get(id)).filter(Boolean);
    const system = cpSystem(analysis, entries, constraintHint(statement));
    const timeLimit = timeLimitOf(analysis, statement);
    const tests = state.tests || [];
    const anyAnswer = analysis.unique_answer === false && ANY_ANSWER_RE.test(statement);
    const doStress = cfg.stress && !anyAnswer && analysis.format !== "interactive";

    let fixesLeft = cfg.fixRounds, rethinksLeft = cfg.rethink ? 1 : 0, fixesDone = 0;
    for (let round = 0; ; round++) {
      const reply = yield* streamReply(system, messages, think, signal);
      messages.push({ role: "assistant", content: reply });
      const code = lastCodeBlock(reply, CODE_LANGS);
      if (!code) {
        if (reply.toUpperCase().includes("BRUTE SAI")) {
          yield { type: "notice", text: "AI kiểm tra lại và cho rằng lời giải trâu sai; giữ code đã qua test mẫu." };
          return;
        }
        if (!fixesLeft || (round === 0 && !lastLooped)) return;
        fixesLeft--;
        messages.push({ role: "user", content: "Câu trả lời vừa rồi không có code hoàn chỉnh. Hãy viết lại ngắn gọn: ý tưởng trong vài câu, "
          + "rồi TOÀN BỘ code trong đúng một code block." });
        yield { type: "notice", text: "AI chưa đưa ra code hoàn chỉnh, đang yêu cầu viết lại…" };
        continue;
      }
      if (analysis.format === "interactive") {
        yield { type: "notice", text: "Bài tương tác: trình chấm cục bộ không mô phỏng được judge nên chưa chạy thử." };
        return;
      }
      if (!tests.length && !doStress) {
        yield { type: "notice", text: "Không tìm thấy test mẫu trong đề nên chưa chạy thử. "
          + "Bạn có thể tự thêm test trong Trình chấm, hoặc chọn mức suy nghĩ Tối đa để stress test." };
        return;
      }
      const [lang, source] = code;
      let feedback = null, verdict = "";
      const passed = [];
      if (tests.length) {
        const result = yield* judgeRun(lang, source, tests, timeLimit, `run${round}`);
        if (result.verdict === "AC" || result.verdict === "OK") passed.push(`${result.passed}/${result.total} test mẫu`);
        else { feedback = failureFeedback(result, tests, analysis); verdict = result.verdict; }
      }
      if (feedback === null && doStress) {
        const result = yield* stress(state, lang, source, timeLimit, `stress${round}`, signal);
        if (result && (result.result === "ALL_PASSED" || result.result === "BUDGET_EXHAUSTED")) {
          passed.push(`${result.iterations_passed} test ngẫu nhiên so với lời giải trâu`);
        } else if (result) { feedback = stressFeedback(result); verdict = result.result; }
      }
      if (feedback === null) {
        yield { type: "notice", text: passed.length ? `✅ Code đã qua ${passed.join(" và ")}.` : "Không chạy được kiểm tra nào cho code này." };
        return;
      }
      if (fixesLeft === 0) {
        if (rethinksLeft === 0) {
          yield { type: "error", message: "Đã tự sửa nhiều lần nhưng vẫn chưa đúng. Hãy thử bật 'Suy nghĩ', đổi model lớn hơn, hoặc gợi ý thêm cho AI." };
          return;
        }
        rethinksLeft--;
        fixesLeft = cfg.fixRounds - 1;
        messages.push({ role: "user", content: feedback + "\n\nĐã sửa nhiều lần mà vẫn sai. Hãy BỎ hướng làm hiện tại và nghĩ lại từ đầu: "
          + "liệt kê lại các quan sát, chọn một thuật toán KHÁC, kiểm tra bằng tay trên test mẫu rồi mới viết lại TOÀN BỘ code." });
        yield { type: "notice", text: "🧠 Các cách sửa chưa hiệu quả, AI đang nghĩ lại từ đầu với hướng khác…" };
        continue;
      }
      fixesLeft--;
      fixesDone++;
      messages.push({ role: "user", content: feedback });
      yield { type: "notice", text: `🔧 Code chưa đúng (${verdict}), AI đang tự sửa (lần ${fixesDone})…` };
    }
  }

  /** One user turn; `conv.messages` already ends with the user message. */
  async function* runTurn(conv, { mode = "cp", think = false, effort = "deep", signal } = {}) {
    if (mode === "cp") {
      yield* solveProblem(conv, think, effort, signal);
      return;
    }
    let system = prompts.system[mode];
    if (mode === "chat") {
      const entries = knowledge.retrieve(conv.messages[conv.messages.length - 1].content, [], 2, 3);
      if (entries.length) {
        system += "\n\n" + knowledgePrompt(entries);
        yield { type: "tool_start", id: "kb", name: "knowledge" };
        yield { type: "tool_result", id: "kb", name: "knowledge", output: { topics: entries.map((e) => ({ id: e.id, title: e.title })) } };
      }
    }
    const reply = yield* streamReply(system, conv.messages, think, signal);
    conv.messages.push({ role: "assistant", content: reply });
    if (mode === "web") {
      const page = lastCodeBlock(reply, { html: "html" });
      if (!page) return;
      yield { type: "tool_start", id: "site", name: "save_web_files" };
      yield { type: "tool_call", id: "site", name: "save_web_files", input: { files: [{ path: "index.html" }] } };
      yield { type: "tool_result", id: "site", name: "save_web_files",
        output: { saved: ["index.html"], all_files: ["index.html"], preview_url: saveSite(conv, page[1]) } };
    }
  }

  return { runTurn };
}
