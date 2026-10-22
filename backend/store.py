import os
import chromadb

# DATA_DIR lets a host keep notes on a persistent disk (e.g. /var/data); locally it is the project folder.
DATA_DIR = os.getenv("DATA_DIR") or os.path.join(os.path.dirname(__file__), "..")
DB_DIR = os.path.join(DATA_DIR, "chroma_db")

# Saved on disk, so notes survive a server restart.
# Chroma's built-in embedding model (MiniLM) turns text into vectors for us.
_client = chromadb.PersistentClient(path=DB_DIR)
_notes = _client.get_or_create_collection("notes")

# Every chunk is tagged with its owner (the user id as text). Every function below takes the
# owner and filters on it, so one person's notes can never be read, searched or deleted by another.


def _where(owner, source=None):
    """Chroma filter: this owner's chunks, optionally from one file."""
    if source:
        return {"$and": [{"owner": owner}, {"source": source}]}
    return {"owner": owner}


def add_chunks(owner, filename, chunks):
    """Store a file's chunks. Re-uploading the same file replaces the old copy."""
    _notes.delete(where=_where(owner, filename))
    if not chunks:
        return
    _notes.add(
        ids=[f"{owner}::{filename}::{i}" for i in range(len(chunks))],
        documents=[c["text"] for c in chunks],
        # Chroma metadata can't hold None, so files without pages simply have no "page" key
        metadatas=[
            {"owner": owner, "source": filename, "chunk": i, **({"page": c["page"]} if c["page"] else {})}
            for i, c in enumerate(chunks)
        ],
    )


def list_sources(owner):
    """Return [{'name', 'chunks'}] for each of this owner's files, sorted by name."""
    counts = {}
    for meta in _notes.get(where=_where(owner), include=["metadatas"])["metadatas"]:
        counts[meta["source"]] = counts.get(meta["source"], 0) + 1
    return [{"name": n, "chunks": c} for n, c in sorted(counts.items())]


def delete_source(owner, filename):
    """Remove all of one file's chunks. Returns how many were deleted."""
    found = _notes.get(where=_where(owner, filename), include=[])["ids"]
    if found:
        _notes.delete(ids=found)
    return len(found)


def delete_owner(owner):
    """Remove everything an owner has stored (used when an account is deleted)."""
    _notes.delete(where=_where(owner))


def search(owner, question, n=4, source=None):
    """Return the n chunks closest in meaning to the question (optionally from one file)."""
    where = _where(owner, source)
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


def get_chunks(owner, source=None, max_chars=24000):
    """Spread-out sample of a file's chunks (or all of this owner's files), in reading order.

    Used by study modes, which need the whole unit rather than the best 4 matches.
    If everything fits in max_chars it is all returned; otherwise evenly spaced chunks.
    """
    res = _notes.get(where=_where(owner, source), include=["documents", "metadatas"])
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
