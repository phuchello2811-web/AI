"""The coding agent: a local open-source model (via Ollama) driven by a fixed workflow.

Small local models are unreliable at deciding when to call tools, so the program drives
the loop instead. For a contest problem, depending on the chosen effort level:

1. analyse the statement (format, constraints, target complexity, likely techniques),
2. look up matching techniques in the knowledge base (knowledge.py) and add them to the prompt,
3. let the model solve it following a fixed reasoning protocol,
4. judge the code on the sample tests,
5. stress-test it against a model-written brute force on small random tests,
6. feed any failure back to the model to fix, and once the fixes run out, ask it to
   start over with a different approach.
"""

import itertools
import json
import os
import re
from pathlib import Path

import ollama

import knowledge
import sandbox

WORKSPACE = Path(__file__).resolve().parent / "workspace"
PREFERRED_MODELS = ["qwen3.5:4b", "qwen3:4b", "qwen2.5-coder:7b", "qwen2.5-coder:3b"]
NEW_PROBLEM_CHARS = 150  # shorter messages are follow-ups to the current problem

# What each effort level adds; "deep" is the default.
EFFORTS = {
    "fast": {"analyze": False, "kb": 2, "fix_rounds": 2, "stress": False, "rethink": False},
    "deep": {"analyze": True, "kb": 3, "fix_rounds": 3, "stress": False, "rethink": False},
    "max": {"analyze": True, "kb": 3, "fix_rounds": 3, "stress": True, "rethink": True},
}
STRESS_ITERATIONS = 150
STRESS_BUDGET_SECONDS = 45

# Prompts are shared with the in-browser version (static/browser/agent.js).
PROMPTS = json.loads((Path(__file__).resolve().parent / "static" / "prompts.json").read_text(encoding="utf-8"))
SYSTEM_PROMPTS = PROMPTS["system"]
FORMAT_RULES = PROMPTS["format_rules"]
ANALYZE_PROMPT = PROMPTS["analyze"]
EXTRACT_PROMPT = PROMPTS["extract"]

ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "format": {"type": "string", "enum": ["stdin", "file_io", "multiple_cases_case_x", "interactive", "function_grader"]},
        "time_limit_seconds": {"type": "number"},
        "target_complexity": {"type": "string"},
        "observations": {"type": "array", "items": {"type": "string"}},
        "edge_cases": {"type": "array", "items": {"type": "string"}},
        "unique_answer": {"type": "boolean"},
        "topics": {"type": "array", "items": {"type": "string", "enum": knowledge.TOPIC_IDS}},
    },
    "required": ["summary", "format", "time_limit_seconds", "target_complexity", "observations",
                 "edge_cases", "unique_answer", "topics"],
}

TEST_SCHEMA = {
    "type": "object",
    "properties": {
        "tests": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"input": {"type": "string"}, "output": {"type": "string"}},
                "required": ["input", "output"],
            },
        }
    },
    "required": ["tests"],
}

CODE_BLOCK_RE = re.compile(r"```([\w+#-]*)[^\n]*\n(.*?)```", re.S)
CODE_LANGS = {"cpp": "cpp", "c++": "cpp", "cc": "cpp", "c": "c", "python": "python", "py": "python", "python3": "python"}
# Small models often claim "several answers accepted"; only believe it when the statement says so.
ANY_ANSWER_RE = re.compile(r"\bany\b|bất k[ỳì]|nào cũng|nhiều đáp án|multiple (?:answers|solutions)", re.I)
# Caps for the helper calls: small models sometimes repeat themselves until the context is full.
MAX_TOKENS = {"extract": 800, "analyze": 700, "generator": 600, "brute": 1000}
# Likewise for formats that change how the code is judged: they must be visible in the statement itself.
FORMAT_EVIDENCE = {
    "interactive": re.compile(r"interactive|tương tác|flush|interactor", re.I),
    "function_grader": re.compile(r"grader|cài đặt hàm|hàm sau|implement the function|function signature", re.I),
    "file_io": re.compile(r"\.(inp|in|out|ans)\b", re.I),
    "multiple_cases_case_x": re.compile(r"case #", re.I),
}
TIME_LIMIT_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:giây|s\b|sec|second)", re.I)

_capabilities: dict[str, list[str]] = {}


def num_ctx() -> int:
    return int(os.environ.get("OLLAMA_NUM_CTX", 8192))


def model_capabilities(client: ollama.Client, model: str) -> list[str]:
    if model not in _capabilities:
        _capabilities[model] = list(getattr(client.show(model), "capabilities", None) or [])
    return _capabilities[model]


def installed_models(client: ollama.Client) -> list[str]:
    names = [m.model for m in client.list().models]
    ranked = [m for m in PREFERRED_MODELS if m in names]
    return ranked + sorted(n for n in names if n not in ranked)


def site_dir(conversation_id: str) -> Path:
    return WORKSPACE / conversation_id


def save_site(conversation_id: str, html: str) -> dict:
    root = site_dir(conversation_id)
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.html").write_text(html, encoding="utf-8")
    return {"saved": ["index.html"], "all_files": ["index.html"],
            "preview_url": f"/preview/{conversation_id}/index.html"}


def last_code_block(text: str, langs: dict[str, str]):
    for lang, body in reversed(CODE_BLOCK_RE.findall(text)):
        if lang.lower() in langs:
            return langs[lang.lower()], body
    return None


def _trim_history(messages: list[dict], system_chars: int) -> list[dict]:
    """Keep the most recent messages that fit next to the system prompt and the reply, starting at a user turn."""
    budget = max(4000, num_ctx() * 2 - system_chars)  # ~2.5 chars per token, leaving room for the reply
    kept, total = [], 0
    for msg in reversed(messages):
        total += len(msg["content"])
        if kept and total > budget:
            break
        kept.append(msg)
    kept.reverse()
    while len(kept) > 1 and kept[0]["role"] != "user":
        kept.pop(0)
    return kept


def _tests_look_real(test: dict, statement: str) -> bool:
    """Reject tests whose numbers or words do not appear in the statement (hallucinated)."""
    words = set(statement.split())
    tokens = test["input"].split() + test["output"].split()
    return bool(test["output"].split()) and all(t in words for t in tokens)


def _no_think(client, model) -> dict:
    return {"think": False} if "thinking" in model_capabilities(client, model) else {}


def extract_tests(client, model, statement):
    resp = client.chat(model=model, format=TEST_SCHEMA,
                       options={"temperature": 0, "num_ctx": num_ctx(), "num_predict": MAX_TOKENS["extract"]},
                       messages=[{"role": "system", "content": EXTRACT_PROMPT},
                                 {"role": "user", "content": statement}], **_no_think(client, model))
    try:
        tests = json.loads(resp.message.content).get("tests", [])
    except (json.JSONDecodeError, AttributeError):
        return []
    return [{"input": t["input"].strip() + "\n", "expected_output": t["output"].strip()}
            for t in tests if isinstance(t, dict) and _tests_look_real(t, statement)][:10]


def _stream_quiet(client, model, messages, tool_id, **kwargs):
    """Stream a helper reply that is not shown as chat text, reporting progress on a tool card."""
    parts, reported = [], 0
    for chunk in client.chat(model=model, messages=messages, stream=True, **kwargs):
        if chunk.message.content:
            parts.append(chunk.message.content)
            size = sum(map(len, parts))
            if size - reported >= 200:
                yield {"type": "tool_progress", "id": tool_id, "chars": size - reported}
                reported = size
    return "".join(parts)


def analyze_problem(client, model, statement):
    """Structured first look at the problem; yields progress events and returns the analysis dict."""
    hint = knowledge.constraint_hint(statement)
    request = [{"role": "system", "content": ANALYZE_PROMPT},
               {"role": "user", "content": statement + (f"\n\n(Gợi ý: {hint})" if hint else "")}]
    raw = yield from _stream_quiet(client, model, request, "analyze", format=ANALYSIS_SCHEMA,
                                   options={"temperature": 0.2, "num_ctx": num_ctx(), "num_predict": MAX_TOKENS["analyze"]},
                                   **_no_think(client, model))
    try:
        analysis = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(analysis, dict):
        return {}
    analysis["topics"] = [t for t in analysis.get("topics", []) if t in knowledge.BY_ID][:4]
    evidence = FORMAT_EVIDENCE.get(analysis.get("format", ""))
    if evidence and not evidence.search(statement):
        analysis["format"] = "stdin"
    for key in ("observations", "edge_cases"):
        analysis[key] = [str(x) for x in analysis.get(key, [])][:4]
    return analysis


def _time_limit(analysis: dict, statement: str) -> float:
    tl = analysis.get("time_limit_seconds")
    if not isinstance(tl, (int, float)) or tl <= 0:
        m = TIME_LIMIT_RE.search(statement)
        tl = float(m.group(1).replace(",", ".")) if m else 2.0
    return max(0.5, min(float(tl), 10.0))


def _cp_system(analysis: dict, entries: list[dict], hint: str) -> str:
    parts = [SYSTEM_PROMPTS["cp"]]
    rule = FORMAT_RULES.get(analysis.get("format", ""))
    if rule:
        parts.append(rule)
    notes = []
    if hint:
        notes.append(hint)
    if analysis.get("target_complexity"):
        notes.append(f"Độ phức tạp mục tiêu (phân tích sơ bộ): {analysis['target_complexity']}")
    for label, key in (("Quan sát", "observations"), ("Trường hợp biên cần kiểm tra", "edge_cases")):
        if analysis.get(key):
            notes.append(f"{label}:\n" + "\n".join(f"- {x}" for x in analysis[key]))
    if notes:
        parts.append("Preliminary analysis (verify it, do not trust blindly):\n" + "\n".join(notes))
    if entries:
        parts.append(knowledge.as_prompt(entries))
    return "\n\n".join(parts)


def stream_reply(client, model, system, messages, think):
    """Stream one model reply as UI events; returns the reply text."""
    kwargs = {}
    if "thinking" in model_capabilities(client, model):
        kwargs["think"] = think
    request = [{"role": "system", "content": system}] + _trim_history(messages, len(system))
    parts, current = [], None
    for chunk in client.chat(model=model, messages=request, stream=True,
                             options={"num_ctx": num_ctx(), "temperature": 0.6}, **kwargs):
        msg = chunk.message
        if getattr(msg, "thinking", None):
            if current != "thinking":
                current = "thinking"
                yield {"type": "block_start", "kind": "thinking"}
            yield {"type": "thinking", "text": msg.thinking}
        if msg.content:
            if current != "text":
                current = "text"
                yield {"type": "block_start", "kind": "text"}
            parts.append(msg.content)
            yield {"type": "text", "text": msg.content}
        if chunk.done:
            seconds = (chunk.eval_duration or 0) / 1e9
            yield {"type": "usage", "input": chunk.prompt_eval_count or 0, "output": chunk.eval_count or 0,
                   "speed": round((chunk.eval_count or 0) / seconds, 1) if seconds else 0}
    return "".join(parts)


def _failure_feedback(result: dict, tests: list[dict], analysis: dict) -> str:
    if result["verdict"] == "CE":
        return f"Code bị lỗi biên dịch:\n```\n{result['compile_error']}\n```\nHãy sửa lỗi và viết lại TOÀN BỘ code."
    bad = next(t for t in result["tests"] if t["verdict"] not in ("AC", "OK"))
    lines = [f"Chạy thử: {result['passed']}/{result['total']} test mẫu đúng. Test {bad['test']} bị {bad['verdict']}."]
    test = tests[bad["test"] - 1]
    lines.append(f"Input:\n```\n{test['input']}```")
    if bad["verdict"] == "TLE":
        target = analysis.get("target_complexity")
        lines.append("Code chạy quá thời gian. Kiểm tra vòng lặp vô hạn, hoặc cần thuật toán nhanh hơn"
                     + (f" (mục tiêu {target})." if target else "."))
    else:
        lines.append(f"Output mong đợi:\n```\n{test['expected_output']}\n```")
        lines.append(f"Output của bạn:\n```\n{bad['stdout']}\n```")
    if bad.get("stderr"):
        lines.append(f"Stderr:\n```\n{bad['stderr']}\n```")
    lines.append("Trước khi sửa: trace code trên input này từng bước để tìm đúng chỗ sai. Nếu lỗi nằm ở chính "
                 "thuật toán (không phải cài đặt), hãy đổi thuật toán. Sau đó viết lại TOÀN BỘ code.")
    return "\n".join(lines)


def _stress_feedback(result: dict) -> str:
    if result["result"] == "CE":
        return f"Code bị lỗi biên dịch:\n```\n{result['compile_error']}\n```\nHãy sửa lỗi và viết lại TOÀN BỘ code."
    lines = [f"Stress test (so với lời giải trâu trên test nhỏ ngẫu nhiên) tìm ra test sai (seed {result.get('seed')}):",
             f"Input:\n```\n{result['input']}```"]
    if result["result"] == "MISMATCH":
        lines.append(f"Output của lời giải trâu:\n```\n{result['expected_output']}\n```")
        lines.append(f"Output của bạn:\n```\n{result['solution_output']}\n```")
        lines.append("Lời giải trâu cũng có thể sai: hãy tự tính đáp án đúng bằng tay trên test nhỏ này trước. "
                     "Nếu code của bạn đúng, chỉ trả lời một câu bắt đầu bằng \"BRUTE SAI\" và không viết code.")
    else:
        lines.append(f"Code của bạn bị {result['result']} trên test nhỏ này"
                     + (" (có thể là vòng lặp vô hạn)." if result["result"] == "TLE" else "."))
        if result.get("stderr"):
            lines.append(f"Stderr:\n```\n{result['stderr']}\n```")
    lines.append("Nếu code sai: tìm nguyên nhân gốc, giải thích ngắn gọn, rồi viết lại TOÀN BỘ code.")
    return "\n".join(lines)


def _generator_ok(code: str) -> bool:
    """A generator prints a test from the seed; small models sometimes write a solver instead."""
    return "sys.argv" in code and "input(" not in code and "stdin" not in code


def _write_stress_helpers(client, model, statement, lang, source, tool_id):
    """Ask for the generator and the brute force separately; returns the helpers dict or None."""
    def ask(messages, max_tokens):
        reply = yield from _stream_quiet(client, model, messages, tool_id,
                                         options={"temperature": 0.3, "num_ctx": num_ctx(), "num_predict": max_tokens},
                                         **_no_think(client, model))
        messages.append({"role": "assistant", "content": reply})
        return last_code_block(reply, CODE_LANGS)

    request = [{"role": "system", "content": PROMPTS["stress_generator"]}, {"role": "user", "content": f"Problem:\n{statement}"}]
    gen = yield from ask(request, MAX_TOKENS["generator"])
    if not gen or gen[0] != "python" or not _generator_ok(gen[1]):
        request.append({"role": "user", "content": PROMPTS["stress_generator_retry"]})
        gen = yield from ask(request, MAX_TOKENS["generator"])
        if not gen or gen[0] != "python" or not _generator_ok(gen[1]):
            return None
    request = [{"role": "system", "content": PROMPTS["stress_brute"]},
               {"role": "user", "content": f"Problem:\n{statement}\n\nSolution:\n```{lang}\n{source}```"}]
    brute = yield from ask(request, MAX_TOKENS["brute"])
    if not brute:
        return None
    return {"generator": gen[1], "brute_language": brute[0], "brute": brute[1]}


def _judge(lang, source, tests, time_limit, run_id):
    yield {"type": "tool_start", "id": run_id, "name": "run_code"}
    yield {"type": "tool_call", "id": run_id, "name": "run_code",
           "input": {"language": lang, "code": source, "tests": tests, "time_limit": time_limit}}
    result = sandbox.run_tests(lang, source, tests, time_limit)
    yield {"type": "tool_result", "id": run_id, "name": "run_code", "output": result}
    return result


def _stress(client, model, state, lang, source, time_limit, run_id):
    """Random-test the solution against a brute force; returns the stress result, or None if it could not run."""
    yield {"type": "tool_start", "id": run_id, "name": "stress_test"}
    helpers = state.get("stress")
    if not helpers:
        helpers = yield from _write_stress_helpers(client, model, state.get("statement", ""), lang, source, run_id)
        if not helpers:
            yield {"type": "tool_result", "id": run_id, "name": "stress_test",
                   "output": {"error": "AI không viết được generator/brute force hợp lệ, bỏ qua stress test."}}
            return None
    yield {"type": "tool_call", "id": run_id, "name": "stress_test",
           "input": {"iterations": STRESS_ITERATIONS, "solution_language": lang, "solution_code": source,
                     "brute_language": helpers["brute_language"], "brute_code": helpers["brute"],
                     "generator_code": helpers["generator"]}}
    result = sandbox.stress_test(helpers["generator"], {"language": lang, "code": source},
                                 {"language": helpers["brute_language"], "code": helpers["brute"]},
                                 STRESS_ITERATIONS, time_limit, STRESS_BUDGET_SECONDS)
    yield {"type": "tool_result", "id": run_id, "name": "stress_test", "output": result}
    if result["result"] in ("GENERATOR_FAILED", "BRUTE_FAILED") or (
            result["result"] == "CE" and result.get("program") != "solution"):
        state["stress"] = None
        yield {"type": "notice", "text": "Generator hoặc lời giải trâu do AI viết bị lỗi nên bỏ qua stress test."}
        return None
    state["stress"] = helpers
    return result


def _solve_problem(client, messages, state, model, think, effort):
    cfg = EFFORTS[effort]
    text = messages[-1]["content"]
    if len(text) > NEW_PROBLEM_CHARS:
        state.update({"statement": text, "analysis": {}, "kb": [], "stress": None})
        yield {"type": "tool_start", "id": "extract", "name": "extract_tests"}
        tests = extract_tests(client, model, text)
        if tests:
            state["tests"] = tests
        yield {"type": "tool_result", "id": "extract", "name": "extract_tests",
               "output": {"tests": tests, "reused": not tests and bool(state.get("tests"))}}
        if cfg["analyze"]:
            yield {"type": "tool_start", "id": "analyze", "name": "analyze_problem"}
            state["analysis"] = yield from analyze_problem(client, model, text)
            yield {"type": "tool_result", "id": "analyze", "name": "analyze_problem",
                   "output": state["analysis"] or {"error": "Không phân tích được đề, tiếp tục giải trực tiếp."}}
        entries = knowledge.retrieve(text, state["analysis"].get("topics"), k=cfg["kb"])
        state["kb"] = [e["id"] for e in entries]
        if entries:
            yield {"type": "tool_start", "id": "kb", "name": "knowledge"}
            yield {"type": "tool_result", "id": "kb", "name": "knowledge",
                   "output": {"topics": [{"id": e["id"], "title": e["title"]} for e in entries]}}

    statement = state.get("statement", text)
    analysis = state.get("analysis") or {}
    entries = [knowledge.BY_ID[i] for i in state.get("kb", []) if i in knowledge.BY_ID]
    system = _cp_system(analysis, entries, knowledge.constraint_hint(statement))
    time_limit = _time_limit(analysis, statement)
    tests = state.get("tests", [])
    any_answer = analysis.get("unique_answer") is False and ANY_ANSWER_RE.search(statement)
    stress = cfg["stress"] and not any_answer and analysis.get("format") != "interactive"

    fixes_left, rethinks_left, fixes_done = cfg["fix_rounds"], int(cfg["rethink"]), 0
    for round_no in itertools.count():  # ends via fixes_left / rethinks_left
        reply = yield from stream_reply(client, model, system, messages, think)
        messages.append({"role": "assistant", "content": reply})
        code = last_code_block(reply, CODE_LANGS)
        if not code:
            if "BRUTE SAI" in reply.upper():
                yield {"type": "notice", "text": "AI kiểm tra lại và cho rằng lời giải trâu sai; giữ code đã qua test mẫu."}
            return
        if analysis.get("format") == "interactive":
            yield {"type": "notice", "text": "Bài tương tác: trình chấm cục bộ không mô phỏng được judge nên chưa chạy thử."}
            return
        if not tests and not stress:
            yield {"type": "notice", "text": "Không tìm thấy test mẫu trong đề nên chưa chạy thử. "
                                             "Bạn có thể tự thêm test trong Trình chấm, hoặc chọn mức suy nghĩ Tối đa để stress test."}
            return
        lang, source = code
        feedback, passed = None, []
        if tests:
            result = yield from _judge(lang, source, tests, time_limit, f"run{round_no}")
            if result["verdict"] in ("AC", "OK"):
                passed.append(f"{result['passed']}/{result['total']} test mẫu")
            else:
                feedback, verdict = _failure_feedback(result, tests, analysis), result["verdict"]
        if feedback is None and stress:
            result = yield from _stress(client, model, state, lang, source, time_limit, f"stress{round_no}")
            if result and result["result"] in ("ALL_PASSED", "BUDGET_EXHAUSTED"):
                passed.append(f"{result['iterations_passed']} test ngẫu nhiên so với lời giải trâu")
            elif result:
                feedback, verdict = _stress_feedback(result), result["result"]
        if feedback is None:
            yield {"type": "notice", "text": "Code đã qua " + " và ".join(passed) + "."
                   if passed else "Không chạy được kiểm tra nào cho code này."}
            return
        if fixes_left == 0:
            if rethinks_left == 0:
                yield {"type": "error", "message": "Đã tự sửa nhiều lần nhưng vẫn chưa đúng. Hãy thử bật 'Suy nghĩ', "
                                                   "đổi model lớn hơn, hoặc gợi ý thêm cho AI."}
                return
            rethinks_left -= 1
            fixes_left = cfg["fix_rounds"] - 1
            messages.append({"role": "user", "content": feedback + "\n\nĐã sửa nhiều lần mà vẫn sai. Hãy BỎ hướng làm "
                             "hiện tại và nghĩ lại từ đầu: liệt kê lại các quan sát, chọn một thuật toán KHÁC, kiểm tra "
                             "bằng tay trên test mẫu rồi mới viết lại TOÀN BỘ code."})
            yield {"type": "notice", "text": "Các cách sửa chưa hiệu quả, AI đang nghĩ lại từ đầu với hướng khác…"}
            continue
        fixes_left -= 1
        fixes_done += 1
        messages.append({"role": "user", "content": feedback})
        yield {"type": "notice", "text": f"Code chưa đúng ({verdict}), AI đang tự sửa (lần {fixes_done})…"}


def run_turn(client: ollama.Client, conversation_id: str, messages: list, state: dict,
             mode: str = "cp", model: str = "", think: bool = True, effort: str = "deep"):
    """Run one user turn, yielding UI events. `messages` already ends with the user message."""
    if mode == "cp":
        yield from _solve_problem(client, messages, state, model, think, effort)
        return

    system = SYSTEM_PROMPTS[mode]
    if mode in ("chat", "web"):
        entries = knowledge.retrieve(messages[-1]["content"], k=2, min_score=3 if mode == "chat" else 2,
                                     kind="web" if mode == "web" else "cp")
        if entries:
            system += "\n\n" + knowledge.as_prompt(entries)
            yield {"type": "tool_start", "id": "kb", "name": "knowledge"}
            yield {"type": "tool_result", "id": "kb", "name": "knowledge",
                   "output": {"topics": [{"id": e["id"], "title": e["title"]} for e in entries]}}
    reply = yield from stream_reply(client, model, system, messages, think)
    messages.append({"role": "assistant", "content": reply})
    if mode == "web":
        page = last_code_block(reply, {"html": "html"})
        if not page:
            return
        yield {"type": "tool_start", "id": "site", "name": "save_web_files"}
        yield {"type": "tool_call", "id": "site", "name": "save_web_files", "input": {"files": [{"path": "index.html"}]}}
        yield {"type": "tool_result", "id": "site", "name": "save_web_files",
               "output": save_site(conversation_id, page[1])}
