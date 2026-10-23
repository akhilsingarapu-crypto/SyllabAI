# Deploying SyllabAI on Render

One Render web service serves both the API and the page (see `render.yaml`).
Step-by-step guidance is given in chat; this file is the reference.

- Needs a paid plan (starter) if you want uploaded notes to survive restarts (persistent disk).
- Set `GROQ_API_KEY` in the Render dashboard, never in git. Users sign up on the site; set `ALLOW_SIGNUP=0` to close registration once your people have accounts.
- OCR for scanned PDFs is not available on Render (no Tesseract); text PDFs and .txt work.
- Uploads over 20 MB are rejected. `ALLOWED_ORIGINS` is not needed (same address for page and API).
- Password-reset emails need `APP_URL` (your https address) and the `SMTP_*` settings from the README; without them reset links are only printed in the Render logs.
- Accounts, chats and feedback live in `app.db` on the same disk as the notes (`DATA_DIR`).
