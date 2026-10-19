import os
import chromadb

DB_DIR = os.path.join(os.path.dirname(__file__), "..", "chroma_db")

# Saved on disk, so notes survive a server restart.
# Chroma's built-in embedding model (MiniLM) turns text into vectors for us.
_client = chromadb.PersistentClient(path=DB_DIR)
_notes = _client.get_or_create_collection("notes")


def add_chunks(filename, chunks):
    """Store a file's chunks. Re-uploading the same file replaces the old copy."""
    _notes.delete(where={"source": filename})
    if not chunks:
        return
    _notes.add(
        ids=[f"{filename}::{i}" for i in range(len(chunks))],
        documents=chunks,
        metadatas=[{"source": filename, "chunk": i} for i in range(len(chunks))],
    )


def search(question, n=4):
    """Return the n chunks closest in meaning to the question."""
    if _notes.count() == 0:
        return []
    res = _notes.query(query_texts=[question], n_results=min(n, _notes.count()))
    return [
        {"text": doc, "source": meta["source"], "chunk": meta["chunk"], "distance": dist}
        for doc, meta, dist in zip(
            res["documents"][0], res["metadatas"][0], res["distances"][0]
        )
    ]
