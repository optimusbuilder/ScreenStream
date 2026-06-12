let room = null;
let mediaStream = null;
let videoTrack = null;

// Audio engine state variables
let audioCtx = null;
let panner = null;
let oscillator = null;
let gainNode = null;
let tickInterval = null;
let audioUnlocked = false;

let confirmOsc = null;
let confirmGain = null;

let activeAudio = null;
let speechActive = false;
let elevenlabsActive = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target && msg.target !== 'offscreen') return;

  if (msg.type === 'start-recording') {
    acquireTabMedia(msg.data);
  }

  if (msg.type === 'PING') {
    chrome.runtime.sendMessage({ type: 'PONG' });
    return;
  }

  if (msg.type === 'PUBLISH_TO_LIVEKIT') {
    publishToLivekit(msg.livekitUrl, msg.livekitToken);
  }

  if (msg.type === 'STOP_CAPTURE') {
    stopCapture();
  }

  if (msg.type === 'INIT_AUDIO' || msg.type === 'UNLOCK_AUDIO') {
    unlockAudio();
  }

  if (msg.type === 'UPDATE_LOCAL_BEACON') {
    handleUpdateLocalBeacon(msg.direction, msg.distance, msg.interactive, msg.element);
  }

  if (msg.type === 'UPDATE_NAVIGATION_BEACON') {
    handleUpdateNavigationBeacon(msg.dx, msg.dy, msg.dist);
  }

  if (msg.type === 'PLAY_LOCKON_SOUND') {
    playLockonSound();
  }

  if (msg.type === 'PLAY_BASE64_AUDIO') {
    playBase64Audio(msg.base64Data, msg.playbackRate);
  }

  if (msg.type === 'STOP_ELEVENLABS') {
    stopElevenLabs();
  }

  if (msg.type === 'SPEECH_STATUS') {
    speechActive = !!msg.active;
  }

  if (msg.type === 'PLAY_HEARTBEAT') {
    playHeartbeat();
  }

  if (msg.type === 'PLAY_START_RECORD') {
    playStartRecordSound();
  }

  if (msg.type === 'PLAY_STOP_RECORD') {
    playStopRecordSound();
  }

  if (msg.type === 'SONAR_SWEEP') {
    playSonarSweep(msg.elements);
  }

  if (msg.type === 'STOP_AUDIO') {
    stopAudio();
  }
});

async function acquireTabMedia(mediaStreamId) {
  try {
    stopCapture();

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: mediaStreamId,
          maxWidth: 854,
          maxHeight: 480,
          maxFrameRate: 15,
        },
      },
    });

    videoTrack = mediaStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('No video track from tab capture');

    console.log('[offscreen] Tab media acquired');
    chrome.runtime.sendMessage({ type: 'MEDIA_ACQUIRED' });
  } catch (err) {
    console.error('[offscreen] Tab media failed:', err);
    chrome.runtime.sendMessage({
      type: 'CAPTURE_ERROR',
      error: err.message || String(err),
    });
  }
}

async function publishToLivekit(livekitUrl, livekitToken) {
  try {
    if (!videoTrack) throw new Error('No tab video track to publish');

    const { Room, RoomEvent, Track } = await import('livekit-client');

    room = new Room({
      adaptiveStream: false,
      dynacast: false,
    });

    room.on(RoomEvent.Disconnected, () => {
      console.log('[offscreen] Disconnected from LiveKit room');
      chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: 'LiveKit disconnected' });
    });

    await room.connect(livekitUrl, livekitToken);

    await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.ScreenShare,
      simulcast: false,
      videoEncoding: {
        maxBitrate: 1_500_000,
        maxFramerate: 15,
      },
    });

    console.log('[offscreen] Publishing tab capture to LiveKit');
    chrome.runtime.sendMessage({ type: 'CAPTURE_READY' });
  } catch (err) {
    console.error('[offscreen] LiveKit publish failed:', err);
    chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: err.message });
  }
}

function stopCapture() {
  stopAudio();
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  videoTrack = null;

  if (room) {
    room.disconnect();
    room = null;
  }
}

// --------------- Spatial Audio Engine & Playback ---------------

function initAudio() {
  if (audioCtx) return;

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

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
  } catch (e) {
    console.error('[offscreen] Failed to initialize AudioContext:', e);
  }
}

function unlockAudio() {
  initAudio();
  if (!audioCtx) return;
  if (audioCtx.state === 'running') {
    audioUnlocked = true;
    return;
  }

  audioCtx.resume().then(() => {
    audioUnlocked = true;
    console.log('[offscreen] AudioContext resumed successfully');
  }).catch((err) => {
    audioUnlocked = false;
    console.warn('[offscreen] AudioContext resume failed:', err);
  });
}

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

function handleUpdateLocalBeacon(dir, dist, interactive, element) {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;

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

    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    gainNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.01);

    lastBeaconElement = element;
    return;
  }

  // --- Directional beacon: pan towards target ---
  if (dist > 200) {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    gainNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.01);
    lastBeaconElement = element;
    return;
  }

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
    if (speechActive || elevenlabsActive) return; // Mute ticks during active speech
    const now = audioCtx.currentTime;
    gainNode.gain.setTargetAtTime(tickGain, now, 0.01);
    gainNode.gain.setTargetAtTime(0, now + 0.05, 0.02);
  }, tickRate);

  lastBeaconElement = element;
}

function handleUpdateNavigationBeacon(dx, dy, dist) {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  
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
    if (speechActive || elevenlabsActive) return; // Mute ticks during active speech
    const now = audioCtx.currentTime;
    gainNode.gain.setTargetAtTime(tickGain, now, 0.01);
    gainNode.gain.setTargetAtTime(0, now + 0.05, 0.02);
  }, tickRate);
}

function playLockonSound() {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  
  const now = audioCtx.currentTime;
  confirmOsc.frequency.setValueAtTime(1000, now);
  confirmGain.gain.setValueAtTime(0, now);
  confirmGain.gain.linearRampToValueAtTime(0.6, now + 0.05);
  confirmGain.gain.linearRampToValueAtTime(0.2, now + 0.15);
  confirmOsc.frequency.setValueAtTime(1300, now + 0.15);
  confirmGain.gain.linearRampToValueAtTime(0.6, now + 0.20);
  confirmGain.gain.linearRampToValueAtTime(0, now + 0.40);
  
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

let pendingAudioData = null;

function playBase64Audio(base64Data, playbackRate = 1.18) {
  try {
    if (activeAudio) {
      activeAudio.pause();
      activeAudio = null;
    }
    
    pendingAudioData = { base64Data, playbackRate };
    
    // If local speech synthesis is active (e.g. "Analyzing visual details..."), wait for it to finish!
    if (speechActive) {
      setTimeout(() => {
        // Only proceed if this specific request is still the pending one (hasn't been cancelled or replaced)
        if (pendingAudioData && pendingAudioData.base64Data === base64Data) {
          playBase64Audio(base64Data, playbackRate);
        }
      }, 100);
      return;
    }
    
    pendingAudioData = null;
    
    // Stop local speech synthesis if any
    chrome.runtime.sendMessage({ type: 'STOP_SPEECH' });
    
    elevenlabsActive = true;
    
    activeAudio = new Audio("data:audio/mp3;base64," + base64Data);
    activeAudio.playbackRate = playbackRate;
    
    activeAudio.onended = () => {
      activeAudio = null;
      elevenlabsActive = false;
      chrome.runtime.sendMessage({ type: 'AUDIO_ENDED' });
    };
    activeAudio.onerror = (err) => {
      console.warn('[offscreen] Audio element error:', err);
      activeAudio = null;
      elevenlabsActive = false;
      chrome.runtime.sendMessage({ type: 'AUDIO_ENDED' });
    };
    
    activeAudio.play().catch((err) => {
      console.warn('[offscreen] Audio play failed:', err);
      activeAudio = null;
      elevenlabsActive = false;
      chrome.runtime.sendMessage({ type: 'AUDIO_ENDED' });
    });
  } catch (err) {
    console.error('[offscreen] playBase64Audio error:', err);
    elevenlabsActive = false;
    chrome.runtime.sendMessage({ type: 'AUDIO_ENDED' });
  }
}

function stopElevenLabs() {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }
  pendingAudioData = null; // Cancel any deferred playback
  elevenlabsActive = false;
}

function playHeartbeat() {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  
  osc.type = 'sine';
  osc.frequency.setValueAtTime(120, audioCtx.currentTime); // 120Hz low hum
  
  gain.gain.setValueAtTime(0, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(0.04, audioCtx.currentTime + 0.02); // very low gain
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
  
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  
  osc.start();
  osc.stop(audioCtx.currentTime + 0.15);
}

function playSonarSweep(elements) {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  
  // Sort elements by xRatio (left to right)
  const sorted = [...elements].sort((a, b) => a.xRatio - b.xRatio);
  
  // Limit to at most 15 elements to avoid audio clutter
  const maxElements = 15;
  const step = Math.max(1, Math.ceil(sorted.length / maxElements));
  const filtered = [];
  for (let i = 0; i < sorted.length && filtered.length < maxElements; i += step) {
    filtered.push(sorted[i]);
  }
  
  const startTime = audioCtx.currentTime + 0.05;
  const timeSpread = 1.2; // sweep spans 1.2 seconds
  const delayStep = filtered.length > 1 ? timeSpread / (filtered.length - 1) : 0;
  
  filtered.forEach((el, index) => {
    const time = startTime + index * delayStep;
    
    // Frequency: map yRatio [-1.0, 1.0] to [440Hz, 1200Hz] (pitch up = top of screen)
    const freq = 1200 - ((el.yRatio + 1.0) / 2.0) * 760; 
    
    // Pan: map xRatio [-1.0, 1.0] to panner X position
    const panX = el.xRatio * 8; 
    
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const pannerNode = audioCtx.createPanner();
    
    pannerNode.panningModel = 'HRTF';
    pannerNode.distanceModel = 'linear';
    pannerNode.positionX.setValueAtTime(panX, time);
    pannerNode.positionZ.setValueAtTime(-3, time);
    
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, time);
    
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.12, time + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.15);
    
    osc.connect(gain);
    gain.connect(pannerNode);
    pannerNode.connect(audioCtx.destination);
    
    osc.start(time);
    osc.stop(time + 0.20);
  });
}

function playStartRecordSound() {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, now); // high pitch A
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.15, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.15);
}

function playStopRecordSound() {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  
  osc.type = 'sine';
  osc.frequency.setValueAtTime(660, now); // E
  osc.frequency.setValueAtTime(880, now + 0.08); // A
  
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.20);
}
