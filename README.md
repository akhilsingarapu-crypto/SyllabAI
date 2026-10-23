# SyllabAI

Upload your PDF / .txt notes, then ask questions answered only from those notes (RAG).

- **Backend**: Flask, PyMuPDF, ChromaDB (local embeddings), Groq LLM
- **Frontend**: plain HTML/CSS/JS

## Run

1. `pip install -r requirements.txt`
2. Create `.env` in the project root with `GROQ_API_KEY=your_key`
3. `cd backend && python app.py` (serves on http://127.0.0.1:5000)
4. Open `frontend/index.html` in a browser

## Features

- Separate chats (new, switch, delete), saved on the server with your account (any device), each with its own memory
- "Answer from" switch: **My notes only** (default, never guesses) or **Notes + general knowledge** (answers questions your notes don't cover from the AI's own knowledge, clearly labelled "Not from your notes")
- Practice: quiz questions you type answers to (marked by the AI) and flip flashcards with a score
- Photos of notes are read by a vision AI (falls back to Tesseract OCR); non-English questions are translated for searching
- "Answer in" picker: 16 languages (the question itself is best asked in English, since search is English-focused)
- "Show the passages used" under each answer, 👍/👎 on answers, and Save PDF
- Delete all notes, light/dark theme, upload progress
- Upload and remove notes: PDF, Word, PowerPoint, Excel, CSV, text/Markdown, web pages, ebooks and photos (photos and scanned PDFs use OCR)
- 📎 attach button and 🎤 voice input beside the question box
- "Ask in" picker: answer from one file or all notes
- Summarize / Quiz me / Flashcards buttons (whole file or all notes)
- Clear chat and Save chat (downloads a .txt) buttons
- Scanned PDFs are read with OCR if Tesseract is installed
- Follow-up questions (remembers the last 3 turns)
- Answers stream in as they are written
- Sources show page numbers (PDFs)
- Says "couldn't find that" when notes don't cover a question
  (tune `MAX_DISTANCE` in `backend/rag.py`)

Deploy plan: see `DEPLOY.md`.

## Accounts

Everyone signs up with a name, email and password (8+ characters) and sees only their own notes.
Passwords are stored as salted hashes in `app.db` (never commit it; it is in `.gitignore`).
Sign-in lasts 30 days. The profile page (click your name, top left) lets you change your name and
password, sign out, or delete the account and all its notes.

- To stop new people registering, set `ALLOW_SIGNUP=0` and restart (existing users can still sign in).
- Five wrong passwords for one email from one address locks it for 15 minutes.
- Forgot password: the sign-in screen sends a reset link. Without email set up (local use) the link is printed in the server window instead.
  For real email set `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` and `APP_URL` (your site's address).
- Chats are saved on the server, per account.
- See what people thought of answers: `python backend/feedback_report.py`.

## Tests

`python -m unittest discover -s tests -v` (does not call the AI or touch your notes).

## Limits and safety settings (environment variables)

| Setting | Default | What it does |
|---|---|---|
| `ALLOW_SIGNUP` | 1 | `0` closes registration |
| `SIGNUP_CODE` | (none) | if set, new accounts must type this invite code |
| `DAILY_LIMIT` | 150 | AI requests per user per day (questions, quizzes, marking) |
| `MAX_USER_MB` | 200 | uploaded files per user |
| `PHOTO_AI` | 1 | `0` stops photos being sent to the vision AI (Tesseract only) |
| `VISION_MODEL` / `CHAT_MODEL` | qwen/qwen3.8-27b / openai/gpt-oss-120b | which Groq models to use |

Photos are sent to Groq for reading, like your questions are.
