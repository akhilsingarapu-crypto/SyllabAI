import os
from dotenv import load_dotenv
from groq import Groq

from store import search

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"), override=True)

MODEL = "openai/gpt-oss-120b"
TOP_K = 4
MAX_DISTANCE = 1.3  # chunks farther than this are treated as unrelated (on-topic ~0.6-1.1, off-topic 1.5+)

# ---- YOUR LEARNING STYLE: edit these lines to tune how StudyBuddy explains ----
LEARNING_STYLE = (
    "Use simple everyday words and avoid jargon unless you explain it. "
    "Explain step by step in short bullet points. "
    "Finish with one tiny example or analogy when it helps. "
    "Keep answers short unless the student asks for detail."
)

SYSTEM_PROMPT = (
    "You are StudyBuddy, a friendly study helper. "
    "Answer the student's question using ONLY the notes provided. "
    "Earlier messages are the conversation so far: use them to work out what words like "
    "'it', 'that' or 'the other one' refer to, and ignore notes unrelated to that topic. "
    "If the notes do not contain the answer, say you couldn't find it in the notes "
    "instead of guessing. "
    "Format with plain text, short lines, '- ' bullets and **bold** for key terms; "
    "do not use tables or headings. "
    + LEARNING_STYLE
)

_client = None


def _get_client():
    global _client
    if _client is None:
        key = os.getenv("GROQ_API_KEY")
        if not key:
            raise RuntimeError("GROQ_API_KEY missing in .env")
        _client = Groq(api_key=key)
    return _client


def answer_question(question, history=None):
    """RAG: find matching chunks, put them in the prompt, ask the model.

    history: earlier turns as [{"role": "user"|"assistant", "content": str}, ...],
    so follow-ups like "explain that more simply" make sense.
    """
    history = history or []
    # A follow-up like "why?" has no keywords, so search with the last question too.
    last_q = next((m["content"] for m in reversed(history) if m["role"] == "user"), "")
    hits = search(f"{last_q} {question}".strip(), TOP_K)
    if not hits:
        return "I don't have any notes yet. Upload a PDF or .txt file first.", []
    hits = [h for h in hits if h["distance"] <= MAX_DISTANCE]
    if not hits:
        return "I couldn't find that in your notes. Try rephrasing, or upload notes that cover it.", []

    context = "\n\n".join(
        f"[Note {i} - {h['source']}]\n{h['text']}" for i, h in enumerate(hits, 1)
    )
    user_prompt = f"NOTES:\n{context}\n\nQUESTION: {question}"

    resp = _get_client().chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            *history,
            {"role": "user", "content": user_prompt},
        ],
    )
    return resp.choices[0].message.content, hits
