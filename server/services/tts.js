const ELEVENLABS_API_KEY = () => process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = () => process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel

async function synthesizeSpeech(text) {
  const apiKey = ELEVENLABS_API_KEY();
  if (!apiKey) {
    return null; // Graceful fallback to local speech synthesis
  }

  const voiceId = ELEVENLABS_VOICE_ID();
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

module.exports = {
  synthesizeSpeech,
};
