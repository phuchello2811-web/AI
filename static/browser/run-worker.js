// Runs one compiled program per message. The page terminates this worker to enforce the time limit.
import * as shim from "https://cdn.jsdelivr.net/npm/@bjorn3/browser_wasi_shim@0.4.2/+esm";
import { runWasi } from "./runtime.js";

self.onmessage = ({ data: { id, module, opts } }) => {
  try {
    self.postMessage({ id, ...runWasi(shim, module, opts) });
  } catch (e) {
    self.postMessage({ id, exit_code: 134, time: 0, stdout: "", stderr: String(e && e.message || e) });
  }
};
