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
- Follow-up questions (remembers the last 3 turns)
- Says "couldn't find that" when notes don't cover a question
  (tune `MAX_DISTANCE` in `backend/rag.py`)
