import os
from sentence_transformers import SentenceTransformer

# Load cached model immediately without network retry delays
try:
    model = SentenceTransformer("all-MiniLM-L6-v2", local_files_only=True)
except Exception:
    model = SentenceTransformer("all-MiniLM-L6-v2")


def create_embeddings(chunks):
    embeddings = model.encode(chunks)
    return embeddings