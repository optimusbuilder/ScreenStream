const stopBtn = document.getElementById('stopBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const speechToggle = document.getElementById('speechToggle');
const elementPreview = document.getElementById('elementPreview');

chrome.storage.local.get(['speechEnabled'], (data) => {
  speechToggle.checked = data.speechEnabled !== false;
});

speechToggle.addEventListener('change', () => {
  chrome.storage.local.set({ speechEnabled: speechToggle.checked });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SESSION' }, () => {
    window.close();
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'INFERENCE_RESULT') {
    elementPreview.textContent = `${msg.data.element_under_cursor} ${msg.data.interactive ? '(interactive)' : ''} — ${msg.data.nearest_actionable_direction} ${msg.data.distance_pixels}px`;
  }

  if (msg.type === 'SESSION_ERROR') {
    statusDot.className = 'status-dot error';
    statusText.textContent = msg.error || 'Error';
  }
});

chrome.runtime.sendMessage({ type: 'SESSION_STATUS' }, (response) => {
  if (!response?.active) {
    statusDot.className = 'status-dot idle';
    statusText.textContent = 'Not running';
    elementPreview.textContent = 'Click the extension icon on a website tab to start.';
  }
});
