"""Print the thumbs up/down people gave answers.

Run from the project folder:  python backend/feedback_report.py
(set DATA_DIR first if your data lives somewhere else, e.g. on a hosting disk).
"""
import os
import sqlite3
import sys

DATA_DIR = os.getenv("DATA_DIR") or os.path.join(os.path.dirname(__file__), "..")
db = sqlite3.connect(os.path.join(DATA_DIR, "app.db"))
db.row_factory = sqlite3.Row

counts = {r["rating"]: r["n"] for r in db.execute("SELECT rating, COUNT(*) AS n FROM feedback GROUP BY rating")}
print(f"Thumbs up: {counts.get('up', 0)}   Thumbs down: {counts.get('down', 0)}\n")

print("Latest thumbs-down (the answers to look at):")
rows = db.execute("SELECT question, answer, sources, created_at FROM feedback WHERE rating = 'down' ORDER BY id DESC LIMIT 20").fetchall()
for r in rows:
    line = f"\nQ: {r['question'][:200]}\nA: {r['answer'][:300]}\nSources: {r['sources']}"
    print(line.encode(sys.stdout.encoding or "utf-8", "replace").decode(sys.stdout.encoding or "utf-8"))
if not rows:
    print("  none yet")
