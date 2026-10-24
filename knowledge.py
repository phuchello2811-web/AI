"""Competitive-programming knowledge base the agent retrieves from before solving.

A small local model cannot be retrained here, so instead the relevant techniques,
templates and contest rules (IOI, Google Code Jam / Kick Start, VOI) are looked up
for each problem and placed in the prompt. Entries are short on purpose: a few of
them must fit into an 8K-token context next to the problem and the reply.
"""

import json
import re
import unicodedata
from pathlib import Path

# Each entry: id, title, keys (lowercase, matched without Vietnamese diacritics), body (markdown).
# The same file is used by the in-browser version (static/browser/agent.js).
ENTRIES = json.loads((Path(__file__).resolve().parent / "static" / "knowledge.json").read_text(encoding="utf-8"))
BY_ID = {e["id"]: e for e in ENTRIES}
TOPIC_IDS = [e["id"] for e in ENTRIES]


def normalize(text: str) -> str:
    """Lowercase and strip Vietnamese diacritics so "Quy hoạch động" matches "quy hoach dong"."""
    text = text.lower().replace("đ", "d")
    text = "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", text)


_NUM = r"(10\s*\^\s*\{?\d+\}?|\d+(?:[.,]\d+)?\s*(?:(?:[·*x×.]|\\cdot)\s*10\s*\^\s*\{?\d+\}?|e\d+)?)"
_BOUND_RE = re.compile(r"(?<![\w])([A-Za-z]\w{0,2}|\|[a-z]\w{0,2}\|)\s*(?:≤|<=|<|\\le)\s*" + _NUM)
SIZE_VARS = {"n", "m", "q", "k", "t", "|s|"}


def _number(text: str) -> float:
    text = text.replace(" ", "")
    m = re.fullmatch(r"10\^\{?(\d+)\}?", text)
    if m:
        return 10.0 ** int(m.group(1))
    m = re.fullmatch(r"(\d+(?:[.,]\d+)?)(?:(?:[·*x×.]|\\cdot)10\^\{?(\d+)\}?|e(\d+))?", text)
    if not m:
        return 0.0
    exp = m.group(2) or m.group(3)
    return float(m.group(1).replace(",", ".")) * (10.0 ** int(exp) if exp else 1.0)


def bounds(statement: str) -> tuple[float, float]:
    """(largest size bound like n ≤ 2·10^5, largest other bound like a_i ≤ 10^9) found in the statement."""
    size = value = 0.0
    for var, num in _BOUND_RE.findall(statement.replace(" ", " ")):
        x = _number(num)
        if var.lower() in SIZE_VARS:
            size = max(size, x)
        else:
            value = max(value, x)
    return size, value


def constraint_hint(statement: str) -> str:
    n, value = bounds(statement)
    if n <= 0:
        if value >= 1e9:
            return f"Giá trị tới {value:g} ⇒ không duyệt từng giá trị: cần O(√X), O(log X) hoặc công thức."
        return ""
    if n <= 11:
        target = "O(n!) hoặc vét cạn"
    elif n <= 25:
        target = "O(2^n · n) — bitmask"
    elif n <= 45:
        target = "O(2^(n/2)) — meet in the middle"
    elif n <= 500:
        target = "O(n^3)"
    elif n <= 5000:
        target = "O(n^2)"
    elif n <= 1e6:
        target = "O(n log n) hoặc O(n √n)"
    elif n <= 1e8:
        target = "O(n)"
    else:
        target = "O(√n), O(log n) hoặc công thức (không duyệt từng giá trị)"
    return f"Kích thước lớn nhất n ≈ {n:g} ⇒ độ phức tạp mục tiêu: {target}."


def _bound_topics(statement: str) -> list[str]:
    n, value = bounds(statement)
    if 0 < n <= 25:
        return ["dp_bitmask"]
    if 25 < n <= 45:
        return ["meet_middle"]
    if n >= 1e12 or (not n and value >= 1e12):
        return ["matrix_expo", "number_theory", "binary_search"]
    return []


def _key_re(key: str) -> re.Pattern:
    return re.compile(r"(?<![a-z0-9])" + re.escape(normalize(key)) + r"(?![a-z0-9])")


_KEY_RES = {e["id"]: [(len(k.split()), _key_re(k)) for k in e["keys"]] for e in ENTRIES}


def retrieve(text: str, topics: list[str] | None = None, k: int = 3, min_score: float = 2.0) -> list[dict]:
    """Rank entries by keyword hits in `text`; ids in `topics` (chosen by the model) get a large bonus."""
    norm = normalize(text)
    chosen = set(topics or []) | set(_bound_topics(text))
    scored = []
    for e in ENTRIES:
        score = sum(weight for weight, rx in _KEY_RES[e["id"]] if rx.search(norm))
        if e["id"] in chosen:
            score += 6
        if score >= min_score:
            scored.append((score, e))
    scored.sort(key=lambda s: -s[0])
    return [e for _, e in scored[:k]]


def as_prompt(entries: list[dict]) -> str:
    if not entries:
        return ""
    parts = [f"### {e['title']}\n{e['body']}" for e in entries]
    return "Kiến thức tham khảo (chỉ dùng phần liên quan):\n\n" + "\n\n".join(parts)
