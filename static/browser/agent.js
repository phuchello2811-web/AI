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
// Likewise for formats that change how the code is judged: they must be visible in the statement itself.
const FORMAT_EVIDENCE = {
  interactive: /interactive|tương tác|flush|interactor/i,
  function_grader: /grader|cài đặt hàm|hàm sau|implement the function|function signature/i,
  file_io: /\.(inp|in|out|ans)\b/i,
  multiple_cases_case_x: /case #/i,
};

function checkedFormat(format, statement) {
  const evidence = FORMAT_EVIDENCE[format];
  return !evidence || evidence.test(statement) ? format : "stdin";
}

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
    entries, byId, ids: entries.filter((e) => (e.kind || "cp") === "cp").map((e) => e.id),
    // kind: "cp" for contest techniques, "web" for front-end knowledge.
    retrieve(text, topics = [], k = 3, minScore = 2, kind = "cp") {
      const norm = normalize(text);
      const chosen = new Set([...(topics || []), ...(kind === "cp" ? boundTopics(text) : [])]);
      return entries
        .filter((e) => (e.kind || "cp") === kind)
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

function trimHistory(messages, systemChars, totalChars = HISTORY_CHARS) {
  const budget = Math.max(4000, totalChars - systemChars);
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

function perfFeedback(result, analysis) {
  if (result.result === "CE") return `Code bị lỗi biên dịch:\n\`\`\`\n${result.compile_error}\n\`\`\`\nHãy sửa lỗi và viết lại TOÀN BỘ code.`;
  const lines = [`Trên test lớn nhất (kích thước tối đa theo đề, ${Math.round(result.size / 1024)} KB input), code của bạn bị ${result.result}`
    + (result.result === "TLE" ? " (quá thời gian)." : ".")];
  if (result.result === "TLE") {
    lines.push("Thuật toán hoặc cài đặt chưa đủ nhanh" + (analysis.target_complexity ? ` (mục tiêu ${analysis.target_complexity})` : "")
      + ". Kiểm tra vòng lặp lồng nhau ẩn, đệ quy/tham chiếu sao chép, cấu trúc dữ liệu chậm, đọc ghi chậm; nếu cần, đổi sang thuật toán tốt hơn.");
  } else if (result.stderr) {
    lines.push(`Stderr:\n\`\`\`\n${result.stderr}\n\`\`\``, "Có thể do tràn mảng, đệ quy quá sâu hoặc dùng quá nhiều bộ nhớ ở kích thước lớn.");
  }
  lines.push("Hãy tìm nguyên nhân, giải thích ngắn gọn, rồi viết lại TOÀN BỘ code.");
  return lines.join("\n");
}

/** The explanation part of a reply (before the code), kept as the lesson of a solved problem. */
function ideaOf(reply) {
  const at = reply.indexOf("```");
  return (at >= 0 ? reply.slice(0, at) : reply).trim().slice(0, 900);
}

const words = (text) => new Set(normalize(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 3));

/** Past lessons most similar to `text` (word overlap), at most `k`. */
export function similarLessons(lessons, text, k = 2) {
  const mine = words(text);
  return lessons
    .map((l) => { const theirs = words(l.text); let common = 0; for (const w of mine) if (theirs.has(w)) common++;
      return [common / Math.max(1, Math.min(mine.size, theirs.size)), l]; })
    .filter(([score]) => score >= 0.35)
    .sort((a, b) => b[0] - a[0])
    .slice(0, k)
    .map(([, l]) => l);
}

/** A generator prints a test from the seed; small models sometimes write a solver instead. */
function generatorOk(code) {
  return !!code && code[0] === "python" && code[1].includes("sys.argv") && !code[1].includes("input(") && !code[1].includes("stdin");
}

/* ---------------- the agent ---------------- */

// Reasoning effort for strong (cloud) models at each effort level.
const REASONING = { fast: "low", deep: "medium", max: "high" };
const STRONG_HISTORY_CHARS = 60000;
const WEB_FIX_ROUNDS = 2;

/**
 * deps: llm (models.js: chat(messages, opts) streaming {text|thinking|usage|wait|status|notice}, stop(),
 * isStrong(model)); judge.runTests / judge.stressTest (results shaped like sandbox.py); knowledge
 * (createKnowledge); prompts (static/prompts.json); saveSite(conv, html) -> preview url;
 * checkSite(html) -> list of runtime errors (optional).
 */
export function createAgent({ llm, judge, knowledge, prompts, saveSite, checkSite, memory }) {
  const analysisProps = {
    summary: { type: "string" },
    format: { type: "string", enum: FORMATS },
    time_limit_seconds: { type: "number" },
    target_complexity: { type: "string" },
    observations: { type: "array", items: { type: "string" } },
    edge_cases: { type: "array", items: { type: "string" } },
    unique_answer: { type: "boolean" },
    topics: { type: "array", items: { type: "string", enum: knowledge.ids } },
  };
  const analysisSchema = { type: "object", properties: analysisProps, required: Object.keys(analysisProps) };
  // Strong models read the samples and analyse the problem in one request (the free cloud allows one reply per 30 s).
  const fullSchema = { type: "object", properties: { tests: TEST_SCHEMA.properties.tests, ...analysisProps },
    required: ["tests", ...Object.keys(analysisProps)] };
  const helpersSchema = { type: "object",
    properties: { generator: { type: "string" }, brute: { type: "string" }, big_generator: { type: "string" } },
    required: ["generator", "brute", "big_generator"] };

  let ctx = {};             // per turn: model, strong, effort, think, signal
  let lastLooped = false;   // whether the latest streamReply was cut off for repeating itself

  // In-browser models think step by step at the "deep" and "max" levels (hosted models always reason).
  const chatOpts = (extra) => ({ model: ctx.model, effort: REASONING[ctx.effort] || "medium",
    think: ctx.think || ctx.effort !== "fast", avoid: ctx.avoid, signal: ctx.signal,
    route: ctx.effort === "fast" ? "fast" : "main", ...extra });

  async function* streamReply(system, messages) {
    const budget = ctx.strong ? STRONG_HISTORY_CHARS : HISTORY_CHARS;
    const request = [{ role: "system", content: system }, ...trimHistory(messages, system.length, budget)];
    let text = "", current = null, thinkingTail = "", looped = false;
    for await (const part of llm.chat(request, chatOpts({ temperature: 0.6, maxTokens: MAX_TOKENS.reply }))) {
      if (looped) continue; // draining the interrupted stream
      if (part.wait) { yield { type: "status", text: `Đang chờ lượt của máy chủ miễn phí: ${part.wait} giây` }; continue; }
      if (part.status) { yield { type: "status", text: part.status }; continue; }
      if (part.notice) { yield { type: "notice", text: part.notice }; continue; }
      thinkingTail = (thinkingTail + (part.thinking || "")).slice(-400);
      if (isLooping(text) || isLooping(thinkingTail)) {
        looped = true;
        llm.stop();
        continue;
      }
      // Reasoning of a continuation (after the answer started) would split the answer on screen; skip it.
      if (part.thinking && !text) {
        if (current !== "thinking") { current = "thinking"; yield { type: "block_start", kind: "thinking" }; }
        yield { type: "thinking", text: part.thinking };
      }
      if (part.text) {
        if (current !== "text") { current = "text"; yield { type: "block_start", kind: "text" }; }
        text += part.text;
        yield { type: "text", text: part.text };
      }
      if (part.usage) {
        if (part.usage.model) ctx.lastModel = part.usage.model;
        yield { type: "usage", ...part.usage };
      }
    }
    lastLooped = looped;
    if (looped) yield { type: "notice", text: "AI bị lặp lại một đoạn nên đã dừng câu trả lời này." };
    return looped ? text.slice(0, -400) : text;
  }

  /** A helper request whose output is not shown as chat text; progress goes to tool card `toolId`. */
  async function* quiet(messages, toolId, extra) {
    let text = "", reported = 0;
    for await (const part of llm.chat(messages, chatOpts({ route: "helper", ...extra }))) {
      if (part.wait) yield { type: "tool_status", id: toolId, text: `đang chờ lượt của máy chủ miễn phí: ${part.wait} giây` };
      else if (part.status) yield { type: "tool_status", id: toolId, text: part.status };
      else if (part.notice) yield { type: "notice", text: part.notice };
      if (!part.text) continue;
      text += part.text;
      if (text.length - reported >= 200) {
        yield { type: "tool_progress", id: toolId, chars: text.length - reported };
        reported = text.length;
      }
    }
    return text;
  }

  // Lenient: services without strict schemas may wrap the JSON in a code fence or add a sentence around it.
  const parseJSON = (raw) => {
    // Only an outer fence is removed: fences inside JSON strings (e.g. code) must stay intact.
    const text = String(raw || "").trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
    for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
      try { const v = JSON.parse(candidate); if (v && typeof v === "object") return v; } catch {}
    }
    return null;
  };

  function cleanTests(tests, statement) {
    return (tests || []).filter((t) => t && typeof t.input === "string" && typeof t.output === "string" && testsLookReal(t, statement))
      .slice(0, 10).map((t) => ({ input: t.input.trim() + "\n", expected_output: t.output.trim() }));
  }

  function cleanAnalysis(a, statement) {
    if (!a) return {};
    const out = {};
    for (const key of Object.keys(analysisProps)) if (key in a) out[key] = a[key];
    if (out.format) out.format = checkedFormat(out.format, statement);
    out.topics = (out.topics || []).filter((t) => knowledge.byId.has(t)).slice(0, 4);
    for (const key of ["observations", "edge_cases"]) out[key] = (out[key] || []).map(String).slice(0, 4);
    return out;
  }

  async function* extractTests(statement) {
    const raw = yield* quiet([{ role: "system", content: prompts.extract }, { role: "user", content: statement }], "extract",
      { schema: TEST_SCHEMA, temperature: 0, maxTokens: MAX_TOKENS.extract, effort: "low" });
    return cleanTests((parseJSON(raw) || {}).tests, statement);
  }

  async function* analyze(statement, withTests) {
    const hint = constraintHint(statement);
    const system = withTests ? `${prompts.analyze}\n- tests: ${prompts.extract}` : prompts.analyze;
    const raw = yield* quiet([{ role: "system", content: system }, { role: "user", content: statement + (hint ? `\n\n(Gợi ý: ${hint})` : "") }],
      "analyze", { schema: withTests ? fullSchema : analysisSchema, temperature: 0.2, maxTokens: MAX_TOKENS.analyze });
    const data = parseJSON(raw);
    return { analysis: cleanAnalysis(data, statement), tests: withTests && data ? cleanTests(data.tests, statement) : [] };
  }

  function cpSystem(analysis, entries, hint, lessons = []) {
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
    if (lessons.length) parts.push(prompts.lessons + "\n\n" + lessons.map((l) => `### ${l.summary}\n${l.idea}`).join("\n\n"));
    return parts.join("\n\n");
  }

  async function* perfRun(state, lang, source, timeLimit, id) {
    yield { type: "tool_start", id, name: "perf_test" };
    const result = yield* withStatus(id, (onStatus) => judge.perfTest(state.big, { language: lang, code: source }, timeLimit, onStatus));
    yield { type: "tool_result", id, name: "perf_test", output: { ...result, time_limit: timeLimit } };
    return result;
  }

  async function* judgeRun(lang, source, tests, timeLimit, id) {
    yield { type: "tool_start", id, name: "run_code" };
    yield { type: "tool_call", id, name: "run_code", input: { language: lang, code: source, tests, time_limit: timeLimit } };
    const result = yield* withStatus(id, (onStatus) => judge.runTests(lang, source, tests, timeLimit, onStatus));
    yield { type: "tool_result", id, name: "run_code", output: result };
    return result;
  }

  /** Generator and brute force: one JSON request for strong models, two separate ones for small models. */
  async function* writeStressHelpers(statement, lang, source, id) {
    const solution = `Problem:\n${statement}\n\nSolution:\n\`\`\`${lang}\n${source}\`\`\``;
    if (ctx.strong) {
      const data = parseJSON(yield* quiet([
        { role: "system", content: `Return JSON with three Python programs.\ngenerator: ${prompts.stress_generator}\n\nbrute: ${prompts.stress_brute}\n\n${prompts.stress_big}` },
        { role: "user", content: solution }], id, { schema: helpersSchema, temperature: 0.3, maxTokens: MAX_TOKENS.generator + MAX_TOKENS.brute, effort: "low" }));
      // Programs sometimes come wrapped in a fence, or with a stray language name as the first line.
      const strip = (code) => String(code || "").trim().replace(/^```[\w+#-]*\s*\n?/, "").replace(/\n?```\s*$/, "")
        .replace(/^(python3?|py|cpp|c\+\+)\s*\n/i, "");
      if (data && generatorOk(["python", strip(data.generator)]) && strip(data.brute).trim()) {
        const big = strip(data.big_generator);
        return { generator: strip(data.generator), brute_language: "python", brute: strip(data.brute),
                 big: generatorOk(["python", big]) ? big : null };
      }
    }
    async function* ask(messages, maxTokens) {
      const reply = yield* quiet(messages, id, { temperature: 0.3, maxTokens, effort: "low" });
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
    const brute = yield* ask([{ role: "system", content: prompts.stress_brute }, { role: "user", content: solution }], MAX_TOKENS.brute);
    return brute ? { generator: gen[1], brute_language: brute[0], brute: brute[1] } : null;
  }

  async function* stress(state, lang, source, timeLimit, id) {
    yield { type: "tool_start", id, name: "stress_test" };
    let helpers = state.stress;
    if (!helpers) {
      helpers = yield* writeStressHelpers(state.statement || "", lang, source, id);
      // Kept apart from the stress helpers so the speed check still runs if the small-test generator fails.
      if (helpers && helpers.big) state.big = helpers.big;
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

  async function* solveProblem(conv) {
    const cfg = EFFORTS[ctx.effort] || EFFORTS.deep;
    const { messages, state } = conv;
    const text = messages[messages.length - 1].content;
    if (text.length > NEW_PROBLEM_CHARS) {
      Object.assign(state, { statement: text, analysis: {}, kb: [], stress: null, big: null });
      let tests = [];
      if (ctx.strong) {
        yield { type: "tool_start", id: "analyze", name: "analyze_problem" };
        const r = yield* analyze(text, true);
        state.analysis = r.analysis;
        tests = r.tests;
        yield { type: "tool_result", id: "analyze", name: "analyze_problem", output: Object.keys(r.analysis).length
          ? { ...r.analysis, tests_found: tests.length } : { error: "Không phân tích được đề, tiếp tục giải trực tiếp." } };
      } else {
        yield { type: "tool_start", id: "extract", name: "extract_tests" };
        tests = yield* extractTests(text);
        yield { type: "tool_result", id: "extract", name: "extract_tests", output: { tests, reused: !tests.length && !!(state.tests || []).length } };
        if (cfg.analyze) {
          yield { type: "tool_start", id: "analyze", name: "analyze_problem" };
          state.analysis = (yield* analyze(text, false)).analysis;
          yield { type: "tool_result", id: "analyze", name: "analyze_problem",
            output: Object.keys(state.analysis).length ? state.analysis : { error: "Không phân tích được đề, tiếp tục giải trực tiếp." } };
        }
      }
      if (tests.length) state.tests = tests;
      const entries = knowledge.retrieve(text, state.analysis.topics, cfg.kb);
      state.kb = entries.map((e) => e.id);
      state.lessons = memory ? similarLessons(await memory.all(), `${state.analysis.summary || ""} ${text}`) : [];
      if (entries.length || state.lessons.length) {
        yield { type: "tool_start", id: "kb", name: "knowledge" };
        yield { type: "tool_result", id: "kb", name: "knowledge", output: { topics: entries.map((e) => ({ id: e.id, title: e.title })),
          lessons: state.lessons.map((l) => l.summary) } };
      }
    }

    const statement = state.statement || text;
    const analysis = state.analysis || {};
    const entries = (state.kb || []).map((id) => knowledge.byId.get(id)).filter(Boolean);
    const system = cpSystem(analysis, entries, constraintHint(statement), state.lessons || []);
    const timeLimit = timeLimitOf(analysis, statement);
    const tests = state.tests || [];
    const anyAnswer = analysis.unique_answer === false && ANY_ANSWER_RE.test(statement);
    const doStress = cfg.stress && !anyAnswer && analysis.format !== "interactive";

    let fixesLeft = cfg.fixRounds, rethinksLeft = cfg.rethink ? 1 : 0, fixesDone = 0;
    for (let round = 0; ; round++) {
      const reply = yield* streamReply(system, messages);
      messages.push({ role: "assistant", content: reply });
      const code = lastCodeBlock(reply, CODE_LANGS);
      if (!code) {
        if (reply.toUpperCase().includes("BRUTE SAI")) {
          yield { type: "notice", text: "AI kiểm tra lại và cho rằng lời giải trâu sai; giữ code đã qua test mẫu." };
          return;
        }
        // A plain explanation (e.g. a follow-up question) needs no code; an empty, looping or cut-off reply
        // (a code block that was opened but never closed) does.
        const truncated = (reply.match(/```/g) || []).length % 2 === 1;
        if (!fixesLeft || (round === 0 && !lastLooped && !truncated && reply.trim())) {
          if (!reply.trim()) yield { type: "error", message: "AI không đưa ra câu trả lời. Hãy thử gửi lại." };
          return;
        }
        fixesLeft--;
        messages.push({ role: "user", content: "Câu trả lời vừa rồi không có code hoàn chỉnh. Hãy viết lại ngắn gọn: ý tưởng trong vài câu, "
          + "rồi TOÀN BỘ code trong đúng một code block." });
        yield { type: "notice", text: "AI chưa đưa ra code hoàn chỉnh, đang yêu cầu viết lại." };
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
        const result = yield* stress(state, lang, source, timeLimit, `stress${round}`);
        if (result && (result.result === "ALL_PASSED" || result.result === "BUDGET_EXHAUSTED")) {
          passed.push(`${result.iterations_passed} test ngẫu nhiên so với lời giải trâu`);
        } else if (result) { feedback = stressFeedback(result); verdict = result.result; }
      }
      if (feedback === null && doStress && state.big) {
        const result = yield* perfRun(state, lang, source, timeLimit, `perf${round}`);
        if (result.result === "OK") passed.push(`test lớn nhất trong ${result.time.toFixed(2)} giây (đo trong trình duyệt, chậm hơn máy chấm khoảng 2 lần)`);
        else if (result.result !== "GENERATOR_FAILED") { feedback = perfFeedback(result, analysis); verdict = `${result.result} trên test lớn`; }
      }
      if (feedback === null) {
        yield { type: "notice", kind: "success", text: passed.length ? `Code đã qua ${passed.join(" và ")}.` : "Không chạy được kiểm tra nào cho code này." };
        if (memory && passed.length && text.length > NEW_PROBLEM_CHARS) {
          await memory.remember({ summary: (analysis.summary || statement.split("\n")[0]).slice(0, 200),
            text: `${analysis.summary || ""} ${statement}`.slice(0, 1500), topics: analysis.topics || [], idea: ideaOf(reply) });
        }
        return;
      }
      if (fixesLeft === 0) {
        if (rethinksLeft === 0) {
          yield { type: "error", message: "Đã tự sửa nhiều lần nhưng vẫn chưa đúng. Hãy thử mức suy nghĩ Tối đa, đổi model, hoặc gợi ý thêm cho AI." };
          return;
        }
        rethinksLeft--;
        fixesLeft = cfg.fixRounds - 1;
        // A second opinion: the fresh start goes to a different model from the one that got stuck.
        ctx.avoid = ctx.lastModel || null;
        messages.push({ role: "user", content: feedback + "\n\nĐã sửa nhiều lần mà vẫn sai. Hãy BỎ hướng làm hiện tại và nghĩ lại từ đầu: "
          + "liệt kê lại các quan sát, chọn một thuật toán KHÁC, kiểm tra bằng tay trên test mẫu rồi mới viết lại TOÀN BỘ code." });
        yield { type: "notice", text: ctx.avoid
          ? `Các cách sửa chưa hiệu quả, đang nhờ một model khác (không phải ${ctx.avoid}) nghĩ lại từ đầu.`
          : "Các cách sửa chưa hiệu quả, AI đang nghĩ lại từ đầu với hướng khác." };
        continue;
      }
      fixesLeft--;
      fixesDone++;
      messages.push({ role: "user", content: feedback });
      yield { type: "notice", text: `Code chưa đúng (${verdict}), AI đang tự sửa (lần ${fixesDone}).` };
    }
  }

  /**
   * Build a page and improve it in stages, each checked in hidden frames on a phone and a desktop screen:
   * 1. runtime errors are fixed (all levels);
   * 2. measured UI issues (overflow, tiny or low-contrast text, small tap targets, missing alt…) are fixed
   *    ("deep" and "max");
   * 3. the model reviews the page against the request ("max").
   * A revision that breaks a working page is dropped and the last working version is kept.
   */
  async function* buildSite(conv, system) {
    // Rounds of UI fixes: none at "fast", one at "deep", two at "max".
    let errorFixes = WEB_FIX_ROUNDS, rewrites = 1, uiRounds = { fast: 0, deep: 1, max: 2 }[ctx.effort] ?? 1, reviewed = ctx.effort !== "max";
    let lastGood = null, round = 0;

    // One model reply → a saved, checked page (or null when the reply has no complete page).
    const attempt = async function* (stage) {
      const reply = yield* streamReply(system, conv.messages);
      conv.messages.push({ role: "assistant", content: reply });
      const page = lastCodeBlock(reply, { html: "html" });
      if (!page) return { reply, page: null };
      const id = `site${round++}`;
      yield { type: "tool_start", id, name: "save_web_files" };
      yield { type: "tool_call", id, name: "save_web_files", input: { files: [{ path: "index.html" }] } };
      const url = saveSite(conv, page[1]);
      const check = checkSite ? await checkSite(page[1]) : { errors: [], ui: [] };
      const errors = Array.isArray(check) ? check : check.errors, ui = Array.isArray(check) ? [] : check.ui;
      yield { type: "tool_result", id, name: "save_web_files", output: { saved: ["index.html"], all_files: ["index.html"], preview_url: url, errors, ui, stage } };
      return { reply, page: page[1], errors, ui };
    };
    const revert = function* (why) {
      if (!lastGood) return;
      saveSite(conv, lastGood);
      yield { type: "notice", text: `${why} nên giữ lại bản trước (đang chạy tốt).` };
    };

    let r = yield* attempt("build");
    for (;;) {
      if (!r.page) {
        // A page that was started but never finished (cut off) is asked for again, once, more compactly.
        if (/```html/i.test(r.reply) && rewrites-- > 0) {
          conv.messages.push({ role: "user", content: "Trang HTML vừa rồi bị cắt giữa chừng. Hãy viết lại TOÀN BỘ file HTML gọn hơn (khoảng 250 dòng), đầy đủ từ <!doctype html> đến </html>, trong một code block." });
          yield { type: "notice", text: "Trang bị cắt giữa chừng, AI đang viết lại gọn hơn." };
          r = yield* attempt("build");
          continue;
        }
        if (/```html/i.test(r.reply)) {
          yield { type: "error", message: "AI chưa viết xong trang (câu trả lời bị cắt). Hãy bấm Hỏi lại hoặc yêu cầu trang gọn hơn." };
          yield* revert("Bản mới chưa hoàn chỉnh");
        }
        return;
      }
      if (r.errors.length) {
        if (errorFixes-- <= 0) { yield* revert("Bản mới vẫn còn lỗi khi chạy"); return; }
        conv.messages.push({ role: "user", content: prompts.web_errors.replace("{errors}", r.errors.map((e) => `- ${e}`).join("\n")) });
        yield { type: "notice", text: `Trang có ${r.errors.length} lỗi khi chạy, AI đang tự sửa.` };
        r = yield* attempt("fix");
        continue;
      }
      lastGood = r.page;
      if (uiRounds > 0 && r.ui.length) {
        uiRounds--;
        conv.messages.push({ role: "user", content: prompts.web_ui.replace("{issues}", r.ui.map((e) => `- ${e}`).join("\n")) });
        yield { type: "notice", text: `Kiểm tra giao diện trên điện thoại và máy tính phát hiện ${r.ui.length} vấn đề, AI đang sửa.` };
        r = yield* attempt("ui");
        continue;
      }
      uiRounds = 0;
      if (reviewed) return;
      reviewed = true;
      conv.messages.push({ role: "user", content: prompts.web_review });
      yield { type: "notice", text: "Trang chạy tốt. AI đang tự đánh giá lại theo yêu cầu (tính năng, giao diện điện thoại, nội dung)." };
      const review = yield* streamReply(system, conv.messages);
      conv.messages.push({ role: "assistant", content: review });
      if (!lastCodeBlock(review, { html: "html" })) {
        yield { type: "notice", kind: "success", text: "AI đánh giá: trang đã đạt yêu cầu." };
        return;
      }
      // The review produced an improved page: save and check it; keep the previous page if it broke.
      const page = lastCodeBlock(review, { html: "html" })[1];
      const id = `site${round++}`;
      yield { type: "tool_start", id, name: "save_web_files" };
      const url = saveSite(conv, page);
      const check = checkSite ? await checkSite(page) : { errors: [], ui: [] };
      const errors = Array.isArray(check) ? check : check.errors, ui = Array.isArray(check) ? [] : check.ui;
      yield { type: "tool_result", id, name: "save_web_files", output: { saved: ["index.html"], all_files: ["index.html"], preview_url: url, errors, ui, stage: "review" } };
      if (errors.length) yield* revert("Bản cải tiến bị lỗi khi chạy");
      return;
    }
  }

  /** One user turn; `conv.messages` already ends with the user message. */
  async function* runTurn(conv, { mode = "cp", model, think = false, effort = "deep", signal } = {}) {
    ctx = { model, strong: !!(llm.isStrong && llm.isStrong(model)), effort, think, signal };
    if (mode === "cp") {
      yield* solveProblem(conv);
      return;
    }
    let system = prompts.system[mode];
    const entries = knowledge.retrieve(conv.messages[conv.messages.length - 1].content, [], mode === "web" ? 3 : 2,
      mode === "web" ? 2 : 3, mode === "web" ? "web" : "cp");
    // Web pages always get the core design principles, whatever the request matched.
    if (mode === "web" && knowledge.byId.has("ui_principles") && !entries.some((e) => e.id === "ui_principles")) {
      entries.push(knowledge.byId.get("ui_principles"));
    }
    if (entries.length) {
      system += "\n\n" + knowledgePrompt(entries);
      yield { type: "tool_start", id: "kb", name: "knowledge" };
      yield { type: "tool_result", id: "kb", name: "knowledge", output: { topics: entries.map((e) => ({ id: e.id, title: e.title })) } };
    }
    if (mode === "web") {
      yield* buildSite(conv, system);
      return;
    }
    let reply = yield* streamReply(system, conv.messages);
    conv.messages.push({ role: "assistant", content: reply });
    // A complete program in an explanation must at least compile: check it once and let the model fix it.
    for (let round = 0; round < 2 && judge.runTests && ctx.effort !== "fast"; round++) {
      const code = lastCodeBlock(reply, CODE_LANGS);
      if (!code || !/\bmain\s*\(|^\s*(import|def|print|for|if|n\s*=)/m.test(code[1])) return;
      const id = `check${round}`;
      yield { type: "tool_start", id, name: "compile_check" };
      const result = yield* withStatus(id, (onStatus) => judge.runTests(code[0], code[1], [{ input: "" }], 2, onStatus));
      const syntax = code[0] === "python" && (result.tests[0] || {}).stderr && /SyntaxError|IndentationError/.test(result.tests[0].stderr);
      const error = result.verdict === "CE" ? result.compile_error : syntax ? result.tests[0].stderr : "";
      yield { type: "tool_result", id, name: "compile_check", output: { ok: !error, language: code[0], error } };
      if (!error || round === 1) return;
      conv.messages.push({ role: "user", content: `Code trong câu trả lời bị lỗi khi biên dịch/chạy:\n\`\`\`\n${error}\n\`\`\`\nHãy sửa và viết lại câu trả lời với code đúng.` });
      yield { type: "notice", text: "Code trong câu trả lời bị lỗi biên dịch, AI đang tự sửa." };
      reply = yield* streamReply(system, conv.messages);
      conv.messages.push({ role: "assistant", content: reply });
    }
  }

  return { runTurn };
}
