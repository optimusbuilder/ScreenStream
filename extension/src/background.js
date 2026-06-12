const SERVER_URL = 'http://localhost:3000';

let session = null;
let keepaliveTimer = null;
let inferenceRunning = false;
let inferenceAbort = null;
let latestMouse = { x: 0, y: 0 };
let contentTabId = null;
let offscreenReadyResolver = null;
let mediaAcquiredResolver = null;
let offscreenPongResolver = null;
let captureReadyResolver = null;

// Chrome requires tabCapture from a direct icon click — popup buttons break the gesture chain.
chrome.action.onClicked.addListener(async (tab) => {
  if (session) return;

  try {
    await chrome.action.setBadgeText({ text: '…' });
    await startSessionFromTab(tab);
    await chrome.action.setPopup({ popup: 'popup.html' });
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#4cd964' });
  } catch (err) {
    console.error('[bg] Icon click start failed:', err);
    chrome.action.setBadgeText({ text: '!' });
    broadcastError(err.message);
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  closeOffscreenDocument().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  closeOffscreenDocument().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
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

    case 'PONG':
      if (offscreenPongResolver) {
        offscreenPongResolver();
        offscreenPongResolver = null;
      }
      return false;

    case 'MEDIA_ACQUIRED':
      if (mediaAcquiredResolver) {
        mediaAcquiredResolver();
        mediaAcquiredResolver = null;
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

    case 'NAVIGATE_QUERY':
      handleNavigateQuery(msg.query, msg.width, msg.height)
        .then((result) => sendResponse({ success: true, data: result }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'VLM_INFERENCE':
      handleVlmInference(msg.x, msg.y)
        .then((result) => sendResponse({ success: true, data: result }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
  }
});

async function startSessionFromTab(tab) {
  if (session) return;

  if (!tab?.id) throw new Error('No active tab found');
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    throw new Error('Open a regular website (e.g. google.com), then click the extension icon.');
  }

  contentTabId = tab.id;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: contentTabId },
      files: ['src/content.js'],
    });
  } catch {
    // Content script may already be injected via manifest.
  }

  // Official Chrome order: offscreen ready → getMediaStreamId → offscreen getUserMedia
  await ensureOffscreenReady();

  const mediaStreamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  await acquireTabMedia(mediaStreamId);

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
  await publishToLivekit(session.livekitUrl, session.livekitToken);
  await waitForVideoFrames();
  await notifyContentSessionStarted();

  // Fire initial page description for blind user orientation
  requestPageDescription();
}

function waitForOffscreenReady(timeoutMs = 15000) {
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

function waitForMediaAcquired(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mediaAcquiredResolver = null;
      reject(new Error('Tab capture timed out — click the extension icon on a website tab, not the popup Start button.'));
    }, timeoutMs);

    mediaAcquiredResolver = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function waitForCaptureReady(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      captureReadyResolver = null;
      reject(new Error('LiveKit publish timed out'));
    }, timeoutMs);

    captureReadyResolver = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function closeOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (contexts.length > 0) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    // Document may already be closed.
  }
}

function waitForPong(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      offscreenPongResolver = null;
      reject(new Error('PONG timeout'));
    }, timeoutMs);

    offscreenPongResolver = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function ensureOffscreenReady() {
  await closeOffscreenDocument();

  const htmlReady = waitForOffscreenReady();

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Tab capture and LiveKit WebRTC publishing',
  });

  await htmlReady;

  const scriptReady = waitForPong();
  chrome.runtime.sendMessage({ type: 'PING', target: 'offscreen' }).catch(() => {});
  try {
    await scriptReady;
  } catch {
    throw new Error('Offscreen script failed to load — run "npm run build" in extension/');
  }
}

async function acquireTabMedia(mediaStreamId) {
  const mediaAcquired = waitForMediaAcquired();

  chrome.runtime.sendMessage({
    type: 'start-recording',
    target: 'offscreen',
    data: mediaStreamId,
  });

  await mediaAcquired;
}

async function publishToLivekit(livekitUrl, livekitToken) {
  const captureReady = waitForCaptureReady();

  chrome.runtime.sendMessage({
    type: 'PUBLISH_TO_LIVEKIT',
    target: 'offscreen',
    livekitUrl,
    livekitToken,
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

// Fire a one-shot page description for initial blind user orientation
async function requestPageDescription() {
  if (!session) return;

  try {
    const res = await fetch(`${SERVER_URL}/api/inference/describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamId: session.streamId }),
    });

    if (!res.ok) {
      console.warn('[bg] Page description failed:', res.status);
      return;
    }

    const data = await res.json();

    if (contentTabId && data.description) {
      chrome.tabs.sendMessage(contentTabId, {
        type: 'PAGE_DESCRIPTION',
        description: data.description,
      }).catch(() => {});
    }

    // Also relay to popup
    chrome.runtime.sendMessage({
      type: 'PAGE_DESCRIPTION',
      description: data.description,
    }).catch(() => {});
  } catch (err) {
    console.warn('[bg] Page description error:', err.message);
  }
}

async function handleNavigateQuery(query, width, height) {
  if (!session) throw new Error('No active session');

  const res = await fetch(`${SERVER_URL}/api/inference/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      streamId: session.streamId,
      query,
      width,
      height,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Server returned status ${res.status}`);
  }

  return res.json();
}

async function handleVlmInference(x, y) {
  if (!session) throw new Error('No active session');

  const res = await fetch(`${SERVER_URL}/api/inference`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      streamId: session.streamId,
      mouseX: x,
      mouseY: y,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Inference server error ${res.status}`);
  }

  return res.json();
}

function startKeepalive() {
  // Overshoot docs: streams expire 5 min after last keepalive. Call every 60s for safety margin.
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
  }, 60_000);
}

// Sequential inference loop — waits for previous request to complete before starting next.
// No stampede of concurrent requests on slow responses.
function startInferenceLoop() {
  if (inferenceRunning) return;
  inferenceRunning = true;
  inferenceAbort = new AbortController();

  const NORMAL_DELAY = 750;
  const MAX_BACKOFF = 8000;
  let consecutiveFailures = 0;

  (async () => {
    while (inferenceRunning && session && !inferenceAbort.signal.aborted) {
      const delay = consecutiveFailures > 0
        ? Math.min(NORMAL_DELAY * Math.pow(2, consecutiveFailures), MAX_BACKOFF)
        : NORMAL_DELAY;

      await new Promise((r) => setTimeout(r, delay));

      if (!session || !inferenceRunning) break;

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
          if (res.status === 409) {
            // Already in-flight — this is fine, just wait
            continue;
          }
          consecutiveFailures++;
          if (consecutiveFailures <= 3) {
            console.warn(`[bg] Inference failed (${res.status}): ${body.error || 'unknown'} — backoff ${consecutiveFailures}`);
          }
          continue;
        }

        consecutiveFailures = 0;
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
        consecutiveFailures++;
        if (consecutiveFailures <= 3) {
          console.error('[bg] Inference error:', err.message);
        }
      }
    }
  })();
}

function stopInferenceLoop() {
  inferenceRunning = false;
  if (inferenceAbort) {
    inferenceAbort.abort();
    inferenceAbort = null;
  }
}

async function handleStopSession() {
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
  stopInferenceLoop();
  offscreenReadyResolver = null;
  mediaAcquiredResolver = null;
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

  chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', target: 'offscreen' }).catch(() => {});

  await closeOffscreenDocument();

  if (contentTabId) {
    chrome.tabs.sendMessage(contentTabId, { type: 'SESSION_STOPPED' }).catch(() => {});
    contentTabId = null;
  }

  await chrome.action.setPopup({ popup: '' });
  chrome.action.setBadgeText({ text: '' });
}

function broadcastError(error) {
  chrome.runtime.sendMessage({
    type: 'SESSION_ERROR',
    error,
  }).catch(() => {});
}
