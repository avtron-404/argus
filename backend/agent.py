import re
from typing import TypedDict, List, Optional
from langgraph.graph import StateGraph, END
from sentence_transformers import CrossEncoder

from chunking import split_text
from embedding import create_embeddings
from vector_db import store_chunks, search_chunks, get_lead_chunks

# ---------------------------------------------------------------------------
# Cross-Encoder Re-Ranker (loaded once at module import for zero-latency reuse)
# Model: ~85 MB, very fast on CPU. Scores (query, chunk) pairs for relevance.
# ---------------------------------------------------------------------------
_cross_encoder = None

def get_cross_encoder() -> CrossEncoder:
    """Lazy-load the cross-encoder model (only downloaded once, cached by HuggingFace)."""
    global _cross_encoder
    if _cross_encoder is None:
        try:
            _cross_encoder = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2", max_length=512, local_files_only=True)
        except Exception:
            _cross_encoder = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2", max_length=512)
    return _cross_encoder


class AgentState(TypedDict):
    question: str
    url: str
    history: List[dict]
    route: str  # "summary" | "direct" | "multi_hop"
    sub_queries: List[str]
    documents: List[str]
    distances: List[float]
    rerank_scores: List[float]   # cross-encoder relevance scores (higher = more relevant)
    relevance_status: str  # "relevant" | "needs_rewrite" | "not_found"
    current_query: str
    rewrite_count: int
    agent_steps: List[str]
    prompt: str


def is_summary_request(text: str) -> bool:
    patterns = [
        r"\bsummar(y|ize|ise|izing|ising)\b",
        r"\boverview\b",
        r"\btldr\b",
        r"\b(tell me|explain|what is|describe|what's).*(this|the).*(page|webpage|web page|site|website|article|document|text)\b",
        r"\b(about|on) this (page|webpage|web page|site|website|article)\b",
        r"\bwhat('?s| is) (this|it) about\b",
        r"\bmain (points|topics|ideas|takeaways)\b",
        r"\bbrief\b"
    ]
    lower = text.lower().strip()
    return any(re.search(p, lower) for p in patterns)


def is_multi_hop_query(text: str) -> bool:
    patterns = [
        r"\b(compare|comparison|versus|vs\.?|difference(s)? between|differ)\b",
        r"\bboth\b.*\band\b",
        r"\bhow do\b.*\bdiffer\b"
    ]
    lower = text.lower().strip()
    return any(re.search(p, lower) for p in patterns)


# ==========================================
# GRAPH NODES
# ==========================================

def router_node(state: AgentState) -> dict:
    """Analyze the user's query and decide the optimal execution strategy."""
    question = state["question"]
    agent_steps = list(state.get("agent_steps", []))

    if is_summary_request(question):
        agent_steps.append("Planner: Detected page summary intent")
        return {
            "route": "summary",
            "agent_steps": agent_steps,
            "sub_queries": []
        }

    if is_multi_hop_query(question):
        # Extract sub-components for multi-hop comparison
        # e.g. "difference between definite and indefinite articles"
        sub_queries = []
        match = re.search(r"between\s+(.+?)\s+and\s+(.+)", question, re.IGNORECASE)
        if match:
            sub1, sub2 = match.group(1).strip(), match.group(2).strip()
            sub_queries = [sub1, sub2]
        else:
            sub_queries = [question]

        agent_steps.append(f"Planner: Complex query decomposed into {len(sub_queries)} sub-searches")
        return {
            "route": "multi_hop",
            "sub_queries": sub_queries,
            "agent_steps": agent_steps
        }

    agent_steps.append("Planner: Direct semantic search selected")
    return {
        "route": "direct",
        "sub_queries": [question],
        "agent_steps": agent_steps
    }


def retrieve_node(state: AgentState) -> dict:
    """Executes retrieval based on the route decided by the router."""
    route = state["route"]
    session_id = state.get("url") or "default"
    agent_steps = list(state.get("agent_steps", []))
    history = state.get("history", [])

    if route == "summary":
        agent_steps.append("Retriever: Fetching lead document overview chunks")
        lead_docs = get_lead_chunks(session_id=session_id, n=4)
        return {
            "documents": lead_docs,
            "distances": [0.0] * len(lead_docs),
            "agent_steps": agent_steps
        }

    # For multi-hop or direct queries
    sub_queries = state.get("sub_queries") or [state["current_query"]]
    aggregated_docs = []
    aggregated_dists = []

    for q in sub_queries:
        # Augment with previous turn if conversational follow-up
        retrieval_query = q
        if history and len(sub_queries) == 1:
            last_user_msgs = [m.get("content", "") for m in history if m.get("role") == "user"]
            if last_user_msgs:
                retrieval_query = f"{last_user_msgs[-1]} {q}"

        q_embed = create_embeddings([retrieval_query])[0]
        res = search_chunks(q_embed, top_k=3 if route == "multi_hop" else 5, session_id=session_id)

        docs = res.get("documents", [[]])[0]
        dists = res.get("distances", [[]])[0]

        for d, dist in zip(docs, dists):
            if d not in aggregated_docs:
                aggregated_docs.append(d)
                aggregated_dists.append(dist)

    agent_steps.append(f"Retriever: Found {len(aggregated_docs)} candidate chunks from ChromaDB")
    return {
        "documents": aggregated_docs,
        "distances": aggregated_dists,
        "agent_steps": agent_steps
    }


def rerank_node(state: AgentState) -> dict:
    """
    Cross-Encoder Re-Ranking Node.

    After the bi-encoder retrieval fetches candidate chunks by approximate
    nearest-neighbour search, this node scores every (question, chunk) pair
    with a cross-encoder — a full transformer that reads both texts jointly,
    producing a much more accurate relevance score.

    Result: chunks are re-ordered so the most relevant ones appear first,
    giving the LLM the best context at the top of the prompt.
    """
    route = state.get("route", "direct")
    documents = state.get("documents", [])
    agent_steps = list(state.get("agent_steps", []))

    # Skip re-ranking for summary mode or when no docs exist
    if route == "summary" or not documents:
        return {"rerank_scores": [], "agent_steps": agent_steps}

    question = state.get("current_query") or state["question"]

    try:
        reranker = get_cross_encoder()
        pairs = [(question, doc) for doc in documents]
        scores = reranker.predict(pairs).tolist()

        # Sort documents by descending cross-encoder score
        ranked = sorted(zip(scores, documents), key=lambda x: x[0], reverse=True)
        sorted_scores = [s for s, _ in ranked]
        sorted_docs = [d for _, d in ranked]

        best_score = sorted_scores[0] if sorted_scores else 0.0
        agent_steps.append(
            f"Re-Ranker: Scored {len(documents)} chunks via cross-encoder "
            f"(best relevance: {best_score:.3f})"
        )
        return {
            "documents": sorted_docs,
            "rerank_scores": sorted_scores,
            "agent_steps": agent_steps
        }

    except Exception as e:
        # Graceful fallback — if re-ranking fails, original order is preserved
        agent_steps.append(f"Re-Ranker: Skipped (error: {str(e)[:60]})")
        return {"rerank_scores": [], "agent_steps": agent_steps}


def grade_documents_node(state: AgentState) -> dict:
    """
    Evaluates whether retrieved (and re-ranked) documents are relevant enough
    to answer the question.
    """
    agent_steps = list(state.get("agent_steps", []))
    route = state.get("route", "direct")
    documents = state.get("documents", [])
    distances = state.get("distances", [])
    rerank_scores = state.get("rerank_scores", [])
    rewrite_count = state.get("rewrite_count", 0)

    if route == "summary":
        if documents:
            agent_steps.append("Grader: Lead chunks verified for summarization")
            return {"relevance_status": "relevant", "agent_steps": agent_steps}
        else:
            agent_steps.append("Grader: No document chunks available")
            return {"relevance_status": "not_found", "agent_steps": agent_steps}

    if not documents:
        if rewrite_count < 1:
            agent_steps.append("Grader: Zero chunks matched. Flagged for query rewrite")
            return {"relevance_status": "needs_rewrite", "agent_steps": agent_steps}
        agent_steps.append("Grader: No chunks found after retry")
        return {"relevance_status": "not_found", "agent_steps": agent_steps}

    # If document set is compact (<= 3 chunks, e.g. Instagram landing page, short docs),
    # pass all chunks so the LLM has complete context without false-negative rejection.
    if len(documents) <= 3:
        agent_steps.append(f"Grader: Compact page context ({len(documents)} chunks); passed directly to Synthesizer")
        return {
            "documents": documents,
            "relevance_status": "relevant",
            "agent_steps": agent_steps
        }

    # ── Primary signal: cross-encoder re-rank scores ──────────────────────
    if rerank_scores:
        RERANK_THRESHOLD = -1.5   # Lenient threshold for cross-encoder logits
        best_score = max(rerank_scores)

        if best_score > RERANK_THRESHOLD:
            filtered = [
                doc for doc, score in zip(documents, rerank_scores)
                if score > RERANK_THRESHOLD
            ]
            kept = filtered if filtered else documents[:3]
            agent_steps.append(
                f"Grader: {len(kept)} chunks passed cross-encoder filter "
                f"(best score: {best_score:.3f})"
            )
            return {
                "documents": kept,
                "relevance_status": "relevant",
                "agent_steps": agent_steps
            }

        # First attempt scored very low -> try query reformulation
        if rewrite_count < 1:
            agent_steps.append(
                f"Grader: Low initial cross-encoder score ({best_score:.3f}). Triggering query rewrite"
            )
            return {"relevance_status": "needs_rewrite", "agent_steps": agent_steps}

        # After retry, pass the best candidates to the LLM to make the final determination
        agent_steps.append("Grader: Passing top candidate chunks to Synthesizer for final evaluation")
        return {
            "documents": documents[:2],
            "relevance_status": "relevant",
            "agent_steps": agent_steps
        }

    # ── Fallback signal: cosine distance ─────────────────────────────────
    if not distances:
        if rewrite_count < 1:
            agent_steps.append("Grader: Zero chunks matched. Flagged for query rewrite")
            return {"relevance_status": "needs_rewrite", "agent_steps": agent_steps}
        agent_steps.append("Grader: No chunks found after retry")
        return {"relevance_status": "not_found", "agent_steps": agent_steps}

    COSINE_THRESHOLD = 0.75
    best_dist = min(distances)

    if best_dist <= COSINE_THRESHOLD:
        filtered_docs = [doc for doc, dist in zip(documents, distances) if dist <= COSINE_THRESHOLD]
        kept = filtered_docs if filtered_docs else documents[:2]
        agent_steps.append(f"Grader: Verified {len(kept)} candidate chunks (best dist: {best_dist:.3f})")
        return {
            "documents": kept,
            "relevance_status": "relevant",
            "agent_steps": agent_steps
        }

    # Similarity is weak
    if rewrite_count < 1:
        agent_steps.append(f"Grader: Weak similarity ({best_dist:.3f} > {COSINE_THRESHOLD}). Triggering query rewrite")
        return {"relevance_status": "needs_rewrite", "agent_steps": agent_steps}

    agent_steps.append("Grader: Passing top chunks to Synthesizer after reformulation")
    return {
        "documents": documents[:2],
        "relevance_status": "relevant",
        "agent_steps": agent_steps
    }


def rewrite_query_node(state: AgentState) -> dict:
    """Self-correction: Reformulates question into an optimized semantic search query."""
    question = state.get("current_query") or state["question"]
    agent_steps = list(state.get("agent_steps", []))

    # Clean filler phrasing from query
    clean_q = re.sub(
        r"^(can you tell me|what is|tell me about|explain to me|i want to know|how do|please explain)\s+",
        "",
        question,
        flags=re.IGNORECASE
    ).strip()

    # Append core keywords
    if not clean_q:
        clean_q = question

    agent_steps.append(f"Self-Correction: Reformulated search query to '{clean_q}'")

    return {
        "current_query": clean_q,
        "sub_queries": [clean_q],
        "rewrite_count": state.get("rewrite_count", 0) + 1,
        "agent_steps": agent_steps
    }


def synthesize_node(state: AgentState) -> dict:
    """Constructs the prompt for answer generation."""
    route = state.get("route", "direct")
    documents = state.get("documents", [])
    question = state["question"]
    history = state.get("history", [])
    agent_steps = list(state.get("agent_steps", []))

    context = "\n\n---\n\n".join(documents)

    history_section = ""
    if history:
        recent_history = history[-6:]
        history_lines = [
            f"{'User' if msg.get('role') == 'user' else 'Assistant'}: {msg.get('content', '')}"
            for msg in recent_history
        ]
        if history_lines:
            history_section = "PREVIOUS CONVERSATION:\n" + "\n".join(history_lines) + "\n\n"

    if route == "summary":
        prompt = f"""You are a helpful webpage summarization assistant.

Please provide a clear, concise, well-structured summary of the webpage using the context below. Highlight the main concepts, purpose, and key takeaways in bullet points.

{history_section}WEBPAGE CONTEXT:
{context}

USER REQUEST:
{question}

SUMMARY:
"""
    else:
        prompt = f"""You are a helpful webpage question-answering assistant.

Answer the user's question accurately and concisely using ONLY the information provided in the webpage context below.

Rules:
- If the answer cannot be found in the webpage context, reply with:
  "I couldn't find this information on the webpage."
- Do not use outside knowledge or assumptions.
- Do not make up information.
- Format code, lists, or steps cleanly if present in the context.

{history_section}WEBPAGE CONTEXT:
{context}

USER QUESTION:
{question}

ANSWER:
"""

    agent_steps.append("Synthesizer: Formulated grounded prompt for response streaming")
    return {
        "prompt": prompt,
        "agent_steps": agent_steps
    }


# ==========================================
# COMPILE GRAPH
# ==========================================

def decide_next_step(state: AgentState) -> str:
    status = state.get("relevance_status")
    if status == "needs_rewrite":
        return "rewrite_query"
    return "synthesize"


workflow = StateGraph(AgentState)

workflow.add_node("router", router_node)
workflow.add_node("retrieve", retrieve_node)
workflow.add_node("rerank", rerank_node)           # ← NEW: cross-encoder re-ranking
workflow.add_node("grade_documents", grade_documents_node)
workflow.add_node("rewrite_query", rewrite_query_node)
workflow.add_node("synthesize", synthesize_node)

workflow.set_entry_point("router")
workflow.add_edge("router", "retrieve")
workflow.add_edge("retrieve", "rerank")            # ← retrieve → rerank (then grade)
workflow.add_edge("rerank", "grade_documents")     # ← rerank → grade
workflow.add_conditional_edges(
    "grade_documents",
    decide_next_step,
    {
        "rewrite_query": "rewrite_query",
        "synthesize": "synthesize"
    }
)
workflow.add_edge("rewrite_query", "retrieve")
workflow.add_edge("synthesize", END)

rag_agent = workflow.compile()
