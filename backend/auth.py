"""Accounts: sign up, sign in, sessions, profile.

Users live in a small SQLite file (app.db in DATA_DIR). Passwords are stored only as salted
hashes. A sign-in gives the browser a random token; only the token's SHA-256 is stored, so a
leaked database does not leak working sessions.
"""
import hashlib
import hmac
import os
import re
import secrets
import shutil
import smtplib
import sqlite3
import threading
import time
from contextlib import closing
from email.message import EmailMessage

from flask import Blueprint, g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

from store import DATA_DIR, delete_owner

DB_PATH = os.path.join(DATA_DIR, "app.db")
UPLOAD_ROOT = os.path.join(DATA_DIR, "upload")
SESSION_SECONDS = 30 * 24 * 3600       # stay signed in for 30 days
MIN_PASSWORD = 8
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ALLOW_SIGNUP = os.getenv("ALLOW_SIGNUP", "1") == "1"   # set ALLOW_SIGNUP=0 to close registration
SIGNUP_CODE = os.getenv("SIGNUP_CODE", "")             # if set, new accounts must type this invite code
DAILY_LIMIT = int(os.getenv("DAILY_LIMIT", "150"))     # AI calls (questions, quizzes, grading) per user per day

# Too many wrong passwords for one email from one address: wait a while.
MAX_FAILS, FAIL_WINDOW = 5, 15 * 60
_fails = {}

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")

# A hash to compare against when the email is unknown, so "no such account" takes as long
# as "wrong password" and timing does not reveal which emails exist.
_DUMMY_HASH = generate_password_hash("not-a-real-password")


def _db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    with closing(_db()) as conn, conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              email TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              password_hash TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
              token_hash TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reset_tokens (
              token_hash TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chats (
              id TEXT NOT NULL,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              title TEXT NOT NULL,
              data TEXT NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (user_id, id)
            );
            CREATE TABLE IF NOT EXISTS usage (
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              day TEXT NOT NULL,
              count INTEGER NOT NULL,
              PRIMARY KEY (user_id, day)
            );
            CREATE TABLE IF NOT EXISTS feedback (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              rating TEXT NOT NULL,
              question TEXT NOT NULL,
              answer TEXT NOT NULL,
              sources TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            """
        )


def _hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def _public(row):
    return {"id": row["id"], "email": row["email"], "name": row["name"]}


def _new_session(conn, user_id):
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
        (_hash_token(token), user_id, int(time.time()) + SESSION_SECONDS),
    )
    return token


def _bearer():
    header = request.headers.get("Authorization", "")
    return header[7:].strip() if header.startswith("Bearer ") else ""


def current_user():
    """The signed-in user for this request (a dict), or None."""
    token = _bearer()
    if not token:
        return None
    with closing(_db()) as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
            (_hash_token(token),),
        ).fetchone()
    return _public(row) if row else None


def try_spend(user_id):
    """Count one AI call against today's limit. False means the limit is already used up."""
    day = time.strftime("%Y-%m-%d", time.gmtime())
    with closing(_db()) as conn, conn:
        row = conn.execute("SELECT count FROM usage WHERE user_id = ? AND day = ?", (user_id, day)).fetchone()
        if (row["count"] if row else 0) >= DAILY_LIMIT:
            return False
        conn.execute(
            "INSERT INTO usage (user_id, day, count) VALUES (?, ?, 1) "
            "ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1",
            (user_id, day),
        )
        conn.execute("DELETE FROM usage WHERE day < ?", (time.strftime("%Y-%m-%d", time.gmtime(time.time() - 7 * 86400)),))
    return True


def _clean_name(value):
    return " ".join(str(value or "").split())[:60]


def _password_problem(password):
    if not isinstance(password, str) or len(password) < MIN_PASSWORD:
        return f"Password must be at least {MIN_PASSWORD} characters."
    if len(password) > 200:
        return "Password is too long."
    return None


def _too_many_fails(key):
    now = time.time()
    _fails[key] = [t for t in _fails.get(key, []) if now - t < FAIL_WINDOW]
    return len(_fails[key]) >= MAX_FAILS


@auth_bp.post("/signup")
def signup():
    if not ALLOW_SIGNUP:
        return jsonify(error="Sign-ups are closed."), 403
    data = request.get_json(silent=True) or {}
    if SIGNUP_CODE and not hmac.compare_digest(str(data.get("code") or "").encode(), SIGNUP_CODE.encode()):
        return jsonify(error="That invite code is wrong. Ask whoever runs this site for it."), 403
    name = _clean_name(data.get("name"))
    email = str(data.get("email") or "").strip().lower()
    password = data.get("password")
    if not name:
        return jsonify(error="Please enter your name."), 400
    if not EMAIL_RE.match(email) or len(email) > 200:
        return jsonify(error="Please enter a valid email."), 400
    problem = _password_problem(password)
    if problem:
        return jsonify(error=problem), 400

    try:
        with closing(_db()) as conn, conn:
            cur = conn.execute(
                "INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)",
                (email, name, generate_password_hash(password), int(time.time())),
            )
            user_id = cur.lastrowid
            token = _new_session(conn, user_id)
    except sqlite3.IntegrityError:
        return jsonify(error="An account with this email already exists."), 409
    return jsonify(token=token, user={"id": user_id, "email": email, "name": name}), 201


@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")
    key = f"{email}|{request.remote_addr}"
    if _too_many_fails(key):
        return jsonify(error="Too many tries. Wait 15 minutes and try again."), 429

    with closing(_db()) as conn, conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        ok = check_password_hash(row["password_hash"] if row else _DUMMY_HASH, password)
        if not (row and ok):
            _fails.setdefault(key, []).append(time.time())
            return jsonify(error="Wrong email or password."), 401
        _fails.pop(key, None)
        token = _new_session(conn, row["id"])
    return jsonify(token=token, user=_public(row))


RESET_SECONDS = 3600   # a reset link works for one hour


def _send_reset(email, link):
    """Email the reset link. With no SMTP_HOST set (local use) it is printed in the server window instead."""
    host = os.getenv("SMTP_HOST")
    if not host:
        print(f"[password reset] SMTP is not set up. Reset link for {email}: {link}", flush=True)
        return
    try:
        msg = EmailMessage()
        msg["Subject"] = "Reset your SyllabAI password"
        msg["From"] = os.getenv("SMTP_FROM") or os.getenv("SMTP_USER") or "no-reply@localhost"
        msg["To"] = email
        msg.set_content(
            f"Open this link to choose a new password (valid for 1 hour):\n\n{link}\n\n"
            "If you did not ask for this, you can ignore this email."
        )
        with smtplib.SMTP(host, int(os.getenv("SMTP_PORT", "587")), timeout=15) as smtp:
            smtp.starttls()
            if os.getenv("SMTP_USER"):
                smtp.login(os.getenv("SMTP_USER"), os.getenv("SMTP_PASSWORD", ""))
            smtp.send_message(msg)
    except Exception as err:   # never tell the visitor whether mail worked
        print("[password reset] could not send email:", err, flush=True)


@auth_bp.post("/forgot")
def forgot():
    """Always answers the same way, so it can't be used to find out which emails have accounts."""
    email = str((request.get_json(silent=True) or {}).get("email") or "").strip().lower()
    key = f"forgot|{email}|{request.remote_addr}"
    if _too_many_fails(key):
        return jsonify(error="Too many tries. Wait 15 minutes and try again."), 429
    _fails.setdefault(key, []).append(time.time())

    with closing(_db()) as conn, conn:
        row = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if row:
            token = secrets.token_urlsafe(32)
            conn.execute(
                "INSERT INTO reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                (_hash_token(token), row["id"], int(time.time()) + RESET_SECONDS),
            )
            base = (os.getenv("APP_URL") or request.host_url).rstrip("/")
            # The token sits after '#', which browsers never send to any server, so it stays out of logs.
            threading.Thread(target=_send_reset, args=(email, f"{base}/#reset={token}"), daemon=True).start()
    return jsonify(message="If that email has an account, a reset link is on its way.")


@auth_bp.post("/reset")
def reset_password():
    data = request.get_json(silent=True) or {}
    problem = _password_problem(data.get("new"))
    if problem:
        return jsonify(error=problem), 400
    with closing(_db()) as conn, conn:
        conn.execute("DELETE FROM reset_tokens WHERE expires_at < ?", (int(time.time()),))
        row = conn.execute(
            "SELECT user_id FROM reset_tokens WHERE token_hash = ?",
            (_hash_token(str(data.get("token") or "")),),
        ).fetchone()
        if not row:
            return jsonify(error="This reset link is invalid or has expired."), 400
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (generate_password_hash(data["new"]), row["user_id"]),
        )
        # The old password may be known to someone else: sign out everywhere, kill other reset links.
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (row["user_id"],))
        conn.execute("DELETE FROM reset_tokens WHERE user_id = ?", (row["user_id"],))
    return jsonify(message="Password changed. You can sign in now.")


@auth_bp.post("/logout")
def logout():
    with closing(_db()) as conn, conn:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(_bearer()),))
    return jsonify(message="signed out")


@auth_bp.get("/me")
def me():
    return jsonify(user=g.user)


@auth_bp.patch("/profile")
def update_profile():
    name = _clean_name((request.get_json(silent=True) or {}).get("name"))
    if not name:
        return jsonify(error="Please enter your name."), 400
    with closing(_db()) as conn, conn:
        conn.execute("UPDATE users SET name = ? WHERE id = ?", (name, g.user["id"]))
    return jsonify(user={**g.user, "name": name})


@auth_bp.post("/password")
def change_password():
    data = request.get_json(silent=True) or {}
    problem = _password_problem(data.get("new"))
    if problem:
        return jsonify(error=problem), 400
    with closing(_db()) as conn, conn:
        row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (g.user["id"],)).fetchone()
        if not check_password_hash(row["password_hash"], str(data.get("current") or "")):
            return jsonify(error="Current password is wrong."), 400
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (generate_password_hash(data["new"]), g.user["id"]),
        )
        # Sign out every other device; keep this one signed in.
        conn.execute(
            "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
            (g.user["id"], _hash_token(_bearer())),
        )
    return jsonify(message="password changed")


@auth_bp.delete("/account")
def delete_account():
    """Permanently removes the user, their sessions, notes and uploaded files."""
    password = str((request.get_json(silent=True) or {}).get("password") or "")
    user_id = g.user["id"]
    with closing(_db()) as conn, conn:
        row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
        if not check_password_hash(row["password_hash"], password):
            return jsonify(error="Password is wrong."), 400
        delete_owner(str(user_id))
        shutil.rmtree(os.path.join(UPLOAD_ROOT, str(user_id)), ignore_errors=True)
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))   # sessions go with it (CASCADE)
    return jsonify(message="account deleted")
