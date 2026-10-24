// Runs Python programs with Pyodide (CPython compiled to WebAssembly).
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs";

const RUNNER = `
import io, os, sys, traceback

def _cm_run(code, stdin, args, input_file, output_file):
    os.makedirs("/work", exist_ok=True)
    os.chdir("/work")
    if input_file:
        with open(input_file, "w") as f:
            f.write(stdin)
    if output_file and os.path.exists(output_file):
        os.remove(output_file)
    out_bytes, err = io.BytesIO(), io.StringIO()
    out = io.TextIOWrapper(out_bytes, encoding="utf-8", write_through=True)
    saved = sys.stdin, sys.stdout, sys.stderr, sys.argv
    sys.stdin = io.TextIOWrapper(io.BytesIO(stdin.encode()), encoding="utf-8")
    sys.stdout, sys.stderr, sys.argv = out, err, ["main.py", *args]
    exit_code = 0
    try:
        exec(compile(code, "main.py", "exec"), {"__name__": "__main__"})
    except SystemExit as e:
        exit_code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException:
        traceback.print_exc()
        exit_code = 1
    finally:
        out.flush()
        sys.stdin, sys.stdout, sys.stderr, sys.argv = saved
    stdout = out_bytes.getvalue().decode("utf-8", "replace")
    if output_file and os.path.exists(output_file):
        with open(output_file, encoding="utf-8", errors="replace") as f:
            stdout = f.read()
    return [exit_code, stdout, err.getvalue()]
`;

const ready = loadPyodide().then((py) => { py.runPython(RUNNER); return py; });

self.onmessage = async ({ data: { id, code, opts } }) => {
  try {
    const py = await ready;
    const start = performance.now();
    const res = py.globals.get("_cm_run")(code, opts.stdin || "", py.toPy(opts.args || []),
      opts.inputFile || null, opts.outputFile || null);
    const [exit_code, stdout, stderr] = res.toJs();
    res.destroy();
    self.postMessage({ id, exit_code, stdout, stderr, time: (performance.now() - start) / 1000 });
  } catch (e) {
    self.postMessage({ id, exit_code: 1, time: 0, stdout: "", stderr: String(e && e.message || e) });
  }
};
