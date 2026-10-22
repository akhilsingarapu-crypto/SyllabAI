import os
import chromadb

# DATA_DIR lets a host keep notes on a persistent disk (e.g. /var/data); locally it is the project folder.
DATA_DIR = os.getenv("DATA_DIR") or os.path.join(os.path.dirname(__file__), "..")
DB_DIR = os.path.join(DATA_DIR, "chroma_db")

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
        documents=[c["text"] for c in chunks],
        # Chroma metadata can't hold None, so .txt files simply have no "page" key
        metadatas=[
            {"source": filename, "chunk": i, **({"page": c["page"]} if c["page"] else {})}
            for i, c in enumerate(chunks)
        ],
    )


def list_sources():
    """Return [{'name', 'chunks'}] for every uploaded file, sorted by name."""
    counts = {}
    for meta in _notes.get(include=["metadatas"])["metadatas"]:
        counts[meta["source"]] = counts.get(meta["source"], 0) + 1
    return [{"name": n, "chunks": c} for n, c in sorted(counts.items())]


def delete_source(filename):
    """Remove all of a file's chunks. Returns how many were deleted."""
    found = _notes.get(where={"source": filename}, include=[])["ids"]
    if found:
        _notes.delete(ids=found)
    return len(found)


def search(question, n=4, source=None):
    """Return the n chunks closest in meaning to the question (optionally from one file)."""
    where = {"source": source} if source else None
    available = len(_notes.get(where=where, include=[])["ids"])
    if available == 0:
        return []
    res = _notes.query(query_texts=[question], n_results=min(n, available), where=where)
    return [
        {"text": doc, "source": meta["source"], "chunk": meta["chunk"],
         "page": meta.get("page"), "distance": dist}
        for doc, meta, dist in zip(
            res["documents"][0], res["metadatas"][0], res["distances"][0]
        )
    ]


def get_chunks(source=None, max_chars=24000):
    """Spread-out sample of a file's chunks (or all files), in reading order.

    Used by study modes, which need the whole unit rather than the best 4 matches.
    If everything fits in max_chars it is all returned; otherwise evenly spaced chunks.
    """
    where = {"source": source} if source else None
    res = _notes.get(where=where, include=["documents", "metadatas"])
    items = sorted(
        (
            {"text": d, "source": m["source"], "chunk": m["chunk"], "page": m.get("page")}
            for d, m in zip(res["documents"], res["metadatas"])
        ),
        key=lambda c: (c["source"], c["chunk"]),
    )
    total = sum(len(c["text"]) for c in items)
    if total > max_chars and items:
        keep = max(1, int(len(items) * max_chars / total))
        step = len(items) / keep
        items = [items[int(i * step)] for i in range(keep)]
    return items
