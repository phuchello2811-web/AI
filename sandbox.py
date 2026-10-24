"""Compile and run contestant code locally, judge it against tests, stress-test it.

This is a convenience sandbox, not a security boundary: code runs as the current
user in a temp directory with CPU-time, file-size and wall-clock limits only
(only the wall-clock limit on Windows, which has no `resource` module).
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    import resource
except ImportError:  # Windows
    resource = None

ROOT = Path(__file__).resolve().parent
# Apple clang ships no <bits/stdc++.h>; this folder provides one.
SHIM_INCLUDE = ROOT / "cpp_shim"

MAX_OUTPUT_CHARS = 3000
COMPILE_TIMEOUT = 60

LANGUAGES = {
    "cpp": {
        "file": "main.cpp",
        "compile": ["g++", "-std=c++17", "-O2", "-pipe", "-I", str(SHIM_INCLUDE), "-o", "main", "main.cpp"],
        "run": ["./main"],
    },
    "c": {
        "file": "main.c",
        "compile": ["gcc", "-std=c11", "-O2", "-pipe", "-o", "main", "main.c", "-lm"],
        "run": ["./main"],
    },
    "python": {
        "file": "main.py",
        "compile": None,
        "run": [sys.executable, "main.py"],
    },
}
# Olympiad problems often read BAI.INP and write BAI.OUT instead of stdin/stdout.
INPUT_FILE_RE = re.compile(r"""["']([\w-]+\.(?:inp|in))["']""", re.IGNORECASE)
OUTPUT_FILE_RE = re.compile(r"""["']([\w-]+\.(?:out|ans))["']""", re.IGNORECASE)
LANGUAGE_ALIASES = {"c++": "cpp", "cc": "cpp", "cxx": "cpp", "py": "python", "python3": "python"}


def normalize_language(language: str) -> str:
    lang = (language or "").strip().lower()
    lang = LANGUAGE_ALIASES.get(lang, lang)
    if lang not in LANGUAGES:
        raise ValueError(f"Unsupported language '{language}'. Use one of: {', '.join(LANGUAGES)}")
    return lang


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n...[truncated, {len(text) - limit} more chars]"


def _limits(cpu_seconds: int):
    if resource is None:
        return None

    def apply():
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 << 20, 64 << 20))
    return apply


def outputs_match(actual: str, expected: str, float_eps: float = 1e-6) -> bool:
    """Token-wise comparison, ignoring whitespace; numbers compared with tolerance."""
    a, e = actual.split(), expected.split()
    if len(a) != len(e):
        return False
    for x, y in zip(a, e):
        if x == y:
            continue
        try:
            fx, fy = float(x), float(y)
        except ValueError:
            return False
        if abs(fx - fy) > float_eps * max(1.0, abs(fy)):
            return False
    return True


class Program:
    """A compiled (or interpreted) program living in its own temp directory."""

    def __init__(self, language: str, code: str):
        self.language = normalize_language(language)
        self.spec = LANGUAGES[self.language]
        self.dir = Path(tempfile.mkdtemp(prefix="judge_"))
        (self.dir / self.spec["file"]).write_text(code, encoding="utf-8")
        self.compile_error = None
        in_match, out_match = INPUT_FILE_RE.search(code), OUTPUT_FILE_RE.search(code)
        self.input_file = in_match.group(1) if in_match else None
        self.output_file = out_match.group(1) if out_match else None

    def compile(self) -> bool:
        if not self.spec["compile"]:
            return True
        try:
            proc = subprocess.run(self.spec["compile"], cwd=self.dir, capture_output=True,
                                  text=True, encoding="utf-8", errors="replace", timeout=COMPILE_TIMEOUT)
        except subprocess.TimeoutExpired:
            self.compile_error = "Compilation timed out"
            return False
        if proc.returncode != 0:
            self.compile_error = _truncate(proc.stderr or proc.stdout)
            return False
        return True

    def _command(self) -> list[str]:
        if self.spec["run"] == ["./main"]:
            # Absolute path: Windows does not look up programs in the child's cwd, and g++ adds ".exe" there.
            return [str(self.dir / ("main.exe" if os.name == "nt" else "main"))]
        return self.spec["run"]

    def run(self, stdin: str, time_limit: float, args: list[str] | None = None) -> dict:
        if self.input_file:
            (self.dir / self.input_file).write_text(stdin, encoding="utf-8")
        if self.output_file:
            (self.dir / self.output_file).unlink(missing_ok=True)
        start = time.perf_counter()
        try:
            proc = subprocess.run(self._command() + (args or []), cwd=self.dir, input=stdin,
                                  capture_output=True, text=True, encoding="utf-8", errors="replace",
                                  timeout=time_limit * 2 + 1, preexec_fn=_limits(int(time_limit) + 1))
        except subprocess.TimeoutExpired:
            return {"status": "TLE", "time": round(time.perf_counter() - start, 3), "stdout": "", "stderr": ""}
        elapsed = time.perf_counter() - start
        stdout = proc.stdout
        if self.output_file and (self.dir / self.output_file).exists():
            stdout = (self.dir / self.output_file).read_text(encoding="utf-8", errors="replace")
        status = "OK"
        if proc.returncode != 0:
            status = "TLE" if proc.returncode in (-24, -9) else "RE"
        elif elapsed > time_limit:
            status = "TLE"
        return {"status": status, "time": round(elapsed, 3), "exit_code": proc.returncode,
                "stdout": stdout, "stderr": proc.stderr}

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def run_tests(language: str, code: str, tests: list[dict], time_limit: float = 2.0) -> dict:
    """Run code on each test. A test is {"input": str, "expected_output": str | None}."""
    time_limit = max(0.1, min(float(time_limit), 10.0))
    prog = Program(language, code)
    try:
        if not prog.compile():
            return {"verdict": "CE", "compile_error": prog.compile_error, "tests": []}
        results = []
        for i, test in enumerate(tests or [{"input": ""}], 1):
            r = prog.run(test.get("input", ""), time_limit)
            expected = test.get("expected_output")
            verdict = r["status"]
            if verdict == "OK" and expected is not None:
                verdict = "AC" if outputs_match(r["stdout"], expected) else "WA"
            item = {"test": i, "verdict": verdict, "time": r["time"],
                    "stdout": _truncate(r["stdout"])}
            if r["stderr"]:
                item["stderr"] = _truncate(r["stderr"], 1000)
            if verdict == "WA":
                item["expected_output"] = _truncate(expected)
            results.append(item)
        bad = [r["verdict"] for r in results if r["verdict"] not in ("AC", "OK")]
        return {"verdict": bad[0] if bad else ("AC" if all(r["verdict"] == "AC" for r in results) else "OK"),
                "passed": sum(r["verdict"] in ("AC", "OK") for r in results),
                "total": len(results), "tests": results}
    finally:
        prog.cleanup()


def stress_test(generator_code: str, solution: dict, brute: dict, iterations: int = 200,
                time_limit: float = 2.0, budget_seconds: float = 60.0) -> dict:
    """Random-test `solution` against `brute` using a Python generator that receives the seed as argv[1]."""
    iterations = max(1, min(int(iterations), 2000))
    progs = {"generator": Program("python", generator_code),
             "solution": Program(solution["language"], solution["code"]),
             "brute": Program(brute["language"], brute["code"])}
    try:
        for name, prog in progs.items():
            if not prog.compile():
                return {"result": "CE", "program": name, "compile_error": prog.compile_error}
        deadline = time.perf_counter() + budget_seconds
        for seed in range(1, iterations + 1):
            if time.perf_counter() > deadline:
                return {"result": "BUDGET_EXHAUSTED", "iterations_passed": seed - 1}
            gen = progs["generator"].run("", 10.0, [str(seed)])
            if gen["status"] != "OK":
                return {"result": "GENERATOR_FAILED", "seed": seed, "stderr": _truncate(gen["stderr"])}
            test_input = gen["stdout"]
            ref = progs["brute"].run(test_input, time_limit * 5)
            if ref["status"] != "OK" or not ref["stdout"].strip():
                return {"result": "BRUTE_FAILED", "seed": seed, "input": _truncate(test_input),
                        "status": ref["status"], "stderr": _truncate(ref["stderr"] or "brute force printed nothing")}
            got = progs["solution"].run(test_input, time_limit)
            if got["status"] != "OK" or not outputs_match(got["stdout"], ref["stdout"]):
                return {"result": "MISMATCH" if got["status"] == "OK" else got["status"], "seed": seed,
                        "input": _truncate(test_input), "expected_output": _truncate(ref["stdout"]),
                        "solution_output": _truncate(got["stdout"]), "stderr": _truncate(got["stderr"], 1000)}
        return {"result": "ALL_PASSED", "iterations_passed": iterations}
    finally:
        for prog in progs.values():
            prog.cleanup()


def ensure_cpp_shim():
    header = SHIM_INCLUDE / "bits" / "stdc++.h"
    if header.exists():
        return
    header.parent.mkdir(parents=True, exist_ok=True)
    headers = [
        "cassert", "cctype", "cerrno", "cfloat", "climits", "cmath", "cstdio", "cstdlib", "cstring",
        "ctime", "cstdint", "cinttypes", "algorithm", "array", "bitset", "chrono", "complex", "deque",
        "functional", "iomanip", "iostream", "istream", "ostream", "sstream", "fstream", "iterator",
        "limits", "list", "map", "memory", "numeric", "queue", "random", "ratio", "set", "stack",
        "string", "tuple", "type_traits", "unordered_map", "unordered_set", "utility", "valarray",
        "vector", "optional", "variant", "string_view", "climits", "cstddef", "regex", "atomic",
        "thread", "mutex",
    ]
    header.write_text("#pragma once\n" + "".join(f"#include <{h}>\n" for h in dict.fromkeys(headers)),
                      encoding="utf-8")


ensure_cpp_shim()
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
