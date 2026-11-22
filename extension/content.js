/**
 * Semantic Content Extractor for Argus
 * 
 * Features:
 * 1. User Selection Priority ("Highlight to Chat")
 * 2. Dedicated YouTube Video Transcript & Metadata Extractor (Captions, Timestamps, Chapters)
 * 3. Mozilla Readability-style Text Density & Paragraph Scoring Algorithm
 * 4. Deep Shadow DOM & Slot Piercing (Web Components, Lit, Polymer)
 * 5. Same-Origin Iframe Content Extraction (Nested docs, embeds)
 * 6. Smart Boilerplate & Noise Stripping with Link-Density Guardrails
 * 7. Structure-Preserving HTML to Markdown (Tables, Code, Headings, Lists, Quotes)
 * 8. Multi-Tier Universal Fallback for Dynamic SPAs & Custom Frameworks
 */

// ---------------------------------------------------------------------------
// 1. Selection Detection
// ---------------------------------------------------------------------------
function getHighlightedText() {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length >= 15) {
        return selection.toString().trim();
    }
    return null;
}

// ---------------------------------------------------------------------------
// 2. Link Density & Element Scoring
// ---------------------------------------------------------------------------
function getLinkDensity(element) {
    const text = (element.innerText || "").trim();
    if (!text || text.length === 0) return 0;

    let linkLength = 0;
    const links = element.querySelectorAll("a");
    links.forEach(a => {
        linkLength += (a.innerText || "").trim().length;
    });

    return linkLength / text.length;
}

// Regex patterns for semantic weighting
const POSITIVE_HINTS = /(article|body|content|entry|main|page|post|text|story|narrative|document|section|blog)/i;
const NEGATIVE_HINTS = /(ad|advertisement|combx|comment|community|disqus|extra|foot|header|menu|nav|remark|rss|shoutbox|sidebar|sponsor|widget|banner|popup|cookie|consent|modal)/i;

function getElementSemanticScore(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return 0;

    let score = 0;
    const tag = element.tagName.toUpperCase();

    // Tag base weighting
    if (tag === "ARTICLE") score += 35;
    else if (tag === "MAIN" || element.getAttribute("role") === "main") score += 30;
    else if (tag === "SECTION") score += 15;
    else if (tag === "DIV") score += 5;

    // Class and ID weighting
    const identifier = `${element.className || ""} ${element.id || ""}`;
    if (POSITIVE_HINTS.test(identifier)) score += 25;
    if (NEGATIVE_HINTS.test(identifier)) score -= 35;

    return score;
}

// ---------------------------------------------------------------------------
// 3. Mozilla Readability-style Container Detection
// ---------------------------------------------------------------------------
function findBestArticleContainer(root = document.body) {
    if (!root) return null;

    // Collect candidate paragraphs and content blocks
    const paragraphs = Array.from(root.querySelectorAll("p, pre, blockquote, table, section, article"));
    if (paragraphs.length === 0) return null;

    const parentScores = new Map();

    paragraphs.forEach(node => {
        const text = (node.innerText || "").trim();
        if (text.length < 25) return; // Skip tiny fragments

        const parent = node.parentElement;
        if (!parent || parent.tagName === "BODY" || parent.tagName === "HTML") return;

        let currentScore = parentScores.get(parent) || getElementSemanticScore(parent);

        // Add points for length and sentence structure
        currentScore += Math.min(Math.floor(text.length / 50), 4);

        // Punctuation check (indicates real prose vs keyword lists)
        const punctuationCount = (text.match(/[,.;:!?]/g) || []).length;
        currentScore += Math.min(Math.floor(punctuationCount / 2), 4);

        parentScores.set(parent, currentScore);

        // Also credit grandparent (common for wrapped article sections)
        const grandParent = parent.parentElement;
        if (grandParent && grandParent.tagName !== "BODY" && grandParent.tagName !== "HTML") {
            let gpScore = parentScores.get(grandParent) || getElementSemanticScore(grandParent);
            gpScore += Math.floor(currentScore / 2);
            parentScores.set(grandParent, gpScore);
        }
    });

    let topCandidate = null;
    let highestScore = -Infinity;

    parentScores.forEach((score, element) => {
        const linkDensity = getLinkDensity(element);
        const adjustedScore = score * (1 - linkDensity);

        if (adjustedScore > highestScore && adjustedScore > 20) {
            const textLen = (element.innerText || "").trim().length;
            if (textLen > 250) {
                highestScore = adjustedScore;
                topCandidate = element;
            }
        }
    });

    return topCandidate;
}

// ---------------------------------------------------------------------------
// 4. Same-Origin Iframe Extraction
// ---------------------------------------------------------------------------
function extractAccessibleFrames() {
    const iframes = Array.from(document.querySelectorAll("iframe"));
    const frameTexts = [];

    iframes.forEach((iframe, idx) => {
        try {
            const rect = iframe.getBoundingClientRect();
            if (rect.width < 100 || rect.height < 100) return;

            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (!doc || !doc.body) return;

            const text = (doc.body.innerText || "").trim();
            if (text.length > 200 && getLinkDensity(doc.body) < 0.5) {
                const title = doc.title || iframe.getAttribute("title") || `Embedded Content ${idx + 1}`;
                const cleanContent = domToMarkdown(doc.body).trim();
                if (cleanContent) {
                    frameTexts.push(`\n\n### Frame: ${title}\n${cleanContent}\n`);
                }
            }
        } catch (e) {
            // Cross-origin iframes ignore safely
        }
    });

    return frameTexts.join("\n");
}

// ---------------------------------------------------------------------------
// 5. Structure-Preserving HTML to Markdown
// ---------------------------------------------------------------------------
function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length === 0) return "";

    const markdownRows = [];

    rows.forEach((tr, index) => {
        const cells = Array.from(tr.querySelectorAll("th, td"));
        if (cells.length === 0) return;

        const cellValues = cells.map(cell => cell.innerText.replace(/[\r\n\t]+/g, " ").trim());
        markdownRows.push("| " + cellValues.join(" | ") + " |");

        if (index === 0) {
            const delimiter = "| " + cells.map(() => "---").join(" | ") + " |";
            markdownRows.push(delimiter);
        }
    });

    return "\n\n" + markdownRows.join("\n") + "\n\n";
}

function domToMarkdown(node) {
    if (!node) return "";

    if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.replace(/\s+/g, " ");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
    }

    const tagName = node.tagName.toUpperCase();

    // Piercing open shadow roots & Web Components
    let shadowContent = "";
    if (node.shadowRoot) {
        shadowContent = Array.from(node.shadowRoot.childNodes)
            .map(domToMarkdown)
            .join("");
    }

    // Images (preserve alt and aria-label as textual cues)
    if (tagName === "IMG") {
        const alt = node.getAttribute("alt") || node.getAttribute("aria-label") || node.getAttribute("title") || "";
        return alt.trim() ? ` [Image: ${alt.trim()}] ` : "";
    }

    // Slotted elements
    if (tagName === "SLOT") {
        const assigned = node.assignedNodes ? node.assignedNodes({ flatten: true }) : [];
        return assigned.map(domToMarkdown).join("");
    }

    // Tables
    if (tagName === "TABLE") {
        return tableToMarkdown(node);
    }

    // Code blocks & inline code
    if (tagName === "PRE") {
        const codeText = node.innerText.trim();
        return `\n\n\`\`\`\n${codeText}\n\`\`\`\n\n`;
    }
    if (tagName === "CODE" && node.parentElement?.tagName.toUpperCase() !== "PRE") {
        return `\`${node.innerText.trim()}\``;
    }

    // Headings
    if (/^H[1-6]$/.test(tagName)) {
        const level = parseInt(tagName[1], 10);
        const prefix = "#".repeat(level);
        const text = node.innerText.replace(/\s+/g, " ").trim();
        return text ? `\n\n${prefix} ${text}\n\n` : "";
    }

    // Lists
    if (tagName === "UL" || tagName === "OL") {
        const items = Array.from(node.children)
            .filter(child => child.tagName.toUpperCase() === "LI")
            .map((li, idx) => {
                const marker = tagName === "OL" ? `${idx + 1}.` : "-";
                const content = domToMarkdown(li).trim();
                return `${marker} ${content}`;
            })
            .join("\n");
        return `\n\n${items}\n\n`;
    }

    // Blockquotes
    if (tagName === "BLOCKQUOTE") {
        return `\n\n> ${node.innerText.trim()}\n\n`;
    }

    // Paragraphs & Line Breaks
    if (tagName === "P") {
        const content = Array.from(node.childNodes).map(domToMarkdown).join("").trim();
        return content ? `\n\n${content}\n\n` : "";
    }
    if (tagName === "BR") {
        return "\n";
    }

    // Recurse child nodes
    const childrenMarkdown = Array.from(node.childNodes)
        .map(domToMarkdown)
        .join("");

    return (childrenMarkdown + shadowContent);
}

// ---------------------------------------------------------------------------
// 6. Boilerplate & Noise Stripping with Safety Guardrails
// ---------------------------------------------------------------------------
function stripBoilerplate(container) {
    const tagsToRemove = [
        "SCRIPT", "STYLE", "NOSCRIPT", "NAV", "FOOTER", "ASIDE",
        "HEADER", "SVG", "FORM", "DIALOG", "BUTTON",
        "INPUT", "SELECT", "TEXTAREA"
    ];

    tagsToRemove.forEach(tag => {
        container.querySelectorAll(tag).forEach(el => el.remove());
    });

    const noiseSelectors = [
        '[role="navigation"]',
        '[role="dialog"]',
        '[role="alert"]',
        '[class*="cookie-banner" i]',
        '[class*="cookie-consent" i]',
        '[id*="cookie-banner" i]',
        '[class*="ad-container" i]',
        '[class*="advertisement" i]',
        '[id*="advertisement" i]',
        '[class*="social-share" i]',
        '[id*="social-share" i]',
        '[class*="sidebar" i]',
        '[id*="sidebar" i]'
    ];

    noiseSelectors.forEach(selector => {
        try {
            container.querySelectorAll(selector).forEach(el => {
                const text = (el.innerText || "").trim();
                if (text.length > 350 && getLinkDensity(el) < 0.3) {
                    return;
                }
                el.remove();
            });
        } catch (e) { }
    });
}

// ---------------------------------------------------------------------------
// 7. Dedicated YouTube Video Transcript & Metadata Extractor
// ---------------------------------------------------------------------------
function isYouTubeWatchPage() {
    const host = window.location.hostname;
    const path = window.location.pathname;
    return (host.includes("youtube.com") || host.includes("youtu.be")) &&
        (path === "/watch" || path.startsWith("/shorts/"));
}

function getYouTubeVideoId() {
    const path = window.location.pathname;
    if (path.startsWith("/shorts/")) {
        return path.split("/")[2] || "";
    }
    return new URLSearchParams(window.location.search).get("v") || "";
}

function formatTimestamp(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
        const remainingMinutes = minutes % 60;
        return `${String(hours).padStart(2, "0")}:${String(remainingMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

async function findYouTubeCaptionTracks(videoId) {
    // 1. Search page script tags for captionTracks
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const script of scripts) {
        const text = script.textContent || "";
        if (text.includes("captionTracks")) {
            const match = text.match(/"captionTracks":\s*(\[.+?\])/);
            if (match && match[1]) {
                try {
                    const tracks = JSON.parse(match[1]);
                    if (Array.isArray(tracks) && tracks.length > 0) {
                        return tracks;
                    }
                } catch (e) { }
            }
        }
    }

    // 2. Fallback: Fetch page HTML directly (handles dynamic SPA navigation)
    if (videoId) {
        try {
            const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
            const html = await resp.text();
            const match = html.match(/"captionTracks":\s*(\[.+?\])/);
            if (match && match[1]) {
                const tracks = JSON.parse(match[1]);
                if (Array.isArray(tracks) && tracks.length > 0) {
                    return tracks;
                }
            }
        } catch (e) {
            console.warn("[YouTube Extractor] Watch page fetch fallback failed:", e);
        }
    }

    return null;
}

async function fetchAndParseYouTubeCaptions(captionTracks) {
    if (!captionTracks || captionTracks.length === 0) return null;

    // Prioritize English track, then manual over auto-generated
    let targetTrack = captionTracks.find(t => t.languageCode && t.languageCode.startsWith("en")) ||
        captionTracks.find(t => t.kind !== "asr") ||
        captionTracks[0];

    if (!targetTrack || !targetTrack.baseUrl) return null;

    const trackName = targetTrack.name?.runs?.[0]?.text || targetTrack.languageCode || "Default";

    // Attempt 1: Fetch as JSON3
    try {
        const jsonUrl = targetTrack.baseUrl + (targetTrack.baseUrl.includes("?") ? "&" : "?") + "fmt=json3";
        const res = await fetch(jsonUrl);
        if (res.ok) {
            const data = await res.json();
            if (data && data.events && data.events.length > 0) {
                const lines = [];
                let currentChunk = "";
                let startMs = 0;
                let endMs = 0;

                for (const evt of data.events) {
                    if (!evt.segs) continue;
                    const text = evt.segs.map(s => s.utf8 || "").join("").replace(/\n/g, " ").trim();
                    if (!text) continue;

                    if (!currentChunk) {
                        startMs = evt.tStartMs || 0;
                    }
                    endMs = (evt.tStartMs || 0) + (evt.dDurationMs || 0);
                    currentChunk += (currentChunk ? " " : "") + text;

                    // Group into semantic 30-second blocks or sentence boundaries
                    if (endMs - startMs >= 30000 || /[.!?]$/.test(currentChunk)) {
                        lines.push(`[${formatTimestamp(startMs)} - ${formatTimestamp(endMs)}] ${currentChunk}`);
                        currentChunk = "";
                    }
                }

                if (currentChunk) {
                    lines.push(`[${formatTimestamp(startMs)} - ${formatTimestamp(endMs)}] ${currentChunk}`);
                }

                if (lines.length > 0) {
                    return {
                        trackName: trackName,
                        transcript: lines.join("\n\n")
                    };
                }
            }
        }
    } catch (e) {
        console.warn("[YouTube Extractor] JSON3 caption parse failed, attempting XML fallback:", e);
    }

    // Attempt 2: XML Fallback
    try {
        const xmlRes = await fetch(targetTrack.baseUrl);
        if (xmlRes.ok) {
            const xmlText = await xmlRes.text();
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, "text/xml");
            const textNodes = Array.from(xmlDoc.querySelectorAll("text"));

            if (textNodes.length > 0) {
                const lines = [];
                let currentChunk = "";
                let startSec = 0;
                let endSec = 0;

                textNodes.forEach(node => {
                    const start = parseFloat(node.getAttribute("start") || "0");
                    const dur = parseFloat(node.getAttribute("dur") || "0");
                    const text = (node.textContent || "")
                        .replace(/&amp;/g, "&")
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'")
                        .replace(/\n/g, " ")
                        .trim();

                    if (!text) return;

                    if (!currentChunk) {
                        startSec = start;
                    }
                    endSec = start + dur;
                    currentChunk += (currentChunk ? " " : "") + text;

                    if (endSec - startSec >= 30 || /[.!?]$/.test(currentChunk)) {
                        lines.push(`[${formatTimestamp(startSec * 1000)} - ${formatTimestamp(endSec * 1000)}] ${currentChunk}`);
                        currentChunk = "";
                    }
                });

                if (currentChunk) {
                    lines.push(`[${formatTimestamp(startSec * 1000)} - ${formatTimestamp(endSec * 1000)}] ${currentChunk}`);
                }

                return {
                    trackName: trackName,
                    transcript: lines.join("\n\n")
                };
            }
        }
    } catch (e) {
        console.warn("[YouTube Extractor] XML caption parse failed:", e);
    }

    return null;
}

async function extractYouTubeContent() {
    const videoId = getYouTubeVideoId();

    // 1. Title
    const titleEl = document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
        document.querySelector("h1.title yt-formatted-string") ||
        document.querySelector("h1 yt-formatted-string") ||
        document.querySelector("h1");
    const title = titleEl ? titleEl.innerText.trim() : document.title.replace(/ - YouTube$/, "");

    // 2. Channel Name
    const channelEl = document.querySelector("#channel-name #text") ||
        document.querySelector("ytd-channel-name a") ||
        document.querySelector("#upload-info #channel-name");
    const channel = channelEl ? channelEl.innerText.trim() : "YouTube Channel";

    // 3. Description & Chapters
    const descEl = document.querySelector("#description-inline-expander") ||
        document.querySelector("ytd-text-inline-expander#description") ||
        document.querySelector("#description");
    const description = descEl ? descEl.innerText.trim() : "";

    // 4. Captions
    const captionTracks = await findYouTubeCaptionTracks(videoId);
    const captionResult = await fetchAndParseYouTubeCaptions(captionTracks);

    // 5. Construct Structured Markdown Document
    let markdown = `# YouTube Video: ${title}\n`;
    markdown += `**Channel:** ${channel}\n`;
    markdown += `**Video URL:** https://www.youtube.com/watch?v=${videoId}\n\n`;

    if (description) {
        markdown += `## Video Overview, Timestamps & Description\n${description}\n\n`;
    }

    if (captionResult && captionResult.transcript) {
        markdown += `## Video Transcript (${captionResult.trackName})\n${captionResult.transcript}\n`;
    } else {
        markdown += `## Video Transcript\n*No automated or manual captions were available for this video. The chatbot will answer using the video's title, chapters, and description above.*\n`;
    }

    const cleanText = markdown.trim();
    const wordCount = cleanText.split(/\s+/).filter(Boolean).length;

    return {
        text: cleanText,
        title: title,
        wordCount: wordCount
    };
}

// ---------------------------------------------------------------------------
// 8. PDF Detection & Payload Extraction
// ---------------------------------------------------------------------------
function isPdfPage() {
    return document.contentType === "application/pdf" ||
        window.location.pathname.toLowerCase().endsWith(".pdf") ||
        Boolean(document.querySelector('embed[type="application/pdf"]'));
}

async function extractPdfContent() {
    const pdfUrl = window.location.href;
    const urlParts = pdfUrl.split("/");
    const lastPart = urlParts[urlParts.length - 1].split("?")[0];
    const filename = decodeURIComponent(lastPart) || "Document.pdf";

    try {
        const resp = await fetch(pdfUrl);
        const blob = await resp.blob();

        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = (reader.result || "").split(",")[1] || null;
                resolve({
                    isPdf: true,
                    pdfBase64: base64,
                    title: filename,
                    url: pdfUrl
                });
            };
            reader.onerror = () => {
                resolve({
                    isPdf: true,
                    pdfBase64: null,
                    title: filename,
                    url: pdfUrl
                });
            };
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        return {
            isPdf: true,
            pdfBase64: null,
            title: filename,
            url: pdfUrl
        };
    }
}

// ---------------------------------------------------------------------------
// 9. Master Webpage Content Extractor
// ---------------------------------------------------------------------------
function extractMainContent() {
    // 1. Highlight / Selection Priority
    const highlighted = getHighlightedText();
    if (highlighted) {
        return {
            text: highlighted,
            mode: "selection"
        };
    }

    // 2. Mozilla Readability-style Scoring
    const bestContainer = findBestArticleContainer(document.body);
    let targetElement = bestContainer;
    let mode = "readability";

    // Guard against locking onto tiny isolated footers/disclaimers on portal & homepage sites (e.g. Policybazaar)
    const bodyTextLen = (document.body?.innerText || "").trim().length;
    if (bestContainer) {
        const containerTextLen = (bestContainer.innerText || "").trim().length;
        if (containerTextLen < 700 && bodyTextLen > 1800) {
            console.log(`[RAG Extractor] Discarding narrow container (${containerTextLen} chars vs ${bodyTextLen} total). Falling back to page sections.`);
            targetElement = null; // Triggers full page/article extraction
        }
    }

    // 3. Explicit Semantic Tag Fallback (article, main, role=main)
    if (!targetElement) {
        const semanticSelectors = [
            '[id^="content-body-"]',
            "article",
            '[role="main"]',
            "main",
            ".article-content",
            ".post-content",
            ".entry-content",
            ".markdown-body"
        ];
        for (const selector of semanticSelectors) {
            const candidate = document.querySelector(selector);
            if (candidate && (candidate.innerText || "").trim().length > 250) {
                targetElement = candidate;
                mode = "article";
                break;
            }
        }
    }

    // 4. Body Fallback (for complex SPAs, custom wrappers, dashboards)
    if (!targetElement) {
        targetElement = document.body;
        mode = "page";
    }

    if (!targetElement) {
        return { text: "", mode: "empty" };
    }

    // Clone element to prevent mutating the user's active page
    const cloned = targetElement.cloneNode(true);
    stripBoilerplate(cloned);

    let markdown = domToMarkdown(cloned);

    // Clean whitespace
    markdown = markdown
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();

    // 5. Append same-origin iframe content if available
    const iframeContent = extractAccessibleFrames();
    if (iframeContent) {
        markdown += `\n\n${iframeContent}`;
    }

    // 6. Absolute Fallback: Raw innerText if parsed markdown is too brief
    if (!markdown || markdown.length < 60) {
        const rawText = (targetElement.innerText || document.body?.innerText || "")
            .replace(/\s+/g, " ")
            .trim();
        if (rawText.length > 0) {
            markdown = rawText;
        }
    }

    return {
        text: markdown,
        mode: mode
    };
}

// ---------------------------------------------------------------------------
// 10. Deep Scan Engine (Auto-Scroll & Lazy-Load Trigger)
// ---------------------------------------------------------------------------
async function triggerDeepScrollScan() {
    return new Promise(async (resolve) => {
        const initialScrollY = window.scrollY;
        const totalHeight = Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
            2500
        );

        const steps = 4;
        const scrollTarget = Math.min(totalHeight, 10000);

        for (let i = 1; i <= steps; i++) {
            const targetY = (scrollTarget / steps) * i;
            window.scrollTo({ top: targetY, behavior: "smooth" });
            await new Promise(r => setTimeout(r, 250));
        }

        // Safely trigger visible "Read more" / "Show more" buttons
        try {
            const buttons = Array.from(document.querySelectorAll("button, a, span[role='button']"));
            buttons.forEach(btn => {
                const txt = (btn.innerText || "").trim().toLowerCase();
                if ((txt === "read more" || txt === "show more" || txt === "see more") &&
                    btn.offsetParent !== null) {
                    btn.click();
                }
            });
        } catch (e) { }

        await new Promise(r => setTimeout(r, 250));

        // Restore scroll position
        window.scrollTo({ top: initialScrollY, behavior: "smooth" });
        await new Promise(r => setTimeout(r, 150));

        resolve();
    });
}

// ---------------------------------------------------------------------------
// 10.5 Webpage Banner & Promotional Image Harvester (Approach 2: Automatic OCR)
// ---------------------------------------------------------------------------
async function getImageDataUrl(el, width, height) {
    // 1. Try offscreen canvas drawing (fastest, ideal for same-origin or CORS-enabled images)
    try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.min(width, 1024);
        canvas.height = Math.min(height, 768);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/png");
        if (dataUrl && dataUrl.length > 300) return dataUrl;
    } catch (e) {
        // Canvas tainted by cross-origin resource
    }

    // 2. Fetch directly with extension permissions (with 2-second timeout to avoid any hang)
    try {
        const src = el.src || el.getAttribute("data-src") || el.currentSrc;
        if (src && (src.startsWith("http://") || src.startsWith("https://"))) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 2000);
            try {
                const resp = await fetch(src, { signal: controller.signal });
                clearTimeout(timer);
                if (resp.ok) {
                    const blob = await resp.blob();
                    if (blob && blob.size > 800) {
                        return await new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result || "");
                            reader.onerror = () => resolve("");
                            reader.readAsDataURL(blob);
                        });
                    }
                }
            } catch (netErr) {
                clearTimeout(timer);
            }
        }
    } catch (fetchErr) {}

    return "";
}

async function extractPageImages() {
    const images = [];
    const seenSrcs = new Set();

    // 1. Query standard img tags, pictures, carousels, and banners
    const candidates = Array.from(document.querySelectorAll(
        "img, [role='img'], [class*='banner' i] img, [class*='slider' i] img, [class*='carousel' i] img, [id*='banner' i] img, [class*='promo' i] img, [class*='hero' i] img"
    ));

    for (const el of candidates) {
        if (images.length >= 3) break;

        const src = el.src || el.getAttribute("data-src") || el.getAttribute("srcset") || "";
        if (!src || src.startsWith("data:image/svg") || seenSrcs.has(src)) continue;

        const rect = el.getBoundingClientRect();
        const width = el.naturalWidth || rect.width || el.width || 0;
        const height = el.naturalHeight || rect.height || el.height || 0;

        // Filter out tiny icons, bullets, and tracking pixels (only prominent banners)
        if (width < 160 || height < 70) continue;
        if (src.includes("icon") || src.includes("avatar") || src.includes("bullet") || src.includes("chevron")) continue;

        seenSrcs.add(src);

        const base64 = await getImageDataUrl(el, width, height);

        images.push({
            src: src,
            alt: el.alt || el.getAttribute("aria-label") || el.title || "",
            base64_data: base64,
            mime_type: "image/png",
            width: Math.round(width),
            height: Math.round(height)
        });
    }

    // 2. Also check elements with CSS background-image (common in hero slides & promo banners)
    if (images.length < 3) {
        const bgElements = Array.from(document.querySelectorAll(
            "[style*='background-image'], [class*='banner' i], [class*='slider' i], [class*='hero' i]"
        ));
        for (const el of bgElements) {
            if (images.length >= 3) break;
            try {
                const style = window.getComputedStyle(el);
                const bg = style.backgroundImage || "";
                if (bg && bg.startsWith("url(") && !bg.includes("data:image/svg")) {
                    const match = bg.match(/url\(['"]?(.*?)['"]?\)/);
                    if (match && match[1] && !seenSrcs.has(match[1])) {
                        const bgUrl = match[1];
                        const rect = el.getBoundingClientRect();
                        if (rect.width >= 160 && rect.height >= 80) {
                            seenSrcs.add(bgUrl);
                            let b64 = "";
                            try {
                                const controller = new AbortController();
                                const timer = setTimeout(() => controller.abort(), 2000);
                                const resp = await fetch(bgUrl, { signal: controller.signal });
                                clearTimeout(timer);
                                const blob = await resp.blob();
                                b64 = await new Promise((r) => {
                                    const reader = new FileReader();
                                    reader.onloadend = () => r(reader.result || "");
                                    reader.onerror = () => r("");
                                    reader.readAsDataURL(blob);
                                });
                            } catch (e) {}

                            images.push({
                                src: bgUrl,
                                alt: el.getAttribute("aria-label") || el.title || "Promotional Banner",
                                base64_data: b64,
                                mime_type: "image/png",
                                width: Math.round(rect.width),
                                height: Math.round(rect.height)
                            });
                        }
                    }
                }
            } catch (e) {}
        }
    }

    return images;
}

// ---------------------------------------------------------------------------
// 10.6 Interactive Screen Snipping Engine (Approach 1: Snip to Chat)
// ---------------------------------------------------------------------------
let isSnipModeActive = false;

function startSnipMode() {
    if (isSnipModeActive) return;
    isSnipModeActive = true;

    // Temporarily hide the floating widget & pill so they aren't captured
    if (ragWidgetContainer) ragWidgetContainer.style.display = "none";
    if (ragLauncherButton) ragLauncherButton.style.display = "none";

    // Create full-screen dimming overlay with subtle blur
    const overlay = document.createElement("div");
    overlay.id = "rag-snip-overlay";
    Object.assign(overlay.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "100vw",
        height: "100vh",
        zIndex: "2147483647",
        cursor: "crosshair",
        backgroundColor: "rgba(15, 23, 42, 0.45)",
        backdropFilter: "blur(2px)",
        userSelect: "none"
    });

    // Top instruction banner
    const banner = document.createElement("div");
    Object.assign(banner.style, {
        position: "fixed",
        top: "20px",
        left: "50%",
        transform: "translateX(-50%)",
        background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
        color: "#ffffff",
        padding: "10px 22px",
        borderRadius: "30px",
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.45)",
        fontSize: "13px",
        fontWeight: "600",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        pointerEvents: "none",
        zIndex: "2147483648",
        border: "1px solid rgba(255, 255, 255, 0.2)"
    });
    banner.innerHTML = `<span style="display: flex; align-items: center; gap: 6px;">✂️ Drag over any ad, image, or section to snip</span> <span style="font-size: 11px; opacity: 0.8; background: rgba(255,255,255,0.18); padding: 3px 8px; border-radius: 6px; font-weight: 500;">ESC to cancel</span>`;
    overlay.appendChild(banner);

    // Selection marquee box
    const marquee = document.createElement("div");
    marquee.id = "rag-snip-marquee";
    Object.assign(marquee.style, {
        position: "fixed",
        border: "2px dashed #38bdf8",
        background: "rgba(56, 189, 248, 0.14)",
        boxShadow: "0 0 0 99999px rgba(15, 23, 42, 0.5), 0 0 20px rgba(56, 189, 248, 0.35)",
        display: "none",
        pointerEvents: "none",
        zIndex: "2147483648"
    });

    // Dimension badge
    const dimBadge = document.createElement("div");
    Object.assign(dimBadge.style, {
        position: "absolute",
        bottom: "-24px",
        right: "0px",
        background: "#0284c7",
        color: "#ffffff",
        padding: "2px 7px",
        borderRadius: "4px",
        fontSize: "10.5px",
        fontWeight: "bold",
        fontFamily: "monospace",
        pointerEvents: "none",
        boxShadow: "0 2px 6px rgba(0,0,0,0.3)"
    });
    marquee.appendChild(dimBadge);
    overlay.appendChild(marquee);

    document.body.appendChild(overlay);

    let startX = 0;
    let startY = 0;
    let isDrawing = false;

    function cleanupSnip() {
        isSnipModeActive = false;
        overlay.remove();
        document.removeEventListener("keydown", onKeyDown);
        if (ragWidgetContainer) ragWidgetContainer.style.display = "flex";
        if (ragLauncherButton) ragLauncherButton.style.display = "flex";
    }

    function onKeyDown(e) {
        if (e.key === "Escape") {
            cleanupSnip();
            sendSnipMessageToPopup({ cancelled: true });
        }
    }
    document.addEventListener("keydown", onKeyDown);

    overlay.addEventListener("mousedown", (e) => {
        isDrawing = true;
        startX = e.clientX;
        startY = e.clientY;
        marquee.style.left = `${startX}px`;
        marquee.style.top = `${startY}px`;
        marquee.style.width = "0px";
        marquee.style.height = "0px";
        marquee.style.display = "block";
    });

    overlay.addEventListener("mousemove", (e) => {
        if (!isDrawing) return;
        const currentX = e.clientX;
        const currentY = e.clientY;

        const left = Math.min(startX, currentX);
        const top = Math.min(startY, currentY);
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);

        marquee.style.left = `${left}px`;
        marquee.style.top = `${top}px`;
        marquee.style.width = `${width}px`;
        marquee.style.height = `${height}px`;
        dimBadge.textContent = `${Math.round(width)} × ${Math.round(height)} px`;
    });

    overlay.addEventListener("mouseup", async (e) => {
        if (!isDrawing) return;
        isDrawing = false;

        const endX = e.clientX;
        const endY = e.clientY;

        const left = Math.min(startX, endX);
        const top = Math.min(startY, endY);
        const width = Math.abs(endX - startX);
        const height = Math.abs(endY - startY);

        overlay.style.display = "none"; // Hide immediately before taking screenshot

        if (width < 20 || height < 20) {
            cleanupSnip();
            sendSnipMessageToPopup({ cancelled: true });
            return;
        }

        // Allow DOM to repaint cleanly before capture
        setTimeout(() => {
            chrome.runtime.sendMessage({ action: "captureVisibleTab" }, (response) => {
                cleanupSnip();

                if (!response || !response.success || !response.dataUrl) {
                    console.error("[Snip] Screenshot capture failed:", response?.error);
                    sendSnipMessageToPopup({ success: false, error: "Failed to capture screen screenshot" });
                    return;
                }

                const img = new Image();
                img.onload = () => {
                    try {
                        const dpr = window.devicePixelRatio || 1;
                        const canvas = document.createElement("canvas");
                        canvas.width = Math.round(width * dpr);
                        canvas.height = Math.round(height * dpr);
                        const ctx = canvas.getContext("2d");

                        ctx.drawImage(
                            img,
                            Math.round(left * dpr),
                            Math.round(top * dpr),
                            Math.round(width * dpr),
                            Math.round(height * dpr),
                            0,
                            0,
                            canvas.width,
                            canvas.height
                        );

                        const croppedDataUrl = canvas.toDataURL("image/png");
                        sendSnipMessageToPopup({
                            success: true,
                            dataUrl: croppedDataUrl,
                            width: Math.round(width),
                            height: Math.round(height)
                        });
                    } catch (cropErr) {
                        console.error("[Snip] Canvas crop failed:", cropErr);
                        sendSnipMessageToPopup({ success: false, error: "Failed to crop snippet" });
                    }
                };
                img.onerror = () => {
                    sendSnipMessageToPopup({ success: false, error: "Failed to load screenshot data" });
                };
                img.src = response.dataUrl;
            });
        }, 50);
    });
}

function sendSnipMessageToPopup(payload) {
    // 1. Send via iframe postMessage (for in-page floating widget)
    const iframe = (ragWidgetContainer && ragWidgetContainer.querySelector("iframe")) || 
                   document.querySelector("#rag-floating-widget-root iframe") ||
                   document.querySelector("#rag-widget-container iframe");
    if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: "RAG_SNIP_RESULT", ...payload }, "*");
    }
    // 2. Also send via runtime message (for popup window)
    try {
        chrome.runtime.sendMessage({ action: "snipResult", ...payload }, () => {
            if (chrome.runtime.lastError) { }
        });
    } catch (e) { }
}

// ---------------------------------------------------------------------------
// 11. Extension Message Listener (Async)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 0. Interactive Snip-to-Chat Trigger (Approach 1)
    if (message.action === "startSnip") {
        startSnipMode();
        sendResponse({ success: true });
        return true;
    }

    // Toggle Floating In-Page Widget
    if (message.action === "toggleFloatingWidget") {
        toggleFloatingWidget();
        sendResponse({ success: true });
        return true;
    }

    if (message.action === "extractArticle") {
        (async () => {
            try {
                // 0. Deep Scan Pre-processing (Auto-Scroll & Expand)
                if (message.deepScan) {
                    console.log("[RAG Extractor] Deep Scan active: scrolling to trigger lazy-loaded text...");
                    await triggerDeepScrollScan();
                }

                // Harvest candidate banners for OCR if requested (Approach 2)
                const pageImages = message.enableOcr ? await extractPageImages() : [];
                if (message.enableOcr) {
                    console.log(`[RAG Extractor] Harvested ${pageImages.length} images/banners for OCR analysis.`);
                }
                // 1. Highlight / Selection Priority (works on any page, including YouTube)
                const highlighted = getHighlightedText();
                if (highlighted) {
                    const wordCount = highlighted.split(/\s+/).filter(Boolean).length;
                    sendResponse({
                        success: true,
                        text: highlighted,
                        mode: "selection",
                        title: document.title || "Selected Text",
                        wordCount: wordCount,
                        images: pageImages
                    });
                    return;
                }

                // 2. YouTube Video Handler
                if (isYouTubeWatchPage()) {
                    console.log("[RAG Extractor] YouTube Watch page detected. Fetching transcript & metadata...");
                    const ytData = await extractYouTubeContent();
                    sendResponse({
                        success: true,
                        text: ytData.text,
                        mode: "youtube",
                        title: ytData.title,
                        wordCount: ytData.wordCount,
                        images: []
                    });
                    return;
                }

                // 3. In-Browser PDF Handler
                if (isPdfPage()) {
                    console.log("[RAG Extractor] PDF document detected. Extracting PDF data...");
                    const pdfData = await extractPdfContent();
                    sendResponse({
                        success: true,
                        isPdf: true,
                        pdfBase64: pdfData.pdfBase64,
                        url: pdfData.url,
                        mode: "pdf",
                        title: pdfData.title,
                        wordCount: 0,
                        images: []
                    });
                    return;
                }

                // 4. Standard Webpage Extraction
                const { text, mode } = extractMainContent();
                const title = document.title || "Webpage";
                const cleanText = (text || "").trim();
                const wordCount = cleanText ? cleanText.split(/\s+/).filter(Boolean).length : 0;

                console.log(`[RAG Extractor] Extracted via [${mode.toUpperCase()}] mode (${wordCount} words, ${cleanText.length} chars)`);

                if (!cleanText) {
                    sendResponse({
                        success: false,
                        error: "No readable content found on this page. Try highlighting text or refreshing the tab."
                    });
                    return;
                }

                sendResponse({
                    success: true,
                    text: cleanText,
                    mode: mode,
                    title: title,
                    wordCount: wordCount,
                    images: pageImages
                });
            } catch (error) {
                console.error("[RAG Extractor] Extraction failed:", error);
                sendResponse({
                    success: false,
                    error: error.message || "Failed to extract content"
                });
            }
        })();
        return true; // Keep message channel open for async response
    }
});

// ===========================================================================
// 12. Floating, Movable, Resizable, and Minimizable In-Page Widget
// ===========================================================================

let ragWidgetContainer = null;
let ragMinimizedBubble = null;
let ragLauncherButton = null;
let ragSavedPosition = null;

function initFloatingWidget() {
    if (ragWidgetContainer || window.self !== window.top) return;

    // 1. Main Floating Container
    ragWidgetContainer = document.createElement("div");
    ragWidgetContainer.id = "rag-floating-widget-root";
    Object.assign(ragWidgetContainer.style, {
        position: "fixed",
        top: "70px",
        right: "25px",
        width: "400px",
        height: "600px",
        minWidth: "330px",
        minHeight: "420px",
        maxWidth: "96vw",
        maxHeight: "96vh",
        zIndex: "2147483647",
        background: "#0f172a",
        borderRadius: "16px",
        boxShadow: "0 24px 60px -10px rgba(15, 23, 42, 0.35), 0 0 0 1px rgba(15, 23, 42, 0.08)",
        display: "none",
        flexDirection: "column",
        overflow: "hidden",
        resize: "both",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    });

    // 2. Draggable Header
    const header = document.createElement("div");
    header.id = "rag-floating-header";
    Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
        color: "#ffffff",
        padding: "10px 14px",
        cursor: "grab",
        userSelect: "none",
        flexShrink: "0",
        borderTopLeftRadius: "16px",
        borderTopRightRadius: "16px",
        borderBottom: "1px solid rgba(255, 255, 255, 0.08)"
    });

    // Left Title & Drag Icon
    const headerLeft = document.createElement("div");
    Object.assign(headerLeft.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        fontSize: "12px",
        fontWeight: "700",
        letterSpacing: "0.2px",
        pointerEvents: "none"
    });
    headerLeft.innerHTML = `
        <span style="opacity: 0.45; font-size: 13px; letter-spacing: -2px;">⋮⋮</span>
        <span style="width: 7px; height: 7px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 8px #38bdf8; display: inline-block;"></span>
        <span style="background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Argus</span>
    `;

    // Right Action Buttons
    const headerActions = document.createElement("div");
    Object.assign(headerActions.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px"
    });

    // Minimize Button
    const minBtn = document.createElement("button");
    minBtn.textContent = "—";
    minBtn.title = "Minimize to floating bubble";
    Object.assign(minBtn.style, {
        background: "rgba(255, 255, 255, 0.08)",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        color: "#cbd5e1",
        fontSize: "12px",
        fontWeight: "bold",
        cursor: "pointer",
        width: "22px",
        height: "22px",
        borderRadius: "6px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: "1",
        transition: "all 0.15s ease"
    });
    minBtn.onmouseenter = () => {
        minBtn.style.background = "rgba(255, 255, 255, 0.22)";
        minBtn.style.color = "#ffffff";
    };
    minBtn.onmouseleave = () => {
        minBtn.style.background = "rgba(255, 255, 255, 0.08)";
        minBtn.style.color = "#cbd5e1";
    };

    // Close Button
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.title = "Close Chatbot (Alt+W to reopen)";
    Object.assign(closeBtn.style, {
        background: "rgba(255, 255, 255, 0.08)",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        color: "#cbd5e1",
        fontSize: "11px",
        fontWeight: "bold",
        cursor: "pointer",
        width: "22px",
        height: "22px",
        borderRadius: "6px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: "1",
        transition: "all 0.15s ease"
    });
    closeBtn.onmouseenter = () => {
        closeBtn.style.background = "rgba(239, 68, 68, 0.25)";
        closeBtn.style.borderColor = "rgba(239, 68, 68, 0.4)";
        closeBtn.style.color = "#f87171";
    };
    closeBtn.onmouseleave = () => {
        closeBtn.style.background = "rgba(255, 255, 255, 0.08)";
        closeBtn.style.borderColor = "rgba(255, 255, 255, 0.12)";
        closeBtn.style.color = "#cbd5e1";
    };

    headerActions.appendChild(minBtn);
    headerActions.appendChild(closeBtn);
    header.appendChild(headerLeft);
    header.appendChild(headerActions);
    ragWidgetContainer.appendChild(header);

    // 3. Iframe hosting popup.html
    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL("popup.html");
    Object.assign(iframe.style, {
        width: "100%",
        flex: "1",
        border: "none",
        background: "#f7f8fa"
    });
    ragWidgetContainer.appendChild(iframe);

    // 4. Transparent Drag Overlay (prevents iframe from intercepting mousemove while dragging)
    const dragOverlay = document.createElement("div");
    Object.assign(dragOverlay.style, {
        position: "absolute",
        top: "36px",
        left: "0",
        right: "0",
        bottom: "0",
        zIndex: "10",
        display: "none"
    });
    ragWidgetContainer.appendChild(dragOverlay);

    // 5. Drag & Drop Handlers
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let elemStartX = 0;
    let elemStartY = 0;

    header.addEventListener("mousedown", (e) => {
        if (e.target === minBtn || e.target === closeBtn) return;
        isDragging = true;
        header.style.cursor = "grabbing";
        dragOverlay.style.display = "block";

        dragStartX = e.clientX;
        dragStartY = e.clientY;

        const rect = ragWidgetContainer.getBoundingClientRect();
        elemStartX = rect.left;
        elemStartY = rect.top;

        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - dragStartX;
        const deltaY = e.clientY - dragStartY;

        let newX = elemStartX + deltaX;
        let newY = elemStartY + deltaY;

        const maxX = window.innerWidth - ragWidgetContainer.offsetWidth - 10;
        const maxY = window.innerHeight - ragWidgetContainer.offsetHeight - 10;

        newX = Math.max(10, Math.min(maxX, newX));
        newY = Math.max(10, Math.min(maxY, newY));

        ragWidgetContainer.style.left = `${newX}px`;
        ragWidgetContainer.style.top = `${newY}px`;
        ragWidgetContainer.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
        if (isDragging) {
            isDragging = false;
            header.style.cursor = "grab";
            dragOverlay.style.display = "none";
        }
    });

    // 6. Minimized Floating Bubble
    ragMinimizedBubble = document.createElement("div");
    ragMinimizedBubble.id = "rag-minimized-bubble";
    Object.assign(ragMinimizedBubble.style, {
        position: "fixed",
        bottom: "25px",
        right: "25px",
        zIndex: "2147483647",
        background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
        color: "#ffffff",
        padding: "8px 14px 8px 16px",
        borderRadius: "30px",
        fontSize: "12px",
        fontWeight: "600",
        cursor: "pointer",
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.35), 0 0 15px rgba(59, 130, 246, 0.25)",
        border: "1px solid rgba(255, 255, 255, 0.18)",
        display: "none",
        alignItems: "center",
        gap: "10px",
        userSelect: "none",
        transition: "transform 0.2s ease, box-shadow 0.2s ease"
    });
    const argusIconUrl = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL("icons/icon32.png") : "";
    ragMinimizedBubble.innerHTML = `
        <span id="rag-bubble-restore" style="display: flex; align-items: center; gap: 7px;">
            ${argusIconUrl ? `<img src="${argusIconUrl}" style="width: 14px; height: 14px; border-radius: 3px;" />` : `<span style="width: 7px; height: 7px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px #10b981;"></span>`}
            <span>Argus</span>
            <span style="font-size: 10px; color: #94a3b8; font-weight: 400;">(Click to restore)</span>
        </span>
        <span id="rag-bubble-close" title="Close / Quit Extension (Alt+W to reopen)" style="font-size: 15px; opacity: 0.65; padding: 0 4px; cursor: pointer; line-height: 1; border-left: 1px solid rgba(255,255,255,0.25); margin-left: 2px;">&times;</span>
    `;
    ragMinimizedBubble.onmouseenter = () => {
        ragMinimizedBubble.style.transform = "translateY(-2px)";
        ragMinimizedBubble.style.boxShadow = "0 12px 35px rgba(0, 0, 0, 0.4), 0 0 20px rgba(59, 130, 246, 0.4)";
    };
    ragMinimizedBubble.onmouseleave = () => {
        ragMinimizedBubble.style.transform = "translateY(0)";
        ragMinimizedBubble.style.boxShadow = "0 10px 30px rgba(0, 0, 0, 0.35), 0 0 15px rgba(59, 130, 246, 0.25)";
    };

    // Bubble Restore Click
    ragMinimizedBubble.querySelector("#rag-bubble-restore").addEventListener("click", () => {
        ragMinimizedBubble.style.display = "none";
        ragWidgetContainer.style.display = "flex";
        if (ragLauncherButton) ragLauncherButton.style.display = "flex";
        if (ragSavedPosition) {
            if (ragSavedPosition.top) ragWidgetContainer.style.top = ragSavedPosition.top;
            if (ragSavedPosition.left) ragWidgetContainer.style.left = ragSavedPosition.left;
            if (ragSavedPosition.right) ragWidgetContainer.style.right = ragSavedPosition.right;
            if (ragSavedPosition.width) ragWidgetContainer.style.width = ragSavedPosition.width;
            if (ragSavedPosition.height) ragWidgetContainer.style.height = ragSavedPosition.height;
        }
    });

    // Bubble Close / Quit Click
    const bubbleClose = ragMinimizedBubble.querySelector("#rag-bubble-close");
    bubbleClose.onmouseenter = () => bubbleClose.style.opacity = "1";
    bubbleClose.onmouseleave = () => bubbleClose.style.opacity = "0.6";
    bubbleClose.addEventListener("click", (e) => {
        e.stopPropagation();
        ragMinimizedBubble.style.display = "none";
        if (ragWidgetContainer) ragWidgetContainer.style.display = "none";
        if (ragLauncherButton) ragLauncherButton.style.display = "none";
    });

    // Minimize Click (Minimizes to floating bubble)
    minBtn.addEventListener("click", () => {
        ragSavedPosition = {
            top: ragWidgetContainer.style.top,
            left: ragWidgetContainer.style.left,
            right: ragWidgetContainer.style.right,
            width: ragWidgetContainer.style.width,
            height: ragWidgetContainer.style.height
        };
        ragWidgetContainer.style.display = "none";
        ragMinimizedBubble.style.display = "flex";
    });

    // Close Click (COMPLETELY QUITS AND HIDES ALL EXTENSION UI FROM PAGE)
    closeBtn.addEventListener("click", () => {
        ragWidgetContainer.style.display = "none";
        if (ragMinimizedBubble) ragMinimizedBubble.style.display = "none";
        if (ragLauncherButton) ragLauncherButton.style.display = "none";
    });

    // 7. Discreet Edge Launcher Pill (1-click toggle on any website)
    ragLauncherButton = document.createElement("div");
    ragLauncherButton.id = "rag-launcher-pill";
    ragLauncherButton.title = "Toggle Argus (Alt+W)";
    Object.assign(ragLauncherButton.style, {
        position: "fixed",
        right: "0px",
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: "2147483646",
        background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
        color: "#ffffff",
        borderTopLeftRadius: "22px",
        borderBottomLeftRadius: "22px",
        padding: "8px 8px 8px 12px",
        cursor: "pointer",
        boxShadow: "-3px 4px 18px rgba(99, 102, 241, 0.4), 0 2px 8px rgba(0, 0, 0, 0.25)",
        border: "1px solid rgba(255, 255, 255, 0.25)",
        borderRight: "none",
        fontSize: "12px",
        fontWeight: "700",
        display: "flex",
        alignItems: "center",
        gap: "7px",
        userSelect: "none",
        transition: "transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.18s"
    });
    const argusLauncherIconUrl = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL("icons/icon32.png") : "";
    ragLauncherButton.innerHTML = `
        <span id="rag-pill-open" style="display: flex; align-items: center; gap: 6px;">
            ${argusLauncherIconUrl ? `<img src="${argusLauncherIconUrl}" style="width: 14px; height: 14px; border-radius: 4px;" />` : `<span style="font-size: 12px;">✦</span>`}
            <span style="font-size: 11.5px; letter-spacing: 0.3px;">Argus</span>
        </span>
        <span id="rag-pill-dismiss" title="Quit / Close extension on this page (Alt+W to reopen)" style="font-size: 16px; opacity: 0.65; padding: 0 4px; cursor: pointer; line-height: 1; border-left: 1px solid rgba(255,255,255,0.3); margin-left: 3px;">&times;</span>
    `;

    ragLauncherButton.onmouseenter = () => {
        ragLauncherButton.style.transform = "translateY(-50%) translateX(-4px)";
        ragLauncherButton.style.boxShadow = "-5px 6px 22px rgba(99, 102, 241, 0.6), 0 4px 12px rgba(0, 0, 0, 0.3)";
    };
    ragLauncherButton.onmouseleave = () => {
        ragLauncherButton.style.transform = "translateY(-50%) translateX(0)";
        ragLauncherButton.style.boxShadow = "-3px 4px 18px rgba(99, 102, 241, 0.4), 0 2px 8px rgba(0, 0, 0, 0.25)";
    };

    ragLauncherButton.querySelector("#rag-pill-open").addEventListener("click", () => {
        toggleFloatingWidget();
    });

    const pillDismiss = ragLauncherButton.querySelector("#rag-pill-dismiss");
    pillDismiss.onmouseenter = () => pillDismiss.style.opacity = "1";
    pillDismiss.onmouseleave = () => pillDismiss.style.opacity = "0.65";
    pillDismiss.addEventListener("click", (e) => {
        e.stopPropagation();
        ragLauncherButton.style.display = "none";
        if (ragWidgetContainer) ragWidgetContainer.style.display = "none";
        if (ragMinimizedBubble) ragMinimizedBubble.style.display = "none";
    });

    document.body.appendChild(ragWidgetContainer);
    document.body.appendChild(ragMinimizedBubble);
    document.body.appendChild(ragLauncherButton);
}

function toggleFloatingWidget() {
    initFloatingWidget();
    if (!ragWidgetContainer) return;

    // If minimized bubble is visible, restore to widget
    if (ragMinimizedBubble && ragMinimizedBubble.style.display === "flex") {
        ragMinimizedBubble.style.display = "none";
        ragWidgetContainer.style.display = "flex";
        if (ragLauncherButton) ragLauncherButton.style.display = "flex";
        return;
    }

    // Toggle widget visibility
    if (ragWidgetContainer.style.display === "none" || !ragWidgetContainer.style.display) {
        ragWidgetContainer.style.display = "flex";
        if (ragMinimizedBubble) ragMinimizedBubble.style.display = "none";
        if (ragLauncherButton) ragLauncherButton.style.display = "flex";
    } else {
        ragWidgetContainer.style.display = "none";
        if (ragMinimizedBubble) ragMinimizedBubble.style.display = "none";
        if (ragLauncherButton) ragLauncherButton.style.display = "none";
    }
}

// Automatically mount launcher when DOM is ready in top-level window
if (window.self === window.top) {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initFloatingWidget);
    } else {
        initFloatingWidget();
    }
}
