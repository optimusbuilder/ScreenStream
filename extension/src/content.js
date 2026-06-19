(function () {
  if (window.__screenStreamAccessLoaded) return;
  window.__screenStreamAccessLoaded = true;

  const SERVER_URL = 'http://localhost:3000';

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
  let lastVlmElement = null;
  let sessionActive = false;
  let lastHeartbeatTime = 0;
  const HEARTBEAT_INTERVAL_MS = 1500;
  let lastBeaconElement = '';
  let lastClientSideHitTime = 0;
  let hasExploredSincePageLoad = false;

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

  function getStructuralContext(el) {
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      const tag = current.tagName;
      const role = current.getAttribute('role') || '';
      
      if (tag === 'NAV' || role === 'navigation') {
        return 'navigation bar';
      }
      if (tag === 'ASIDE' || role === 'complementary') {
        return 'sidebar';
      }
      if (tag === 'HEADER' || role === 'banner') {
        return 'header';
      }
      if (tag === 'FOOTER' || role === 'contentinfo') {
        return 'footer';
      }
      if (tag === 'MAIN' || role === 'main') {
        return 'main content area';
      }
      current = current.parentElement;
    }
    return '';
  }

  function hasDirectText(el) {
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0) {
        return true;
      }
    }
    return false;
  }

  function describeElementUnderCursor(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    
    // Find structural context
    const context = getStructuralContext(el);
    const contextPhrase = context ? ` in the ${context}` : '';
    
    // Find if it is or is inside an interactive element
    let interactiveEl = null;
    let curr = el;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      if (isInteractive(curr)) {
        interactiveEl = curr;
        break;
      }
      curr = curr.parentElement;
    }
    
    if (interactiveEl) {
      const label = getAccessibilityLabel(interactiveEl);
      const tag = interactiveEl.tagName;
      const role = interactiveEl.getAttribute('role') || '';
      let speech = generateActionableSpeech(label, tag, role, true);
      if (context) {
        speech = `${speech} (located in the ${context})`;
      }
      return {
        element: interactiveEl,
        text: speech,
        label: label,
        interactive: true,
        context: context
      };
    }
    
    // Check if it is a heading
    let headingEl = null;
    curr = el;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(curr.tagName)) {
        headingEl = curr;
        break;
      }
      curr = curr.parentElement;
    }
    if (headingEl) {
      const text = headingEl.textContent ? headingEl.textContent.trim() : '';
      const speech = `${text}${contextPhrase}`;
      return {
        element: headingEl,
        text: speech,
        label: text,
        interactive: false,
        context: context
      };
    }
    
    // Check if it is an image/visual element
    const isVisual = ['IMG', 'CANVAS', 'SVG', 'VIDEO'].includes(el.tagName) || el.getAttribute('role') === 'img';
    if (isVisual) {
      const alt = el.getAttribute('alt') || '';
      const label = alt ? `Image: ${alt.trim()}` : 'Unlabeled image';
      return {
        element: el,
        text: `${label}${contextPhrase}`,
        label: label,
        interactive: false,
        context: context,
        isVisual: true
      };
    }
    
    // Check if it is a text element or contains text
    curr = el;
    let textEl = null;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      const textTags = ['P', 'LI', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'CODE', 'PRE', 'BLOCKQUOTE', 'TD', 'TH'];
      if (textTags.includes(curr.tagName) || (curr.tagName === 'DIV' && hasDirectText(curr))) {
        textEl = curr;
        break;
      }
      curr = curr.parentElement;
    }
    
    if (textEl) {
      const text = textEl.textContent ? textEl.textContent.trim() : '';
      if (text) {
        return {
          element: textEl,
          text: `${text}${contextPhrase}`,
          label: text,
          interactive: false,
          context: context
        };
      }
    }
    
    // Fallback description
    const text = el.textContent ? el.textContent.trim() : '';
    if (text && text.length < 200) {
      return {
        element: el,
        text: `${text}${contextPhrase}`,
        label: text,
        interactive: false,
        context: context
      };
    }
    
    return null;
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
    const desc = describeElementUnderCursor(target);
    if (desc) {
      const rect = desc.element.getBoundingClientRect();
      return {
        element: desc.element,
        rect: rect,
        distance_pixels: 0,
        nearest_actionable_direction: 'ON_OBJECT',
        element_under_cursor: desc.label,
        interactive: desc.interactive,
        full_description: desc.text,
        is_direct_hit: true,
        context: desc.context
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
    // Demo default: keep exploration quiet. Spoken labels carry the guidance.
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
    
    // Visual target remains visible; repeated audio ticks are intentionally disabled.
  }

  // --------------- Speech Announcer ---------------

  let lastSpokenElement = '';
  let lastSpeechTime = 0;
  const CONTINUOUS_SPEECH_INTERVAL_MS = 800;
  const IDLE_SPEECH_INTERVAL_MS = 1200;
  let speechEnabled = true;
  let latestResult = null;
  let narratorSpeaking = false;

  chrome.storage.local.get(['speechEnabled'], (data) => {
    speechEnabled = data.speechEnabled !== false;
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.speechEnabled) {
      speechEnabled = changes.speechEnabled.newValue;
    }
  });

  async function speakText(text, priority = false, onEnd = null) {
    if (!speechEnabled) return;
    if (priority) {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_ELEVENLABS' });
    }

    narratorSpeaking = true;
    const finishNarration = () => {
      narratorSpeaking = false;
      if (onEnd) onEnd();
    };

    try {
      const res = await fetch(`${SERVER_URL}/api/inference/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.audio) {
          playBase64Audio(data.audio, finishNarration);
          return;
        }
      }
    } catch (err) {
      console.warn('[ScreenStream] ElevenLabs narrator failed:', err);
    }

    // Last-resort fallback only. In the happy path, all narration uses ElevenLabs.
    chrome.runtime.sendMessage({
      type: 'SPEAK',
      text,
      priority,
    });
    activeAudioCallback = finishNarration;
  }

  function generateActionableSpeech(label, tag, role, isInteractive) {
    if (!label) return '';
    
    const lowerLabel = label.toLowerCase();
    
    if (!isInteractive) {
      return `${label}.`;
    }
    
    // Interactive links
    if (tag === 'A' || role === 'link') {
      if (lowerLabel.includes('sign in') || lowerLabel.includes('login') || lowerLabel.includes('log in')) {
        return `Clicking this will lead you to the login page to sign into your account.`;
      }
      if (lowerLabel.includes('sign up') || lowerLabel.includes('register') || lowerLabel.includes('create account')) {
        return `Clicking this will lead you to the registration page to create a new account.`;
      }
      if (lowerLabel.includes('cart') || lowerLabel.includes('bag') || lowerLabel.includes('checkout')) {
        return `Clicking this will open your shopping cart to review items and start checkout.`;
      }
      if (lowerLabel.includes('store') || lowerLabel.includes('shop')) {
        return `Clicking this will lead you to the store page to browse all available products.`;
      }
      if (lowerLabel.includes('support') || lowerLabel.includes('help')) {
        return `Clicking this will open the support and help page.`;
      }
      return `Clicking this will navigate you to the ${label} page.`;
    }
    
    // Interactive buttons
    if (tag === 'BUTTON' || role === 'button') {
      if (lowerLabel.includes('search') || lowerLabel.includes('find')) {
        return `Clicking this will submit and search your query.`;
      }
      if (lowerLabel.includes('cart') || lowerLabel.includes('bag') || lowerLabel.includes('add')) {
        return `Clicking this will add the selected product to your shopping cart.`;
      }
      if (lowerLabel.includes('close') || lowerLabel.includes('dismiss')) {
        return `Clicking this will close and dismiss this view.`;
      }
      if (lowerLabel.includes('submit') || lowerLabel.includes('send')) {
        return `Clicking this will submit the form and send your details.`;
      }
      if (lowerLabel.includes('buy') || lowerLabel.includes('purchase')) {
        return `Clicking this will start the purchase flow for this item.`;
      }
      if (lowerLabel.includes('select') || lowerLabel.includes('choose')) {
        return `Clicking this will select this option.`;
      }
      return `Clicking this will activate the ${label} action.`;
    }
    
    // Input fields
    if (tag === 'INPUT') {
      if (lowerLabel.includes('search')) {
        return `Search text field. Type your query here.`;
      }
      if (lowerLabel.includes('email')) {
        return `Email address field. Type your email address.`;
      }
      if (lowerLabel.includes('password')) {
        return `Password field. Type your password securely.`;
      }
      return `Text input field. Type your text here.`;
    }
    
    return `${label}.`;
  }

  function buildSpeechText(result) {
    if (result.full_description) {
      return result.full_description;
    }

    let descriptionText = '';
    if (result.element) {
      const tag = result.element.tagName;
      const role = result.element.getAttribute('role') || '';
      descriptionText = generateActionableSpeech(result.element_under_cursor, tag, role, result.interactive);
    } else {
      descriptionText = result.element_under_cursor;
    }
    
    return descriptionText;
  }

  function announceResult(result, force = false) {
    if (!speechEnabled) return;

    if (!force && narratorSpeaking) return;

    const key = result.full_description || result.element_under_cursor;

    if (!force && key === lastSpokenElement) return;

    lastSpokenElement = key;
    lastSpeechTime = Date.now();

    const text = buildSpeechText(result);
    speakText(text, true);
  }

  function maybeAnnounce() {
    if (!latestResult) return;
    // Only speak automatically during mouse movement if it is a direct hit
    if (latestResult.is_direct_hit) {
      announceResult(latestResult, false);
    }
  }

  let activeAudioCallback = null;

  function playBase64Audio(base64Data, onEndCallback = null) {
    narratorSpeaking = true;
    activeAudioCallback = () => {
      narratorSpeaking = false;
      if (onEndCallback) onEndCallback();
    };
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'PLAY_BASE64_AUDIO',
      base64Data: base64Data,
      playbackRate: 1.0
    });
  }

  function speakNarration(text, base64Audio = null, onEnd = null) {
    if (!speechEnabled) return;
    if (base64Audio) {
      playBase64Audio(base64Audio, onEnd);
    } else {
      speakText(text, true, onEnd);
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

        speakNarration(announceText, response.audio, updatePopup);
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
        announceResult(latestResult, true);
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
        /* Pointer-guided exploration — enhanced with voice commands */
        .ss-mic-indicator {
          position: fixed;
          bottom: 24px;
          right: 24px;
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: hsla(338, 100%, 50%, 0.9);
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
          z-index: 10000001;
          box-shadow: 0 4px 20px rgba(255, 20, 147, 0.5);
          animation: ss-mic-pulse 1.5s infinite;
          transition: opacity 0.2s, transform 0.2s;
        }
        .ss-mic-indicator.ss-mic-hidden {
          opacity: 0;
          transform: scale(0.5);
          pointer-events: none;
        }
        .ss-mic-indicator svg {
          width: 24px;
          height: 24px;
          fill: white;
        }
        .ss-mic-indicator .ss-mic-waves {
          position: absolute;
          width: 100%;
          height: 100%;
          border-radius: 50%;
          border: 2px solid hsla(338, 100%, 50%, 0.6);
          animation: ss-mic-wave 1.5s infinite;
        }
        @keyframes ss-mic-pulse {
          0% { box-shadow: 0 4px 20px rgba(255, 20, 147, 0.5); }
          50% { box-shadow: 0 4px 30px rgba(255, 20, 147, 0.8); }
          100% { box-shadow: 0 4px 20px rgba(255, 20, 147, 0.5); }
        }
        @keyframes ss-mic-wave {
          0% { transform: scale(1); opacity: 0.8; }
          100% { transform: scale(2); opacity: 0; }
        }
        .ss-pointer.ss-animating {
          transition: left 0.5s cubic-bezier(0.4, 0, 0.2, 1), top 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .ss-processing-indicator {
          position: fixed;
          bottom: 24px;
          right: 90px;
          padding: 8px 16px;
          background: hsla(0, 0%, 10%, 0.9);
          color: #e0e0e0;
          border-radius: 20px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
          pointer-events: none;
          z-index: 10000001;
          backdrop-filter: blur(8px);
          border: 1px solid hsla(338, 100%, 50%, 0.3);
          transition: opacity 0.3s, transform 0.3s;
        }
        .ss-processing-indicator.ss-hidden {
          opacity: 0;
          transform: translateY(10px);
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


  // --------------- Mouse Movements ---------------

  window.addEventListener('mousemove', (e) => {
    if (!sessionActive) return;
    hasExploredSincePageLoad = true;
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
        
        chrome.runtime.sendMessage({
          type: 'INFERENCE_RESULT',
          data: {
            element_under_cursor: result.element_under_cursor,
            interactive: result.interactive,
            nearest_actionable_direction: result.nearest_actionable_direction,
            distance_pixels: Math.round(result.distance_pixels),
            full_description: result.full_description,
            is_direct_hit: result.is_direct_hit,
            context: result.context,
            isClientSide: true
          }
        }).catch(() => {});
      }
    }

    mouseIdleTimer = setTimeout(() => {
      mouseStopped = true;
      handleLinger(latestMouse.x, latestMouse.y);
    }, IDLE_THRESHOLD_MS);
  });

  // --------------- Keyboard Shortcuts ---------------

  window.addEventListener('keydown', (e) => {
    if (!sessionActive) return;

    // Alt+Shift+R: Re-read current element
    if (e.altKey && e.shiftKey && e.code === 'KeyR') {
      e.preventDefault();
      if (currentTargetCoord) {
        speakText(`Move toward ${currentTargetCoord.name}. ${currentTargetCoord.description}`, true);
      } else if (latestResult) {
        announceResult(latestResult, true);
      } else {
        speakText('Move your cursor to explore the page.', true);
      }
    }

    // Alt+Shift+V: Describe what you're pointing at (visual lens)
    if (e.altKey && e.shiftKey && e.code === 'KeyV') {
      e.preventDefault();
      requestVlmLens(latestMouse.x, latestMouse.y);
    }

    // Alt+Shift+S: Page layout sonar sweep
    if (e.altKey && e.shiftKey && e.code === 'KeyS') {
      e.preventDefault();
      triggerSonarSweep();
    }

    // Alt+Shift+M: Toggle push-to-talk voice input
    if (e.altKey && e.shiftKey && e.code === 'KeyM') {
      e.preventDefault();
      toggleVoiceInput();
    }
  });

  function triggerHeartbeat() {
    // Repeating background heartbeat was too distracting for the accessibility demo.
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

  // --------------- Page Navigation Awareness ---------------

  let lastKnownUrl = window.location.href;

  // Detect SPA-style navigation (URL changes without full page reload)
  const urlObserver = new MutationObserver(() => {
    if (window.location.href !== lastKnownUrl) {
      lastKnownUrl = window.location.href;
      if (sessionActive) {
        hasExploredSincePageLoad = false;
        updateInteractiveElementsCache();
        chrome.runtime.sendMessage({ type: 'PAGE_NAVIGATED' });
      }
    }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });

  // Also catch popstate (browser back/forward)
  window.addEventListener('popstate', () => {
    if (sessionActive && window.location.href !== lastKnownUrl) {
      lastKnownUrl = window.location.href;
      hasExploredSincePageLoad = false;
      updateInteractiveElementsCache();
      chrome.runtime.sendMessage({ type: 'PAGE_NAVIGATED' });
    }
  });

  // --------------- Message Handling ---------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'INFERENCE_RESULT') {
      if (msg.data.isClientSide) {
        if (msg.data.is_direct_hit) {
          lastClientSideHitTime = Date.now();
        }
      } else {
        // Server-side VLM inference result
        // Ignore if we had a client-side direct hit readout very recently (within 1.5s)
        if (Date.now() - lastClientSideHitTime < 1500) {
          return;
        }
      }

      latestResult = msg.data;
      updateLocalBeacon(msg.data);
      if (sessionActive && !narratorSpeaking) {
        const now = Date.now();
        if (now - lastSpeechTime >= CONTINUOUS_SPEECH_INTERVAL_MS) {
          maybeAnnounce();
        }
      }
    }

    if (msg.type === 'SESSION_STARTED' || msg.type === 'START_SESSION') {
      sessionActive = true;
      hasExploredSincePageLoad = false;
      createVisualCursor();
      updateInteractiveElementsCache();
      unlockAudio();
      speakText('ScreenStream active. Move your cursor to explore.', true);
    }

    if (msg.type === 'PAGE_DESCRIPTION') {
      if (!hasExploredSincePageLoad) {
        setTimeout(() => {
          if (!hasExploredSincePageLoad) {
            speakNarration(msg.description, msg.audio);
          }
        }, 1500);
      }
    }

    if (msg.type === 'AUDIO_ENDED' || msg.type === 'TTS_ENDED') {
      if (activeAudioCallback) {
        const cb = activeAudioCallback;
        activeAudioCallback = null;
        cb();
      } else {
        narratorSpeaking = false;
      }
    }

    if (msg.type === 'SESSION_STOPPED') {
      sessionActive = false;
      stopVoiceInput();
      stopAudio();
      chrome.runtime.sendMessage({ type: 'STOP_SPEECH' });
      activeAudioCallback = null;
      removeVisualCursor();
      removeMicIndicator();
      removeProcessingIndicator();
      currentTargetCoord = null;
      latestResult = null;
      lastSpokenElement = '';
      lastBeaconElement = '';
      lastClientSideHitTime = 0;
      hasExploredSincePageLoad = false;
      speakText('ScreenStream stopped.');
    }

    if (msg.type === 'VOICE_ONSTART') {
      voiceActive = true;
      showMicIndicator();
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_ELEVENLABS' });
      chrome.runtime.sendMessage({ type: 'STOP_SPEECH' });
      narratorSpeaking = false;
      speakText('Listening...', true);
    }

    if (msg.type === 'VOICE_ONRESULT') {
      if (msg.isFinal) {
        hideMicIndicator();
        showProcessingIndicator(`Processing: "${msg.transcript}"`);
        sendVoiceTranscript(msg.transcript);
      } else {
        showProcessingIndicator(`"${msg.transcript}"`);
      }
    }

    if (msg.type === 'VOICE_ONERROR') {
      voiceActive = false;
      hideMicIndicator();
      hideProcessingIndicator();
      if (msg.error === 'permission-request-opened') {
        speakText('Microphone access is required. Please grant permission in the tab that just opened.', true);
      } else if (msg.error === 'not-allowed') {
        speakText('Microphone access was denied. Please allow microphone access in your browser settings.', true);
      } else if (msg.error !== 'aborted' && msg.error !== 'no-speech') {
        speakText('Voice input error. Press Alt Shift M to try again.', true);
      }
    }

    if (msg.type === 'VOICE_ONEND') {
      voiceActive = false;
      hideMicIndicator();
    }

    // Handle conversation response with actions
    if (msg.type === 'CONVERSE_RESULT') {
      hideProcessingIndicator();
      if (msg.reply) {
        speakNarration(msg.reply, msg.audio, () => {
          // After speaking the reply, execute any pending actions
        });
      }
      if (msg.actions && msg.actions.length > 0) {
        executeActionQueue(msg.actions);
      }
    }

    // Execute a single action from the orchestrator
    if (msg.type === 'EXECUTE_ACTION') {
      executeAction(msg.action);
    }
  });

  chrome.storage.local.get(['sessionActive'], (data) => {
    if (data.sessionActive) {
      sessionActive = true;
      hasExploredSincePageLoad = false;
      createVisualCursor();
      updateInteractiveElementsCache();
      // Delay audio init to give offscreen time to be ready after navigation
      setTimeout(() => {
        initAudio();
        chrome.runtime.sendMessage({ type: 'PAGE_NAVIGATED' });
      }, 500);
    }
  });

  window.addEventListener('click', (e) => {
    if (!sessionActive) return;
    const target = e.target;
    if (!target) return;
    
    const desc = describeElementUnderCursor(target);
    if (desc) {
      let actionText = '';
      if (desc.interactive) {
        actionText = desc.text;
      } else {
        actionText = `Selected: ${desc.label}`;
        if (desc.context) {
          actionText += ` in the ${desc.context}`;
        }
      }
      speakText(actionText, true);
    }
  });

  // --------------- Voice Input (Push-to-Talk) ---------------

  let voiceRecognition = null;
  let voiceActive = false;
  let micIndicator = null;
  let processingIndicator = null;

  function createMicIndicator() {
    if (micIndicator) return;
    micIndicator = document.createElement('div');
    micIndicator.className = 'ss-mic-indicator ss-mic-hidden';
    micIndicator.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
      <div class="ss-mic-waves"></div>
    `;
    document.body.appendChild(micIndicator);
  }

  function showMicIndicator() {
    createMicIndicator();
    micIndicator.classList.remove('ss-mic-hidden');
  }

  function hideMicIndicator() {
    if (micIndicator) {
      micIndicator.classList.add('ss-mic-hidden');
    }
  }

  function removeMicIndicator() {
    if (micIndicator) {
      micIndicator.remove();
      micIndicator = null;
    }
  }

  function createProcessingIndicator() {
    if (processingIndicator) return;
    processingIndicator = document.createElement('div');
    processingIndicator.className = 'ss-processing-indicator ss-hidden';
    processingIndicator.textContent = 'Thinking...';
    document.body.appendChild(processingIndicator);
  }

  function showProcessingIndicator(text) {
    createProcessingIndicator();
    processingIndicator.textContent = text || 'Thinking...';
    processingIndicator.classList.remove('ss-hidden');
  }

  function hideProcessingIndicator() {
    if (processingIndicator) {
      processingIndicator.classList.add('ss-hidden');
    }
  }

  function removeProcessingIndicator() {
    if (processingIndicator) {
      processingIndicator.remove();
      processingIndicator = null;
    }
  }

  function toggleVoiceInput() {
    if (voiceActive) {
      stopVoiceInput();
    } else {
      startVoiceInput();
    }
  }

  function startVoiceInput() {
    chrome.runtime.sendMessage({ type: 'START_VOICE_INPUT' });
  }

  function stopVoiceInput() {
    chrome.runtime.sendMessage({ type: 'STOP_VOICE_INPUT' });
    voiceActive = false;
    hideMicIndicator();
  }

  function sendVoiceTranscript(transcript) {
    if (!transcript) return;

    chrome.runtime.sendMessage({
      type: 'VOICE_TRANSCRIPT',
      transcript: transcript,
      cursorX: latestMouse.x,
      cursorY: latestMouse.y,
      currentUrl: window.location.href,
      pageTitle: document.title,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
  }

  // --------------- Autonomous Cursor Animation ---------------

  let animatingCursor = false;

  function animateCursorTo(x, y, durationMs = 500) {
    return new Promise((resolve) => {
      if (!visualCursor) {
        resolve();
        return;
      }

      animatingCursor = true;
      visualCursor.classList.add('ss-animating');

      visualCursor.style.left = `${x}px`;
      visualCursor.style.top = `${y}px`;

      // Update the internal mouse position to match
      latestMouse = { x, y };

      setTimeout(() => {
        visualCursor.classList.remove('ss-animating');
        animatingCursor = false;
        resolve();
      }, durationMs);
    });
  }

  // --------------- Action Execution Engine ---------------

  async function executeAction(action) {
    if (!action) return;

    switch (action.action) {
      case 'click': {
        // Animate cursor to target, then click
        await animateCursorTo(action.x, action.y);
        await new Promise(r => setTimeout(r, 150)); // Brief pause after arrival

        // Dispatch real mouse events at the target
        const target = document.elementFromPoint(action.x, action.y);
        if (target) {
          const events = ['mousedown', 'mouseup', 'click'];
          for (const eventType of events) {
            const event = new MouseEvent(eventType, {
              bubbles: true,
              cancelable: true,
              clientX: action.x,
              clientY: action.y,
              view: window,
            });
            target.dispatchEvent(event);
          }
        }
        break;
      }

      case 'scroll': {
        const amounts = { small: 150, medium: 400, large: 800, page: window.innerHeight };
        const px = amounts[action.amount] || amounts.medium;
        const dirMap = {
          up: [0, -px],
          down: [0, px],
          left: [-px, 0],
          right: [px, 0],
        };
        const [dx, dy] = dirMap[action.direction] || [0, px];
        window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
        break;
      }

      case 'type_text': {
        const focused = document.activeElement;
        if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.isContentEditable)) {
          // Set value for input/textarea
          if (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA') {
            focused.value = action.text;
            focused.dispatchEvent(new Event('input', { bubbles: true }));
            focused.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            focused.textContent = action.text;
            focused.dispatchEvent(new Event('input', { bubbles: true }));
          }

          if (action.pressEnter) {
            setTimeout(() => {
              const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
              });
              focused.dispatchEvent(enterEvent);
              // Also try form submission
              const form = focused.closest('form');
              if (form) {
                form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              }
            }, 100);
          }
        } else {
          // No input focused — try to find and focus the nearest input
          const nearestInput = document.querySelector('input:not([type=hidden]), textarea, [contenteditable="true"]');
          if (nearestInput) {
            nearestInput.focus();
            setTimeout(() => executeAction(action), 200);
          }
        }
        break;
      }

      case 'navigate_back': {
        window.history.back();
        break;
      }

      default:
        console.warn('[ScreenStream] Unknown action type:', action.action);
    }
  }

  async function executeActionQueue(actions) {
    for (const action of actions) {
      await executeAction(action);
      // Brief pause between actions for visual clarity
      await new Promise(r => setTimeout(r, 300));
    }
  }

})();
