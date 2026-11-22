/**
 * Background Service Worker for Argus
 * Handles toolbar clicks and keyboard shortcuts to toggle the floating in-page widget.
 */

async function toggleWidgetOnTab(tabId) {
    if (!tabId) return;

    try {
        await chrome.tabs.sendMessage(tabId, { action: "toggleFloatingWidget" });
    } catch (error) {
        // Tab may have been loaded before extension installed/reloaded. Inject content script dynamically.
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ["content.js"]
            });
            // Small pause for initialization, then send toggle
            setTimeout(async () => {
                try {
                    await chrome.tabs.sendMessage(tabId, { action: "toggleFloatingWidget" });
                } catch (e) {
                    console.warn("[Background] Failed to send toggle message after injection:", e);
                }
            }, 100);
        } catch (injectionError) {
            console.warn("[Background] Cannot inject script on this URL (restricted browser page):", injectionError);
        }
    }
}

// 1. Toolbar icon click
chrome.action.onClicked.addListener((tab) => {
    if (tab && tab.id) {
        toggleWidgetOnTab(tab.id);
    }
});

// 2. Keyboard shortcut (Alt + W)
chrome.commands.onCommand.addListener((command) => {
    if (command === "toggle-chatbot") {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs[0] && tabs[0].id) {
                toggleWidgetOnTab(tabs[0].id);
            }
        });
    }
});

// 3. Screen capture listener for Snip-to-Chat (Approach 1)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "captureVisibleTab") {
        const targetWindowId = sender.tab ? sender.tab.windowId : undefined;
        chrome.tabs.captureVisibleTab(targetWindowId, { format: "png" }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) {
                const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : "Failed to capture tab";
                console.warn("[Background] captureVisibleTab error:", err);
                sendResponse({ success: false, error: err });
            } else {
                sendResponse({ success: true, dataUrl: dataUrl });
            }
        });
        return true; // Keep response channel open for async callback
    }
});
