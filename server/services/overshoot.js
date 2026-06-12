const BASE_URL = process.env.OVERSHOOT_BASE_URL || 'https://api.overshoot.ai/v1';
const API_KEY = () => process.env.OVERSHOOT_API_KEY;
const MODEL = () => process.env.OVERSHOOT_MODEL || 'Qwen/Qwen3.6-27B-FP8';

// Hosted models on Overshoot's fast path — sub-second TTFT.
const FALLBACK_MODELS = [
  'Qwen/Qwen3.6-27B-FP8',
  'google/gemma-4-26B-A4B-it',
  'Qwen/Qwen3.6-35B-A3B-FP8',
  'google/gemma-4-31B-it',
];

function formatErrorBody(body) {
  if (!body) return 'Unknown error';
  if (typeof body.detail === 'string') return body.detail;
  if (body.detail?.error?.message) return body.detail.error.message;
  if (body.message) return typeof body.message === 'string' ? body.message : JSON.stringify(body.message);
  return JSON.stringify(body);
}

function headers() {
  return {
    'Authorization': `Bearer ${API_KEY()}`,
    'Content-Type': 'application/json',
  };
}

// ---- Fetch with timeout + retry ----

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, options = {}, { timeoutMs = 15000, retries = 3, backoffMs = [500, 1000, 2000] } = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);

      // Don't retry client errors (4xx) except 429
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        return res;
      }

      // Retry on 503 / 429 / 5xx
      const body = await res.json().catch(() => ({}));
      lastError = new OvershotError(res.status, formatErrorBody(body) || `HTTP ${res.status}`);
      console.warn(`[overshoot] Attempt ${attempt + 1}/${retries} failed: ${res.status} — retrying in ${backoffMs[attempt] || 2000}ms`);
    } catch (err) {
      lastError = err.name === 'AbortError'
        ? new OvershotError(504, 'Request timed out')
        : new OvershotError(502, err.message || 'Network error');
      console.warn(`[overshoot] Attempt ${attempt + 1}/${retries} failed: ${lastError.message} — retrying`);
    }

    if (attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, backoffMs[attempt] || 2000));
    }
  }
  throw lastError;
}

// ---- Stream lifecycle ----

async function createStream() {
  const res = await fetchWithRetry(`${BASE_URL}/streams`, {
    method: 'POST',
    headers: headers(),
  }, { retries: 3, backoffMs: [1000, 2000, 4000] });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OvershotError(res.status, formatErrorBody(body) || 'Failed to create stream');
  }

  return res.json();
}

async function keepalive(streamId) {
  const res = await fetchWithRetry(`${BASE_URL}/streams/${streamId}/keepalive`, {
    method: 'POST',
    headers: headers(),
  }, { retries: 3, backoffMs: [1000, 1000, 1000] });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OvershotError(res.status, formatErrorBody(body) || 'Keepalive failed');
  }

  return res.json();
}

async function deleteStream(streamId) {
  const res = await fetchWithTimeout(`${BASE_URL}/streams/${streamId}`, {
    method: 'DELETE',
    headers: headers(),
  }, 10000);

  if (res.status === 404) return { deleted: true };

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OvershotError(res.status, formatErrorBody(body) || 'Delete failed');
  }

  return { deleted: true };
}

async function getStreamStatus(streamId) {
  const res = await fetchWithTimeout(`${BASE_URL}/streams/${streamId}`, {
    method: 'GET',
    headers: headers(),
  }, 10000);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OvershotError(res.status, formatErrorBody(body) || 'Failed to get stream status');
  }

  return res.json();
}

// ---- Inference ----

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    element_under_cursor: { type: 'string' },
    interactive: { type: 'boolean' },
    nearest_actionable_direction: {
      type: 'string',
      enum: ['N', 'S', 'E', 'W', 'ON_OBJECT'],
    },
    distance_pixels: { type: 'number' },
  },
  required: ['element_under_cursor', 'interactive', 'nearest_actionable_direction', 'distance_pixels'],
};

async function infer(streamId, mouseX, mouseY) {
  const prompt = `You are an instantaneous web accessibility navigator. The user is hovering their mouse at current viewport coordinates: X=${mouseX}, Y=${mouseY}. Analyze the current live tab frame. Determine exactly what visual or functional interface element is located directly beneath or nearest to those coordinates. Output strict JSON matching the schema format.`;

  const models = [MODEL(), ...FALLBACK_MODELS.filter((m) => m !== MODEL())];

  let lastError;
  for (const model of models) {
    try {
      const res = await fetchWithRetry(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: `ovs://streams/${streamId}?frame_index=-1`,
                  },
                },
              ],
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'spatial_nav',
              strict: true,
              schema: OUTPUT_SCHEMA,
            },
          },
          max_tokens: 150,
        }),
      }, { timeoutMs: 12000, retries: 2, backoffMs: [500, 1000] });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        lastError = new OvershotError(res.status, formatErrorBody(body) || 'Inference failed');
        if (res.status === 503) {
          console.warn(`[overshoot] Model ${model} returned 503, trying next model`);
          continue;
        }
        throw lastError;
      }

      const completion = await res.json();
      const raw = completion.choices?.[0]?.message?.content;

      if (!raw) {
        throw new OvershotError(500, 'Empty completion response');
      }

      return JSON.parse(raw);
    } catch (err) {
      lastError = err;
      if (err.status === 503 || err.status === 504 || err.status === 502) {
        console.warn(`[overshoot] Model ${model} failed (${err.status}), trying next`);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new OvershotError(503, 'All models failed');
}


// ---- Navigation & Landmark Location ----

const NAVIGATE_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    x: { type: 'number' },
    y: { type: 'number' },
    element_name: { type: 'string' },
    guidance: { type: 'string' },
  },
  required: ['found', 'x', 'y', 'element_name', 'guidance'],
};

async function navigate(streamId, query, width, height) {
  const prompt = `You are an AI web accessibility assistant helping a user locate an element on the screen. The user is asking to find: "${query}". The current viewport dimensions are ${width} width by ${height} height. Analyze the current live tab frame. Locate the target element. If found, return its center coordinates X and Y in viewport pixels (0 to ${width} and 0 to ${height}), its name/label, and brief direction/guidance (e.g. "near the top right"). If not found, set "found" to false, and set x and y to 0.`;

  const models = [MODEL(), ...FALLBACK_MODELS.filter((m) => m !== MODEL())];

  let lastError;
  for (const model of models) {
    try {
      const res = await fetchWithRetry(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: `ovs://streams/${streamId}?frame_index=-1`,
                  },
                },
              ],
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'navigate_landmark',
              strict: true,
              schema: NAVIGATE_SCHEMA,
            },
          },
          max_tokens: 150,
        }),
      }, { timeoutMs: 12000, retries: 2, backoffMs: [500, 1000] });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        lastError = new OvershotError(res.status, formatErrorBody(body) || 'Navigation failed');
        if (res.status === 503) {
          console.warn(`[overshoot] Model ${model} returned 503 during navigation, trying next model`);
          continue;
        }
        throw lastError;
      }

      const completion = await res.json();
      const raw = completion.choices?.[0]?.message?.content;

      if (!raw) {
        throw new OvershotError(500, 'Empty completion response');
      }

      return JSON.parse(raw);
    } catch (err) {
      lastError = err;
      if (err.status === 503 || err.status === 504 || err.status === 502) {
        console.warn(`[overshoot] Model ${model} failed navigation (${err.status}), trying next`);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new OvershotError(503, 'All models failed navigation');
}

// ---- Describe Element (Visual Lens) ----

async function describeElement(streamId, x, y, context = null) {
  let prompt = `You are a web accessibility visual assistant. The user is hovering their mouse at coordinates X=${x}, Y=${y}. Analyze the live video stream frame and identify the image, chart, canvas, or visual element located at these coordinates (marked visually by a pink target ring).`;

  if (context) {
    prompt += `\nHere is the metadata of the element under the cursor from the DOM to help anchor your description and avoid hallucinations:`;
    if (context.tagName) prompt += `\nHTML Tag: ${context.tagName}`;
    if (context.alt) prompt += `\nAlt Text: ${context.alt}`;
    if (context.outerHTML) prompt += `\nOuter HTML Snippet: ${context.outerHTML}`;
    if (context.textContext) prompt += `\nSurrounding Card Text: ${context.textContext}`;
  }

  prompt += `\nDescribe the visual content of this element in detail (e.g. if it is a photo, describe what is in the photo; if it is a chart, describe what it depicts and any visible values or trend). Use the DOM context metadata to ground your description accurately. Be extremely descriptive but concise — keep your answer to exactly 1 or 2 sentences maximum.`;

  const res = await fetchWithRetry(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: MODEL(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `ovs://streams/${streamId}?frame_index=-1`,
              },
            },
          ],
        },
      ],
      max_tokens: 200,
    }),
  }, { timeoutMs: 15000, retries: 2, backoffMs: [1000, 2000] });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OvershotError(res.status, formatErrorBody(body) || 'Describe element failed');
  }

  const completion = await res.json();
  const raw = completion.choices?.[0]?.message?.content;

  if (!raw) {
    throw new OvershotError(500, 'Empty description response');
  }

  return raw;
}

// ---- Page description for initial orientation ----

async function describePage(streamId) {
  const prompt = `You are a web accessibility assistant helping a blind user understand a web page. Describe the overall layout of this web page concisely. List the main sections, navigation areas, and key interactive elements from top to bottom. Be brief — 2 to 3 sentences maximum. Start with the page title or site name if visible.`;

  const res = await fetchWithRetry(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: MODEL(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `ovs://streams/${streamId}?frame_index=-1`,
              },
            },
          ],
        },
      ],
      max_tokens: 200,
    }),
  }, { timeoutMs: 15000, retries: 2, backoffMs: [1000, 2000] });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OvershotError(res.status, formatErrorBody(body) || 'Describe failed');
  }

  const completion = await res.json();
  const raw = completion.choices?.[0]?.message?.content;

  if (!raw) {
    throw new OvershotError(500, 'Empty description response');
  }

  return raw;
}

// ---- Q&A / Conversational Tab Query ----

async function ask(streamId, query) {
  const prompt = `You are a conversational web accessibility partner for a blind user. The user is asking the following question about the current web page: "${query}". Analyze the live page frame. Answer their question concisely, accurately, and clearly. Keep the explanation user-friendly and limit your response to at most 3 sentences.`;

  const res = await fetchWithRetry(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: MODEL(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `ovs://streams/${streamId}?frame_index=-1`,
              },
            },
          ],
        },
      ],
      max_tokens: 250,
    }),
  }, { timeoutMs: 15000, retries: 2, backoffMs: [1000, 2000] });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OvershotError(res.status, formatErrorBody(body) || 'Q&A request failed');
  }

  const completion = await res.json();
  const raw = completion.choices?.[0]?.message?.content;

  if (!raw) {
    throw new OvershotError(500, 'Empty conversational response');
  }

  return raw;
}

// ---- Frame waiting ----

async function waitForFrames(streamId, { timeoutMs = 30000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await getStreamStatus(streamId);
    if (status.last_frame_at_ms != null) {
      return status;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new OvershotError(408, 'Timed out waiting for first video frame');
}

async function listModels() {
  const res = await fetchWithTimeout(`${BASE_URL}/models`, {
    method: 'GET',
  }, 10000);

  if (!res.ok) {
    throw new OvershotError(res.status, 'Failed to list models');
  }

  return res.json();
}

class OvershotError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'OvershotError';
    this.status = status;
  }
}

module.exports = {
  createStream,
  keepalive,
  deleteStream,
  getStreamStatus,
  waitForFrames,
  infer,
  navigate,
  describeElement,
  describePage,
  ask,
  listModels,
  OvershotError,
};

