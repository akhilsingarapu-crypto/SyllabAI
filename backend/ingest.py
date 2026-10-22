import os
from html.parser import HTMLParser

import docx      # python-docx: .docx
import openpyxl  # .xlsx
import pptx      # python-pptx: .pptx
import pymupdf   # PyMuPDF: .pdf, .epub, photos

CHUNK_SIZE = 800     # characters per chunk
CHUNK_OVERLAP = 150  # characters shared between neighbouring chunks


# PyMuPDF needs Tesseract's language data. If the installer's PATH change hasn't reached
# this process yet, point it at the default Windows install folder.
_TESSDATA = r"C:\Program Files\Tesseract-OCR\tessdata"
if not os.environ.get("TESSDATA_PREFIX") and os.path.isdir(_TESSDATA):
    os.environ["TESSDATA_PREFIX"] = _TESSDATA

MIN_TEXT = 20       # a page with fewer characters is treated as a scan (an image)
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


IMAGE_TYPES = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff")
TEXT_TYPES = (".txt", ".md", ".csv", ".tsv", ".json", ".log")
SUPPORTED = (".pdf", ".docx", ".pptx", ".xlsx", ".epub", ".html", ".htm") + TEXT_TYPES + IMAGE_TYPES


class _TagStripper(HTMLParser):
    """Collects the visible text of an HTML page (skips <script> and <style>)."""

    def __init__(self):
        super().__init__()
        self.parts, self._skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1
        elif tag in ("p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def _read_docx(path):
    doc = docx.Document(path)
    lines = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        lines += [" | ".join(cell.text for cell in row.cells) for row in table.rows]
    return [(None, "\n".join(lines))]


def _read_pptx(path):
    """One entry per slide, so sources read 'p. 3' = slide 3."""
    pages = []
    for number, slide in enumerate(pptx.Presentation(path).slides, 1):
        texts = [shape.text_frame.text for shape in slide.shapes if shape.has_text_frame]
        if slide.has_notes_slide:
            texts.append(slide.notes_slide.notes_text_frame.text)
        pages.append((number, "\n".join(texts)))
    return pages


def _read_xlsx(path):
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    pages = []
    for sheet in book.worksheets:
        rows = [" | ".join("" if c is None else str(c) for c in row) for row in sheet.iter_rows(values_only=True)]
        pages.append((None, f"Sheet: {sheet.title}\n" + "\n".join(rows)))
    book.close()
    return pages


def _read_html(path):
    with open(path, encoding="utf-8", errors="ignore") as f:
        stripper = _TagStripper()
        stripper.feed(f.read())
    return [(None, "".join(stripper.parts))]


def extract_pages(path):
    """Return [(page_number_or_None, text)] for any supported file.

    PDFs give real page numbers, slides give slide numbers, photos are read with OCR,
    everything else is one block of text.
    """
    lower = path.lower()
    if lower.endswith(".pdf"):
        with pymupdf.open(path) as doc:
            return [(i, _page_text(page)) for i, page in enumerate(doc, 1)]
    if lower.endswith(".epub"):
        with pymupdf.open(path) as doc:
            return [(None, page.get_text()) for page in doc]
    if lower.endswith(IMAGE_TYPES):
        with pymupdf.open(path) as doc:   # an image opens as a one-page document
            return [(None, _page_text(page)) for page in doc]
    if lower.endswith(".docx"):
        return _read_docx(path)
    if lower.endswith(".pptx"):
        return _read_pptx(path)
    if lower.endswith(".xlsx"):
        return _read_xlsx(path)
    if lower.endswith((".html", ".htm")):
        return _read_html(path)
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
