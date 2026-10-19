import os
from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.utils import secure_filename

from ingest import ingest_file
from store import add_chunks, search
from rag import answer_question

app = Flask(__name__)
CORS(app)  # lets the frontend (opened from a file / other port) call this server

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "upload")
os.makedirs(UPLOAD_DIR, exist_ok=True)
ALLOWED = {".pdf", ".txt"}


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

    try:
        answer, hits = answer_question(question)
    except Exception as err:  # bad key, no internet, rate limit...
        print("chat error:", err)
        return jsonify(error=str(err)), 500
    sources = sorted({h["source"] for h in hits})
    return jsonify(answer=answer, sources=sources)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
