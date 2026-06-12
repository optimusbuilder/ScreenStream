const { Router } = require('express');
const overshoot = require('../services/overshoot');

const router = Router();

router.post('/', async (req, res) => {
  const { streamId, mouseX, mouseY } = req.body;

  if (!streamId || mouseX == null || mouseY == null) {
    return res.status(400).json({ error: 'streamId, mouseX, and mouseY are required' });
  }

  try {
    const result = await overshoot.infer(streamId, mouseX, mouseY);
    res.json(result);
  } catch (err) {
    console.error('[inference]', err.status || 500, err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
