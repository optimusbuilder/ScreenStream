const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const speechToggle = document.getElementById('speechToggle');
const elementPreview = document.getElementById('elementPreview');

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
  elementPreview.classList.toggle('visible', active);
}

startBtn.addEventListener('click', () => {
  startBtn.disabled = true;
  setStatus('connecting', 'Connecting (capturing tab)...');

  chrome.runtime.sendMessage({ type: 'START_SESSION' }, (response) => {
    startBtn.disabled = false;

    if (response?.success) {
      setStatus('active', 'Streaming');
      setSessionUI(true);
    } else {
      setStatus('error', response?.error || 'Failed to start');
      setTimeout(() => setStatus('idle', 'Idle'), 3000);
    }
  });
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
    setStatus('error', msg.error);
    setSessionUI(false);
  }
});

chrome.runtime.sendMessage({ type: 'SESSION_STATUS' }, (response) => {
  if (response?.active) {
    setStatus('active', 'Streaming');
    setSessionUI(true);
  }
});
