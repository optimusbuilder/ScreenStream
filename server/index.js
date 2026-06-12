require('dotenv').config();

const express = require('express');
const cors = require('cors');
const sessionRoutes = require('./routes/session');
const inferenceRoutes = require('./routes/inference');
const overshoot = require('./services/overshoot');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

function requireApiKey(req, res, next) {
  if (!process.env.OVERSHOOT_API_KEY) {
    return res.status(503).json({
      error: 'OVERSHOOT_API_KEY is not configured. Add it to server/.env and restart.',
    });
  }
  next();
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', hasApiKey: !!process.env.OVERSHOOT_API_KEY });
});

app.get('/api/models', async (_req, res) => {
  try {
    const models = await overshoot.listModels();
    res.json(models);
  } catch (err) {
    console.error('[models]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.use('/api/session', requireApiKey, sessionRoutes);
app.use('/api/inference', requireApiKey, inferenceRoutes);

app.listen(PORT, () => {
  console.log(`[ScreenStream] Server running on http://localhost:${PORT}`);
  if (!process.env.OVERSHOOT_API_KEY) {
    console.warn('[ScreenStream] WARNING: No OVERSHOOT_API_KEY set. Session and inference endpoints will return 503.');
    console.warn('[ScreenStream] Copy server/.env.example to server/.env and add your key.');
  } else {
    console.log('[ScreenStream] API key configured');
  }
});
