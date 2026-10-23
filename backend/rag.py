import json

from llm import MODEL, get_client
from store import get_chunks, search

TOP_K = 4
MAX_DISTANCE = 1.3       # chunks farther than this are treated as unrelated (on-topic ~0.6-1.1, off-topic 1.5+)
CAUTION_DISTANCE = 1.15  # a best match farther than this is a weak one: warn the student

# ---- YOUR LEARNING STYLE: edit these lines to tune how SyllabAI explains ----
LEARNING_STYLE = (
    "Use simple everyday words and avoid jargon unless you explain it. "
    "Explain step by step in short bullet points. "
    "Finish with one tiny example or analogy when it helps. "
    "Keep answers short unless the student asks for detail."
)

FORMAT_RULES = (
    "Format with plain text, short lines, '- ' bullets and **bold** for key terms; "
    "do not use tables or headings. "
)

HISTORY_RULE = (
    "Earlier messages are the conversation so far: use them to work out what words like "
    "'it', 'that' or 'the other one' refer to. "
)

# "My notes only": never guess, say so when the notes don't have it.
SYSTEM_PROMPT = (
    "You are SyllabAI, a friendly study helper. "
    "Answer the student's question using ONLY the notes provided. "
    + HISTORY_RULE
    + "Ignore notes unrelated to that topic. "
    "If the notes do not contain the answer, say you couldn't find it in the notes "
    "instead of guessing. "
    + FORMAT_RULES
    + LEARNING_STYLE
)

# "Notes + general knowledge", when the notes are relevant: lean on them, fill gaps openly.
SYSTEM_PROMPT_GENERAL = (
    "You are SyllabAI, a friendly study helper. "
    "The student's notes are provided. Use them first. If the notes cover only part of the "
    "question, answer that part from the notes, then add the rest from your general knowledge "
    "and begin that part with 'Beyond your notes:'. Never present general knowledge as if it were in the notes. "
    + HISTORY_RULE
    + FORMAT_RULES
    + LEARNING_STYLE
)

# "Notes + general knowledge", when the notes have nothing relevant.
SYSTEM_PROMPT_OPEN = (
    "You are SyllabAI, a friendly study helper. The student's notes do not cover this question, "
    "so answer from your own general knowledge. Be accurate, and say so plainly if you are not sure. "
    + HISTORY_RULE
    + FORMAT_RULES
    + LEARNING_STYLE
)

# Languages the "Answer in" picker offers. None / "" means: reply in the language of the question.
LANGUAGES = [
    "English", "Hindi", "Telugu", "Tamil", "Kannada", "Malayalam", "Bengali", "Marathi",
    "Gujarati", "Urdu", "Spanish", "French", "German", "Arabic", "Chinese", "Japanese",
]


def _language_note(language):
    """Extra instruction for the system prompt, or '' to leave the language alone."""
    if language not in LANGUAGES:
        return ""
    return (
        f" Write your whole answer in {language}. Keep file names and exact technical terms from the "
        f"notes; when a term has no common {language} word, give the English term in brackets."
    )


def _english_for_search(text):
    """The notes are searched with an English-only model, so a question typed in Hindi, Telugu etc.
    is translated to English first (for searching only; the answer language is unaffected)."""
    letters = [c for c in text if c.isalpha()]
    if not letters or sum(c.isascii() for c in letters) / len(letters) > 0.85:
        return text
    try:
        resp = get_client().chat.completions.create(
            model=MODEL,
            max_completion_tokens=1000,
            messages=[
                {"role": "system", "content": "Translate the user's text into English. Output only the translation."},
                {"role": "user", "content": text},
            ],
        )
        return (resp.choices[0].message.content or "").strip() or text
    except Exception:
        return text   # translation is a nicety: fall back to searching with the original


def _prepare(owner, question, history, source=None, language=None, general=False):
    """Find matching chunks and build the model messages.

    Returns (fixed_reply, hits, messages, prefix).
    fixed_reply is a ready-made answer when no model call is needed (otherwise None).
    prefix is a line to show before the model's answer (a warning or a 'not from your notes' label).
    general=True is the "Notes + general knowledge" mode.
    """
    history = history or []
    # A follow-up like "why?" has no keywords, so search with the last question too.
    last_q = next((m["content"] for m in reversed(history) if m["role"] == "user"), "")
    hits = search(owner, _english_for_search(f"{last_q} {question}".strip()), TOP_K, source)
    if not hits and not general:
        return "I don't have any notes yet. Upload a PDF or .txt file first.", [], None, ""

    # "My notes only" with ONE file picked: use its best chunks even if they are far away (photos and
    # vague questions score badly); the prompt still makes the model say if the notes lack the answer.
    # Otherwise a far-away match means the question isn't covered by the notes.
    related = hits if (source and not general) else [h for h in hits if h["distance"] <= MAX_DISTANCE]

    if related:
        context = "\n\n".join(
            f"[Note {i} - {h['source']}]\n{h['text']}" for i, h in enumerate(related, 1)
        )
        base = SYSTEM_PROMPT_GENERAL if general else SYSTEM_PROMPT
        messages = [
            {"role": "system", "content": base + _language_note(language)},
            *history,
            {"role": "user", "content": f"NOTES:\n{context}\n\nQUESTION: {question}"},
        ]
        weak = min(h["distance"] for h in related) > CAUTION_DISTANCE
        prefix = "Only a weak match in your notes, so double-check this answer.\n\n" if (weak and not general) else ""
        return None, related, messages, prefix

    if general:
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT_OPEN + _language_note(language)},
            *history,
            {"role": "user", "content": question},
        ]
        return None, [], messages, "Not from your notes (general knowledge):\n\n"

    return ("I couldn't find that in your notes. Try rephrasing, pick the file in \"Ask in\", "
            "switch to \"Notes + general knowledge\", or use Summarize for a general overview."), [], None, ""


def answer_question(owner, question, history=None, source=None, language=None, general=False):
    """RAG: find matching chunks, put them in the prompt, ask the model.

    history: earlier turns as [{"role": "user"|"assistant", "content": str}, ...],
    so follow-ups like "explain that more simply" make sense.
    """
    fixed, hits, messages, prefix = _prepare(owner, question, history, source, language, general)
    if fixed:
        return fixed, hits
    resp = get_client().chat.completions.create(model=MODEL, messages=messages)
    return prefix + (resp.choices[0].message.content or ""), hits


def stream_answer(owner, question, history=None, source=None, language=None, general=False):
    """Like answer_question, but returns (hits, generator of text pieces)."""
    fixed, hits, messages, prefix = _prepare(owner, question, history, source, language, general)
    if fixed:
        return hits, iter([fixed])
    return hits, _stream(messages, prefix)


def _stream(messages, prefix=""):
    """Yield the model's answer in small text pieces as they are produced."""
    if prefix:
        yield prefix
    stream = get_client().chat.completions.create(
        model=MODEL, messages=messages, stream=True
    )
    for event in stream:
        delta = event.choices[0].delta.content if event.choices else None
        if delta:
            yield delta


# ---- Study modes: work on a whole file instead of the few best-matching chunks ----
STUDY_MODES = {
    "summary": (
        "Write a clear summary of these notes for revision. "
        "Group it under 4-8 short bold topic lines, each followed by 2-4 '- ' bullets "
        "with the key points. End with one line on what to revise first."
    ),
    "quiz": (
        "Write 6 quiz questions from these notes, mixing short-answer and 'why/how' questions. "
        "Number them 1 to 6 with no answers. Then write 'Answers' on its own line and give "
        "a one or two line answer for each, numbered the same way."
    ),
    "flashcards": (
        "Make 8 flashcards from these notes. For each, write a line starting with '- **Q:**' "
        "and the question, then a line starting with '- **A:**' and a short answer. "
        "Cover the most important terms and ideas."
    ),
}


def stream_study(owner, mode, source=None, language=None):
    """Returns (chunks_used, generator of text pieces) for summary / quiz / flashcards."""
    if mode not in STUDY_MODES:
        raise ValueError(f"Unknown study mode: {mode}")
    chunks = get_chunks(owner, source)
    if not chunks:
        return [], iter(["I don't have any notes yet. Upload a PDF or .txt file first."])
    context = "\n\n".join(f"[{c['source']}]\n{c['text']}" for c in chunks)
    messages = [
        {
            "role": "system",
            "content": (
                "You are SyllabAI, a friendly study helper. Use ONLY the notes provided. "
                + FORMAT_RULES + LEARNING_STYLE + _language_note(language)
            ),
        },
        {"role": "user", "content": f"NOTES:\n{context}\n\nTASK: {STUDY_MODES[mode]}"},
    ]
    return chunks, _stream(messages)


# ---- Practice: one question or card at a time, with grading ----
PRACTICE_COUNT = {"quiz": 6, "cards": 8}


def _json_from(text):
    """The first {...} object in a model reply (it may add words around it)."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON in reply")
    return json.loads(text[start:end + 1])


def parse_practice_items(text):
    """Validate the model's {"items": [{"q": ..., "a": ...}]} and return clean (q, a) dicts."""
    items = []
    for raw in _json_from(text).get("items", []):
        q, a = str(raw.get("q", "")).strip(), str(raw.get("a", "")).strip()
        if q and a:
            items.append({"q": q[:500], "a": a[:800]})
    if not items:
        raise ValueError("no usable questions")
    return items


def generate_practice(owner, kind, source=None, language=None):
    """Make quiz questions or flashcards as data (not text) for the practice screen.
    Returns a list of {"q", "a"}, or None if the student has no notes."""
    if kind not in PRACTICE_COUNT:
        raise ValueError("kind must be quiz or cards")
    chunks = get_chunks(owner, source, max_chars=18000)
    if not chunks:
        return None
    context = "\n\n".join(f"[{c['source']}]\n{c['text']}" for c in chunks)
    task = (
        f"Make {PRACTICE_COUNT[kind]} {'short-answer quiz questions' if kind == 'quiz' else 'flashcards (a term or question on the front)'} "
        "from the notes. Each answer must be short (1-2 sentences) and come from the notes. "
        'Reply with ONLY JSON in this shape: {"items": [{"q": "question", "a": "answer"}]}'
        + _language_note(language)
    )
    last_error = None
    for _ in range(2):   # one retry if the reply isn't valid JSON
        resp = get_client().chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": "You write study questions. Use ONLY the notes provided."},
                {"role": "user", "content": f"NOTES:\n{context}\n\nTASK: {task}"},
            ],
        )
        try:
            return parse_practice_items(resp.choices[0].message.content or "")
        except (ValueError, json.JSONDecodeError, AttributeError) as err:
            last_error = err
    raise ValueError(f"The AI's reply could not be read ({last_error}). Try again.")


def grade_answer(question, expected, answer, language=None):
    """Mark a typed answer against the model answer. Returns {"verdict", "feedback"}."""
    task = (
        f"Question: {question}\nModel answer: {expected}\nStudent's answer: {answer}\n\n"
        "Is the student's answer correct? Accept different wording if the meaning is right. "
        'Reply with ONLY JSON: {"verdict": "correct" | "partly" | "wrong", '
        '"feedback": "one or two short, kind sentences saying what is right or what is missing"}'
        + _language_note(language)
    )
    resp = get_client().chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "You are a fair, encouraging teacher marking a student's answer."},
            {"role": "user", "content": task},
        ],
    )
    data = _json_from(resp.choices[0].message.content or "")
    verdict = data.get("verdict") if data.get("verdict") in ("correct", "partly", "wrong") else "wrong"
    return {"verdict": verdict, "feedback": str(data.get("feedback") or "")[:400]}
