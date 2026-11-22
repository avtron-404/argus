import hashlib
import chromadb

client = chromadb.PersistentClient(path="./chroma_db")


def get_collection_name(session_id: str = "default") -> str:
    """Generate a valid, deterministic ChromaDB collection name from session ID or URL."""
    if not session_id:
        session_id = "default"
    digest = hashlib.sha256(session_id.strip().encode("utf-8")).hexdigest()[:24]
    return f"page_{digest}"


def store_chunks(chunks, embeddings, session_id: str = "default"):
    """
    Stores chunks in an isolated ChromaDB collection for the given session/URL.
    Purges any previous collection for this session to eliminate ghost chunk pollution.
    """
    if not chunks:
        return

    col_name = get_collection_name(session_id)

    # Clean purge old collection for this session to prevent ghost chunks
    try:
        client.delete_collection(name=col_name)
    except Exception:
        pass

    # Create fresh collection with explicit cosine distance metric
    collection = client.create_collection(
        name=col_name,
        metadata={"hnsw:space": "cosine"}
    )

    ids = [f"chunk_{i}" for i in range(len(chunks))]

    collection.add(
        ids=ids,
        documents=chunks,
        embeddings=embeddings.tolist()
    )

    print(f"Stored {len(chunks)} chunks in ChromaDB collection [{col_name}]")


def search_chunks(query_embedding, top_k: int = 5, session_id: str = "default"):
    """
    Searches chunks within the isolated ChromaDB collection for the given session/URL.
    """
    col_name = get_collection_name(session_id)

    try:
        collection = client.get_collection(name=col_name)
    except Exception:
        # Collection does not exist yet
        return {"documents": [[]], "distances": [[]]}

    count = collection.count()
    if count == 0:
        return {"documents": [[]], "distances": [[]]}

    actual_k = min(top_k, count)

    results = collection.query(
        query_embeddings=[query_embedding.tolist()],
        n_results=actual_k,
        include=["documents", "distances"]
    )

    return results


def get_lead_chunks(session_id: str = "default", n: int = 4):
    """
    Retrieves the first N sequential chunks (e.g. chunk_0 .. chunk_3) representing
    the introduction and core overview of the document.
    """
    col_name = get_collection_name(session_id)
    try:
        collection = client.get_collection(name=col_name)
    except Exception:
        return []

    count = collection.count()
    if count == 0:
        return []

    target_count = min(n, count)
    target_ids = [f"chunk_{i}" for i in range(target_count)]

    try:
        data = collection.get(ids=target_ids, include=["documents"])
        id_to_doc = dict(zip(data["ids"], data["documents"]))
        ordered_docs = [id_to_doc[cid] for cid in target_ids if cid in id_to_doc]
        return ordered_docs
    except Exception:
        return []