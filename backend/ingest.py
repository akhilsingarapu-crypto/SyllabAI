import os
import pymupdf  # PyMuPDF

CHUNK_SIZE = 800     # characters per chunk
CHUNK_OVERLAP = 150  # characters shared between neighbouring chunks


MIN_TEXT = 20        # a page with fewer characters is treated as a scan (an image)
ocr_available = True  # flips to False the first time OCR fails (Tesseract not installed)


def _page_text(page):
    """Text of one PDF page; scanned pages are read with OCR when Tesseract is installed."""
    global ocr_available
    text = page.get_text()
    if len(text.strip()) >= MIN_TEXT or not ocr_available:
        return text
    try:
        return page.get_text(textpage=page.get_textpage_ocr(language="eng", dpi=200, full=True))
    except Exception:
        ocr_available = False
        return text


def extract_pages(path):
    """Return [(page_number, text)] for a .pdf, or [(None, text)] for a .txt file."""
    if path.lower().endswith(".pdf"):
        with pymupdf.open(path) as doc:
            return [(i, _page_text(page)) for i, page in enumerate(doc, 1)]
    with open(path, encoding="utf-8", errors="ignore") as f:
        return [(None, f.read())]


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
    """Return chunks as [{"text": str, "page": int | None}]. Chunks never span pages."""
    chunks = [
        {"text": piece, "page": page}
        for page, text in extract_pages(path)
        for piece in chunk_text(text)
    ]
    print(f"\n=== {os.path.basename(path)}: {len(chunks)} chunks ===")
    for i, chunk in enumerate(chunks, 1):
        # Windows terminals can't show every symbol (PDF bullets etc.); replace instead of crashing
        safe = chunk["text"].encode("ascii", "replace").decode("ascii")
        print(f"--- chunk {i} (page {chunk['page']}, {len(chunk['text'])} chars) ---\n{safe}\n")
    return chunks


if __name__ == "__main__":
    import sys
    ingest_file(sys.argv[1])
