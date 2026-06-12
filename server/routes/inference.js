const { Router } = require('express');
const overshoot = require('../services/overshoot');
const tts = require('../services/tts');

const router = Router();

// Per-stream concurrency lock — prevents inference stampede
const inFlightStreams = new Set();

router.post('/', async (req, res) => {
  const { streamId, mouseX, mouseY } = req.body;

  if (!streamId || mouseX == null || mouseY == null) {
    return res.status(400).json({ error: 'streamId, mouseX, and mouseY are required' });
  }

  // If a request is already in-flight for this stream, reject immediately
  if (inFlightStreams.has(streamId)) {
    return res.status(409).json({ error: 'Inference already in progress for this stream' });
  }

  inFlightStreams.add(streamId);

  try {
    const result = await overshoot.infer(streamId, mouseX, mouseY);
    res.json(result);
  } catch (err) {
    console.error('[inference]', err.status || 500, err.message);
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    inFlightStreams.delete(streamId);
  }
});


// One-shot page description for initial orientation
router.post('/describe', async (req, res) => {
  const { streamId } = req.body;

  if (!streamId) {
    return res.status(400).json({ error: 'streamId is required' });
  }

  try {
    const description = await overshoot.describePage(streamId);
    const audio = await tts.synthesizeSpeech(description);
    res.json({ description, audio });
  } catch (err) {
    console.error('[inference/describe]', err.status || 500, err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// VLM-guided spatial element search
router.post('/navigate', async (req, res) => {
  const { streamId, query, width, height } = req.body;

  if (!streamId || !query || width == null || height == null) {
    return res.status(400).json({ error: 'streamId, query, width, and height are required' });
  }

  try {
    const result = await overshoot.navigate(streamId, query, width, height);
    res.json(result);
  } catch (err) {
    console.error('[inference/navigate]', err.status || 500, err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// On-demand element detailed visual description
router.post('/visual-lens', async (req, res) => {
  const { streamId, x, y, context } = req.body;

  if (!streamId || x == null || y == null) {
    return res.status(400).json({ error: 'streamId, x, and y are required' });
  }

  try {
    const description = await overshoot.describeElement(streamId, x, y, context);
    const audio = await tts.synthesizeSpeech(description);
    res.json({ description, audio });
  } catch (err) {
    console.error('[inference/visual-lens]', err.status || 500, err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Conversational Tab Q&A Endpoint
router.post('/ask', async (req, res) => {
  const { streamId, query } = req.body;

  if (!streamId || !query) {
    return res.status(400).json({ error: 'streamId and query are required' });
  }

  try {
    const description = await overshoot.ask(streamId, query);
    const audio = await tts.synthesizeSpeech(description);
    res.json({ description, audio });
  } catch (err) {
    console.error('[inference/ask]', err.status || 500, err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
