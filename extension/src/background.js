const SERVER_URL = 'http://localhost:3000';

let session = null;
let keepaliveTimer = null;
let inferenceTimer = null;
let latestMouse = { x: 0, y: 0 };
let contentTabId = null;

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

    case 'CAPTURE_READY':
      console.log('[bg] Capture is publishing to LiveKit');
      startInferenceLoop();
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
    if (!activeTab) throw new Error('No active tab found');

    contentTabId = activeTab.id;

    await chrome.scripting.executeScript({
      target: { tabId: contentTabId },
      files: ['src/content.js'],
    });

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

    sendResponse({ success: true });
  } catch (err) {
    console.error('[bg] Start session failed:', err);
    sendResponse({ success: false, error: err.message });
    await handleStopSession();
  }
}

async function createOffscreenAndCapture(tab) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Tab capture and LiveKit WebRTC publishing',
    });
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  chrome.runtime.sendMessage({
    type: 'START_CAPTURE',
    mediaStreamId: streamId,
    livekitUrl: session.livekitUrl,
    livekitToken: session.livekitToken,
  });
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

      if (!res.ok) return;

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
  }, 100);
}

async function handleStopSession() {
  clearInterval(keepaliveTimer);
  clearInterval(inferenceTimer);
  keepaliveTimer = null;
  inferenceTimer = null;

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
