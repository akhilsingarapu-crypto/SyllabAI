import html
import io
import json
import os
import shutil

import pymupdf
from flask import Flask, Response, g, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename

from auth import DAILY_LIMIT, SIGNUP_CODE, auth_bp, current_user, init_db, try_spend
from chats import chats_bp
from ingest import SUPPORTED, ingest_file
from store import DATA_DIR, add_chunks, delete_owner, delete_source, list_sources, search
from rag import (
    LANGUAGES, STUDY_MODES, answer_question, generate_practice, grade_answer, stream_answer, stream_study,
)

app = Flask(__name__)
# Lets the frontend (opened from a file / other port) call this server.
# When deployed, set ALLOWED_ORIGINS="https://your-site" (comma separated) to lock it down.
_origins = os.getenv("ALLOWED_ORIGINS", "*")
CORS(app, origins=[o.strip() for o in _origins.split(",")])
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # reject uploads over 20 MB

UPLOAD_DIR = os.path.join(DATA_DIR, "upload")
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
os.makedirs(UPLOAD_DIR, exist_ok=True)
ALLOWED = set(SUPPORTED)
MAX_HISTORY = 6  # last 3 question/answer pairs


init_db()
app.register_blueprint(auth_bp)
app.register_blueprint(chats_bp)

# Everything except the page itself, /health and sign-up / sign-in / password reset needs a signed-in user.
OPEN_PATHS = {
    "/", "/health", "/index.html", "/app.js", "/style.css",
    "/auth/signup", "/auth/login", "/auth/forgot", "/auth/reset",
}


@app.before_request
def require_login():
    if request.method == "OPTIONS" or request.path in OPEN_PATHS:
        return None
    g.user = current_user()
    if g.user is None:
        return jsonify(error="Please sign in."), 401
    return None


def owner_id():
    """Who the notes belong to: the signed-in user's id, as text."""
    return str(g.user["id"])


MAX_USER_MB = int(os.getenv("MAX_USER_MB", "200"))   # uploaded files per user


def folder_size(path):
    return sum(
        os.path.getsize(os.path.join(root, name))
        for root, _dirs, names in os.walk(path) for name in names
    )


def spend_question():
    """Count one AI call for this user. Returns an error response if today's limit is used up, else None."""
    if try_spend(g.user["id"]):
        return None
    return jsonify(error=f"You've used today's limit of {DAILY_LIMIT} AI requests. It resets tomorrow."), 429


def user_upload_dir():
    path = os.path.join(UPLOAD_DIR, owner_id())
    os.makedirs(path, exist_ok=True)
    return path


@app.errorhandler(413)
def too_large(_err):
    return jsonify(error="File is too big (limit 20 MB)."), 413


def page_ranges(nums):
    """[1, 2, 3, 5, 8, 9] -> '1-3, 5, 8-9'"""
    out, nums = [], sorted(nums)
    i = 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(str(nums[i]) if i == j else f"{nums[i]}-{nums[j]}")
        i = j + 1
    return ", ".join(out)


def format_sources(hits):
    """['Unit_3.pdf (p. 4-5, 9)', 'notes.txt'] - one entry per file, pages sorted."""
    pages = {}
    for h in hits:
        pages.setdefault(h["source"], set())
        if h.get("page"):  # older uploads and .txt files have no page
            pages[h["source"]].add(h["page"])
    return [
        f"{name} (p. {page_ranges(nums)})" if nums else name
        for name, nums in sorted(pages.items())
    ]


@app.get("/")
@app.get("/index.html")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/app.js")
@app.get("/style.css")
def frontend_file():
    return send_from_directory(FRONTEND_DIR, request.path.lstrip("/"))


@app.get("/health")
def health():
    return jsonify(status="ok", signup_code=bool(SIGNUP_CODE))   # signup_code: the sign-up form must ask for it


@app.post("/upload")
def upload():
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify(error="No file sent"), 400

    name = secure_filename(file.filename)
    if os.path.splitext(name)[1].lower() not in ALLOWED:
        return jsonify(error="This file type isn't supported. Try PDF, Word, PowerPoint, Excel, text, web page, ebook or a photo."), 400

    folder = user_upload_dir()
    if folder_size(folder) + (request.content_length or 0) > MAX_USER_MB * 1024 * 1024:
        return jsonify(error=f"Your storage is full ({MAX_USER_MB} MB). Remove some notes first."), 413
    path = os.path.join(folder, name)
    file.save(path)
    chunks = ingest_file(path)  # Phase 4: read + split into chunks (tagged with page)
    if not chunks:
        os.remove(path)
        scanned = name.lower().endswith((".pdf", ".png", ".jpg", ".jpeg"))
        hint = " Scans and photos need OCR (Tesseract), which this server may not have, or the picture is too unclear." if scanned else ""
        return jsonify(error="No readable text found in this file." + hint), 422
    add_chunks(owner_id(), name, chunks)    # Phase 5: embed + store in ChromaDB
    # A short preview of what was read, so a photo that OCR misread is easy to spot
    preview = " ".join(chunks[0]["text"].split())[:200]
    return jsonify(message="saved", filename=name, chunks=len(chunks), preview=preview)


@app.get("/files")
def files():
    return jsonify(files=list_sources(owner_id()))


@app.delete("/files")
def delete_all_files():
    """Remove every note this user has (their chats and account stay)."""
    count = sum(f["chunks"] for f in list_sources(owner_id()))
    delete_owner(owner_id())
    shutil.rmtree(os.path.join(UPLOAD_DIR, owner_id()), ignore_errors=True)
    return jsonify(message="deleted all", chunks=count)


@app.delete("/files/<path:filename>")
def delete_file(filename):
    name = secure_filename(filename)  # same cleaning as upload, blocks ../ tricks
    removed = delete_source(owner_id(), name)
    path = os.path.join(user_upload_dir(), name)
    if os.path.isfile(path):
        os.remove(path)
    elif not removed:
        return jsonify(error="No such file"), 404
    return jsonify(message="deleted", filename=name, chunks=removed)


@app.get("/search")
def search_notes():
    """Phase 5 test route: show which chunks best match a question."""
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify(error="Add ?q=your+question"), 400
    return jsonify(results=search(owner_id(), q))


def parse_chat_request():
    """Return (question, history, source) from the JSON body. question is None if empty."""
    data = request.get_json(silent=True) or {}
    question = (data.get("question") or "").strip()
    # Keep only well-formed recent turns; the client is not trusted.
    history = [
        {"role": m["role"], "content": m["content"][:2000]}
        for m in data.get("history") or []
        if isinstance(m, dict)
        and m.get("role") in ("user", "assistant")
        and isinstance(m.get("content"), str)
    ][-MAX_HISTORY:]
    source = data.get("source")
    source = source if isinstance(source, str) and source else None  # None = all notes
    general = data.get("knowledge") == "general"   # "Notes + general knowledge" instead of "My notes only"
    return (question or None), history, source, parse_language(data), general


def parse_language(data):
    """The 'Answer in' choice if it is one we offer, else None (= same language as the question)."""
    language = data.get("language")
    return language if language in LANGUAGES else None


@app.post("/chat")
def chat():
    question, history, source, language, general = parse_chat_request()
    if not question:
        return jsonify(error="Empty question"), 400
    limited = spend_question()
    if limited:
        return limited

    try:
        answer, hits = answer_question(owner_id(), question, history, source, language, general)
    except Exception as err:  # bad key, no internet, rate limit...
        print("chat error:", err)
        return jsonify(error=str(err)), 500
    return jsonify(answer=answer, sources=format_sources(hits))


@app.post("/chat/stream")
def chat_stream():
    """Same as /chat, but sends the answer piece by piece as JSON lines:
    {"sources": [...]} first, then {"delta": "text"} repeatedly, or {"error": "..."}."""
    question, history, source, language, general = parse_chat_request()
    if not question:
        return jsonify(error="Empty question"), 400
    limited = spend_question()
    if limited:
        return limited
    owner = owner_id()   # read now: the response is produced after this request has ended
    return stream_response(lambda: stream_answer(owner, question, history, source, language, general), passages=True)


@app.post("/study/stream")
def study_stream():
    """Whole-file helpers. Body: {"mode": "summary" | "quiz" | "flashcards", "source": optional file}."""
    data = request.get_json(silent=True) or {}
    mode = data.get("mode")
    if mode not in STUDY_MODES:
        return jsonify(error="mode must be summary, quiz or flashcards"), 400
    source = data.get("source")
    source = source if isinstance(source, str) and source else None
    limited = spend_question()
    if limited:
        return limited
    owner = owner_id()
    language = parse_language(data)
    return stream_response(lambda: stream_study(owner, mode, source, language))


@app.post("/practice/generate")
def practice_generate():
    """Questions or flashcards as data for the Practice screen. Body: {"kind": "quiz"|"cards", "source", "language"}."""
    data = request.get_json(silent=True) or {}
    kind = data.get("kind")
    if kind not in ("quiz", "cards"):
        return jsonify(error="kind must be quiz or cards"), 400
    source = data.get("source")
    source = source if isinstance(source, str) and source else None
    limited = spend_question()
    if limited:
        return limited
    try:
        items = generate_practice(owner_id(), kind, source, parse_language(data))
    except Exception as err:
        print("practice error:", err, flush=True)
        return jsonify(error=str(err)), 500
    if items is None:
        return jsonify(error="Upload some notes first."), 400
    return jsonify(items=items)


@app.post("/practice/grade")
def practice_grade():
    """Mark one typed answer. Body: {"question", "expected", "answer", "language"}."""
    data = request.get_json(silent=True) or {}
    question, expected, answer = (str(data.get(k) or "").strip()[:1500] for k in ("question", "expected", "answer"))
    if not (question and expected and answer):
        return jsonify(error="Type an answer first."), 400
    limited = spend_question()
    if limited:
        return limited
    try:
        return jsonify(**grade_answer(question, expected, answer, parse_language(data)))
    except Exception as err:
        print("grade error:", err, flush=True)
        return jsonify(error="Couldn't mark that answer. Try again."), 500


def passages_for(hits):
    """The exact note text each answer was based on, shortened, so the reader can check it."""
    return [
        {"source": h["source"], "page": h.get("page"), "text": " ".join(h["text"].split())[:400]}
        for h in hits
    ]


def stream_response(start, passages=False):
    """Send start() -> (hits, pieces) as JSON lines: sources first, then text pieces."""
    def lines():
        try:
            hits, pieces = start()
            first = {"sources": format_sources(hits)}
            if passages:
                first["passages"] = passages_for(hits)
            yield json.dumps(first) + "\n"
            for piece in pieces:
                yield json.dumps({"delta": piece}) + "\n"
        except Exception as err:
            print("chat error:", err)
            yield json.dumps({"error": str(err)}) + "\n"

    return Response(lines(), mimetype="application/x-ndjson")


PDF_CSS = "body { font-family: sans-serif; font-size: 11pt; } h1 { font-size: 16pt; } li { margin-bottom: 4pt; }"


@app.post("/export/pdf")
def export_pdf():
    """Turn an answer (quiz, flashcards, summary...) into a downloadable PDF.
    Body: {"title": str, "text": str}. Bullets ('- ' or '1.') become list items; **bold** is kept."""
    data = request.get_json(silent=True) or {}
    text = str(data.get("text") or "").strip()[:30000]
    if not text:
        return jsonify(error="Nothing to export."), 400
    title = html.escape(" ".join(str(data.get("title") or "SyllabAI").split())[:100])

    body, in_list = [f"<h1>{title}</h1>"], False
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        bullet = line[:2] in ("- ", "* ") or (line[:1].isdigit() and line[1:3] in (". ", ") "))
        content = html.escape(line.lstrip("-*0123456789.) ").strip() if bullet else line)
        parts = content.split("**")           # **bold** pairs -> <b>
        content = "".join(f"<b>{p}</b>" if i % 2 else p for i, p in enumerate(parts))
        if bullet and not in_list:
            body.append("<ul>")
        if not bullet and in_list:
            body.append("</ul>")
        in_list = bullet
        body.append(f"<li>{content}</li>" if bullet else f"<p>{content}</p>")
    if in_list:
        body.append("</ul>")

    out = io.BytesIO()
    writer = pymupdf.DocumentWriter(out)
    story = pymupdf.Story(html="".join(body), user_css=PDF_CSS)
    page_rect = pymupdf.paper_rect("a4")
    more = True
    while more:
        device = writer.begin_page(page_rect)
        more, _ = story.place(page_rect + (50, 50, -50, -50))
        story.draw(device)
        writer.end_page()
    writer.close()
    return Response(
        out.getvalue(), mimetype="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="syllabai.pdf"'},
    )


if __name__ == "__main__":
    # Local defaults; a host sets PORT (and HOST=0.0.0.0) through environment variables.
    app.run(
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "5000")),
        debug=os.getenv("DEBUG", "1") == "1",
    )
