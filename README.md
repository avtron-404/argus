# 👁️ Argus

> **Agentic Web RAG, Multimodal Vision, and Document Intelligence Assistant**

Argus is an intelligent browser extension and backend API that reads, indexes, and reasons over any webpage, visual banner, YouTube transcript, or PDF document. Powered by **LangGraph**, **ChromaDB**, and a cascading **multi-provider LLM failover engine** (Gemini, Groq, OpenRouter, OpenAI, and local Ollama).

---

## 🌟 Key Features

- **⚡ Grounded Webpage RAG:** Deep content scanning, noise stripping, and semantic chunking with ChromaDB vector search.
- **🎯 LangGraph Agentic Pipeline:** Multi-hop query routing, query self-correction, and **Cross-Encoder re-ranking** (`ms-marco-MiniLM-L-6-v2`) for pinpoint relevance.
- **✂️ Snip-to-Chat (Vision AI):** Drag-to-select any ad banner, chart, or visual graphic to ask grounded questions directly to a multimodal vision LLM.
- **📄 Local PDF Chat:** Upload local PDF files to extract text, chunk, and index for semantic Q&A.
- **📺 YouTube Transcript Extractor:** Auto-extracts captions and timestamps from YouTube videos.
- **🔄 Multi-Provider LLM Cascade:** Automatic zero-downtime failover across Groq, Gemini, OpenRouter, OpenAI, and offline Ollama.
- **🎨 Sleek Modern Interface:** Dark & light mode, markdown rendering, copy answer buttons, and conversation export as Markdown.

---

## 🏗️ Architecture

```
Argus Chrome Extension (Popup / In-page Floating Widget)
       │
       ▼ (REST / SSE Streaming)
FastAPI Backend (main.py)
       │
       ├── LangGraph Agent Workflow (agent.py)
       │     ├── Query Router (Direct / Multi-hop / Summary)
       │     ├── ChromaDB Vector Search (vector_db.py)
       │     ├── Cross-Encoder Re-ranker (sentence-transformers)
       │     └── Self-Correction Query Rewriter
       │
       └── Cascading LLM Engine (llm.py)
             └── Groq ➔ Gemini ➔ OpenRouter ➔ OpenAI ➔ Ollama
```

---

## 🚀 Cloud Deployment (Render.com)

### 1. Web Service Configuration on Render:
- **Root Directory:** `backend`
- **Runtime:** `Python 3`
- **Build Command:** `pip install -r requirements.txt`
- **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`

### 2. Environment Variables:
- `GEMINI_API_KEY`: `your_gemini_api_key`
- `LLM_PROVIDER`: `gemini`
- `PYTHON_VERSION`: `3.10.12`

---

## 💻 Local Development

### 1. Backend Setup:
```bash
cd backend
python -m venv venv
# Windows:
venv\Scripts\activate
# Linux/macOS:
source venv/bin/activate

pip install -r requirements.txt
cp .env.example .env
# Edit .env with your API keys

uvicorn main:app --reload
```

### 2. Chrome Extension Setup:
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin **Argus** to your toolbar or press **Alt+W** to toggle on any webpage!

---

## 📜 License
MIT License.
