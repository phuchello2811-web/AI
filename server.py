"""Web server: chat API (Server-Sent Events), code judge API, site previews, and the UI.

The UI is served here at "/", and can also be opened from VS Code's Live Server ("Go Live",
port 5500), in which case it calls this API cross-origin; CORS allows only local origins.
"""

import json
import os
import threading
import time
import uuid
from pathlib import Path

import httpx
import ollama
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import agent
import knowledge
import sandbox

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
agent.WORKSPACE.mkdir(exist_ok=True)


def load_dotenv(path: Path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_dotenv(ROOT / ".env")

app = FastAPI(title="CodeMaster")
# Live Server ("Go Live") uses port 5500 and moves up when it is busy.
app.add_middleware(CORSMiddleware, allow_methods=["*"], allow_headers=["*"],
                   allow_origin_regex=os.environ.get("CORS_ORIGIN_REGEX",
                                                     r"http://(127\.0\.0\.1|localhost):55\d\d"))
client = ollama.Client(host=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"))
_locks: dict[str, threading.Lock] = {}

OLLAMA_DOWN = "Không kết nối được Ollama. Chạy lệnh: brew services start ollama"


# ---------- conversation storage ----------

def conv_path(cid: str) -> Path:
    if not cid.isalnum():
        raise HTTPException(400, "bad conversation id")
    return DATA / f"{cid}.json"


def load_conv(cid: str) -> dict:
    path = conv_path(cid)
    if not path.exists():
        raise HTTPException(404, "conversation not found")
    return json.loads(path.read_text(encoding="utf-8"))


def save_conv(conv: dict):
    conv["updated"] = time.time()
    tmp = conv_path(conv["id"]).with_suffix(".tmp")
    tmp.write_text(json.dumps(conv, ensure_ascii=False), encoding="utf-8")
    tmp.replace(conv_path(conv["id"]))


@app.get("/api/health")
def health():
    try:
        models = agent.installed_models(client)
    except (httpx.HTTPError, ConnectionError):
        return {"ollama": False, "models": [], "languages": list(sandbox.LANGUAGES)}
    return {"ollama": True, "models": [{"name": m, "capabilities": agent.model_capabilities(client, m)}
                                       for m in models],
            "languages": list(sandbox.LANGUAGES)}


@app.get("/api/conversations")
def list_conversations():
    convs = []
    for p in DATA.glob("*.json"):
        c = json.loads(p.read_text(encoding="utf-8"))
        convs.append({"id": c["id"], "title": c["title"], "updated": c.get("updated", 0)})
    return sorted(convs, key=lambda c: -c["updated"])


@app.post("/api/conversations")
def create_conversation():
    conv = {"id": uuid.uuid4().hex, "title": "Cuộc trò chuyện mới", "messages": [], "events": [], "state": {}}
    save_conv(conv)
    return {"id": conv["id"], "title": conv["title"]}


@app.get("/api/conversations/{cid}")
def get_conversation(cid: str):
    conv = load_conv(cid)
    has_site = (agent.site_dir(cid) / "index.html").exists()
    return {"id": cid, "title": conv["title"], "events": conv["events"],
            "preview_url": f"/preview/{cid}/index.html" if has_site else None}


@app.delete("/api/conversations/{cid}")
def delete_conversation(cid: str):
    conv_path(cid).unlink(missing_ok=True)
    return {"ok": True}


@app.get("/api/conversations/{cid}/files")
def site_files(cid: str):
    conv_path(cid)  # validates id
    root = agent.site_dir(cid)
    if not root.exists():
        return []
    return [{"path": str(p.relative_to(root)), "content": p.read_text(encoding="utf-8", errors="replace")}
            for p in sorted(root.rglob("*")) if p.is_file() and p.stat().st_size < 500_000]


# ---------- chat ----------

class ImageIn(BaseModel):
    media_type: str
    data: str


class ChatIn(BaseModel):
    conversation_id: str
    text: str
    images: list[ImageIn] = []
    mode: str = "cp"
    model: str
    think: bool = True
    effort: str = "deep"


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@app.post("/api/chat")
def chat(body: ChatIn):
    conv = load_conv(body.conversation_id)
    if body.mode not in agent.SYSTEM_PROMPTS:
        raise HTTPException(400, "bad mode")
    if body.effort not in agent.EFFORTS:
        raise HTTPException(400, "bad effort")
    try:
        caps = agent.model_capabilities(client, body.model)
    except (httpx.HTTPError, ConnectionError):
        raise HTTPException(503, OLLAMA_DOWN)
    except ollama.ResponseError:
        raise HTTPException(400, f"Chưa có model {body.model}. Chạy: ollama pull {body.model}")
    if body.images and "vision" not in caps:
        raise HTTPException(400, f"Model {body.model} không đọc được ảnh. Hãy dán đề dạng chữ.")
    lock = _locks.setdefault(conv["id"], threading.Lock())
    if not lock.acquire(blocking=False):
        raise HTTPException(409, "Cuộc trò chuyện này đang chạy, hãy đợi hoặc bấm Dừng.")

    message = {"role": "user", "content": body.text or "(xem ảnh)"}
    if body.images:
        message["images"] = [im.data for im in body.images]
    conv["messages"].append(message)
    conv["events"].append({"type": "user", "text": body.text, "images": len(body.images)})
    conv.setdefault("state", {})
    if not conv["events"][:-1]:
        conv["title"] = (body.text.strip().splitlines() or ["Ảnh đề bài"])[0][:60]

    def stream():
        try:
            yield sse({"type": "title", "title": conv["title"]})
            for event in agent.run_turn(client, conv["id"], conv["messages"], conv["state"],
                                        body.mode, body.model, body.think, body.effort):
                conv["events"].append(event)
                yield sse(event)
        except (httpx.HTTPError, ConnectionError):
            err = {"type": "error", "message": OLLAMA_DOWN}
            conv["events"].append(err)
            yield sse(err)
        except ollama.ResponseError as exc:
            err = {"type": "error", "message": f"Lỗi từ Ollama: {exc.error}"}
            conv["events"].append(err)
            yield sse(err)
        finally:
            conv["events"].append({"type": "done"})
            save_conv(conv)
            lock.release()
        yield sse({"type": "done"})

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------- knowledge library ----------

@app.get("/api/knowledge")
def knowledge_entries():
    return [{"id": e["id"], "title": e["title"], "body": e["body"]} for e in knowledge.ENTRIES]


# ---------- judge (used by the editor panel) ----------

class TestIn(BaseModel):
    input: str = ""
    expected_output: str | None = None


class RunIn(BaseModel):
    language: str
    code: str
    tests: list[TestIn] = []
    time_limit: float = 2.0


@app.post("/api/run")
def run(body: RunIn):
    try:
        lang = sandbox.normalize_language(body.language)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    tests = [t.model_dump() for t in body.tests] or [{"input": ""}]
    return sandbox.run_tests(lang, body.code, tests, body.time_limit)


# ---------- static ----------

app.mount("/preview", StaticFiles(directory=agent.WORKSPACE, html=True), name="preview")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(ROOT / "index.html")


@app.get("/sw.js")
def service_worker():
    return FileResponse(ROOT / "sw.js", media_type="text/javascript")


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(ROOT / "manifest.webmanifest", media_type="application/manifest+json")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", 8000)))
