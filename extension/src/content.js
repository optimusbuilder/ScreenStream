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
  let speechRecognition = null;
  let lastVlmElement = null;
  let sessionActive = false;
  let lastHeartbeatTime = 0;
  const HEARTBEAT_INTERVAL_MS = 1500;
  let lastBeaconElement = '';

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

  function initAudio() {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'INIT_AUDIO' });
  }

  function unlockAudio() {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'UNLOCK_AUDIO' });
  }

  function stopAudio() {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_AUDIO' });
  }

  function updateLocalBeacon(result) {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'UPDATE_LOCAL_BEACON',
      direction: result.nearest_actionable_direction,
      distance: result.distance_pixels,
      interactive: result.interactive,
      element: result.element_under_cursor
    });
  }

  function updateNavigationBeacon() {
    if (!currentTargetCoord) return;
    
    const dx = currentTargetCoord.x - latestMouse.x;
    const dy = currentTargetCoord.y - latestMouse.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    // Play lock-on sound if within 30px
    if (dist < 30) {
      currentTargetCoord = null;
      removeTargetBeacon();
      speakText(`Target locked!`, true);
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'PLAY_LOCKON_SOUND' });
      return;
    }
    
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'UPDATE_NAVIGATION_BEACON',
      dx: dx,
      dy: dy,
      dist: dist
    });
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
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_ELEVENLABS' });
    }
    chrome.runtime.sendMessage({
      type: 'SPEAK',
      text: text,
      priority: priority
    });
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
        return `${label}. Click to log into your account.`;
      }
      if (lowerLabel.includes('sign up') || lowerLabel.includes('register') || lowerLabel.includes('create account')) {
        return `${label}. Click to register a new account.`;
      }
      if (lowerLabel.includes('cart') || lowerLabel.includes('bag') || lowerLabel.includes('checkout')) {
        return `Shopping Cart. ${label}. Click to review items and check out.`;
      }
      return `${label}. Click to follow.`;
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

    const element = result.element_under_cursor;

    if (!force && element === lastSpokenElement) return;

    lastSpokenElement = element;
    lastSpeechTime = Date.now();

    const text = buildSpeechText(result);
    speakText(text, true);
  }

  function maybeAnnounce() {
    if (!latestResult) return;
    announceResult(latestResult, false);
  }

  let activeAudioCallback = null;

  function playBase64Audio(base64Data, onEndCallback = null) {
    activeAudioCallback = onEndCallback;
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'PLAY_BASE64_AUDIO',
      base64Data: base64Data,
      playbackRate: 1.18
    });
  }

  let pendingAutoListen = false;

  function speakGuideResponse(text, base64Audio = null, onEnd = null) {
    if (!speechEnabled) return;

    pendingAutoListen = text && text.includes('?');

    const handleSpeechFinished = () => {
      if (onEnd) onEnd();
      if (pendingAutoListen) {
        pendingAutoListen = false;
        setTimeout(() => {
          if (sessionActive && !voiceListening) {
            startVoiceCommand();
          }
        }, 400);
      }
    };

    if (base64Audio) {
      playBase64Audio(base64Audio, handleSpeechFinished);
    } else {
      speakText(text, true); // Local TTS
      activeAudioCallback = handleSpeechFinished;
    }
  }

  function requestVlmLens(x, y) {
    const el = document.elementFromPoint(x, y);
    let context = null;
    if (el) {
      let textContext = '';
      let parent = el.parentElement;
      for (let i = 0; i < 3 && parent; i++) {
        if (parent.innerText && parent.innerText.length < 300) {
          textContext = parent.innerText.trim();
          break;
        }
        parent = parent.parentElement;
      }
      
      context = {
        tagName: el.tagName,
        alt: el.getAttribute('alt') || '',
        outerHTML: el.outerHTML ? el.outerHTML.substring(0, 400) : '',
        textContext: textContext,
      };
    }

    chrome.runtime.sendMessage({
      type: 'VISUAL_LENS',
      x,
      y,
      context
    }, (response) => {
      if (response && response.success && response.description) {
        const announceText = "Visual details: " + response.description;
        
        const updatePopup = () => {
          chrome.runtime.sendMessage({
            type: 'INFERENCE_RESULT',
            data: {
              element_under_cursor: response.description,
              interactive: false,
              nearest_actionable_direction: 'ON_OBJECT',
              distance_pixels: 0,
            }
          }).catch(() => {});
        };

        speakGuideResponse(announceText, response.audio, updatePopup);
      } else {
        console.error('VLM Lens error:', response?.error);
        speakText('Visual analysis failed.', true);
      }
    });
  }

  function handleLinger(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    const isVisual = ['IMG', 'CANVAS', 'SVG', 'VIDEO'].includes(el.tagName) || el.getAttribute('role') === 'img';
    if (isVisual) {
      if (el === lastVlmElement) return;
      lastVlmElement = el;
      requestVlmLens(x, y);
    } else {
      lastVlmElement = null;
      if (latestResult) {
        announceResult(latestResult, false);
      }
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
        /* Modal CSS removed — using voice-only command system */
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

  // --------------- Voice Command System (No Visual Modal) ---------------

  let commandSubmitted = false;
  let voiceListening = false;

  function startVoiceCommand() {
    if (voiceListening) {
      speakText('Already listening. Say your command.', true);
      return;
    }
    
    voiceListening = true;
    commandSubmitted = false;
    
    chrome.runtime.sendMessage({ type: 'START_VOICE_COMMAND' });
  }

  function stopVoiceCommand() {
    voiceListening = false;
    commandSubmitted = false;
    chrome.runtime.sendMessage({ type: 'STOP_VOICE_COMMAND' });
  }

  function submitSearch(command) {
    if (!command || !command.trim()) return;
    
    stopVoiceCommand();
    const raw = command.trim();
    const text = raw.toLowerCase();
    
    // --- Robust intent extraction (keyword-anywhere, not prefix-only) ---
    
    // Pattern 0: Help command
    if (text === 'help' || text.includes('what can you do') || text.includes('what commands')) {
      speakText('You can say: search for something, click on a button or link, read this page, scroll down, scroll up, go back, go forward, or ask any question about what you see. Double tap shift to speak a command.', true);
      scheduleHandsFreeReopen();
      return;
    }
    
    // Pattern 0.5: Scroll commands (instant, no VLM)
    if (text.includes('scroll down') || text === 'page down' || text === 'down') {
      window.scrollBy({ top: window.innerHeight * 0.75, behavior: 'smooth' });
      speakText('Scrolled down.', true);
      setTimeout(() => updateInteractiveElementsCache(), 600);
      scheduleHandsFreeReopen();
      return;
    }
    if (text.includes('scroll up') || text === 'page up' || text === 'up') {
      window.scrollBy({ top: -window.innerHeight * 0.75, behavior: 'smooth' });
      speakText('Scrolled up.', true);
      setTimeout(() => updateInteractiveElementsCache(), 600);
      scheduleHandsFreeReopen();
      return;
    }
    if (text.includes('go to top') || text.includes('scroll to top') || text === 'top') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      speakText('At the top of the page.', true);
      setTimeout(() => updateInteractiveElementsCache(), 600);
      scheduleHandsFreeReopen();
      return;
    }
    if (text.includes('go to bottom') || text.includes('scroll to bottom') || text === 'bottom') {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      speakText('At the bottom of the page.', true);
      setTimeout(() => updateInteractiveElementsCache(), 600);
      scheduleHandsFreeReopen();
      return;
    }
    
    // Pattern 0.6: Back / Forward navigation (instant)
    if (text === 'go back' || text === 'back' || text === 'previous page') {
      speakText('Going back.', true);
      window.history.back();
      return;
    }
    if (text === 'go forward' || text === 'forward' || text === 'next page') {
      speakText('Going forward.', true);
      window.history.forward();
      return;
    }
    
    // Pattern 0.7: Read page content (instant DOM extraction, no VLM)
    if (text === 'read this page' || text === 'read the page' || text === 'read page' || text.includes('read this') || text.includes('read it to me') || text.includes('read aloud')) {
      executeReadPage();
      return;
    }
    
    // Pattern 0.8: Form fill (instant DOM)
    const fillMatch = text.match(/(?:fill|type|enter|put|write)\s+(.+?)\s+(?:in|into|in the|on|on the)\s+(.+)/i)
      || text.match(/(?:fill|type|enter|put|write)\s+(.+?)\s+(?:as|with)\s+(.+)/i);
    if (fillMatch) {
      executeFormFill(fillMatch[2].trim(), fillMatch[1].trim());
      return;
    }
    // Alternate: "fill [field] with [value]"
    const fillAlt = text.match(/(?:fill)\s+(?:in\s+)?(?:the\s+)?(.+?)\s+(?:with|as)\s+(.+)/i);
    if (fillAlt) {
      executeFormFill(fillAlt[1].trim(), fillAlt[2].trim());
      return;
    }
    
    // Pattern 1: Search intent — look for "search" or "find" + a payload anywhere
    const searchMatch = text.match(/(?:search\s+for|search|find|look\s+for|look\s+up)\s+(.+)/i);
    if (searchMatch) {
      executeSearchTask(searchMatch[1].trim());
      return;
    }
    
    // Pattern 2: Click/Navigate intent — look for "click", "go to", "open", "press", "tap"
    const clickMatch = text.match(/(?:click(?:\s+on)?|go\s+to|open|press|tap|select|navigate\s+to)\s+(.+)/i);
    if (clickMatch) {
      executeClickTask(clickMatch[1].trim());
      return;
    }
    
    // Pattern 3: Read/Describe intent — route to VLM Q&A
    const readMatch = text.match(/(?:summarize|describe|tell\s+me\s+about|what(?:'s|\s+is)\s+on)\s*(.*)/i);
    if (readMatch) {
      executeAskTask(raw);
      return;
    }
    
    // Pattern 4: Question intent — starts with question word or contains "?"
    const isQuestion = /^(what|why|how|who|where|when|is|are|can|could|should|would|do|does|did)\b/i.test(text) || text.includes('?');
    if (isQuestion) {
      executeAskTask(raw);
      return;
    }
    
    // Pattern 5: Multi-word default → Q&A, single-word/two-word → spatial guide
    if (text.split(/\s+/).length > 2) {
      executeAskTask(raw);
    } else {
      executeGuideTask(raw);
    }
  }

  // React-safe way to set input value
  function setNativeInputValue(inputEl, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(inputEl, value);
    } else {
      inputEl.value = value;
    }
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Dispatch a full Enter key sequence (keydown + keypress + keyup)
  function dispatchEnterKey(el) {
    const props = { key: 'Enter', keyCode: 13, code: 'Enter', which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', props));
    el.dispatchEvent(new KeyboardEvent('keypress', props));
    el.dispatchEvent(new KeyboardEvent('keyup', props));
  }

  // After a command finishes, prompt readiness
  function scheduleHandsFreeReopen() {
    setTimeout(() => {
      if (sessionActive && !voiceListening) {
        speakText('Ready for next command.', false);
      }
    }, 1500);
  }

  function executeSearchTask(searchTerm) {
    speakText(`Locating search box to search for: ${searchTerm}`, true);
    
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    // Try local DOM search first (fast and reliable), then VLM fallback
    const localInput = findSearchInputLocally();
    if (localInput) {
      performSearch(localInput, searchTerm);
      return;
    }
    
    chrome.runtime.sendMessage({
      type: 'NAVIGATE_QUERY',
      query: 'search input box or search bar',
      width,
      height
    }, (response) => {
      if (response && response.success && response.data && response.data.found) {
        const data = response.data;
        const targetEl = document.elementFromPoint(data.x, data.y);
        const inputEl = findInputElement(targetEl);
        
        if (inputEl) {
          latestMouse = { x: data.x, y: data.y };
          if (visualCursor) {
            visualCursor.style.left = `${data.x}px`;
            visualCursor.style.top = `${data.y}px`;
          }
          performSearch(inputEl, searchTerm);
        } else {
          speakText(`Found search area but could not locate the input field. Try clicking on the search box first.`, true);
          scheduleHandsFreeReopen();
        }
      } else {
        speakText(`Could not find a search box on this page.`, true);
        scheduleHandsFreeReopen();
      }
    });
  }

  function performSearch(inputEl, searchTerm) {
    inputEl.focus();
    setNativeInputValue(inputEl, searchTerm);
    speakText(`Searching for ${searchTerm}...`, true);
    
    setTimeout(() => {
      const form = inputEl.closest('form');
      if (form) {
        // Try submitting the form, but also fire Enter as fallback for SPAs
        try {
          form.requestSubmit();
        } catch(e) {
          form.submit();
        }
      } else {
        dispatchEnterKey(inputEl);
      }
      scheduleHandsFreeReopen();
    }, 600);
  }

  function executeClickTask(targetElement) {
    speakText(`Locating and clicking: ${targetElement}`, true);
    
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    chrome.runtime.sendMessage({
      type: 'NAVIGATE_QUERY',
      query: targetElement,
      width,
      height
    }, (response) => {
      if (response && response.success && response.data && response.data.found) {
        const data = response.data;
        
        latestMouse = { x: data.x, y: data.y };
        if (visualCursor) {
          visualCursor.style.left = `${data.x}px`;
          visualCursor.style.top = `${data.y}px`;
        }
        
        const rawEl = document.elementFromPoint(data.x, data.y);
        const clickableEl = findClickableElement(rawEl);
        
        if (clickableEl) {
          speakText(`Clicking ${data.element_name}.`, true);
          clickableEl.focus();
          clickableEl.click();
        } else if (rawEl) {
          speakText(`Clicking ${data.element_name}.`, true);
          rawEl.click();
        } else {
          speakText(`Found ${targetElement} but could not interact with it.`, true);
        }
      } else {
        speakText(`Could not locate ${targetElement} on this page.`, true);
      }
      scheduleHandsFreeReopen();
    });
  }

  function executeAskTask(question) {
    speakText('Analyzing page to answer your question...', true);
    
    chrome.runtime.sendMessage({
      type: 'ASK_QUERY',
      query: question
    }, (response) => {
      if (response && response.success && response.description) {
        const announceText = response.description;
        speakGuideResponse(announceText, response.audio, () => scheduleHandsFreeReopen());
      } else {
        console.error('Q&A error:', response?.error);
        speakText('Sorry, I could not answer that question. Try again.', true);
        scheduleHandsFreeReopen();
      }
    });
  }

  function executeGuideTask(query) {
    speakText('Searching the page...', true);
    
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    chrome.runtime.sendMessage({
      type: 'NAVIGATE_QUERY',
      query: query,
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
          speakText(`Could not find ${query} on this page.`, true);
          scheduleHandsFreeReopen();
        }
      } else {
        console.error('Navigation error:', response?.error);
        speakText('Navigation search failed. Try again.', true);
        scheduleHandsFreeReopen();
      }
    });
  }

  function findInputElement(el) {
    if (!el) return null;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el;
    const input = el.querySelector('input, textarea');
    if (input) return input;
    
    let parent = el.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      if (parent.tagName === 'INPUT') return parent;
      const childInput = parent.querySelector('input, textarea');
      if (childInput) return childInput;
      parent = parent.parentElement;
    }
    return null;
  }

  function findSearchInputLocally() {
    // Try progressively broader selectors (most specific first)
    const selectors = [
      'input[type="search"]',
      'input[role="searchbox"]',
      '[role="search"] input',
      'input[name="q"]',                    // Google, many sites
      'input[name="query"]',                // Generic
      'input[name="search_query"]',         // YouTube
      'input[id*="search" i]',
      'input[name*="search" i]',
      'input[placeholder*="search" i]',
      'input[aria-label*="search" i]',
      'textarea[aria-label*="search" i]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findClickableElement(el) {
    if (!el) return null;
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      if (isInteractive(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  // --------------- Read Page (DOM Text Extraction) ---------------

  function executeReadPage() {
    speakText('Reading page content...', true);
    
    // Try to find the main content area
    const mainContent = document.querySelector('main, [role="main"], article, .article, .content, .post, .entry-content, #content, #main');
    let textSource = mainContent || document.body;
    
    // Extract meaningful text, skipping nav/header/footer/scripts
    const skipTags = new Set(['NAV', 'HEADER', 'FOOTER', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME']);
    const skipRoles = new Set(['navigation', 'banner', 'contentinfo', 'complementary']);
    
    let paragraphs = [];
    const walker = document.createTreeWalker(
      textSource,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (skipTags.has(node.tagName)) return NodeFilter.FILTER_REJECT;
          if (skipRoles.has(node.getAttribute('role'))) return NodeFilter.FILTER_REJECT;
          if (['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'BLOCKQUOTE', 'FIGCAPTION'].includes(node.tagName)) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      }
    );
    
    let node;
    while ((node = walker.nextNode()) && paragraphs.length < 20) {
      const text = node.textContent?.trim();
      if (text && text.length > 15) {
        const tag = node.tagName;
        if (tag.startsWith('H') && tag.length === 2) {
          paragraphs.push(`Heading: ${text}`);
        } else {
          paragraphs.push(text.length > 200 ? text.substring(0, 197) + '...' : text);
        }
      }
    }
    
    if (paragraphs.length === 0) {
      // Fallback: just grab visible text
      const bodyText = textSource.innerText?.trim() || '';
      if (bodyText.length > 0) {
        paragraphs.push(bodyText.substring(0, 800));
      } else {
        speakText('Could not find readable content on this page.', true);
        scheduleHandsFreeReopen();
        return;
      }
    }
    
    const fullText = paragraphs.join('. ');
    
    // Use ElevenLabs for long content if available, otherwise chrome.tts
    if (fullText.length > 100) {
      chrome.runtime.sendMessage({
        type: 'ASK_QUERY',
        query: `Please read and summarize the following page content for a blind user in a clear, natural way: ${fullText.substring(0, 1500)}`
      }, (response) => {
        if (response && response.success && response.description) {
          speakGuideResponse(response.description, response.audio, () => scheduleHandsFreeReopen());
        } else {
          // Fallback: just read the raw text
          speakText(fullText.substring(0, 500), true);
          scheduleHandsFreeReopen();
        }
      });
    } else {
      speakText(fullText, true);
      scheduleHandsFreeReopen();
    }
  }

  // --------------- Form Fill ---------------

  function executeFormFill(fieldHint, value) {
    speakText(`Filling ${fieldHint} with ${value}...`, true);
    
    // Try to find the input by various attributes
    const hint = fieldHint.toLowerCase();
    const allInputs = document.querySelectorAll('input, textarea, select');
    let bestMatch = null;
    let bestScore = 0;
    
    for (const input of allInputs) {
      const style = window.getComputedStyle(input);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      
      let score = 0;
      const attrs = [
        input.getAttribute('name'),
        input.getAttribute('id'),
        input.getAttribute('placeholder'),
        input.getAttribute('aria-label'),
        input.getAttribute('type'),
      ].filter(Boolean).map(a => a.toLowerCase());
      
      // Check for label element
      if (input.id) {
        const label = document.querySelector(`label[for="${input.id}"]`);
        if (label) attrs.push(label.textContent.trim().toLowerCase());
      }
      
      for (const attr of attrs) {
        if (attr.includes(hint) || hint.includes(attr)) {
          score += 10;
        }
        // Fuzzy: check each word
        const hintWords = hint.split(/\s+/);
        for (const word of hintWords) {
          if (word.length > 2 && attr.includes(word)) score += 3;
        }
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = input;
      }
    }
    
    if (bestMatch) {
      bestMatch.focus();
      setNativeInputValue(bestMatch, value);
      speakText(`Filled ${fieldHint} with ${value}.`, true);
      scheduleHandsFreeReopen();
    } else {
      // Fallback: try VLM to locate the field
      const width = window.innerWidth;
      const height = window.innerHeight;
      chrome.runtime.sendMessage({
        type: 'NAVIGATE_QUERY',
        query: `${fieldHint} input field`,
        width,
        height
      }, (response) => {
        if (response && response.success && response.data && response.data.found) {
          const targetEl = document.elementFromPoint(response.data.x, response.data.y);
          const inputEl = findInputElement(targetEl);
          if (inputEl) {
            inputEl.focus();
            setNativeInputValue(inputEl, value);
            speakText(`Filled ${fieldHint} with ${value}.`, true);
          } else {
            speakText(`Found ${fieldHint} area but could not fill it.`, true);
          }
        } else {
          speakText(`Could not find ${fieldHint} field on this page.`, true);
        }
        scheduleHandsFreeReopen();
      });
    }
  }

  // --------------- Mouse Movements ---------------

  window.addEventListener('mousemove', (e) => {
    if (!sessionActive) return;
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
      const dist = Math.round(Math.sqrt((currentTargetCoord.x - e.clientX) ** 2 + (currentTargetCoord.y - e.clientY) ** 2));
      chrome.runtime.sendMessage({
        type: 'INFERENCE_RESULT',
        data: {
          element_under_cursor: `Guidance target: ${currentTargetCoord.name}`,
          interactive: true,
          nearest_actionable_direction: 'TARGET',
          distance_pixels: dist,
        }
      }).catch(() => {});
    } else {
      const result = findNearestInteractive(e.clientX, e.clientY);
      if (result) {
        latestResult = result;
        updateLocalBeacon(result);
        
        if (result.distance_pixels > 200) {
          triggerHeartbeat();
        }

        chrome.runtime.sendMessage({
          type: 'INFERENCE_RESULT',
          data: {
            element_under_cursor: result.element_under_cursor,
            interactive: result.interactive,
            nearest_actionable_direction: result.nearest_actionable_direction,
            distance_pixels: Math.round(result.distance_pixels),
          }
        }).catch(() => {});
      }
    }

    mouseIdleTimer = setTimeout(() => {
      mouseStopped = true;
      handleLinger(latestMouse.x, latestMouse.y);
    }, 3000);
  });

  // --------------- Keyboard Shortcuts ---------------

  let lastShiftTime = 0;

  window.addEventListener('keydown', (e) => {
    if (!sessionActive) return;

    // Shift double-press detection
    if (e.key === 'Shift') {
      const now = Date.now();
      if (now - lastShiftTime < 400) {
        e.preventDefault();
        startVoiceCommand();
      }
      lastShiftTime = now;
    }

    // Tilde key trigger
    if (e.key === '`') {
      const isTyping = document.activeElement && (
        document.activeElement.tagName === 'INPUT' || 
        document.activeElement.tagName === 'TEXTAREA' || 
        document.activeElement.isContentEditable
      );
      if (!isTyping) {
        e.preventDefault();
        startVoiceCommand();
      }
    }

    // Escape key — cancel voice listening
    if (e.key === 'Escape' && voiceListening) {
      e.preventDefault();
      stopVoiceCommand();
      speakText('Cancelled.', true);
    }

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

    // Alt+Shift+G: Voice command
    if (e.altKey && e.shiftKey && e.key === 'G') {
      e.preventDefault();
      startVoiceCommand();
    }

    // Alt+Shift+V: Trigger Visual Lens (VLM visual explain)
    if (e.altKey && e.shiftKey && e.key === 'V') {
      e.preventDefault();
      requestVlmLens(latestMouse.x, latestMouse.y);
    }

    // Alt+Shift+S: Trigger page layout Sonar Sweep
    if (e.altKey && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      triggerSonarSweep();
    }
  });

  function triggerHeartbeat() {
    const now = Date.now();
    if (now - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatTime = now;
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'PLAY_HEARTBEAT' });
    }
  }

  function triggerSonarSweep() {
    if (!sessionActive) return;
    
    speakText('Sweeping page layout...', true);
    
    const elements = [];
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    cachedInteractiveElements.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.right < 0 || rect.bottom < 0 || rect.left > viewportWidth || rect.top > viewportHeight) {
        return;
      }
      if (rect.width === 0 || rect.height === 0) {
        return;
      }
      
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      const xRatio = (centerX / viewportWidth) * 2 - 1;
      const yRatio = (centerY / viewportHeight) * 2 - 1;
      
      elements.push({ xRatio, yRatio });
    });
    
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'SONAR_SWEEP',
      elements: elements
    });
  }

  // --------------- Cache Re-build triggers ---------------

  window.addEventListener('resize', throttle(updateInteractiveElementsCache, 1000));
  window.addEventListener('scroll', throttle(updateInteractiveElementsCache, 500));

  const observer = new MutationObserver(throttle(updateInteractiveElementsCache, 1000));
  observer.observe(document.body, { childList: true, subtree: true });

  // --------------- Message Handling ---------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SPEECH_RECOGNITION_RESULT') {
      if (commandSubmitted) return;
      commandSubmitted = true;
      voiceListening = false;
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'PLAY_STOP_RECORD' });
      submitSearch(msg.text);
    }

    if (msg.type === 'SPEECH_RECOGNITION_ERROR') {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'PLAY_STOP_RECORD' });
      voiceListening = false;
      if (msg.error === 'no-speech') {
        speakText('I didn\'t hear anything. Double tap shift to try again.', true);
      } else if (msg.error !== 'aborted' && msg.error !== 'not-allowed') {
        speakText('Voice input failed. Double tap shift to try again.', true);
      }
    }

    if (msg.type === 'SPEECH_RECOGNITION_END') {
      voiceListening = false;
    }

    if (msg.type === 'INFERENCE_RESULT') {
      latestResult = msg.data;
      updateLocalBeacon(msg.data);
    }

    if (msg.type === 'SESSION_STARTED' || msg.type === 'START_SESSION') {
      sessionActive = true;
      createVisualCursor();
      updateInteractiveElementsCache();
      unlockAudio();
      speakText('ScreenStream active. Move your cursor to explore the page. Double tap shift to speak a command.', true);
    }

    if (msg.type === 'PAGE_DESCRIPTION') {
      setTimeout(() => {
        speakGuideResponse(msg.description, msg.audio);
      }, 1500);
    }

    if (msg.type === 'AUDIO_ENDED' || msg.type === 'TTS_ENDED') {
      if (activeAudioCallback) {
        const cb = activeAudioCallback;
        activeAudioCallback = null;
        cb();
      }
    }

    if (msg.type === 'SESSION_STOPPED') {
      sessionActive = false;
      stopAudio();
      chrome.runtime.sendMessage({ type: 'STOP_SPEECH' });
      activeAudioCallback = null;
      removeVisualCursor();
      currentTargetCoord = null;
      latestResult = null;
      lastSpokenElement = '';
      lastBeaconElement = '';
      speakText('ScreenStream stopped.');
    }
  });

  chrome.storage.local.get(['sessionActive'], (data) => {
    if (data.sessionActive) {
      sessionActive = true;
      createVisualCursor();
      updateInteractiveElementsCache();
      // Delay audio init to give offscreen time to be ready after navigation
      setTimeout(() => {
        initAudio();
        chrome.runtime.sendMessage({ type: 'PAGE_NAVIGATED' });
      }, 500);
    }
  });
})();
