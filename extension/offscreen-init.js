// Signals that the offscreen HTML document has loaded.
// Must be a separate file — Manifest V3 blocks inline scripts via CSP.
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});
