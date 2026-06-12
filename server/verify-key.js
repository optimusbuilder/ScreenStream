require('dotenv').config();

const BASE_URL = process.env.OVERSHOOT_BASE_URL || 'https://api.overshoot.ai/v1';
const API_KEY = process.env.OVERSHOOT_API_KEY;

async function verify() {
  console.log('=== ScreenStream-Access Key Verification ===\n');

  if (!API_KEY) {
    console.error('FAIL: No OVERSHOOT_API_KEY found in .env');
    console.error('  → Copy .env.example to .env and paste your ovs-... key');
    process.exit(1);
  }

  console.log(`Key: ${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)}`);
  console.log(`Base URL: ${BASE_URL}\n`);

  // 1. List models (unauthenticated)
  console.log('[1/3] Listing available models...');
  try {
    const res = await fetch(`${BASE_URL}/models`);
    const data = await res.json();
    const models = data.data || data;
    const ready = Array.isArray(models) ? models.filter((m) => m.ready !== false) : [];
    console.log(`  OK: ${ready.length} model(s) available`);
    ready.forEach((m) => console.log(`    - ${m.id}`));
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
  }

  // 2. Create a test stream (authenticated)
  console.log('\n[2/3] Creating test stream...');
  let streamId = null;
  try {
    const res = await fetch(`${BASE_URL}/streams`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`${res.status} — ${body.detail || JSON.stringify(body)}`);
    }

    const stream = await res.json();
    streamId = stream.id;
    console.log(`  OK: Stream created (${streamId})`);
    console.log(`  LiveKit URL: ${stream.publish.url}`);
    console.log(`  TTL: ${stream.ttl_seconds}s`);
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
    if (err.message.includes('402')) {
      console.error('  → Your account may need credits. Check the Overshoot dashboard.');
    }
    process.exit(1);
  }

  // 3. Clean up — delete the test stream
  console.log('\n[3/3] Cleaning up test stream...');
  try {
    await fetch(`${BASE_URL}/streams/${streamId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    console.log('  OK: Stream deleted');
  } catch (err) {
    console.log(`  WARN: Cleanup failed (${err.message}) — stream will auto-expire`);
  }

  console.log('\n=== All checks passed. You are ready to go. ===');
}

verify();
