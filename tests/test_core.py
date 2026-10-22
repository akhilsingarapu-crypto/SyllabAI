"""Run from the project root:  python -m unittest discover -s tests -v

These tests never call the AI model and never write to your notes database.
"""
import os
import sys
import tempfile
import unittest

os.environ["APP_PASSWORD"] = "secret-for-tests"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import pymupdf  # noqa: E402

import app as app_module  # noqa: E402
from ingest import chunk_text, ingest_file  # noqa: E402


def make_pdf(path, pages):
    """Write a PDF with one text per page (None = blank page)."""
    doc = pymupdf.open()
    for text in pages:
        page = doc.new_page()
        if text:
            page.insert_text((72, 72), text)
    doc.save(path)
    doc.close()


class ChunkingTests(unittest.TestCase):
    def test_overlap_and_coverage(self):
        text = "x" * 2000
        chunks = chunk_text(text, size=800, overlap=150)
        self.assertEqual(len(chunks[0]), 800)
        self.assertGreater(len(chunks), 2)
        self.assertTrue(chunks[-1])  # nothing empty at the end

    def test_blank_text_gives_no_chunks(self):
        self.assertEqual(chunk_text("   \n  "), [])


class IngestTests(unittest.TestCase):
    def test_pdf_chunks_carry_page_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "two.pdf")
            make_pdf(path, ["First page about cats " * 5, "Second page about dogs " * 5])
            chunks = ingest_file(path)
        self.assertEqual({c["page"] for c in chunks}, {1, 2})

    def test_txt_has_no_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "n.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write("hello notes")
            chunks = ingest_file(path)
        self.assertEqual(chunks, [{"text": "hello notes", "page": None}])

    def test_blank_pdf_has_no_chunks(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "blank.pdf")
            make_pdf(path, [None])
            self.assertEqual(ingest_file(path), [])


class FileTypeTests(unittest.TestCase):
    """Each supported office/web format gives back its text."""

    def read(self, name, writer):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, name)
            writer(path)
            return ingest_file(path)

    def test_docx(self):
        import docx
        def write(p):
            d = docx.Document(); d.add_paragraph("zebra stripes"); d.save(p)
        self.assertIn("zebra stripes", self.read("a.docx", write)[0]["text"])

    def test_pptx_pages_are_slide_numbers(self):
        import pptx
        def write(p):
            pr = pptx.Presentation()
            s = pr.slides.add_slide(pr.slide_layouts[1])
            s.shapes.title.text = "otters"
            pr.save(p)
        chunks = self.read("a.pptx", write)
        self.assertEqual(chunks[0]["page"], 1)
        self.assertIn("otters", chunks[0]["text"])

    def test_xlsx(self):
        import openpyxl
        def write(p):
            wb = openpyxl.Workbook(); wb.active.append(["Asha", 91]); wb.save(p)
        self.assertIn("Asha | 91", self.read("a.xlsx", write)[0]["text"])

    def test_html_skips_scripts(self):
        def write(p):
            with open(p, "w", encoding="utf-8") as f:
                f.write("<body><p>whales</p><script>secret=1</script></body>")
        text = self.read("a.html", write)[0]["text"]
        self.assertIn("whales", text)
        self.assertNotIn("secret", text)

    def test_csv_and_markdown_read_as_text(self):
        def write(p):
            with open(p, "w", encoding="utf-8") as f:
                f.write("city,pop\nParis,2100000\n")
        self.assertIn("Paris,2100000", self.read("a.csv", write)[0]["text"])


class SourceFormatTests(unittest.TestCase):
    def test_page_ranges(self):
        self.assertEqual(app_module.page_ranges([9, 1, 2, 3, 5, 8]), "1-3, 5, 8-9")

    def test_format_sources(self):
        hits = [
            {"source": "a.pdf", "page": 2},
            {"source": "a.pdf", "page": 3},
            {"source": "b.txt", "page": None},
        ]
        self.assertEqual(app_module.format_sources(hits), ["a.pdf (p. 2-3)", "b.txt"])


class PasswordTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_health_is_open_and_reports_auth(self):
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json()["auth"])

    def test_page_loads_without_password_so_login_box_can_show(self):
        for path in ["/", "/app.js", "/style.css"]:
            self.assertEqual(self.client.get(path).status_code, 200, path)

    def test_protected_routes_need_the_key(self):
        for method, path in [("get", "/files"), ("post", "/chat"), ("delete", "/files/x.pdf")]:
            res = getattr(self.client, method)(path)
            self.assertEqual(res.status_code, 401, path)

    def test_wrong_key_rejected(self):
        res = self.client.get("/files", headers={"X-Access-Key": "nope"})
        self.assertEqual(res.status_code, 401)

    def test_empty_question_with_right_key(self):
        res = self.client.post(
            "/chat", json={"question": "  "}, headers={"X-Access-Key": "secret-for-tests"}
        )
        self.assertEqual(res.status_code, 400)

    def test_bad_study_mode(self):
        res = self.client.post(
            "/study/stream", json={"mode": "x"}, headers={"X-Access-Key": "secret-for-tests"}
        )
        self.assertEqual(res.status_code, 400)


if __name__ == "__main__":
    unittest.main()
