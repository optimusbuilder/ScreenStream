const SERVER_URL = 'http://localhost:3000';

let session = null;
let keepaliveTimer = null;
let inferenceTimer = null;
let latestMouse = { x: 0, y: 0 };
let contentTabId = null;
let offscreenReadyResolver = null;
let captureReadyResolver = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'START_SESSION':
      handleStartSession(sendResponse);
      return true;

    case 'STOP_SESSION':
      handleStopSession().then(() => sendResponse({ success: true }));
      return true;

    case 'SESSION_STATUS':
      sendResponse({ active: !!session, streamId: session?.streamId });
      return false;

    case 'MOUSE_MOVE':
      latestMouse = { x: msg.x, y: msg.y };
      return false;

    case 'OFFSCREEN_READY':
      if (offscreenReadyResolver) {
        offscreenReadyResolver();
        offscreenReadyResolver = null;
      }
      return false;

    case 'CAPTURE_READY':
      console.log('[bg] Capture is publishing to LiveKit');
      if (captureReadyResolver) {
        captureReadyResolver();
        captureReadyResolver = null;
      }
      return false;

    case 'CAPTURE_ERROR':
      console.error('[bg] Capture error:', msg.error);
      broadcastError(msg.error);
      handleStopSession();
      return false;
  }
});

async function handleStartSession(sendResponse) {
  if (session) {
    sendResponse({ success: true });
    return;
  }

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) throw new Error('No active tab found');
    if (!activeTab.url || activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://')) {
      throw new Error('Open a regular website first (not a Chrome internal page)');
    }

    contentTabId = activeTab.id;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: contentTabId },
        files: ['src/content.js'],
      });
    } catch {
      // Content script may already be injected via manifest.
    }

    const res = await fetch(`${SERVER_URL}/api/session/init`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Server returned ${res.status}`);
    }

    const data = await res.json();
    session = {
      streamId: data.streamId,
      livekitUrl: data.livekitUrl,
      livekitToken: data.livekitToken,
      expiresAt: data.expiresAt,
    };

    startKeepalive();
    await createOffscreenAndCapture(activeTab);
    await waitForVideoFrames();
    await notifyContentSessionStarted();
    startInferenceLoop();

    sendResponse({ success: true });
  } catch (err) {
    console.error('[bg] Start session failed:', err);
    sendResponse({ success: false, error: err.message });
    await handleStopSession();
  }
}

function waitForOffscreenReady(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      offscreenReadyResolver = null;
      reject(new Error('Offscreen document failed to load'));
    }, timeoutMs);

    offscreenReadyResolver = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function waitForCaptureReady(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      captureReadyResolver = null;
      reject(new Error('Tab capture timed out'));
    }, timeoutMs);

    captureReadyResolver = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function createOffscreenAndCapture(tab) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  const offscreenReady = waitForOffscreenReady();

  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Tab capture and LiveKit WebRTC publishing',
    });
  } else {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});
  }

  await offscreenReady;

  const captureReady = waitForCaptureReady();

  const mediaStreamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  chrome.runtime.sendMessage({
    type: 'START_CAPTURE',
    mediaStreamId,
    livekitUrl: session.livekitUrl,
    livekitToken: session.livekitToken,
  });

  await captureReady;
}

async function waitForVideoFrames() {
  const res = await fetch(`${SERVER_URL}/api/session/${session.streamId}/wait-for-frames`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Video frames never arrived from tab capture');
  }
}

async function notifyContentSessionStarted() {
  if (!contentTabId) return;

  await chrome.tabs.sendMessage(contentTabId, { type: 'SESSION_STARTED' }).catch(() => {});
  await chrome.storage.local.set({ sessionActive: true });
}

function startKeepalive() {
  keepaliveTimer = setInterval(async () => {
    if (!session) return;

    try {
      const res = await fetch(`${SERVER_URL}/api/session/keepalive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId: session.streamId }),
      });

      if (!res.ok) throw new Error('Keepalive failed');

      const data = await res.json();
      if (data.publish?.token) {
        session.livekitToken = data.publish.token;
      }
    } catch (err) {
      console.error('[bg] Keepalive error:', err);
    }
  }, 90_000);
}

function startInferenceLoop() {
  if (inferenceTimer) return;

  inferenceTimer = setInterval(async () => {
    if (!session) return;

    try {
      const res = await fetch(`${SERVER_URL}/api/inference`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          streamId: session.streamId,
          mouseX: latestMouse.x,
          mouseY: latestMouse.y,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status !== 409) {
          console.warn('[bg] Inference failed:', body.error || res.status);
        }
        return;
      }

      const result = await res.json();

      if (contentTabId) {
        chrome.tabs.sendMessage(contentTabId, {
          type: 'INFERENCE_RESULT',
          data: result,
        }).catch(() => {});
      }

      chrome.runtime.sendMessage({
        type: 'INFERENCE_RESULT',
        data: result,
      }).catch(() => {});
    } catch (err) {
      console.error('[bg] Inference error:', err.message);
    }
  }, 750);
}

async function handleStopSession() {
  clearInterval(keepaliveTimer);
  clearInterval(inferenceTimer);
  keepaliveTimer = null;
  inferenceTimer = null;
  offscreenReadyResolver = null;
  captureReadyResolver = null;

  if (session) {
    try {
      await fetch(`${SERVER_URL}/api/session/${session.streamId}`, {
        method: 'DELETE',
      });
    } catch (err) {
      console.error('[bg] Delete stream error:', err);
    }
  }

  session = null;
  await chrome.storage.local.set({ sessionActive: false });

  chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }).catch(() => {});

  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (contexts.length > 0) {
      await chrome.offscreen.closeDocument();
    }
  } catch (err) {
    console.error('[bg] Close offscreen error:', err);
  }

  if (contentTabId) {
    chrome.tabs.sendMessage(contentTabId, { type: 'SESSION_STOPPED' }).catch(() => {});
    contentTabId = null;
  }
}

function broadcastError(error) {
  chrome.runtime.sendMessage({
    type: 'SESSION_ERROR',
    error,
  }).catch(() => {});
}
