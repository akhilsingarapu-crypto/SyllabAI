# Deploying SyllabAI (not done yet, this is the plan)

Two parts: the Flask backend (needs Python, a disk, a secret key) and the static frontend.

## 1. Backend (Render "Web Service" or similar)

- Build command: `pip install -r requirements.txt`
- Start command: `cd backend && gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120`
- Environment variables: `GROQ_API_KEY=...`, `DEBUG=0`
- **Persistent disk** mounted so `chroma_db/` and `upload/` survive restarts. Without a disk,
  every notes upload is lost on each deploy.
- Needs about 1 GB RAM: ChromaDB downloads a small embedding model (about 80 MB) on first use.
- Free tiers sleep when idle, so the first request after a pause is slow.

## 2. Frontend (GitHub Pages / Netlify / Vercel)

- Publish the `frontend/` folder as a static site.
- In `frontend/app.js` change `API_URL` from `http://127.0.0.1:5000` to the backend's https URL.

## 3. Before making it public

- Anyone with the link can upload, delete and chat. There is no login. Add one, or keep the
  link private, or your Groq quota is what gets used.
- Restrict CORS in `backend/app.py` to your frontend's address: `CORS(app, origins=["https://your-site"])`.
- Set a max upload size: `app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024`.
