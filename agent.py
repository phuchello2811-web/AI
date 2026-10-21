"""The coding agent: a local open-source model (via Ollama) driven by a fixed workflow.

Small local models are unreliable at deciding when to call tools, so the program drives
the loop instead: the model writes code, the server judges it on the sample tests, and
any failure is fed back to the model to fix, up to MAX_FIX_ROUNDS times.
"""

import json
import os
import re
from pathlib import Path

import ollama

import sandbox

WORKSPACE = Path(__file__).resolve().parent / "workspace"
PREFERRED_MODELS = ["qwen3.5:4b", "qwen3:4b", "qwen2.5-coder:7b", "qwen2.5-coder:3b"]
MAX_FIX_ROUNDS = 3
HISTORY_CHAR_BUDGET = 16000  # roughly what fits in the default 8192-token context next to the reply

SYSTEM_PROMPTS = {
    "cp": """You are an expert competitive programmer who coaches Vietnamese informatics olympiad students. Always reply in Vietnamese.

For each problem:
1. Restate the task and its constraints in one or two sentences.
2. Explain the algorithm and its time complexity. The complexity must fit the constraints.
3. Write the complete solution in exactly ONE code block. Use C++17 (```cpp) unless the user asks for another language, with fast I/O. Read from stdin and write to stdout, unless the statement names input/output files (for example BAI.INP and BAI.OUT); then read and write those files.

Your code is compiled and run on the sample tests automatically. If you are told that a test failed, find the bug, explain it in one or two sentences, and write the complete corrected code again in one code block.""",
    "web": """You are an expert front-end developer. Always reply in Vietnamese.

Build what the user asks as ONE complete HTML file in a single ```html code block, with CSS inside <style> and JavaScript inside <script>. Libraries may be loaded from a CDN. Make it modern, polished and responsive, with real content instead of placeholders where possible.
Before the code, write one or two sentences describing what you built. Write nothing after the code.
When the user asks for changes, output the complete updated file again.""",
    "chat": """You are a helpful programming assistant for students learning to code and preparing for informatics olympiads. Always reply in Vietnamese.
Explain clearly and concisely. Put code in fenced code blocks with a language tag.""",
}

EXTRACT_PROMPT = """Extract the sample tests (example input and expected output) from the programming problem below.
Copy them exactly as written, keeping line breaks. If the problem has no sample tests, return an empty list. Do not invent tests."""

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


def _trim_history(messages: list[dict]) -> list[dict]:
    """Keep the most recent messages that fit the context budget, starting at a user turn."""
    kept, total = [], 0
    for msg in reversed(messages):
        total += len(msg["content"])
        if kept and total > HISTORY_CHAR_BUDGET:
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


def extract_tests(client, model, statement):
    kwargs = {}
    if "thinking" in model_capabilities(client, model):
        kwargs["think"] = False
    resp = client.chat(model=model, format=TEST_SCHEMA, options={"temperature": 0, "num_ctx": num_ctx()},
                       messages=[{"role": "system", "content": EXTRACT_PROMPT},
                                 {"role": "user", "content": statement}], **kwargs)
    try:
        tests = json.loads(resp.message.content).get("tests", [])
    except (json.JSONDecodeError, AttributeError):
        return []
    return [{"input": t["input"].strip() + "\n", "expected_output": t["output"].strip()}
            for t in tests if isinstance(t, dict) and _tests_look_real(t, statement)][:10]


def stream_reply(client, model, mode, messages, think):
    """Stream one model reply as UI events; returns the reply text."""
    kwargs = {}
    if "thinking" in model_capabilities(client, model):
        kwargs["think"] = think
    request = [{"role": "system", "content": SYSTEM_PROMPTS[mode]}] + _trim_history(messages)
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


def _failure_feedback(result: dict) -> str:
    if result["verdict"] == "CE":
        return f"Code bị lỗi biên dịch:\n```\n{result['compile_error']}\n```\nHãy sửa lỗi và viết lại TOÀN BỘ code."
    bad = next(t for t in result["tests"] if t["verdict"] not in ("AC", "OK"))
    lines = [f"Chạy thử: {result['passed']}/{result['total']} test đúng. Test {bad['test']} bị {bad['verdict']}."]
    test = result["_tests"][bad["test"] - 1]
    lines.append(f"Input:\n```\n{test['input']}```")
    if bad["verdict"] == "TLE":
        lines.append("Code chạy quá thời gian (2 giây). Cần thuật toán nhanh hơn hoặc sửa vòng lặp vô hạn.")
    else:
        lines.append(f"Output mong đợi:\n```\n{test['expected_output']}\n```")
        lines.append(f"Output của bạn:\n```\n{bad['stdout']}\n```")
    if bad.get("stderr"):
        lines.append(f"Stderr:\n```\n{bad['stderr']}\n```")
    lines.append("Hãy tìm lỗi, giải thích ngắn gọn, rồi viết lại TOÀN BỘ code đã sửa.")
    return "\n".join(lines)


def run_turn(client: ollama.Client, conversation_id: str, messages: list, state: dict,
             mode: str = "cp", model: str = "", think: bool = True):
    """Run one user turn, yielding UI events. `messages` already ends with the user message."""
    if mode == "cp":
        statement = messages[-1]["content"]
        if len(statement) > 150:
            yield {"type": "tool_start", "id": "extract", "name": "extract_tests"}
            tests = extract_tests(client, model, statement)
            if tests:
                state["tests"] = tests
            yield {"type": "tool_result", "id": "extract", "name": "extract_tests",
                   "output": {"tests": tests, "reused": not tests and bool(state.get("tests"))}}
        tests = state.get("tests", [])

        for round_no in range(MAX_FIX_ROUNDS + 1):
            reply = yield from stream_reply(client, model, mode, messages, think)
            messages.append({"role": "assistant", "content": reply})
            code = last_code_block(reply, CODE_LANGS)
            if not code or not tests:
                if code and not tests:
                    yield {"type": "notice", "text": "Không tìm thấy test mẫu trong đề nên chưa chạy thử. "
                                                     "Bạn có thể tự thêm test trong Trình chấm."}
                return
            lang, source = code
            run_id = f"run{round_no}"
            yield {"type": "tool_start", "id": run_id, "name": "run_code"}
            yield {"type": "tool_call", "id": run_id, "name": "run_code",
                   "input": {"language": lang, "code": source, "tests": tests}}
            result = sandbox.run_tests(lang, source, tests)
            yield {"type": "tool_result", "id": run_id, "name": "run_code", "output": result}
            if result["verdict"] in ("AC", "OK"):
                yield {"type": "notice", "text": f"✅ Code đã qua {result['passed']}/{result['total']} test mẫu."}
                return
            if round_no == MAX_FIX_ROUNDS:
                yield {"type": "error", "message": f"Sau {MAX_FIX_ROUNDS} lần tự sửa vẫn chưa qua hết test mẫu. "
                                                   "Hãy thử bật 'Suy nghĩ', đổi model, hoặc gợi ý thêm cho AI."}
                return
            feedback = _failure_feedback({**result, "_tests": tests})
            messages.append({"role": "user", "content": feedback})
            yield {"type": "notice", "text": f"🔧 Code chưa đúng ({result['verdict']}), AI đang tự sửa (lần {round_no + 1}/{MAX_FIX_ROUNDS})…"}
        return

    reply = yield from stream_reply(client, model, mode, messages, think)
    messages.append({"role": "assistant", "content": reply})
    if mode == "web":
        page = last_code_block(reply, {"html": "html"})
        if not page:
            return
        yield {"type": "tool_start", "id": "site", "name": "save_web_files"}
        yield {"type": "tool_call", "id": "site", "name": "save_web_files", "input": {"files": [{"path": "index.html"}]}}
        yield {"type": "tool_result", "id": "site", "name": "save_web_files",
               "output": save_site(conversation_id, page[1])}
