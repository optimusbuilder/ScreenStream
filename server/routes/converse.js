/**
 * Conversation Route — /api/converse
 * 
 * Single endpoint for all voice interactions. Receives the user's
 * speech transcript, runs it through the Gemini orchestrator, and
 * returns a spoken response + any DOM actions to execute.
 */

const { Router } = require('express');
const orchestrator = require('../services/orchestrator');
const tts = require('../services/tts');
const memory = require('../services/memory');

const router = Router();

/**
 * POST /api/converse
 * 
 * Body:
 *   streamId: string         — Overshoot stream ID
 *   transcript: string       — User's spoken words
 *   cursorX: number          — Current cursor X position
 *   cursorY: number          — Current cursor Y position
 *   currentUrl: string       — Current page URL
 *   pageTitle: string        — Current page title
 *   viewportWidth: number    — Viewport width in pixels
 *   viewportHeight: number   — Viewport height in pixels
 * 
 * Response:
 *   reply: string            — Text response to speak
 *   audio: string|null       — Base64 encoded audio (ElevenLabs)
 *   actions: array           — DOM actions for the content script to execute
 */
router.post('/', async (req, res) => {
  const {
    streamId,
    transcript,
    cursorX,
    cursorY,
    currentUrl,
    pageTitle,
    viewportWidth,
    viewportHeight,
  } = req.body;

  if (!streamId || !transcript) {
    return res.status(400).json({ error: 'streamId and transcript are required' });
  }

  console.log(`[converse] User: "${transcript}"`);

  try {
    const { reply, actions } = await orchestrator.converse(streamId, transcript, {
      cursorX,
      cursorY,
      url: currentUrl,
      title: pageTitle,
      viewportWidth: viewportWidth || 1280,
      viewportHeight: viewportHeight || 720,
    });

    console.log(`[converse] Reply: "${reply.substring(0, 100)}${reply.length > 100 ? '...' : ''}"`);
    if (actions.length > 0) {
      console.log(`[converse] Actions:`, actions.map(a => a.action));
    }

    // Generate TTS audio for the response
    const audio = await tts.synthesizeSpeech(reply);

    res.json({
      reply,
      audio,
      actions,
    });
  } catch (err) {
    console.error('[converse]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
