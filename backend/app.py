import os
from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.utils import secure_filename

from ingest import ingest_file
from store import add_chunks, delete_source, list_sources, search
from rag import answer_question

app = Flask(__name__)
CORS(app)  # lets the frontend (opened from a file / other port) call this server

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "upload")
os.makedirs(UPLOAD_DIR, exist_ok=True)
ALLOWED = {".pdf", ".txt"}
MAX_HISTORY = 6  # last 3 question/answer pairs


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.post("/upload")
def upload():
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify(error="No file sent"), 400

    name = secure_filename(file.filename)
    if os.path.splitext(name)[1].lower() not in ALLOWED:
        return jsonify(error="Only PDF or .txt"), 400

    path = os.path.join(UPLOAD_DIR, name)
    file.save(path)
    chunks = ingest_file(path)  # Phase 4: read + split into chunks
    add_chunks(name, chunks)    # Phase 5: embed + store in ChromaDB
    return jsonify(message="saved", filename=name, chunks=len(chunks))


@app.get("/files")
def files():
    return jsonify(files=list_sources())


@app.delete("/files/<path:filename>")
def delete_file(filename):
    name = secure_filename(filename)  # same cleaning as upload, blocks ../ tricks
    removed = delete_source(name)
    path = os.path.join(UPLOAD_DIR, name)
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
    return jsonify(results=search(q))


@app.post("/chat")
def chat():
    data = request.get_json(silent=True) or {}
    question = (data.get("question") or "").strip()
    if not question:
        return jsonify(error="Empty question"), 400

    # Keep only well-formed recent turns; the client is not trusted.
    history = [
        {"role": m["role"], "content": m["content"][:2000]}
        for m in data.get("history") or []
        if isinstance(m, dict)
        and m.get("role") in ("user", "assistant")
        and isinstance(m.get("content"), str)
    ][-MAX_HISTORY:]

    try:
        answer, hits = answer_question(question, history)
    except Exception as err:  # bad key, no internet, rate limit...
        print("chat error:", err)
        return jsonify(error=str(err)), 500
    sources = sorted({h["source"] for h in hits})
    return jsonify(answer=answer, sources=sources)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
