#!/bin/sh
# Khởi động CodeMaster: kiểm tra Ollama và model, cài thư viện Python (lần đầu), chạy server.
cd "$(dirname "$0")"

if ! command -v ollama >/dev/null 2>&1; then
  echo "Chưa cài Ollama. Cài bằng: brew install ollama  (hoặc tải tại https://ollama.com/download)"
  exit 1
fi
if ! curl -s http://127.0.0.1:11434/api/version >/dev/null; then
  echo "Đang bật Ollama…"
  brew services start ollama >/dev/null 2>&1 || (ollama serve >/dev/null 2>&1 &)
  sleep 3
fi
if [ -z "$(ollama list | tail -n +2)" ]; then
  echo "Chưa có model nào, đang tải qwen3:4b (~2.5 GB)…"
  ollama pull qwen3:4b || exit 1
fi

[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
echo "Mở trình duyệt: http://127.0.0.1:${PORT:-8000}"
exec .venv/bin/python server.py
