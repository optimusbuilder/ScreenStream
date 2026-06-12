(function () {
  if (window.__screenStreamAccessLoaded) return;
  window.__screenStreamAccessLoaded = true;

  // --------------- Mouse Tracking ---------------

  let lastSendTime = 0;
  const THROTTLE_MS = 100;
  let mouseIdleTimer = null;
  let mouseStopped = false;
  const IDLE_THRESHOLD_MS = 500;

  window.addEventListener('mousemove', (e) => {
    mouseStopped = false;
    clearTimeout(mouseIdleTimer);

    const now = Date.now();
    if (now - lastSendTime >= THROTTLE_MS) {
      lastSendTime = now;
      chrome.runtime.sendMessage({
        type: 'MOUSE_MOVE',
        x: e.clientX,
        y: e.clientY,
      }).catch(() => {});
    }

    mouseIdleTimer = setTimeout(() => {
      mouseStopped = true;
      maybeAnnounce();
    }, IDLE_THRESHOLD_MS);
  });

  // --------------- Spatial Audio Engine ---------------

  let audioCtx = null;
  let panner = null;
  let oscillator = null;
  let gainNode = null;
  let tickInterval = null;
  let audioUnlocked = false;

  function initAudio() {
    if (audioCtx) return;

    audioCtx = new AudioContext();
    audioCtx.suspend();

    panner = audioCtx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'linear';
    panner.maxDistance = 1000;
    panner.refDistance = 1;
    panner.connect(audioCtx.destination);

    gainNode = audioCtx.createGain();
    gainNode.gain.value = 0;
    gainNode.connect(panner);

    oscillator = audioCtx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 660;
    oscillator.connect(gainNode);
    oscillator.start();
  }

  function unlockAudio() {
    if (audioUnlocked) return;
    initAudio();
    audioCtx.resume().catch(() => {});
    audioUnlocked = true;
  }

  chrome.storage.local.get(['sessionActive'], (data) => {
    if (data.sessionActive) {
      unlockAudio();
    }
  });

  function stopAudio() {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    if (audioCtx && audioCtx.state === 'running') {
      audioCtx.suspend();
    }
    audioUnlocked = false;
  }

  function updateBeacon(result) {
    if (!audioUnlocked || !audioCtx || audioCtx.state !== 'running') return;

    const dir = result.nearest_actionable_direction;
    const dist = result.distance_pixels;
    const interactive = result.interactive;

    let panX = 0, panZ = 0;
    switch (dir) {
      case 'E': panX = 1; break;
      case 'W': panX = -1; break;
      case 'N': panZ = -1; break;
      case 'S': panZ = 1; break;
      case 'ON_OBJECT': panX = 0; panZ = 0; break;
    }
    panner.positionX.setTargetAtTime(panX * 5, audioCtx.currentTime, 0.05);
    panner.positionZ.setTargetAtTime(panZ * 5, audioCtx.currentTime, 0.05);

    const baseFreq = interactive ? 880 : 440;
    oscillator.frequency.setTargetAtTime(baseFreq, audioCtx.currentTime, 0.05);

    const clampedDist = Math.max(1, Math.min(dist, 500));
    const tickRate = dir === 'ON_OBJECT'
      ? 80
      : Math.max(100, Math.min(800, clampedDist * 1.6));

    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(() => {
      const now = audioCtx.currentTime;
      gainNode.gain.setTargetAtTime(0.3, now, 0.01);
      gainNode.gain.setTargetAtTime(0, now + 0.04, 0.02);
    }, tickRate);
  }

  // --------------- Speech Announcer ---------------

  let lastSpokenElement = '';
  let lastSpeechTime = 0;
  const MIN_SPEECH_INTERVAL_MS = 1500;
  let speechEnabled = true;
  let latestResult = null;

  chrome.storage.local.get(['speechEnabled'], (data) => {
    speechEnabled = data.speechEnabled !== false;
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.speechEnabled) {
      speechEnabled = changes.speechEnabled.newValue;
    }
  });

  function maybeAnnounce() {
    if (!speechEnabled || !mouseStopped || !latestResult) return;

    const now = Date.now();
    if (now - lastSpeechTime < MIN_SPEECH_INTERVAL_MS) return;

    const element = latestResult.element_under_cursor;
    if (element === lastSpokenElement) return;

    lastSpokenElement = element;
    lastSpeechTime = now;

    window.speechSynthesis.cancel();

    let text = element;
    if (latestResult.interactive) {
      text += ', interactive';
    }
    if (latestResult.nearest_actionable_direction !== 'ON_OBJECT' && latestResult.distance_pixels > 0) {
      const dirLabel = {
        N: 'above',
        S: 'below',
        E: 'to the right',
        W: 'to the left',
      }[latestResult.nearest_actionable_direction] || '';
      text += `. Nearest control ${dirLabel}, ${Math.round(latestResult.distance_pixels)} pixels`;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.1;
    utterance.volume = 0.9;
    window.speechSynthesis.speak(utterance);
  }

  // --------------- Message Handling ---------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'INFERENCE_RESULT') {
      latestResult = msg.data;
      unlockAudio();
      updateBeacon(msg.data);
      if (mouseStopped) {
        maybeAnnounce();
      }
    }

    if (msg.type === 'SESSION_STARTED' || msg.type === 'START_SESSION') {
      unlockAudio();
    }

    if (msg.type === 'SESSION_STOPPED') {
      stopAudio();
      window.speechSynthesis.cancel();
      latestResult = null;
      lastSpokenElement = '';
    }
  });
})();
