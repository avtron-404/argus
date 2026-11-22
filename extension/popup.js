// Backend API URL (Change to your deployed cloud URL, e.g. "https://your-rag-backend.onrender.com")
const BACKEND_URL = "http://127.0.0.1:8000";

const extractBtn = document.getElementById("extractBtn");
const uploadPdfBtn = document.getElementById("uploadPdfBtn");
const pdfFileInput = document.getElementById("pdfFileInput");
const sendBtn = document.getElementById("sendBtn");
const questionInput = document.getElementById("questionInput");
const chat = document.getElementById("chat");
const status = document.getElementById("status");
const statusDot = document.getElementById("statusDot");
const modeBadge = document.getElementById("modeBadge");
const titlePreview = document.getElementById("titlePreview");
const deepScanToggle = document.getElementById("deepScanToggle");
const ocrImagesToggle = document.getElementById("ocrImagesToggle");
const snipBtn = document.getElementById("snipBtn");
const quickSnipBtn = document.getElementById("quickSnipBtn");
const clearChatBtn = document.getElementById("clearChatBtn");
const exportChatBtn = document.getElementById("exportChatBtn");
const themeToggleBtn = document.getElementById("themeToggleBtn");
const emptyState = document.getElementById("emptyState");
const snipAttachment = document.getElementById("snipAttachment");
const snipThumb = document.getElementById("snipThumb");
const snipSize = document.getElementById("snipSize");
const cancelSnipBtn = document.getElementById("cancelSnipBtn");
const suggestBtn = document.getElementById("suggestBtn");
const suggestionsBox = document.getElementById("suggestionsBox");
const suggestionsList = document.getElementById("suggestionsList");
const closeSuggestionsBtn = document.getElementById("closeSuggestionsBtn");

let pageLoaded = false;
let currentUrl = "";
let chatHistory = [];
let activeSnippetBase64 = null;

// ===============================
// THEME (DARK / LIGHT MODE)
// ===============================
function initTheme() {
    const savedTheme = localStorage.getItem("argus_theme");
    const systemPrefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = savedTheme === "dark" || (!savedTheme && systemPrefersDark);

    if (isDark) {
        document.body.classList.add("dark-mode");
        if (themeToggleBtn) themeToggleBtn.textContent = "☀️";
    } else {
        document.body.classList.remove("dark-mode");
        if (themeToggleBtn) themeToggleBtn.textContent = "🌙";
    }
}
initTheme();

if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
        const isDark = document.body.classList.toggle("dark-mode");
        themeToggleBtn.textContent = isDark ? "☀️" : "🌙";
        localStorage.setItem("argus_theme", isDark ? "dark" : "light");
    });
}

// ===============================
// HELPER: ROBUST ACTIVE TAB FINDER
// ===============================
async function getActiveTab() {
    try {
        let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
            [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        }
        if (!tab) {
            const tabs = await chrome.tabs.query({ active: true });
            if (tabs && tabs.length > 0) tab = tabs[0];
        }
        return tab;
    } catch (e) {
        return null;
    }
}

function sendTabMessageWithRetry(tabId, message, callback) {
    chrome.tabs.sendMessage(tabId, message, async (response) => {
        if (chrome.runtime.lastError) {
            console.warn("[Argus] Direct message failed, attempting dynamic content script injection:", chrome.runtime.lastError.message);
            try {
                if (chrome.scripting && chrome.scripting.executeScript) {
                    await chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        files: ["content.js"]
                    });
                    setTimeout(() => {
                        chrome.tabs.sendMessage(tabId, message, (retryResponse) => {
                            if (chrome.runtime.lastError) {
                                console.error("[Argus] Retry failed:", chrome.runtime.lastError.message);
                                callback(null, chrome.runtime.lastError.message);
                            } else {
                                callback(retryResponse, null);
                            }
                        });
                    }, 150);
                    return;
                }
            } catch (injectErr) {
                console.error("[Argus] Script injection error:", injectErr);
            }
            callback(null, chrome.runtime.lastError.message);
            return;
        }
        callback(response, null);
    });
}

// ===============================
// COPY & CHAT STORAGE HELPERS
// ===============================
function attachCopyButton(container, textToCopy) {
    if (!container || container.querySelector(".copy-btn")) return;
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.title = "Copy answer";
    copyBtn.textContent = "📋";
    copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
            const rawText = textToCopy || container.innerText.replace(/^[⚡📚].*$/gm, "").trim();
            await navigator.clipboard.writeText(rawText);
            copyBtn.textContent = "✓";
            copyBtn.classList.add("copied");
            setTimeout(() => {
                copyBtn.textContent = "📋";
                copyBtn.classList.remove("copied");
            }, 1500);
        } catch (err) {
            console.error("Clipboard copy failed:", err);
        }
    });
    container.appendChild(copyBtn);
}

function getStorageKey(url) {
    if (!url) return "argus_chat_default";
    try {
        const u = new URL(url);
        return "argus_chat_" + (u.origin + u.pathname).slice(0, 80);
    } catch (e) {
        return "argus_chat_" + String(url).slice(0, 80);
    }
}

async function saveChatToStorage() {
    if (!currentUrl) return;
    const key = getStorageKey(currentUrl);
    const dataToSave = {
        url: currentUrl,
        pageLoaded: pageLoaded,
        chatHistory: chatHistory,
        timestamp: Date.now()
    };
    try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set({ [key]: dataToSave });
        } else {
            localStorage.setItem(key, JSON.stringify(dataToSave));
        }
    } catch (e) {
        try { localStorage.setItem(key, JSON.stringify(dataToSave)); } catch (err) {}
    }
}

async function restoreChatFromStorage(url) {
    if (!url) return;
    const key = getStorageKey(url);
    let saved = null;
    try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            const res = await chrome.storage.local.get([key]);
            saved = res ? res[key] : null;
        }
        if (!saved) {
            const localStr = localStorage.getItem(key);
            if (localStr) saved = JSON.parse(localStr);
        }
    } catch (e) {
        try {
            const localStr = localStorage.getItem(key);
            if (localStr) saved = JSON.parse(localStr);
        } catch (err) {}
    }

    if (saved && Array.isArray(saved.chatHistory) && saved.chatHistory.length > 0) {
        chatHistory = saved.chatHistory;
        pageLoaded = Boolean(saved.pageLoaded);
        if (pageLoaded && statusDot) statusDot.classList.add("active");
        if (emptyState) emptyState.style.display = "none";

        // Render previous messages
        chatHistory.forEach(item => {
            const msgEl = document.createElement("div");
            msgEl.classList.add("message", item.role === "user" ? "user" : "bot");
            if (item.role === "user") {
                msgEl.textContent = item.content;
            } else {
                msgEl.innerHTML = renderMarkdown(item.content);
                attachCopyButton(msgEl, item.content);
            }
            chat.appendChild(msgEl);
        });
        chat.scrollTop = chat.scrollHeight;

        if (pageLoaded) {
            status.textContent = `Restored chat (${chatHistory.length} messages)`;
            extractBtn.innerHTML = `<span>🔄 Reload</span>`;
            if (suggestBtn) suggestBtn.disabled = false;
        }
    }
}

async function clearChatStorage(url) {
    if (!url) return;
    const key = getStorageKey(url);
    try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            await chrome.storage.local.remove([key]);
        }
        localStorage.removeItem(key);
    } catch (e) {
        try { localStorage.removeItem(key); } catch (err) {}
    }
}

// ===============================
// INITIALIZATION: TAB TITLE & HEALTH
// ===============================
(async () => {
    try {
        const tab = await getActiveTab();
        if (tab) {
            currentUrl = tab.url || "";
            if (tab.title && titlePreview) {
                titlePreview.textContent = tab.title;
                titlePreview.title = tab.title;
                titlePreview.style.display = "block";
            }
            await restoreChatFromStorage(currentUrl);
        }
    } catch (e) { }

    fetch(`${BACKEND_URL}/health`, { method: "GET" })
        .then(r => r.json())
        .then(data => {
            if (data.status === "healthy" || data.status === "ok") {
                if (!pageLoaded && (!chatHistory || chatHistory.length === 0)) {
                    status.textContent = "Backend ready • Load page to begin";
                }
            }
        })
        .catch(() => {
            status.textContent = "Backend offline (Start uvicorn)";
        });
})();

// ===============================
// QUICK PROMPTS & EMPTY STATE
// ===============================

document.querySelectorAll(".quick-chip").forEach(chip => {
    chip.addEventListener("click", () => {
        if (chip.dataset.action === "snip") {
            triggerSnip();
        } else if (chip.dataset.prompt) {
            questionInput.value = chip.dataset.prompt;
            askQuestion();
        }
    });
});

if (clearChatBtn) {
    clearChatBtn.addEventListener("click", () => {
        chatHistory = [];
        activeSnippetBase64 = null;
        if (snipAttachment) snipAttachment.style.display = "none";
        clearChatStorage(currentUrl);
        
        // Remove all message bubbles except emptyState
        const messages = Array.from(chat.querySelectorAll(".message"));
        messages.forEach(m => m.remove());
        if (emptyState) emptyState.style.display = "flex";
        status.textContent = pageLoaded ? "Page indexed (Chat cleared)" : "Page not loaded";
    });
}

if (exportChatBtn) {
    exportChatBtn.addEventListener("click", () => {
        if (!chatHistory || chatHistory.length === 0) {
            status.textContent = "No conversation to export yet";
            return;
        }

        let md = `# Argus Conversation Export\n\n`;
        md += `- **Source URL:** ${currentUrl || "N/A"}\n`;
        md += `- **Date:** ${new Date().toLocaleString()}\n`;
        md += `- **Total Messages:** ${chatHistory.length}\n\n---\n\n`;

        chatHistory.forEach((msg, idx) => {
            const role = msg.role === "user" ? "### 👤 User" : "### 👁️ Argus";
            md += `${role}\n\n${msg.content}\n\n`;
        });

        const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const sanitizedTitle = (document.title || "chat").replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
        a.download = `argus-${sanitizedTitle}-${Date.now()}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        status.textContent = "Chat exported as Markdown!";
    });
}

// ===============================
// LOAD PAGE
// ===============================

extractBtn.addEventListener("click", async () => {
    const isDeepScan = Boolean(deepScanToggle && deepScanToggle.checked);
    const isOcr = Boolean(ocrImagesToggle && ocrImagesToggle.checked);
    status.textContent = isOcr ? "Scanning page & banners (OCR)..." : (isDeepScan ? "Deep scanning..." : "Extracting content...");
    extractBtn.disabled = true;

    try {
        const tab = await getActiveTab();

        if (!tab || !tab.id) {
            status.textContent = "No active tab found (click page & retry)";
            extractBtn.disabled = false;
            return;
        }

        currentUrl = tab.url || "default";

        sendTabMessageWithRetry(
            tab.id,
            { action: "extractArticle", deepScan: isDeepScan, enableOcr: isOcr },
            async (response, errorMsg) => {
                if (errorMsg || !response) {
                    console.error("[Argus] Extraction failed:", errorMsg);
                    status.textContent = "Cannot read tab (refresh tab & retry)";
                    if (statusDot) statusDot.classList.remove("active");
                    extractBtn.disabled = false;
                    return;
                }

                const isPdf = Boolean(response && response.isPdf);
                const articleText = (response && response.text) ? response.text.trim() : "";

                if (!response || !response.success || (!articleText && !isPdf)) {
                    status.textContent = response?.error || "No readable content found on this page.";
                    if (statusDot) statusDot.classList.remove("active");
                    extractBtn.disabled = false;
                    return;
                }

                const mode = response.mode || (isPdf ? "pdf" : "page");
                const title = response.title || (isPdf ? "PDF Document" : "Webpage");
                const wordCount = response.wordCount || (articleText ? articleText.split(/\s+/).length : 0);

                // Update UI Badges
                updateModeBadge(mode);
                if (title && title !== "Webpage") {
                    titlePreview.textContent = title;
                    titlePreview.title = title;
                    titlePreview.style.display = "block";
                }

                status.textContent = isOcr ? "Transcribing banners & indexing in ChromaDB..." : "Indexing in ChromaDB...";

                // Reset chat history for newly loaded content
                chatHistory = [];

                // ===============================
                // SEND TO FASTAPI (PDF OR TEXT)
                // ===============================
                try {
                    const endpoint = isPdf ? `${BACKEND_URL}/process-pdf` : `${BACKEND_URL}/process-page`;
                    const payload = isPdf ? {
                        url: response.url || currentUrl,
                        base64_pdf: response.pdfBase64,
                        title: title
                    } : {
                        text: articleText,
                        url: currentUrl,
                        images: response.images || [],
                        enable_ocr: isOcr
                    };

                    const result = await fetch(endpoint, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify(payload)
                    });

                    const data = await result.json();

                    if (result.ok && data.status === "success") {
                        pageLoaded = true;
                        if (statusDot) statusDot.classList.add("active");
                        status.textContent = `Indexed (${data.chunks} chunks)`;
                        extractBtn.innerHTML = `<span>🔄 Reload</span>`;

                        let welcomeText = `The page has been loaded into memory (${wordCount} words, ${data.chunks} semantic chunks).`;
                        if (mode === "selection") {
                            welcomeText = `Ready! Indexed your highlighted text (${wordCount} words). Ask me anything about it!`;
                        } else if (mode === "pdf") {
                            welcomeText = `Ready! Extracted PDF "${title}" (${data.characters} characters, ${data.chunks} semantic chunks). Ask me anything about this document!`;
                        } else if (mode === "youtube") {
                            welcomeText = `Ready! Indexed YouTube video transcript for "${title}" (${wordCount} words). Ask me anything about this video!`;
                        } else if (mode === "article" || mode === "readability") {
                            welcomeText = `Ready! Extracted article "${title}" (${wordCount} words). Ask me anything about it!`;
                        }

                        if (isDeepScan) {
                            welcomeText += " ⚡ (Deep Scan auto-scrolled & captured lazy-loaded content)";
                        }

                        if (data.ocr_images_processed && data.ocr_images_processed > 0) {
                            welcomeText += ` 🖼️ (OCR transcribed ${data.ocr_images_processed} ad banners & promotional graphics into the searchable index).`;
                        }

                        addMessage("bot", welcomeText);

                        // Enable and load suggested questions
                        if (suggestBtn) suggestBtn.disabled = false;
                        loadSuggestedQuestions();
                    } else {
                        status.textContent = data.detail || "Failed to index content";
                        if (statusDot) statusDot.classList.remove("active");
                    }
                } catch (error) {
                    console.error("FastAPI connection failed:", error);
                    status.textContent = "Backend offline (Start FastAPI server)";
                    if (statusDot) statusDot.classList.remove("active");
                }

                extractBtn.disabled = false;
            }
        );
    } catch (error) {
        console.error(error);
        status.textContent = "Failed to load page";
        if (statusDot) statusDot.classList.remove("active");
        extractBtn.disabled = false;
    }
});

function updateModeBadge(mode) {
    if (!modeBadge) return;
    modeBadge.className = "mode-badge";
    if (mode === "selection") {
        modeBadge.textContent = "Selection";
        modeBadge.classList.add("mode-selection");
    } else if (mode === "pdf") {
        modeBadge.textContent = "PDF";
        modeBadge.classList.add("mode-pdf");
    } else if (mode === "youtube") {
        modeBadge.textContent = "YouTube";
        modeBadge.classList.add("mode-youtube");
    } else if (mode === "readability" || mode === "article") {
        modeBadge.textContent = mode === "readability" ? "Readability" : "Article";
        modeBadge.classList.add("mode-article");
    } else if (mode === "vision") {
        modeBadge.textContent = "Vision AI";
        modeBadge.classList.add("mode-vision");
    } else {
        modeBadge.textContent = "Full Page";
        modeBadge.classList.add("mode-page");
    }
    modeBadge.style.display = "inline-block";
}

// ===============================
// LOCAL PDF FILE UPLOAD
// ===============================

if (uploadPdfBtn && pdfFileInput) {
    uploadPdfBtn.addEventListener("click", () => {
        pdfFileInput.click();
    });

    pdfFileInput.addEventListener("change", async (event) => {
        const file = event.target.files[0];
        if (!file) return;

        status.textContent = `Reading ${file.name}...`;
        uploadPdfBtn.disabled = true;
        extractBtn.disabled = true;

        const reader = new FileReader();
        reader.onload = async () => {
            const base64data = (reader.result || "").split(",")[1];
            currentUrl = `file://${file.name}`;
            updateModeBadge("pdf");
            titlePreview.textContent = file.name;
            titlePreview.title = file.name;
            titlePreview.style.display = "block";
            status.textContent = "Indexing PDF in ChromaDB...";

            try {
                const result = await fetch(`${BACKEND_URL}/process-pdf`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        url: currentUrl,
                        base64_pdf: base64data,
                        title: file.name
                    })
                });

                const data = await result.json();

                if (result.ok && data.status === "success") {
                    pageLoaded = true;
                    if (statusDot) statusDot.classList.add("active");
                    status.textContent = `PDF Indexed (${data.chunks} chunks)`;
                    extractBtn.innerHTML = `<span>🔄 Reload</span>`;

                    addMessage("bot", `Ready! Indexed PDF document "${file.name}" (${data.characters} characters, ${data.chunks} semantic chunks). Ask me anything about it!`);

                    if (suggestBtn) suggestBtn.disabled = false;
                    loadSuggestedQuestions();
                } else {
                    status.textContent = data.detail || "Failed to index PDF";
                    if (statusDot) statusDot.classList.remove("active");
                }
            } catch (err) {
                console.error("PDF upload failed:", err);
                status.textContent = "Backend offline (Start FastAPI)";
                if (statusDot) statusDot.classList.remove("active");
            } finally {
                uploadPdfBtn.disabled = false;
                extractBtn.disabled = false;
                pdfFileInput.value = "";
            }
        };
        reader.readAsDataURL(file);
    });
}

// ===============================
// SNIP-TO-CHAT (APPROACH 1)
// ===============================

async function triggerSnip() {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
        status.textContent = "No active tab to snip";
        return;
    }
    status.textContent = "Drag to select any ad, banner, or image...";
    sendTabMessageWithRetry(tab.id, { action: "startSnip" }, () => {});
}

if (snipBtn) {
    snipBtn.addEventListener("click", triggerSnip);
}

if (quickSnipBtn) {
    quickSnipBtn.addEventListener("click", triggerSnip);
}

function handleSnipResult(data) {
    if (data.cancelled) {
        status.textContent = pageLoaded ? "Page ready" : "Snip cancelled";
        return;
    }
    if (data.success && data.dataUrl) {
        activeSnippetBase64 = data.dataUrl;
        if (snipThumb) snipThumb.src = data.dataUrl;
        if (snipSize) snipSize.textContent = `${data.width} × ${data.height} px`;
        if (snipAttachment) snipAttachment.style.display = "flex";
        questionInput.placeholder = "Ask something about this snipped image...";
        status.textContent = "Image snippet attached! Ready for Vision chat.";
        if (statusDot) statusDot.classList.add("active");
        updateModeBadge("vision");
        questionInput.focus();
    } else if (data.error) {
        status.textContent = data.error;
    }
}

// 1. PostMessage listener (when popup is inside in-page floating iframe)
window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "RAG_SNIP_RESULT") {
        handleSnipResult(event.data);
    }
});

// 2. Chrome runtime listener (when popup is opened from browser action toolbar)
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "snipResult") {
        handleSnipResult(message);
    }
});

if (cancelSnipBtn) {
    cancelSnipBtn.addEventListener("click", () => {
        activeSnippetBase64 = null;
        if (snipAttachment) snipAttachment.style.display = "none";
        questionInput.placeholder = "Ask anything about this page...";
        status.textContent = pageLoaded ? "Page ready" : "Ready";
    });
}

// ===============================
// SUGGESTED QUESTIONS
// ===============================

if (suggestBtn) {
    suggestBtn.addEventListener("click", () => {
        loadSuggestedQuestions();
    });
}

if (closeSuggestionsBtn) {
    closeSuggestionsBtn.addEventListener("click", () => {
        suggestionsBox.style.display = "none";
    });
}

async function loadSuggestedQuestions() {
    if (!currentUrl) return;
    if (suggestBtn) suggestBtn.disabled = true;
    suggestionsBox.style.display = "block";
    suggestionsList.innerHTML = `<div style="font-size: 11px; color: #64748b; padding: 4px 0;">✨ Generating questions...</div>`;

    try {
        const res = await fetch(`${BACKEND_URL}/suggest-questions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: currentUrl })
        });
        const data = await res.json();
        if (res.ok && data.questions && data.questions.length > 0) {
            renderSuggestedQuestions(data.questions);
        } else {
            suggestionsBox.style.display = "none";
        }
    } catch (e) {
        console.error("Failed to fetch suggested questions:", e);
        suggestionsBox.style.display = "none";
    } finally {
        if (suggestBtn) suggestBtn.disabled = false;
    }
}

function renderSuggestedQuestions(questions) {
    suggestionsList.innerHTML = "";
    questions.forEach(q => {
        const btn = document.createElement("button");
        btn.className = "suggestion-pill";
        btn.textContent = `❓ ${q}`;
        btn.addEventListener("click", () => {
            questionInput.value = q;
            askQuestion();
        });
        suggestionsList.appendChild(btn);
    });
    suggestionsBox.style.display = "block";
}

// ===============================
// SEND QUESTION
// ===============================

sendBtn.addEventListener("click", askQuestion);

questionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        askQuestion();
    }
});

async function askQuestion() {
    let question = questionInput.value.trim();
    const snippetToSend = activeSnippetBase64;

    if (!question && !snippetToSend) {
        return;
    }

    // Default question for image snippet if user submitted with blank input
    if (!question && snippetToSend) {
        question = "Analyze this image and explain what offer or information it shows in detail.";
    }

    if (!snippetToSend && !pageLoaded) {
        addMessage("bot", "Please click '⚡ Load Page' first so I can index this webpage, or click '✂️ Snip' to chat with a specific image/banner.");
        return;
    }

    // Hide empty state if visible
    if (emptyState) emptyState.style.display = "none";

    // Render user message (with snippet thumbnail if attached)
    const userMsg = document.createElement("div");
    userMsg.classList.add("message", "user");
    userMsg.textContent = question;

    if (snippetToSend) {
        const thumb = document.createElement("img");
        thumb.src = snippetToSend;
        thumb.className = "chat-snippet-preview";
        userMsg.appendChild(thumb);
    }

    chat.appendChild(userMsg);
    chat.scrollTop = chat.scrollHeight;

    // Reset input and clear attached snippet
    questionInput.value = "";
    activeSnippetBase64 = null;
    if (snipAttachment) snipAttachment.style.display = "none";
    questionInput.placeholder = "Ask anything about this page...";

    sendBtn.disabled = true;
    questionInput.disabled = true;

    // Create bot response message element with cursor
    const messageContainer = document.createElement("div");
    messageContainer.classList.add("message", "bot", "streaming-cursor");

    // Agent reasoning steps container
    const agentTrace = document.createElement("div");
    agentTrace.classList.add("agent-trace");
    messageContainer.appendChild(agentTrace);

    const textSpan = document.createElement("span");
    textSpan.textContent = snippetToSend ? "Vision AI analyzing image..." : "Agent thinking...";
    messageContainer.appendChild(textSpan);

    chat.appendChild(messageContainer);
    chat.scrollTop = chat.scrollHeight;

    let fullAnswer = "";
    let sources = [];

    try {
        const endpoint = snippetToSend ? `${BACKEND_URL}/query-vision` : `${BACKEND_URL}/query`;
        const payload = snippetToSend ? {
            question: question,
            image_base64: snippetToSend,
            mime_type: "image/png",
            url: currentUrl,
            history: chatHistory.slice(-4),
            stream: true
        } : {
            question: question,
            url: currentUrl,
            history: chatHistory.slice(-6),
            stream: true
        };

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            textSpan.textContent = errorData.detail || `Server error (${response.status})`;
            messageContainer.classList.remove("streaming-cursor");
            sendBtn.disabled = false;
            questionInput.disabled = false;
            questionInput.focus();
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop(); // keep remainder

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data: ")) continue;

                try {
                    const event = JSON.parse(trimmed.slice(6));

                    if (event.type === "agent_step") {
                        const pill = document.createElement("div");
                        pill.classList.add("agent-pill");
                        pill.textContent = `⚡ ${event.step}`;
                        agentTrace.appendChild(pill);
                        chat.scrollTop = chat.scrollHeight;
                    } else if (event.type === "sources") {
                        sources = event.chunks || [];
                    } else if (event.type === "token") {
                        if (textSpan.textContent.startsWith("Agent thinking") || textSpan.textContent.startsWith("Vision AI analyzing")) {
                            textSpan.textContent = "";
                        }
                        textSpan.textContent += event.token;
                        fullAnswer += event.token;
                        chat.scrollTop = chat.scrollHeight;
                    } else if (event.type === "error") {
                        textSpan.textContent = event.error || "Generation error.";
                    }
                } catch (e) {
                    console.error("SSE parse error:", e);
                }
            }
        }

        // Streaming finished
        messageContainer.classList.remove("streaming-cursor");

        if (!fullAnswer && textSpan.textContent === "Thinking...") {
            textSpan.textContent = "I couldn't find this information on the webpage.";
            fullAnswer = textSpan.textContent;
        } else if (fullAnswer) {
            textSpan.innerHTML = renderMarkdown(fullAnswer);
        }

        // Attach copy button for this bot response
        attachCopyButton(messageContainer, fullAnswer);

        // Add to conversational history for follow-ups & persist
        chatHistory.push({ role: "user", content: question });
        chatHistory.push({ role: "assistant", content: fullAnswer });
        saveChatToStorage();

        // Render Source Attribution Dropdown if chunks were retrieved
        if (sources && sources.length > 0) {
            const details = document.createElement("details");
            details.classList.add("sources-details");

            const summary = document.createElement("summary");
            summary.classList.add("sources-summary");
            summary.textContent = `📚 View ${sources.length} Grounding Source${sources.length > 1 ? "s" : ""}`;
            details.appendChild(summary);

            const sourcesList = document.createElement("div");
            sourcesList.classList.add("sources-list");

            sources.forEach((chunk, idx) => {
                const item = document.createElement("div");
                item.classList.add("source-item");
                item.textContent = `[${idx + 1}] ${chunk.length > 300 ? chunk.slice(0, 300) + "..." : chunk}`;
                sourcesList.appendChild(item);
            });

            details.appendChild(sourcesList);
            messageContainer.appendChild(details);
            chat.scrollTop = chat.scrollHeight;
        }

    } catch (error) {
        console.error("Streaming query failed:", error);
        messageContainer.classList.remove("streaming-cursor");
        textSpan.textContent = "Could not connect to backend server.";
    }

    sendBtn.disabled = false;
    questionInput.disabled = false;
    questionInput.focus();
}

function renderMarkdown(text) {
    if (!text) return "";
    let html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/```([\s\S]*?)```/g, '<pre class="md-code-block">$1</pre>')
        .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.*?)\*/g, "<em>$1</em>")
        .replace(/^[\*\-] (.*?)$/gm, "• $1")
        .replace(/\n{2,}/g, "<br><br>")
        .replace(/\n/g, "<br>");
    return html;
}

function addMessage(sender, text) {
    if (emptyState) emptyState.style.display = "none";
    const message = document.createElement("div");
    message.classList.add("message", sender);
    if (sender === "bot") {
        message.innerHTML = renderMarkdown(text);
        attachCopyButton(message, text);
    } else {
        message.textContent = text;
    }
    chat.appendChild(message);
    chat.scrollTop = chat.scrollHeight;
    return message;
}
