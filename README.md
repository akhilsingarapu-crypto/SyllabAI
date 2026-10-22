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

- Separate chats (new, switch, delete), saved in your browser, each with its own memory
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
- Chats are saved in the browser (per account), not on the server.

## Tests

`python -m unittest discover -s tests -v` (does not call the AI or touch your notes).
