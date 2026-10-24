#!/bin/sh
# Khởi động CodeMaster: kiểm tra Ollama và model, cài thư viện Python (lần đầu), chạy server.
cd "$(dirname "$0")"

if curl -s http://127.0.0.1:${PORT:-8000}/api/health >/dev/null 2>&1; then
  echo "CodeMaster đã chạy ở http://127.0.0.1:${PORT:-8000}"
  exit 0
fi
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

# Cần Python 3.10+; macOS chỉ có sẵn 3.9 nên ưu tiên bản mới hơn nếu đã cài (brew install python).
PY=""
for p in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
    PY="$p"; break
  fi
done
if [ -z "$PY" ]; then
  echo "Cần Python 3.10 trở lên. Cài bằng: brew install python"
  exit 1
fi
if [ -d .venv ] && ! .venv/bin/python -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
  rm -rf .venv
fi
[ -d .venv ] || "$PY" -m venv .venv
.venv/bin/pip install -q -r requirements.txt
echo "Mở trình duyệt: http://127.0.0.1:${PORT:-8000}  (hoặc bấm Go Live trong VS Code)"
exec .venv/bin/python server.py
