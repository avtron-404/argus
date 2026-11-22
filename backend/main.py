import io
import re
import json
import base64
import requests
import concurrent.futures
try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List

from chunking import split_text
from embedding import create_embeddings
from vector_db import store_chunks, get_lead_chunks
from llm import (
    generate_answer,
    stream_answer,
    stream_answer_events,
    generate_vision_answer,
    stream_vision_answer_events,
    transcribe_image,
    LLMServiceError,
    LLM_PROVIDER,
    get_active_provider_chain,
    get_active_vision_provider_chain
)
from agent import rag_agent


app = FastAPI(
    title="Argus API",
    description="Argus — Agentic Web RAG API powered by LangGraph, ChromaDB, and Local/Cloud LLMs."
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ImageData(BaseModel):
    src: Optional[str] = None
    alt: Optional[str] = None
    base64_data: Optional[str] = None
    mime_type: Optional[str] = "image/png"
    width: Optional[int] = None
    height: Optional[int] = None


class PageData(BaseModel):
    text: str
    url: Optional[str] = "default"
    images: Optional[List[ImageData]] = []
    enable_ocr: Optional[bool] = False


class VisionQueryData(BaseModel):
    question: Optional[str] = "Analyze this image and explain what it offers/shows in detail."
    image_base64: str
    mime_type: Optional[str] = "image/png"
    url: Optional[str] = "default"
    history: Optional[List[ChatMessage]] = []
    stream: Optional[bool] = True


class PdfData(BaseModel):
    url: Optional[str] = "default"
    base64_pdf: Optional[str] = None
    title: Optional[str] = "Document.pdf"


class SuggestQuery(BaseModel):
    url: Optional[str] = "default"


class QueryData(BaseModel):
    question: str
    url: Optional[str] = "default"
    history: Optional[List[ChatMessage]] = []
    stream: Optional[bool] = True


@app.get("/")
def root():
    chain = get_active_provider_chain()
    return {
        "message": "Argus backend is running",
        "orchestrator": "LangGraph",
        "primary_provider": chain[0] if chain else "none",
        "fallback_chain": chain
    }


@app.get("/health")
def health():
    chain = get_active_provider_chain()
    return {
        "status": "healthy",
        "orchestrator": "LangGraph",
        "primary_provider": chain[0] if chain else "none",
        "fallback_chain": chain
    }


@app.post("/process-page")
def process_page(data: PageData):
    text = data.text.strip() if data.text else ""
    session_id = data.url or "default"

    print(f"\n===== PAGE RECEIVED [{session_id}] =====")
    print("Characters:", len(text))
    print("Preview:", text[:300] if text else "[EMPTY TEXT]")
    print("=========================================")

    if not text:
        raise HTTPException(
            status_code=400,
            detail="Page text cannot be empty. If this is a dynamic page, try highlighting text or refreshing the tab."
        )

    # Approach 2: Process prominent images & promotional banners via OCR if enabled
    ocr_processed_count = 0
    if data.enable_ocr and data.images:
        print(f"[*] OCR Pipeline active: Scanning up to 3 candidate banners concurrently...")
        image_markdown_sections = []

        def process_single_banner(item):
            idx, img = item
            b64_to_use = img.base64_data
            if not b64_to_use and img.src and (img.src.startswith("http://") or img.src.startswith("https://")):
                try:
                    resp = requests.get(img.src, timeout=3)
                    if resp.ok and len(resp.content) > 1000:
                        b64_to_use = base64.b64encode(resp.content).decode("utf-8")
                except Exception:
                    pass

            if not b64_to_use:
                return None

            try:
                print(f"  [+] OCR transcribing banner {idx + 1} ({img.width or 0}x{img.height or 0})...")
                transcription = transcribe_image(b64_to_use, img.mime_type or "image/png")
                if transcription and transcription.strip():
                    img_label = img.alt or img.src or f"Banner #{idx + 1}"
                    return (
                        f"\n\n### Webpage Graphic / Promotional Banner (OCR Transcription)\n"
                        f"**Banner Description/Source:** {img_label}\n"
                        f"**Extracted Offer & Text Details:**\n{transcription.strip()}\n"
                    )
            except Exception as ocr_err:
                print(f"  [-] OCR failed on image {idx + 1}: {ocr_err}")
            return None

        # Execute top candidate banners concurrently
        items_to_process = list(enumerate(data.images[:3]))
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            futures = [executor.submit(process_single_banner, itm) for itm in items_to_process]
            try:
                for future in concurrent.futures.as_completed(futures, timeout=12):
                    res = future.result()
                    if res:
                        image_markdown_sections.append(res)
                        ocr_processed_count += 1
            except Exception as fut_err:
                print(f"[*] OCR concurrent execution notice: {fut_err}")

        if image_markdown_sections:
            text = text + "\n\n" + "\n".join(image_markdown_sections)
            print(f"[*] OCR Pipeline: Appended {ocr_processed_count} banner transcriptions to page context.")

    # Step 1: Split webpage into semantically sized chunks
    chunks = split_text(text)

    if not chunks:
        raise HTTPException(status_code=400, detail="No readable text chunks could be extracted.")

    print(f"Number of chunks: {len(chunks)}")

    # Step 2: Create embeddings
    embeddings = create_embeddings(chunks)
    print(f"Embeddings created: {len(embeddings)}")

    # Step 3: Store chunks + embeddings in isolated ChromaDB collection
    store_chunks(chunks, embeddings, session_id=session_id)
    print(f"Page successfully stored for session [{session_id}]\n")

    return {
        "status": "success",
        "message": "Page processed and stored in ChromaDB",
        "characters": len(text),
        "chunks": len(chunks),
        "ocr_images_processed": ocr_processed_count,
        "url": session_id
    }


@app.post("/process-pdf")
def process_pdf(data: PdfData):
    session_id = data.url or "default"
    text = ""
    print(f"\n===== PDF RECEIVED [{session_id}] =====")

    if data.base64_pdf:
        try:
            raw_bytes = base64.b64decode(data.base64_pdf)
            reader = PdfReader(io.BytesIO(raw_bytes))
            pages = []
            for idx, page in enumerate(reader.pages):
                extracted = page.extract_text() or ""
                if extracted.strip():
                    pages.append(f"--- Page {idx + 1} ---\n{extracted.strip()}")
            text = "\n\n".join(pages)
            print(f"Extracted {len(pages)} pages from base64 PDF payload.")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to parse base64 PDF: {str(e)}")
    elif data.url and (data.url.startswith("http://") or data.url.startswith("https://")):
        try:
            resp = requests.get(data.url, timeout=25)
            if not resp.ok:
                raise HTTPException(status_code=400, detail=f"Failed to fetch PDF from URL: {resp.status_code}")
            reader = PdfReader(io.BytesIO(resp.content))
            pages = []
            for idx, page in enumerate(reader.pages):
                extracted = page.extract_text() or ""
                if extracted.strip():
                    pages.append(f"--- Page {idx + 1} ---\n{extracted.strip()}")
            text = "\n\n".join(pages)
            print(f"Extracted {len(pages)} pages from downloaded PDF.")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to download and parse PDF: {str(e)}")
    else:
        raise HTTPException(status_code=400, detail="Either base64_pdf or a valid http(s) url must be provided.")

    if not text.strip():
        raise HTTPException(
            status_code=400,
            detail="The PDF contains no extractable text. It may be a scanned image or protected document."
        )

    # Step 1: Split into chunks
    chunks = split_text(text)
    if not chunks:
        raise HTTPException(status_code=400, detail="No readable text chunks could be extracted from PDF.")

    print(f"PDF Chunks generated: {len(chunks)}")

    # Step 2: Embeddings
    embeddings = create_embeddings(chunks)

    # Step 3: Store in ChromaDB
    store_chunks(chunks, embeddings, session_id=session_id)
    print(f"PDF successfully indexed for session [{session_id}]\n")

    return {
        "status": "success",
        "message": "PDF processed and stored in ChromaDB",
        "characters": len(text),
        "chunks": len(chunks),
        "url": session_id,
        "title": data.title or "PDF Document"
    }


@app.post("/suggest-questions")
def suggest_questions(data: SuggestQuery):
    session_id = data.url or "default"
    chunks = get_lead_chunks(session_id=session_id, n=4)

    if not chunks:
        return {
            "status": "success",
            "questions": [
                "What is the main topic of this page?",
                "Can you summarize the key takeaways?",
                "What are the most important details mentioned?"
            ]
        }

    context = "\n\n---\n\n".join(chunks)

    prompt = f"""You are an insightful reading assistant. Based ONLY on the following webpage text, generate 4 concise, specific, and high-value questions that a curious user would want answered about this content.

Rules:
1. Every question must be directly answerable from the text.
2. Keep each question short, engaging, and under 15 words.
3. Return ONLY a valid JSON array of strings without markdown formatting. Example:
["What is the primary topic discussed?", "How does the core concept work?", "What are the key benefits mentioned?", "What are the limitations or next steps?"]

WEBPAGE CONTENT:
{context}

JSON ARRAY:"""

    try:
        raw_output = generate_answer(prompt)
        cleaned = re.sub(r"^```(?:json)?\s*", "", raw_output.strip(), flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned.strip())

        match = re.search(r"\[\s*\"[\s\S]*\"\s*\]", cleaned)
        if match:
            questions = json.loads(match.group(0))
        else:
            questions = json.loads(cleaned)

        if isinstance(questions, list) and len(questions) > 0:
            filtered = [q.strip() for q in questions if isinstance(q, str) and q.strip()][:4]
            if filtered:
                return {"status": "success", "questions": filtered}
    except Exception as e:
        print(f"[Suggest Questions] LLM generation error: {e}")

    return {
        "status": "success",
        "questions": [
            "What is this page about?",
            "What are the main key points discussed?",
            "Can you provide a summary of this content?",
            "What are the most notable findings or details?"
        ]
    }


@app.post("/query")
def query_page(data: QueryData):
    question = data.question.strip() if data.question else ""
    session_id = data.url or "default"

    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    print(f"\n===== [LANGGRAPH AGENT EXECUTION] [{session_id}] =====")
    print(f"Question: {question}")

    # Prepare initial Agent state
    history_dicts = [{"role": m.role, "content": m.content} for m in data.history] if data.history else []
    initial_state = {
        "question": question,
        "url": session_id,
        "history": history_dicts,
        "route": "direct",
        "sub_queries": [question],
        "documents": [],
        "distances": [],
        "rerank_scores": [],
        "relevance_status": "relevant",
        "current_query": question,
        "rewrite_count": 0,
        "agent_steps": [],
        "prompt": ""
    }

    # Execute the LangGraph Agentic workflow
    final_state = rag_agent.invoke(initial_state)

    quality_chunks = final_state.get("documents", [])
    agent_steps = final_state.get("agent_steps", [])
    relevance_status = final_state.get("relevance_status", "relevant")
    prompt = final_state.get("prompt", "")

    print(f"Agent Steps completed ({len(agent_steps)}):")
    for step in agent_steps:
        print(f"  [*] {step}")


    # Handle empty context condition (when ChromaDB has 0 matching chunks)
    if not quality_chunks:
        fallback_msg = "I couldn't find this information on the webpage. (Make sure you clicked 'Load Page' for this site)."
        if not data.stream:
            return {
                "question": question,
                "answer": fallback_msg,
                "retrieved_chunks": [],
                "agent_steps": agent_steps
            }

        def fallback_stream():
            for step in agent_steps:
                yield f"data: {json.dumps({'type': 'agent_step', 'step': step})}\n\n"
            yield f"data: {json.dumps({'type': 'sources', 'chunks': []})}\n\n"
            yield f"data: {json.dumps({'type': 'token', 'token': fallback_msg})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        return StreamingResponse(fallback_stream(), media_type="text/event-stream")

    # If client requested synchronous non-streaming JSON
    if not data.stream:
        try:
            details = generate_answer(prompt, return_details=True)
            for f in details.get("failovers", []):
                agent_steps.append(f)
            agent_steps.append(f"LLM: Fulfilled via {details.get('provider')} ({details.get('model')})")
            return {
                "question": question,
                "answer": details.get("answer"),
                "retrieved_chunks": quality_chunks,
                "agent_steps": agent_steps,
                "provider": details.get("provider"),
                "model": details.get("model")
            }
        except LLMServiceError as e:
            raise HTTPException(status_code=503, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    # Real-time token streaming with SSE (Agent steps + Sources + LLM Stream / Failover Events)
    def sse_event_stream():
        # First send agent planning & retrieval trace steps
        for step in agent_steps:
            yield f"data: {json.dumps({'type': 'agent_step', 'step': step})}\n\n"

        # Next send retrieved grounding chunks
        yield f"data: {json.dumps({'type': 'sources', 'chunks': quality_chunks})}\n\n"

        # Stream provider connection, failover notices, and generated tokens
        try:
            for event in stream_answer_events(prompt):
                yield f"data: {json.dumps(event)}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        except LLMServiceError as e:
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'error': f'Generation error: {str(e)}'})}\n\n"

    return StreamingResponse(sse_event_stream(), media_type="text/event-stream")


@app.post("/query-vision")
def query_vision(data: VisionQueryData):
    """
    Approach 1: Snip-to-Chat endpoint.
    Answers questions grounded in an attached image snippet using a multimodal vision model.
    """
    if not data.image_base64:
        raise HTTPException(status_code=400, detail="Image snippet payload is required for vision query.")

    question = (data.question or "").strip()
    if not question:
        question = "Analyze this image, extract all visible text, numbers, and summarize what it offers or shows."

    session_id = data.url or "default"
    print(f"\n===== [VISION QUERY EXECUTION] [{session_id}] =====")
    print(f"Question: {question}")
    print(f"Image length (b64): {len(data.image_base64)} chars")

    # Build prompt with conversation history context
    history_section = ""
    if data.history:
        recent = data.history[-4:]
        history_lines = [
            f"{'User' if m.role == 'user' else 'Assistant'}: {m.content}" for m in recent
        ]
        if history_lines:
            history_section = "PREVIOUS CONVERSATION:\n" + "\n".join(history_lines) + "\n\n"

    prompt = f"""You are an expert visual intelligence assistant for a web browsing RAG extension.
Analyze the provided user snippet/screenshot image and answer the user's question accurately.

{history_section}USER QUESTION:
{question}

Provide a direct, thorough, and clear response. Explicitly highlight any numbers, currency amounts, returns, terms, badges, disclaimers, or button actions visible in the image."""

    if not data.stream:
        try:
            details = generate_vision_answer(
                prompt=prompt,
                image_base64=data.image_base64,
                mime_type=data.mime_type or "image/png",
                return_details=True
            )
            return {
                "question": question,
                "answer": details.get("answer"),
                "provider": details.get("provider"),
                "model": details.get("model"),
                "agent_steps": [
                    "Vision: Snip captured and validated",
                    f"LLM: Fulfilled via {details.get('provider')} ({details.get('model')})"
                ]
            }
        except LLMServiceError as e:
            raise HTTPException(status_code=503, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    def vision_sse_stream():
        yield f"data: {json.dumps({'type': 'agent_step', 'step': 'Vision: Snip captured and verified'})}\n\n"
        yield f"data: {json.dumps({'type': 'agent_step', 'step': 'Vision: Analyzing image with multimodal vision model'})}\n\n"
        yield f"data: {json.dumps({'type': 'sources', 'chunks': ['[Visual Snippet / Cropped Banner]']})}\n\n"

        try:
            for event in stream_vision_answer_events(
                prompt=prompt,
                image_base64=data.image_base64,
                mime_type=data.mime_type or "image/png"
            ):
                yield f"data: {json.dumps(event)}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except LLMServiceError as e:
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'error': f'Vision error: {str(e)}'})}\n\n"

    return StreamingResponse(vision_sse_stream(), media_type="text/event-stream")
