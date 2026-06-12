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

app.use('/api/session', sessionRoutes);
app.use('/api/inference', inferenceRoutes);

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

app.listen(PORT, () => {
  console.log(`[ScreenStream] Server running on http://localhost:${PORT}`);
  console.log(`[ScreenStream] API key configured: ${!!process.env.OVERSHOOT_API_KEY}`);
});
