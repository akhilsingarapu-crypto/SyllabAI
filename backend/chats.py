"""Chats and answer feedback, stored per user in the same SQLite file as the accounts."""
import json
import re
import time
from contextlib import closing

from flask import Blueprint, g, jsonify, request

from auth import _db

MAX_CHATS = 30              # per user; the least recently used are dropped beyond this
MAX_CHAT_BYTES = 1_000_000  # one chat's messages + memory
ID_RE = re.compile(r"^[a-z0-9]{6,32}$")

chats_bp = Blueprint("chats", __name__)


@chats_bp.get("/chats")
def list_chats():
    """All of this user's chats, most recently used first."""
    with closing(_db()) as conn:
        rows = conn.execute(
            "SELECT id, title, data, updated_at FROM chats WHERE user_id = ? ORDER BY updated_at DESC",
            (g.user["id"],),
        ).fetchall()
    chats = []
    for row in rows:
        body = json.loads(row["data"])
        chats.append({
            "id": row["id"], "title": row["title"], "updated_at": row["updated_at"],
            "messages": body.get("messages", []), "history": body.get("history", []),
        })
    return jsonify(chats=chats)


@chats_bp.put("/chats/<chat_id>")
def save_chat(chat_id):
    if not ID_RE.match(chat_id):
        return jsonify(error="Bad chat id."), 400
    data = request.get_json(silent=True) or {}
    messages, history = data.get("messages"), data.get("history")
    if not isinstance(messages, list) or not isinstance(history, list):
        return jsonify(error="messages and history must be lists."), 400
    blob = json.dumps({"messages": messages, "history": history})
    if len(blob) > MAX_CHAT_BYTES:
        return jsonify(error="This chat is too long to save. Start a new chat."), 413
    title = " ".join(str(data.get("title") or "New chat").split())[:80] or "New chat"

    with closing(_db()) as conn, conn:
        conn.execute(
            "INSERT INTO chats (id, user_id, title, data, updated_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(user_id, id) DO UPDATE SET title = excluded.title, data = excluded.data, "
            "updated_at = excluded.updated_at",
            (chat_id, g.user["id"], title, blob, int(time.time() * 1000)),
        )
        conn.execute(
            "DELETE FROM chats WHERE user_id = ? AND id NOT IN "
            "(SELECT id FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?)",
            (g.user["id"], g.user["id"], MAX_CHATS),
        )
    return jsonify(message="saved")


@chats_bp.delete("/chats/<chat_id>")
def delete_chat(chat_id):
    with closing(_db()) as conn, conn:
        conn.execute("DELETE FROM chats WHERE user_id = ? AND id = ?", (g.user["id"], chat_id))
    return jsonify(message="deleted")


@chats_bp.post("/feedback")
def add_feedback():
    """A thumbs up/down on one answer. Read it with backend/feedback_report.py."""
    data = request.get_json(silent=True) or {}
    rating = data.get("rating")
    if rating not in ("up", "down"):
        return jsonify(error="rating must be up or down."), 400
    sources = data.get("sources") if isinstance(data.get("sources"), list) else []
    with closing(_db()) as conn, conn:
        conn.execute(
            "INSERT INTO feedback (user_id, rating, question, answer, sources, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                g.user["id"], rating,
                str(data.get("question") or "")[:2000], str(data.get("answer") or "")[:6000],
                json.dumps([str(s)[:200] for s in sources[:20]]), int(time.time()),
            ),
        )
    return jsonify(message="thanks")
