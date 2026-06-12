(function () {
  if (window.__screenStreamAccessLoaded) return;
  window.__screenStreamAccessLoaded = true;

  // --------------- State Variables ---------------

  let lastSendTime = 0;
  const THROTTLE_MS = 100;
  let mouseIdleTimer = null;
  let hoverIdleTimer = null;
  let mouseStopped = false;
  const IDLE_THRESHOLD_MS = 500;

  let latestMouse = { x: 0, y: 0 };
  let cachedInteractiveElements = [];
  let currentTargetCoord = null; // { x, y, name, description } - navigation destination

  // Visual highlights
  let visualCursor = null; 
  let targetBeacon = null; 

  // Modal UI
  let navigationModal = null;
  let searchInput = null;
  let micBtn = null;
  let speechRecognition = null;
  let lastVlmElement = null;

  // --------------- Helper Functions ---------------

  function throttle(func, limit) {
    let inThrottle;
    return function() {
      const args = arguments;
      const context = this;
      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    }
  }

  // --------------- DOM Analysis & Cache ---------------

  function isInteractive(el) {
    if (!el) return false;
    const tag = el.tagName;
    const interactiveTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY', 'IFRAME'];
    if (interactiveTags.includes(tag)) return true;
    
    const role = el.getAttribute('role');
    if (role && ['button', 'link', 'checkbox', 'radio', 'tab', 'textbox', 'menuitem', 'option', 'switch'].includes(role)) {
      return true;
    }
    
    if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') {
      return true;
    }
    
    return false;
  }

  function getSemanticElement(el) {
    if (!el) return null;
    
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      const tag = current.tagName;
      
      if (isInteractive(current)) {
        return current;
      }
      
      // Semantic structural elements
      if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'NAV', 'HEADER', 'FOOTER', 'MAIN', 'ARTICLE', 'SECTION'].includes(tag)) {
        return current;
      }
      
      current = current.parentElement;
    }
    
    return null;
  }

  function getAccessibilityLabel(el) {
    if (!el) return '';
    
    // 1. Aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) {
      return ariaLabel.trim();
    }
    
    // 2. Aria-labelledby
    const ariaLabelledby = el.getAttribute('aria-labelledby');
    if (ariaLabelledby) {
      const labelEl = document.getElementById(ariaLabelledby);
      if (labelEl && labelEl.textContent.trim()) {
        return labelEl.textContent.trim();
      }
    }
    
    // 3. Form labels / Placeholders
    if (el.tagName === 'INPUT') {
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label && label.textContent.trim()) {
          return `${label.textContent.trim()} input`;
        }
      }
      const placeholder = el.getAttribute('placeholder');
      if (placeholder && placeholder.trim()) {
        return `${placeholder.trim()} input`;
      }
      const type = el.getAttribute('type') || 'text';
      return `${type} input`;
    }
    
    // 4. Image alt text
    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) {
        return `Image: ${alt.trim()}`;
      }
      return 'Unlabeled image';
    }
    
    // 5. Content text fallback
    const text = el.textContent ? el.textContent.trim() : '';
    if (text) {
      if (text.length > 80) {
        return text.substring(0, 77) + '...';
      }
      return text;
    }
    
    // 6. Generic Tag fallback
    const tagDesc = el.tagName.toLowerCase();
    return `${tagDesc} element`;
  }

  function updateInteractiveElementsCache() {
    const interactiveSelectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [tabindex]';
    const allElements = document.querySelectorAll(interactiveSelectors);
    
    const visible = [];
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      if (el.getAttribute('tabindex') === '-1' && !el.getAttribute('role')) {
        continue;
      }
      
      // Basic visibility styles check
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        continue;
      }

      visible.push(el);
    }
    
    cachedInteractiveElements = visible;
  }

  function getDistanceToRect(x, y, rect) {
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function findNearestInteractive(x, y) {
    let nearestEl = null;
    let minDistance = Infinity;
    let nearestRect = null;
    
    // 1. Direct hit check
    const target = document.elementFromPoint(x, y);
    const semantic = getSemanticElement(target);
    if (semantic) {
      const rect = semantic.getBoundingClientRect();
      return {
        element: semantic,
        rect: rect,
        distance_pixels: 0,
        nearest_actionable_direction: 'ON_OBJECT',
        element_under_cursor: getAccessibilityLabel(semantic),
        interactive: isInteractive(semantic),
      };
    }
    
    // 2. Scan visible interactive elements
    for (let i = 0; i < cachedInteractiveElements.length; i++) {
      const el = cachedInteractiveElements[i];
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      
      const dist = getDistanceToRect(x, y, rect);
      if (dist < minDistance) {
        minDistance = dist;
        nearestEl = el;
        nearestRect = rect;
      }
    }
    
    if (nearestEl) {
      const centerX = (nearestRect.left + nearestRect.right) / 2;
      const centerY = (nearestRect.top + nearestRect.bottom) / 2;
      const dx = centerX - x;
      const dy = centerY - y;
      let direction;
      if (Math.abs(dx) > Math.abs(dy)) {
        direction = dx > 0 ? 'E' : 'W';
      } else {
        direction = dy > 0 ? 'S' : 'N';
      }
      
      return {
        element: nearestEl,
        rect: nearestRect,
        distance_pixels: minDistance,
        nearest_actionable_direction: direction,
        element_under_cursor: getAccessibilityLabel(nearestEl),
        interactive: true,
      };
    }
    
    return null;
  }

  // --------------- Spatial Audio Engine ---------------

  let audioCtx = null;
  let panner = null;
  let oscillator = null;
  let gainNode = null;
  let tickInterval = null;
  let audioUnlocked = false;

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
      createVisualCursor();
      updateInteractiveElementsCache();
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

  function updateLocalBeacon(result) {
    if (!audioUnlocked || !audioCtx || audioCtx.state !== 'running') return;

    const dir = result.nearest_actionable_direction;
    const dist = result.distance_pixels;
    const interactive = result.interactive;
    const element = result.element_under_cursor;

    // --- ON_OBJECT: plays chord/tone confirmation ---
    if (dir === 'ON_OBJECT') {
      panner.positionX.setTargetAtTime(0, audioCtx.currentTime, 0.02);
      panner.positionZ.setTargetAtTime(0, audioCtx.currentTime, 0.02);

      if (element !== lastBeaconElement) {
        const now = audioCtx.currentTime;
        confirmOsc.frequency.setValueAtTime(interactive ? 1200 : 800, now);
        confirmGain.gain.setValueAtTime(0, now);
        confirmGain.gain.linearRampToValueAtTime(0.5, now + 0.02);
        confirmGain.gain.linearRampToValueAtTime(0, now + 0.15);

        if (interactive) {
          confirmOsc.frequency.setValueAtTime(1500, now + 0.12);
          confirmGain.gain.linearRampToValueAtTime(0.4, now + 0.14);
          confirmGain.gain.linearRampToValueAtTime(0, now + 0.25);
        }
      }

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

    // --- Directional beacon: pan towards target ---
    let panX = 0, panZ = 0;
    switch (dir) {
      case 'E': panX = 1; break;
      case 'W': panX = -1; break;
      case 'N': panZ = -1; break;
      case 'S': panZ = 1; break;
    }
    panner.positionX.setTargetAtTime(panX * 8, audioCtx.currentTime, 0.03);
    panner.positionZ.setTargetAtTime(panZ * 8, audioCtx.currentTime, 0.03);

    const baseFreq = interactive ? 880 : 440;
    oscillator.frequency.setTargetAtTime(baseFreq, audioCtx.currentTime, 0.05);

    const clampedDist = Math.max(1, Math.min(dist, 500));
    const tickRate = Math.max(100, Math.min(800, clampedDist * 1.6));
    const tickGain = Math.max(0.15, 0.5 - (clampedDist / 500) * 0.35);

    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(() => {
      const now = audioCtx.currentTime;
      gainNode.gain.setTargetAtTime(tickGain, now, 0.01);
      gainNode.gain.setTargetAtTime(0, now + 0.05, 0.02);
    }, tickRate);

    lastBeaconElement = element;
  }

  function updateNavigationBeacon() {
    if (!audioUnlocked || !audioCtx || audioCtx.state !== 'running' || !currentTargetCoord) return;
    
    const dx = currentTargetCoord.x - latestMouse.x;
    const dy = currentTargetCoord.y - latestMouse.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    // Play lock-on sound if within 30px
    if (dist < 30) {
      currentTargetCoord = null;
      removeTargetBeacon();
      
      const now = audioCtx.currentTime;
      confirmOsc.frequency.setValueAtTime(1000, now);
      confirmGain.gain.setValueAtTime(0, now);
      confirmGain.gain.linearRampToValueAtTime(0.6, now + 0.05);
      confirmGain.gain.linearRampToValueAtTime(0.2, now + 0.15);
      confirmOsc.frequency.setValueAtTime(1300, now + 0.15);
      confirmGain.gain.linearRampToValueAtTime(0.6, now + 0.20);
      confirmGain.gain.linearRampToValueAtTime(0, now + 0.40);
      
      speakText(`Target locked!`, true);
      
      if (tickInterval) clearInterval(tickInterval);
      return;
    }
    
    // Guide towards target coordinate
    let dir = 'ON_OBJECT';
    let panX = 0, panZ = 0;
    if (Math.abs(dx) > Math.abs(dy)) {
      dir = dx > 0 ? 'E' : 'W';
      panX = dx > 0 ? 1 : -1;
    } else {
      dir = dy > 0 ? 'S' : 'N';
      panZ = dy > 0 ? 1 : -1;
    }
    
    panner.positionX.setTargetAtTime(panX * 8, audioCtx.currentTime, 0.03);
    panner.positionZ.setTargetAtTime(panZ * 8, audioCtx.currentTime, 0.03);
    
    const baseFreq = 880; 
    oscillator.frequency.setTargetAtTime(baseFreq, audioCtx.currentTime, 0.05);
    
    const clampedDist = Math.max(1, Math.min(dist, 800));
    const tickRate = Math.max(80, Math.min(800, clampedDist * 1.0));
    const tickGain = Math.max(0.25, 0.6 - (clampedDist / 800) * 0.35);
    
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(() => {
      const now = audioCtx.currentTime;
      gainNode.gain.setTargetAtTime(tickGain, now, 0.01);
      gainNode.gain.setTargetAtTime(0, now + 0.05, 0.02);
    }, tickRate);
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

  function generateActionableSpeech(label, tag, role, isInteractive) {
    if (!label) return '';
    
    const lowerLabel = label.toLowerCase();
    
    // If not interactive, check if it's a heading
    if (!isInteractive) {
      if (tag && tag.startsWith('H') && tag.length === 2 && !isNaN(tag[1])) {
        return `Heading level ${tag[1]}. ${label}.`;
      }
      return `${label}.`;
    }
    
    // Interactive elements
    if (tag === 'A' || role === 'link') {
      if (lowerLabel.includes('sign in') || lowerLabel.includes('login') || lowerLabel.includes('log in')) {
        return `Sign in link. ${label}. Click to log into your account.`;
      }
      if (lowerLabel.includes('sign up') || lowerLabel.includes('register') || lowerLabel.includes('create account')) {
        return `Sign up link. ${label}. Click to register a new account.`;
      }
      if (lowerLabel.includes('cart') || lowerLabel.includes('bag') || lowerLabel.includes('checkout')) {
        return `Shopping Cart link. ${label}. Click to review items and check out.`;
      }
      return `Link. ${label}. Click to follow.`;
    }
    
    if (tag === 'BUTTON' || role === 'button') {
      if (lowerLabel.includes('search') || lowerLabel.includes('find')) {
        return `Search button. ${label}. Click to submit query.`;
      }
      if (lowerLabel.includes('cart') || lowerLabel.includes('bag') || lowerLabel.includes('add')) {
        return `Add to Bag button. ${label}. Click to add items to your shopping cart.`;
      }
      if (lowerLabel.includes('close') || lowerLabel.includes('dismiss')) {
        return `Close button. Click to close.`;
      }
      if (lowerLabel.includes('submit') || lowerLabel.includes('send')) {
        return `Submit button. ${label}. Click to send.`;
      }
      return `Button. ${label}. Click to activate.`;
    }
    
    if (tag === 'INPUT') {
      if (lowerLabel.includes('search')) {
        return `Search text field. ${label}. Type your search query here.`;
      }
      if (lowerLabel.includes('email')) {
        return `Email address input field. ${label}. Enter your email.`;
      }
      if (lowerLabel.includes('password')) {
        return `Password input field. ${label}. Enter your password securely.`;
      }
      return `Text input field. ${label}. Type your response here.`;
    }
    
    return `${label}, interactive element.`;
  }

  function buildSpeechText(result) {
    let descriptionText = '';
    if (result.element) {
      const tag = result.element.tagName;
      const role = result.element.getAttribute('role') || '';
      descriptionText = generateActionableSpeech(result.element_under_cursor, tag, role, result.interactive);
    } else {
      descriptionText = result.element_under_cursor;
      if (result.interactive) {
        descriptionText += ', interactive.';
      }
    }
    
    if (result.nearest_actionable_direction !== 'ON_OBJECT' && result.distance_pixels > 0) {
      const dirLabel = {
        N: 'above',
        S: 'below',
        E: 'to the right',
        W: 'to the left',
      }[result.nearest_actionable_direction] || '';
      descriptionText += ` Nearest control ${dirLabel}, ${Math.round(result.distance_pixels)} pixels.`;
    }
    return descriptionText;
  }

  function announceResult(result, force = false) {
    if (!speechEnabled) return;

    const now = Date.now();
    const element = result.element_under_cursor;

    if (!force && element === lastSpokenElement) return;

    const minInterval = mouseStopped ? IDLE_SPEECH_INTERVAL_MS : CONTINUOUS_SPEECH_INTERVAL_MS;
    if (!force && now - lastSpeechTime < minInterval) return;

    lastSpokenElement = element;
    lastSpeechTime = now;

    const text = buildSpeechText(result);
    speakText(text, true);
  }

  function maybeAnnounce() {
    if (!latestResult) return;
    announceResult(latestResult, false);
  }

  function requestVlmLens(x, y) {
    speakText('Analyzing visual details with Overshoot...', true);
    
    chrome.runtime.sendMessage({
      type: 'VISUAL_LENS',
      x,
      y
    }, (response) => {
      if (response && response.success && response.description) {
        speakText("Visual details: " + response.description, true);
      } else {
        console.error('VLM Lens error:', response?.error);
        speakText('Visual analysis failed.', true);
      }
    });
  }

  function handleHoverPause(el, x, y) {
    if (!el) return;
    const isVisual = ['IMG', 'CANVAS', 'SVG', 'VIDEO'].includes(el.tagName) || el.getAttribute('role') === 'img';
    if (isVisual) {
      if (el === lastVlmElement) return;
      hoverIdleTimer = setTimeout(() => {
        lastVlmElement = el;
        requestVlmLens(x, y);
      }, 1200); 
    } else {
      lastVlmElement = null;
    }
  }

  // --------------- Custom Cursor UI ---------------

  function createVisualCursor() {
    if (visualCursor) return;
    
    const styleId = 'screen-stream-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        .ss-pointer {
          position: fixed;
          width: 44px;
          height: 44px;
          border-radius: 50%;
          border: 2px solid hsla(338, 100%, 50%, 0.85);
          background: hsla(338, 100%, 50%, 0.15);
          pointer-events: none;
          z-index: 10000000;
          transform: translate(-50%, -50%);
          transition: left 0.05s ease-out, top 0.05s ease-out;
          box-shadow: 0 0 12px hsla(338, 100%, 50%, 0.5);
          animation: ss-pulse 2s infinite;
        }
        .ss-pointer-dot {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: hsla(338, 100%, 50%, 0.95);
          transform: translate(-50%, -50%);
        }
        .ss-target-beacon {
          position: fixed;
          width: 60px;
          height: 60px;
          border-radius: 50%;
          border: 3px dashed hsla(145, 100%, 45%, 0.9);
          background: hsla(145, 100%, 45%, 0.1);
          pointer-events: none;
          z-index: 9999999;
          transform: translate(-50%, -50%);
          animation: ss-pulse-green 1.5s infinite;
        }
        @keyframes ss-pulse {
          0% { box-shadow: 0 0 0 0 rgba(255, 20, 147, 0.6); }
          70% { box-shadow: 0 0 0 10px rgba(255, 20, 147, 0); }
          100% { box-shadow: 0 0 0 0 rgba(255, 20, 147, 0); }
        }
        @keyframes ss-pulse-green {
          0% { box-shadow: 0 0 0 0 rgba(46, 204, 113, 0.6); transform: translate(-50%, -50%) scale(1); }
          70% { box-shadow: 0 0 0 15px rgba(46, 204, 113, 0); transform: translate(-50%, -50%) scale(1.1); }
          100% { box-shadow: 0 0 0 0 rgba(46, 204, 113, 0); transform: translate(-50%, -50%) scale(1); }
        }
        .ss-modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(8px);
          z-index: 100000000;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }
        .ss-modal-card {
          background: rgba(24, 24, 28, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 16px;
          padding: 24px;
          width: 450px;
          box-shadow: 0 20px 40px rgba(0,0,0,0.5);
          color: #fff;
          text-align: center;
        }
        .ss-modal-title {
          font-size: 1.3rem;
          margin-bottom: 8px;
          font-weight: 600;
          background: linear-gradient(135deg, #ff1493, #da70d6);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .ss-modal-sub {
          font-size: 0.9rem;
          color: #a0a0ab;
          margin-bottom: 20px;
        }
        .ss-modal-input-row {
          display: flex;
          gap: 10px;
          margin-bottom: 15px;
        }
        .ss-modal-input {
          flex: 1;
          background: rgba(0,0,0,0.4);
          border: 1.5px solid rgba(255,255,255,0.2);
          border-radius: 8px;
          padding: 12px 16px;
          color: #fff;
          font-size: 1rem;
          outline: none;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .ss-modal-input:focus {
          border-color: hsla(338, 100%, 50%, 0.8);
          box-shadow: 0 0 8px hsla(338, 100%, 50%, 0.4);
        }
        .ss-modal-btn {
          background: rgba(255, 255, 255, 0.1);
          border: none;
          color: white;
          width: 48px;
          height: 48px;
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.2s;
        }
        .ss-modal-btn:hover {
          background: rgba(255,255,255,0.2);
        }
        .ss-modal-btn.listening {
          background: hsla(338, 100%, 50%, 0.8);
          animation: ss-pulse-green 1s infinite;
        }
        .ss-modal-instructions {
          font-size: 0.8rem;
          color: #71717a;
          margin-top: 15px;
        }
      `;
      document.head.appendChild(style);
    }

    visualCursor = document.createElement('div');
    visualCursor.className = 'ss-pointer';
    const dot = document.createElement('div');
    dot.className = 'ss-pointer-dot';
    visualCursor.appendChild(dot);
    document.body.appendChild(visualCursor);
  }

  function removeVisualCursor() {
    if (visualCursor) {
      visualCursor.remove();
      visualCursor = null;
    }
    removeTargetBeacon();
  }

  function createTargetBeacon(x, y) {
    removeTargetBeacon();
    targetBeacon = document.createElement('div');
    targetBeacon.className = 'ss-target-beacon';
    targetBeacon.style.left = `${x}px`;
    targetBeacon.style.top = `${y}px`;
    document.body.appendChild(targetBeacon);
  }

  function removeTargetBeacon() {
    if (targetBeacon) {
      targetBeacon.remove();
      targetBeacon = null;
    }
  }

  // --------------- VLM Navigation Modal ---------------

  function initSpeechRecognition() {
    if (speechRecognition) return;
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return;
    
    speechRecognition = new SpeechRec();
    speechRecognition.continuous = false;
    speechRecognition.interimResults = false;
    speechRecognition.lang = 'en-US';
    
    speechRecognition.onstart = () => {
      micBtn.classList.add('listening');
      speakText('Listening...', true);
    };
    
    speechRecognition.onresult = (e) => {
      const text = e.results[0][0].transcript;
      searchInput.value = text;
      speakText(`Searching for ${text}`, true);
      submitSearch(text);
    };
    
    speechRecognition.onerror = (e) => {
      console.error('Speech recognition error:', e.error);
      speakText('Speech recognition failed. Please try typing.', true);
      micBtn.classList.remove('listening');
    };
    
    speechRecognition.onend = () => {
      micBtn.classList.remove('listening');
    };
  }

  function openSearchModal() {
    if (navigationModal) {
      closeSearchModal();
      return;
    }
    
    navigationModal = document.createElement('div');
    navigationModal.className = 'ss-modal-overlay';
    
    const card = document.createElement('div');
    card.className = 'ss-modal-card';
    
    const title = document.createElement('div');
    title.className = 'ss-modal-title';
    title.textContent = 'Overshoot VLM Navigator';
    
    const sub = document.createElement('div');
    sub.className = 'ss-modal-sub';
    sub.textContent = 'What element would you like to find?';
    
    const inputRow = document.createElement('div');
    inputRow.className = 'ss-modal-input-row';
    
    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'ss-modal-input';
    searchInput.placeholder = 'e.g. checkout, search bar, sign in';
    searchInput.autofocus = true;
    
    micBtn = document.createElement('button');
    micBtn.className = 'ss-modal-btn';
    micBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v4M8 23h8"/>
      </svg>
    `;
    
    inputRow.appendChild(searchInput);
    inputRow.appendChild(micBtn);
    
    const instr = document.createElement('div');
    instr.className = 'ss-modal-instructions';
    instr.textContent = 'Press Enter to search, Esc to close. Speak or type your request.';
    
    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(inputRow);
    card.appendChild(instr);
    navigationModal.appendChild(card);
    document.body.appendChild(navigationModal);
    
    searchInput.focus();
    
    initSpeechRecognition();
    micBtn.addEventListener('click', () => {
      if (micBtn.classList.contains('listening')) {
        speechRecognition.stop();
      } else {
        speechRecognition.start();
      }
    });
    
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        submitSearch(searchInput.value);
      } else if (e.key === 'Escape') {
        closeSearchModal();
      }
    });
    
    navigationModal.addEventListener('click', (e) => {
      if (e.target === navigationModal) {
        closeSearchModal();
      }
    });
    
    speakText('What element would you like to find?', true);
  }
  
  function closeSearchModal() {
    if (navigationModal) {
      if (speechRecognition) {
        try { speechRecognition.stop(); } catch(e){}
      }
      navigationModal.remove();
      navigationModal = null;
      searchInput = null;
      micBtn = null;
      speakText('Navigator closed.', true);
    }
  }

  function submitSearch(query) {
    if (!query || !query.trim()) return;
    
    speakText('Analyzing stream with Overshoot...', true);
    closeSearchModal();
    
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    chrome.runtime.sendMessage({
      type: 'NAVIGATE_QUERY',
      query: query.trim(),
      width,
      height
    }, (response) => {
      if (response && response.success && response.data) {
        const data = response.data;
        if (data.found) {
          currentTargetCoord = {
            x: data.x,
            y: data.y,
            name: data.element_name,
            description: data.guidance
          };
          
          createTargetBeacon(data.x, data.y);
          speakText(`Found ${data.element_name}. ${data.guidance}. Navigate towards the beacon sound.`, true);
          
          unlockAudio();
          updateNavigationBeacon();
        } else {
          speakText(`Overshoot could not find ${query} on this page.`, true);
        }
      } else {
        console.error('Navigation error:', response?.error);
        speakText('Navigation search failed. Please try again.', true);
      }
    });
  }

  // --------------- Mouse Movements ---------------

  window.addEventListener('mousemove', (e) => {
    mouseStopped = false;
    clearTimeout(mouseIdleTimer);
    clearTimeout(hoverIdleTimer);

    latestMouse = { x: e.clientX, y: e.clientY };

    if (visualCursor) {
      visualCursor.style.left = `${e.clientX}px`;
      visualCursor.style.top = `${e.clientY}px`;
    }

    const now = Date.now();
    if (now - lastSendTime >= THROTTLE_MS) {
      lastSendTime = now;
      chrome.runtime.sendMessage({
        type: 'MOUSE_MOVE',
        x: e.clientX,
        y: e.clientY,
      }).catch(() => {});
    }

    if (currentTargetCoord) {
      updateNavigationBeacon();
    } else {
      const result = findNearestInteractive(e.clientX, e.clientY);
      if (result) {
        latestResult = result;
        updateLocalBeacon(result);
        
        if (result.element_under_cursor !== lastSpokenElement) {
          announceResult(result);
        }
      }
    }

    const hoveredEl = document.elementFromPoint(e.clientX, e.clientY);
    if (hoveredEl) {
      handleHoverPause(hoveredEl, e.clientX, e.clientY);
    }

    mouseIdleTimer = setTimeout(() => {
      mouseStopped = true;
      maybeAnnounce();
    }, IDLE_THRESHOLD_MS);
  });

  // --------------- Keyboard Shortcuts ---------------

  window.addEventListener('keydown', (e) => {
    // Alt+Shift+R: Re-read current element / beacon target
    if (e.altKey && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      if (currentTargetCoord) {
        speakText(`Navigating towards: ${currentTargetCoord.name}. ${currentTargetCoord.description}`, true);
      } else if (latestResult) {
        announceResult(latestResult, true);
      } else {
        speakText('No element detected yet. Move your mouse to explore.', true);
      }
    }

    // Alt+Shift+G: Open spatial navigation command card
    if (e.altKey && e.shiftKey && e.key === 'G') {
      e.preventDefault();
      openSearchModal();
    }

    // Alt+Shift+V: Trigger Visual Lens (VLM visual explain)
    if (e.altKey && e.shiftKey && e.key === 'V') {
      e.preventDefault();
      requestVlmLens(latestMouse.x, latestMouse.y);
    }
  });

  // --------------- Cache Re-build triggers ---------------

  window.addEventListener('resize', throttle(updateInteractiveElementsCache, 1000));
  window.addEventListener('scroll', throttle(updateInteractiveElementsCache, 500));

  const observer = new MutationObserver(throttle(updateInteractiveElementsCache, 1000));
  observer.observe(document.body, { childList: true, subtree: true });

  // --------------- Message Handling ---------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'INFERENCE_RESULT') {
      latestResult = msg.data;
      unlockAudio();
      updateLocalBeacon(msg.data);
    }

    if (msg.type === 'SESSION_STARTED' || msg.type === 'START_SESSION') {
      unlockAudio();
      createVisualCursor();
      updateInteractiveElementsCache();
      speakText('ScreenStream active. Move your mouse to explore the page.', true);
    }

    if (msg.type === 'PAGE_DESCRIPTION') {
      setTimeout(() => {
        speakText(msg.description, false);
      }, 2500);
    }

    if (msg.type === 'SESSION_STOPPED') {
      stopAudio();
      window.speechSynthesis.cancel();
      removeVisualCursor();
      currentTargetCoord = null;
      latestResult = null;
      lastSpokenElement = '';
      lastBeaconElement = '';
      speakText('ScreenStream stopped.');
    }
  });
})();
