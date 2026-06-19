const ELEVENLABS_API_KEY = () => process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = () => process.env.ELEVENLABS_VOICE_ID;

// Cache for dynamically discovered voice ID
let discoveredVoiceId = null;
let discoveryAttempted = false;

/**
 * Auto-discover a usable voice on the free tier.
 * Fetches the /v1/voices endpoint and picks the first "premade" voice.
 */
async function discoverFreeVoice() {
  if (discoveryAttempted) return discoveredVoiceId;
  discoveryAttempted = true;

  const apiKey = ELEVENLABS_API_KEY();
  if (!apiKey) return null;

  try {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
    });

    if (!res.ok) {
      console.warn('[tts] Failed to list ElevenLabs voices:', res.status);
      return null;
    }

    const data = await res.json();
    const voices = data.voices || [];

    // Prefer premade/default voices (these work on free tier)
    const premade = voices.find(v => v.category === 'premade');
    const firstAvailable = premade || voices[0];

    if (firstAvailable) {
      discoveredVoiceId = firstAvailable.voice_id;
      console.log(`[tts] Discovered free voice: "${firstAvailable.name}" (${discoveredVoiceId})`);
      return discoveredVoiceId;
    }

    console.warn('[tts] No voices found on account');
    return null;
  } catch (err) {
    console.error('[tts] Voice discovery failed:', err.message);
    return null;
  }
}

/**
 * Get the best available voice ID:
 * 1. Explicitly configured ELEVENLABS_VOICE_ID (if set and not the broken library voice)
 * 2. Auto-discovered free/premade voice
 * Falls back to null if nothing works.
 */
async function getVoiceId() {
  const configured = ELEVENLABS_VOICE_ID();

  // If no voice configured, auto-discover
  if (!configured) {
    return discoverFreeVoice();
  }

  return configured;
}

async function synthesizeSpeech(text) {
  const apiKey = ELEVENLABS_API_KEY();
  if (!apiKey) {
    return null; // Graceful fallback to local speech synthesis
  }

  const voiceId = await getVoiceId();
  if (!voiceId) {
    console.warn('[tts] No usable voice ID available');
    return null;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));

      // If the configured voice is a paid-only library voice, try auto-discovery
      if (res.status === 402 || res.status === 403) {
        console.warn(`[tts] Voice ${voiceId} requires paid plan. Attempting auto-discovery...`);
        discoveryAttempted = false; // Reset to allow re-discovery
        discoveredVoiceId = null;
        const freeVoice = await discoverFreeVoice();

        if (freeVoice && freeVoice !== voiceId) {
          // Retry with the discovered free voice
          return synthesizeSpeechWithVoice(text, freeVoice, apiKey);
        }
      }

      console.warn('[tts] ElevenLabs synthesis failed status:', res.status, errBody);
      return null;
    }

    const buffer = await res.arrayBuffer();
    const base64Audio = Buffer.from(buffer).toString('base64');
    return base64Audio;
  } catch (err) {
    console.error('[tts] ElevenLabs error:', err.message);
    return null;
  }
}

async function synthesizeSpeechWithVoice(text, voiceId, apiKey) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.warn('[tts] ElevenLabs retry synthesis failed:', res.status, errBody);
      return null;
    }

    const buffer = await res.arrayBuffer();
    const base64Audio = Buffer.from(buffer).toString('base64');
    return base64Audio;
  } catch (err) {
    console.error('[tts] ElevenLabs retry error:', err.message);
    return null;
  }
}

module.exports = {
  synthesizeSpeech,
};
