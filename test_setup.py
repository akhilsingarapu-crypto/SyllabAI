import os
from dotenv import load_dotenv
from groq import Groq

load_dotenv(override=True)

api_key = os.getenv("GROQ_API_KEY")

if not api_key:
    print("ERROR: Open .env and paste your Groq API key.")
elif not api_key.startswith("gsk_"):
    print(f"ERROR: Groq keys start with 'gsk_', yours starts with '{api_key[:4]}'.")
else:
    client = Groq(api_key=api_key)
    response = client.chat.completions.create(
        model="openai/gpt-oss-120b",
        messages=[{"role": "user", "content": "explain integrations in maths"}]
    )
    print(response.choices[0].message.content)