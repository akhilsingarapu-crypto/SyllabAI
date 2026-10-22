# Deploying SyllabAI on Render

One Render web service serves both the API and the page (see `render.yaml`).
Step-by-step guidance is given in chat; this file is the reference.

- Needs a paid plan (starter) if you want uploaded notes to survive restarts (persistent disk).
- Set `GROQ_API_KEY` and `APP_PASSWORD` in the Render dashboard, never in git.
- OCR for scanned PDFs is not available on Render (no Tesseract); text PDFs and .txt work.
- Uploads over 20 MB are rejected. `ALLOWED_ORIGINS` is not needed (same address for page and API).
