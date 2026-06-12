const { Router } = require('express');
const overshoot = require('../services/overshoot');

const router = Router();

router.post('/init', async (req, res) => {
  try {
    const stream = await overshoot.createStream();

    res.status(201).json({
      streamId: stream.id,
      livekitUrl: stream.publish.url,
      livekitToken: stream.publish.token,
      expiresAt: stream.expires_at_ms,
      ttl: stream.ttl_seconds,
    });
  } catch (err) {
    console.error('[session/init]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/keepalive', async (req, res) => {
  const { streamId } = req.body;

  if (!streamId) {
    return res.status(400).json({ error: 'streamId is required' });
  }

  try {
    const result = await overshoot.keepalive(streamId);
    res.json(result);
  } catch (err) {
    console.error('[session/keepalive]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await overshoot.deleteStream(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[session/delete]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/:id/wait-for-frames', async (req, res) => {
  try {
    const status = await overshoot.waitForFrames(req.params.id);
    res.json(status);
  } catch (err) {
    console.error('[session/wait-for-frames]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/:id/status', async (req, res) => {
  try {
    const status = await overshoot.getStreamStatus(req.params.id);
    res.json(status);
  } catch (err) {
    console.error('[session/status]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
