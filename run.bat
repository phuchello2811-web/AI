@echo off
rem Khoi dong CodeMaster tren Windows: kiem tra Ollama va model, cai thu vien Python (lan dau), chay server.
chcp 65001 >nul
cd /d "%~dp0"

curl -s http://127.0.0.1:8000/api/health >nul 2>nul && (echo CodeMaster da chay o http://127.0.0.1:8000 & exit /b 0)
where ollama >nul 2>nul || (echo Chua cai Ollama. Tai tai https://ollama.com/download & pause & exit /b 1)
curl -s http://127.0.0.1:11434/api/version >nul 2>nul || (echo Dang bat Ollama... & start "" /b ollama serve & timeout /t 3 >nul)
for /f "skip=1" %%a in ('ollama list') do goto has_model
echo Chua co model nao, dang tai qwen3:4b (~2.5 GB)...
ollama pull qwen3:4b || (pause & exit /b 1)
:has_model

where g++ >nul 2>nul || echo Canh bao: chua co g++ nen chua cham duoc code C++. Cai MinGW-w64: winget install BrechtSanders.WinLibs.POSIX.UCRT

if not exist .venv (py -3 -m venv .venv 2>nul || python -m venv .venv)
.venv\Scripts\python -c "import sys; sys.exit(sys.version_info < (3, 10))" || (echo Can Python 3.10 tro len: https://www.python.org/downloads/ & rmdir /s /q .venv & pause & exit /b 1)
.venv\Scripts\python -m pip install -q -r requirements.txt
echo Mo trinh duyet: http://127.0.0.1:8000  (hoac bam Go Live trong VS Code)
.venv\Scripts\python server.py
