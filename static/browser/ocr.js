// Reads the text in an image (a photo of a problem statement, a screenshot of code or an error) right in
// the browser with Tesseract.js: free, no account, and offline once its files are cached. The text is
// added to the message, so every model can use it, including models that cannot see images.

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js";

let workerPromise = null;

/** One shared OCR worker for Vietnamese + English; `onStatus(text)` reports the first-time download. */
function getWorker(onStatus) {
  workerPromise ||= (async () => {
    const mod = await import(TESSERACT);
    const createWorker = mod.createWorker || (mod.default && mod.default.createWorker);
    return createWorker(["vie", "eng"], 1, {
      logger: (m) => {
        if (onStatus && m.status && typeof m.progress === "number" && m.progress < 1) {
          onStatus(`${m.status.includes("load") ? "đang tải bộ đọc chữ (chỉ lần đầu)" : "đang đọc chữ"} ${Math.round(m.progress * 100)}%`);
        }
      },
    });
  })().catch((e) => { workerPromise = null; throw e; });
  return workerPromise;
}

/** Text and confidence (0–100) of an image given as a data: URL. */
export async function readImage(dataUrl, onStatus) {
  const worker = await getWorker(onStatus);
  const { data } = await worker.recognize(dataUrl);
  const text = (data.text || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, confidence: Math.round(data.confidence || 0) };
}
