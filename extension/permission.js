const btn = document.getElementById('allow-btn');

async function requestPermission() {
  try {
    console.log('[permission] Requesting microphone access...');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Stop tracks immediately to turn off the recording indicator
    stream.getTracks().forEach(t => t.stop());
    
    console.log('[permission] Microphone permission granted!');
    chrome.runtime.sendMessage({ type: 'PERMISSION_GRANTED' });
    
    // Auto-close tab
    window.close();
  } catch (err) {
    console.warn('[permission] Permission prompt error or denied:', err);
  }
}

// Proactively prompt user immediately when tab opens
requestPermission();

btn.addEventListener('click', requestPermission);
