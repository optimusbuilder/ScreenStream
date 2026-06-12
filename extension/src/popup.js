const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const speechToggle = document.getElementById('speechToggle');
const elementPreview = document.getElementById('elementPreview');
const captureHint = document.getElementById('captureHint');

let sessionActive = false;

chrome.storage.local.get(['speechEnabled'], (data) => {
  speechToggle.checked = data.speechEnabled !== false;
});

speechToggle.addEventListener('change', () => {
  chrome.storage.local.set({ speechEnabled: speechToggle.checked });
});

function setStatus(state, text) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = text;
}

function setSessionUI(active) {
  sessionActive = active;
  startBtn.style.display = active ? 'none' : 'block';
  stopBtn.style.display = active ? 'block' : 'none';
  captureHint.style.display = active ? 'none' : 'block';
  elementPreview.classList.toggle('visible', active);
}

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (msg.includes('Permission dismissed') || msg.includes('NotAllowedError')) {
    return 'Tab capture failed. Click the page you want to navigate, then open this popup and click Start again immediately.';
  }
  if (msg.includes('Cannot capture')) {
    return 'Cannot capture this page. Try a normal website like google.com.';
  }
  return msg;
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  setStatus('connecting', 'Starting capture...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('No active tab found');
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      throw new Error('Open a regular website first (not a Chrome internal page)');
    }

    chrome.runtime.sendMessage({
      type: 'START_SESSION',
      tabId: tab.id,
    }, (response) => {
      startBtn.disabled = false;

      if (chrome.runtime.lastError) {
        setStatus('error', chrome.runtime.lastError.message);
        setTimeout(() => setStatus('idle', 'Idle'), 4000);
        return;
      }

      if (response?.success) {
        setStatus('active', 'Streaming');
        setSessionUI(true);
      } else {
        setStatus('error', friendlyError({ message: response?.error }) || 'Failed to start');
        setTimeout(() => setStatus('idle', 'Idle'), 5000);
      }
    });
  } catch (err) {
    startBtn.disabled = false;
    setStatus('error', friendlyError(err));
    setTimeout(() => setStatus('idle', 'Idle'), 5000);
  }
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SESSION' }, () => {
    setStatus('idle', 'Idle');
    setSessionUI(false);
    elementPreview.textContent = '';
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'INFERENCE_RESULT' && sessionActive) {
    elementPreview.textContent = `${msg.data.element_under_cursor} ${msg.data.interactive ? '(interactive)' : ''} — ${msg.data.nearest_actionable_direction} ${msg.data.distance_pixels}px`;
  }

  if (msg.type === 'SESSION_ERROR') {
    setStatus('error', friendlyError({ message: msg.error }));
    setSessionUI(false);
  }
});

chrome.runtime.sendMessage({ type: 'SESSION_STATUS' }, (response) => {
  if (response?.active) {
    setStatus('active', 'Streaming');
    setSessionUI(true);
  }
});
