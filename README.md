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

- Upload and remove notes
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

## Password (optional)

Set `APP_PASSWORD` before starting the server and the page asks for it first:
`set APP_PASSWORD=mypass` (Windows cmd) then `python app.py`. Leave it unset for local use.

## Tests

`python -m unittest discover -s tests -v` (does not call the AI or touch your notes).
