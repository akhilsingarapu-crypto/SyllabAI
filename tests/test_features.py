"""More tests: general-knowledge mode, practice, limits, invite code, photos.

Run everything with:  python -m unittest discover -s tests -v
No test calls the real AI; the model is replaced with a stand-in.
"""
import os
import tempfile
import unittest
from unittest import mock

import pymupdf

import test_core   # first: it points the app at a throwaway data folder
from test_core import app_module


def signup(client, email, name="T"):
    res = client.post("/auth/signup", json={"name": name, "email": email, "password": "correct-horse"})
    assert res.status_code == 201, res.get_json()
    return res.get_json()


def bearer(data):
    return {"Authorization": "Bearer " + data["token"]}


class GeneralKnowledgeTests(unittest.TestCase):
    """The "Notes + general knowledge" switch, the weak-match warning, and searching in English."""

    @staticmethod
    def hit(distance):
        return {"text": "mitochondria make energy", "source": "bio.txt", "chunk": 0, "page": None, "distance": distance}

    def test_notes_only_refuses_when_nothing_related(self):
        import rag
        with mock.patch("rag.search", return_value=[self.hit(1.9)]):
            fixed, hits, messages, prefix = rag._prepare("o", "who won the world cup", [], None, None, False)
        self.assertIn("couldn't find", fixed)
        self.assertIn("general knowledge", fixed)       # the refusal points to the switch
        self.assertIsNone(messages)

    def test_general_mode_answers_from_own_knowledge_and_says_so(self):
        import rag
        with mock.patch("rag.search", return_value=[self.hit(1.9)]):
            fixed, hits, messages, prefix = rag._prepare("o", "who won the world cup", [], None, None, True)
        self.assertIsNone(fixed)
        self.assertEqual(hits, [])                      # no sources: it did not come from the notes
        self.assertTrue(prefix.startswith("Not from your notes"))
        self.assertIn("general knowledge", messages[0]["content"])
        self.assertNotIn("NOTES:", messages[-1]["content"])

    def test_general_mode_with_no_notes_at_all_still_answers(self):
        import rag
        with mock.patch("rag.search", return_value=[]):
            fixed, _, messages, prefix = rag._prepare("o", "what is gravity", [], None, None, True)
        self.assertIsNone(fixed)
        self.assertTrue(prefix)

    def test_general_mode_uses_notes_when_related(self):
        import rag
        with mock.patch("rag.search", return_value=[self.hit(0.7)]):
            fixed, hits, messages, prefix = rag._prepare("o", "what do mitochondria do", [], None, None, True)
        self.assertEqual(len(hits), 1)
        self.assertEqual(prefix, "")
        self.assertIn("Beyond your notes:", messages[0]["content"])
        self.assertIn("mitochondria make energy", messages[-1]["content"])

    def test_weak_match_gets_a_warning_in_notes_only_mode(self):
        import rag
        with mock.patch("rag.search", return_value=[self.hit(1.25)]):
            _, hits, _, prefix = rag._prepare("o", "tell me about cells", [], None, None, False)
        self.assertEqual(len(hits), 1)
        self.assertIn("weak match", prefix)

    def test_non_english_questions_are_translated_for_search_only(self):
        import rag
        with mock.patch("rag.get_client", side_effect=AssertionError("no AI call needed for English")):
            self.assertEqual(rag._english_for_search("what is a cell"), "what is a cell")
        fake = mock.Mock()
        fake.chat.completions.create.return_value.choices = [mock.Mock(message=mock.Mock(content="what is a cell"))]
        with mock.patch("rag.get_client", return_value=fake):
            self.assertEqual(rag._english_for_search("कोशिका क्या है"), "what is a cell")
        with mock.patch("rag.get_client", side_effect=RuntimeError("offline")):
            self.assertEqual(rag._english_for_search("कोशिका क्या है"), "कोशिका क्या है")   # falls back, never fails

    def test_chat_endpoint_passes_the_switch_through(self):
        client = app_module.app.test_client()
        h = bearer(signup(client, "general@example.com"))
        with mock.patch("app.answer_question", return_value=("ok", [])) as answer:
            client.post("/chat", json={"question": "hi", "knowledge": "general"}, headers=h)
            client.post("/chat", json={"question": "hi"}, headers=h)
        self.assertTrue(answer.call_args_list[0][0][5])        # general=True
        self.assertFalse(answer.call_args_list[1][0][5])       # default: notes only


class PracticeTests(unittest.TestCase):
    def test_parse_items_accepts_json_wrapped_in_words(self):
        import rag
        text = 'Sure! {"items": [{"q": "What is RAM?", "a": "Memory"}, {"q": "", "a": "x"}]} Hope that helps.'
        self.assertEqual(rag.parse_practice_items(text), [{"q": "What is RAM?", "a": "Memory"}])

    def test_parse_items_rejects_nonsense(self):
        import rag
        for bad in ("no json here", '{"items": []}', '{"items": [{"q": "", "a": ""}]}'):
            with self.assertRaises(ValueError):
                rag.parse_practice_items(bad)

    def test_endpoints(self):
        client = app_module.app.test_client()
        h = bearer(signup(client, "practice@example.com"))
        self.assertEqual(client.post("/practice/generate", json={"kind": "essay"}, headers=h).status_code, 400)
        with mock.patch("app.generate_practice", return_value=[{"q": "Q?", "a": "A."}]):
            ok = client.post("/practice/generate", json={"kind": "quiz"}, headers=h)
        self.assertEqual(ok.get_json()["items"], [{"q": "Q?", "a": "A."}])
        with mock.patch("app.generate_practice", return_value=None):
            self.assertEqual(client.post("/practice/generate", json={"kind": "cards"}, headers=h).status_code, 400)
        self.assertEqual(client.post("/practice/grade", json={"question": "Q", "expected": "A"}, headers=h).status_code, 400)
        with mock.patch("app.grade_answer", return_value={"verdict": "correct", "feedback": "Yes."}):
            graded = client.post("/practice/grade", json={"question": "Q", "expected": "A", "answer": "A"}, headers=h)
        self.assertEqual(graded.get_json()["verdict"], "correct")


class LimitsAndInviteTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_daily_limit(self):
        import auth
        data = signup(self.client, "limit@example.com")
        with mock.patch("auth.DAILY_LIMIT", 2):
            self.assertEqual([auth.try_spend(data["user"]["id"]) for _ in range(3)], [True, True, False])
            limited = self.client.post(      # today's allowance is already used up
                "/practice/grade", json={"question": "Q", "expected": "A", "answer": "A"}, headers=bearer(data)
            )
        self.assertEqual(limited.status_code, 429)

    def test_invite_code(self):
        body = {"name": "I", "email": "invite@example.com", "password": "correct-horse"}
        with mock.patch("auth.SIGNUP_CODE", "open-sesame"):
            self.assertEqual(self.client.post("/auth/signup", json=body).status_code, 403)
            self.assertEqual(self.client.post("/auth/signup", json={**body, "code": "nope"}).status_code, 403)
            self.assertEqual(self.client.post("/auth/signup", json={**body, "code": "open-sesame"}).status_code, 201)

    def test_health_tells_the_page_if_a_code_is_needed(self):
        with mock.patch("app.SIGNUP_CODE", "x"):
            self.assertTrue(self.client.get("/health").get_json()["signup_code"])
        self.assertFalse(self.client.get("/health").get_json()["signup_code"])

    def test_storage_limit(self):
        from io import BytesIO
        h = bearer(signup(self.client, "storage@example.com"))
        with mock.patch("app.MAX_USER_MB", 0):
            full = self.client.post(
                "/upload", data={"file": (BytesIO(b"abc"), "a.txt")}, headers=h, content_type="multipart/form-data"
            )
        self.assertEqual(full.status_code, 413)


class PhotoTests(unittest.TestCase):
    @staticmethod
    def make_png(path):
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 40, 40), False)
        pix.clear_with(255)
        pix.save(path)

    def test_vision_text_is_used_when_available(self):
        import ingest
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "p.png")
            self.make_png(path)
            with mock.patch("ingest._vision_text", return_value="F = ma (Newton's second law)"):
                chunks = ingest.ingest_file(path)
        self.assertEqual(chunks, [{"text": "F = ma (Newton's second law)", "page": None}])

    def test_falls_back_to_ocr_when_vision_fails(self):
        import ingest
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "p.png")
            self.make_png(path)
            with mock.patch("ingest._vision_text", return_value=None):
                self.assertEqual(ingest.ingest_file(path), [])     # a blank picture has no text either way

    def test_vision_can_be_turned_off(self):
        import ingest
        with mock.patch.dict(os.environ, {"PHOTO_AI": "0"}), \
                mock.patch("ingest.get_client", side_effect=AssertionError("must not be called")):
            self.assertIsNone(ingest._vision_text("whatever.png"))


if __name__ == "__main__":
    unittest.main()
