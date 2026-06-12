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

  // Confirmation tone nodes (for ON_OBJECT)
  let confirmOsc = null;
  let confirmGain = null;

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

    // Confirmation tone for ON_OBJECT hits
    confirmGain = audioCtx.createGain();
    confirmGain.gain.value = 0;
    confirmGain.connect(audioCtx.destination);

    confirmOsc = audioCtx.createOscillator();
    confirmOsc.type = 'triangle';
    confirmOsc.frequency.value = 1000;
    confirmOsc.connect(confirmGain);
    confirmOsc.start();
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

  let lastBeaconElement = '';

  function updateBeacon(result) {
    if (!audioUnlocked || !audioCtx || audioCtx.state !== 'running') return;

    const dir = result.nearest_actionable_direction;
    const dist = result.distance_pixels;
    const interactive = result.interactive;
    const element = result.element_under_cursor;

    // --- ON_OBJECT: play a clear confirmation tone ---
    if (dir === 'ON_OBJECT') {
      panner.positionX.setTargetAtTime(0, audioCtx.currentTime, 0.02);
      panner.positionZ.setTargetAtTime(0, audioCtx.currentTime, 0.02);

      // Play a short confirmation "ding" only when entering a new element
      if (element !== lastBeaconElement) {
        const now = audioCtx.currentTime;
        confirmOsc.frequency.setValueAtTime(interactive ? 1200 : 800, now);
        confirmGain.gain.setValueAtTime(0, now);
        confirmGain.gain.linearRampToValueAtTime(0.5, now + 0.02);
        confirmGain.gain.linearRampToValueAtTime(0, now + 0.15);

        // Interactive elements get a second, higher "ding"
        if (interactive) {
          confirmOsc.frequency.setValueAtTime(1500, now + 0.12);
          confirmGain.gain.linearRampToValueAtTime(0.4, now + 0.14);
          confirmGain.gain.linearRampToValueAtTime(0, now + 0.25);
        }
      }

      // Gentle steady pulse while on object
      if (tickInterval) clearInterval(tickInterval);
      tickInterval = setInterval(() => {
        const now = audioCtx.currentTime;
        oscillator.frequency.setValueAtTime(interactive ? 880 : 660, now);
        gainNode.gain.setTargetAtTime(0.15, now, 0.01);
        gainNode.gain.setTargetAtTime(0, now + 0.03, 0.02);
      }, 400);

      lastBeaconElement = element;
      return;
    }

    // --- Directional beacon: pan towards nearest interactive ---
    let panX = 0, panZ = 0;
    switch (dir) {
      case 'E': panX = 1; break;
      case 'W': panX = -1; break;
      case 'N': panZ = -1; break;
      case 'S': panZ = 1; break;
    }
    panner.positionX.setTargetAtTime(panX * 8, audioCtx.currentTime, 0.03);
    panner.positionZ.setTargetAtTime(panZ * 8, audioCtx.currentTime, 0.03);

    // Higher pitch for interactive, lower for non-interactive
    const baseFreq = interactive ? 880 : 440;
    oscillator.frequency.setTargetAtTime(baseFreq, audioCtx.currentTime, 0.05);

    // Tick rate scales with distance — closer = faster ticks
    const clampedDist = Math.max(1, Math.min(dist, 500));
    const tickRate = Math.max(100, Math.min(800, clampedDist * 1.6));

    // Louder when closer
    const tickGain = Math.max(0.15, 0.5 - (clampedDist / 500) * 0.35);

    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(() => {
      const now = audioCtx.currentTime;
      gainNode.gain.setTargetAtTime(tickGain, now, 0.01);
      gainNode.gain.setTargetAtTime(0, now + 0.05, 0.02);
    }, tickRate);

    lastBeaconElement = element;
  }

  // --------------- Speech Announcer ---------------

  let lastSpokenElement = '';
  let lastSpeechTime = 0;
  const CONTINUOUS_SPEECH_INTERVAL_MS = 800;
  const IDLE_SPEECH_INTERVAL_MS = 1200;
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

  function speakText(text, priority = false) {
    if (!speechEnabled) return;
    if (priority) {
      window.speechSynthesis.cancel();
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.2;
    utterance.volume = 0.9;
    window.speechSynthesis.speak(utterance);
  }

  function buildSpeechText(result) {
    let text = result.element_under_cursor;
    if (result.interactive) {
      text += ', interactive';
    }
    if (result.nearest_actionable_direction !== 'ON_OBJECT' && result.distance_pixels > 0) {
      const dirLabel = {
        N: 'above',
        S: 'below',
        E: 'to the right',
        W: 'to the left',
      }[result.nearest_actionable_direction] || '';
      text += `. Nearest control ${dirLabel}, ${Math.round(result.distance_pixels)} pixels`;
    }
    return text;
  }

  function announceResult(result, force = false) {
    if (!speechEnabled) return;

    const now = Date.now();
    const element = result.element_under_cursor;

    // Don't repeat the same element unless forced
    if (!force && element === lastSpokenElement) return;

    // Respect minimum interval
    const minInterval = mouseStopped ? IDLE_SPEECH_INTERVAL_MS : CONTINUOUS_SPEECH_INTERVAL_MS;
    if (!force && now - lastSpeechTime < minInterval) return;

    lastSpokenElement = element;
    lastSpeechTime = now;

    const text = buildSpeechText(result);
    speakText(text, true);
  }

  // Called when mouse stops — always announce current element
  function maybeAnnounce() {
    if (!latestResult) return;
    announceResult(latestResult, false);
  }

  // --------------- Keyboard Shortcuts ---------------

  window.addEventListener('keydown', (e) => {
    // Alt+Shift+R: Re-read current element
    if (e.altKey && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      if (latestResult) {
        announceResult(latestResult, true);
      } else {
        speakText('No element detected yet. Move your mouse to explore.');
      }
    }
  });

  // --------------- Message Handling ---------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'INFERENCE_RESULT') {
      const previousElement = latestResult?.element_under_cursor;
      latestResult = msg.data;
      unlockAudio();
      updateBeacon(msg.data);

      // Announce when element changes (continuous mode) or on mouse stop
      if (msg.data.element_under_cursor !== previousElement) {
        announceResult(msg.data);
      } else if (mouseStopped) {
        maybeAnnounce();
      }
    }

    if (msg.type === 'SESSION_STARTED' || msg.type === 'START_SESSION') {
      unlockAudio();
      speakText('ScreenStream active. Move your mouse to explore the page.', true);
    }

    if (msg.type === 'PAGE_DESCRIPTION') {
      // Speak the initial page description after a brief delay so the startup message finishes
      setTimeout(() => {
        speakText(msg.description, false);
      }, 2500);
    }

    if (msg.type === 'SESSION_STOPPED') {
      stopAudio();
      window.speechSynthesis.cancel();
      latestResult = null;
      lastSpokenElement = '';
      lastBeaconElement = '';
      speakText('ScreenStream stopped.');
    }
  });
})();
