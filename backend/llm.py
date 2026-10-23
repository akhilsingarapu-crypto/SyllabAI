"""The Groq AI client and model names, shared by everything that talks to the AI."""
import os

from dotenv import load_dotenv
from groq import Groq

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"), override=True)

MODEL = os.getenv("CHAT_MODEL", "openai/gpt-oss-120b")          # answers, quizzes, grading
VISION_MODEL = os.getenv("VISION_MODEL", "qwen/qwen3.8-27b")    # reads photos of notes

_client = None


def get_client():
    global _client
    if _client is None:
        key = os.getenv("GROQ_API_KEY")
        if not key:
            raise RuntimeError("GROQ_API_KEY missing in .env")
        _client = Groq(api_key=key)
    return _client
