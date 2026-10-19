import os
import pymupdf  # PyMuPDF

CHUNK_SIZE = 800     # characters per chunk
CHUNK_OVERLAP = 150  # characters shared between neighbouring chunks


def extract_text(path):
    """Return all the text in a .pdf or .txt file."""
    if path.lower().endswith(".pdf"):
        with pymupdf.open(path) as doc:
            return "\n".join(page.get_text() for page in doc)
    with open(path, encoding="utf-8", errors="ignore") as f:
        return f.read()


def chunk_text(text, size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Split text into overlapping pieces so no idea is cut off cleanly."""
    text = " ".join(text.split())  # collapse whitespace
    chunks = []
    start = 0
    while start < len(text):
        chunks.append(text[start:start + size])
        start += size - overlap
    return chunks


def ingest_file(path):
    chunks = chunk_text(extract_text(path))
    print(f"\n=== {os.path.basename(path)}: {len(chunks)} chunks ===")
    for i, chunk in enumerate(chunks, 1):
        # Windows terminals can't show every symbol (PDF bullets etc.); replace instead of crashing
        safe = chunk.encode("ascii", "replace").decode("ascii")
        print(f"--- chunk {i} ({len(chunk)} chars) ---\n{safe}\n")
    return chunks


if __name__ == "__main__":
    import sys
    ingest_file(sys.argv[1])
