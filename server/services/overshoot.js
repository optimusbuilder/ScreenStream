const BASE_URL = process.env.OVERSHOOT_BASE_URL || 'https://api.overshoot.ai/v1';
const API_KEY = () => process.env.OVERSHOOT_API_KEY;
const MODEL = () => process.env.OVERSHOOT_MODEL || 'Qwen/Qwen3.6-27B-FP8';

// Stateful message history for the conversational guide
const sessionHistories = {};

function getSessionHistory(streamId) {
  if (!sessionHistories[streamId]) {
    sessionHistories[streamId] = [];
  }
  return sessionHistories[streamId];
}

function addMessageToHistory(streamId, role, content) {
  const history = getSessionHistory(streamId);
  history.push({ role, content });
  if (history.length > 6) {
    history.shift();
  }
}

const SYSTEM_PROMPT = `You are a warm, proactive, and friendly museum tour guide helping a blind friend explore a website. Speak directly and colloquially to them (e.g. "Welcome to...", "You're pointing at...", "Let's explore..."). Keep descriptions concise (1-2 sentences) but extremely helpful. Answer their questions warmly, and if appropriate, proactively suggest next steps or ask encouraging questions to guide them.`;

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
  delete sessionHistories[streamId]; // Clear conversational history
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

// ---- Chat Completion Helper with Model Fallbacks & History ----

async function chatWithVlm(streamId, prompt, maxTokens) {
  // Add current query/description context to conversation history
  addMessageToHistory(streamId, 'user', prompt);

  const modelsToTry = [MODEL(), ...FALLBACK_MODELS.filter(m => m !== MODEL())];
  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const history = getSessionHistory(streamId);
      const apiMessages = [
        { role: 'system', content: SYSTEM_PROMPT }
      ];

      // Format previous conversation turns as plain text
      for (let i = 0; i < history.length - 1; i++) {
        apiMessages.push({
          role: history[i].role,
          content: history[i].content
        });
      }

      // Add the latest query with the live VLM frame
      const latestMsg = history[history.length - 1];
      apiMessages.push({
        role: 'user',
        content: [
          { type: 'text', text: latestMsg.content },
          {
            type: 'image_url',
            image_url: {
              url: `ovs://streams/${streamId}?frame_index=-1`,
            },
          },
        ]
      });

      const res = await fetchWithRetry(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          model: model,
          messages: apiMessages,
          max_tokens: maxTokens,
        }),
      }, { timeoutMs: 12000, retries: 2, backoffMs: [500, 1000] });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new OvershotError(res.status, formatErrorBody(body) || `Model ${model} failed`);
      }

      const completion = await res.json();
      const raw = completion.choices?.[0]?.message?.content;

      if (!raw) {
        throw new OvershotError(500, `Empty response from model ${model}`);
      }

      // Store assistant's response in history
      addMessageToHistory(streamId, 'assistant', raw);
      return raw;
    } catch (err) {
      lastError = err;
      console.warn(`[overshoot] Model ${model} failed chat completion: ${err.message}. Trying next.`);
    }
  }

  // Roll back the user message if all attempts failed
  const history = getSessionHistory(streamId);
  if (history.length > 0 && history[history.length - 1].role === 'user') {
    history.pop();
  }

  throw lastError || new OvershotError(503, 'All models failed chat completion');
}

// ---- Describe Element (Visual Lens) ----

async function describeElement(streamId, x, y, context = null) {
  let prompt = `The user is hovering their cursor at coordinates X=${x}, Y=${y} (marked on the screen frame by a pink ring). Analyze this live video frame, identify the specific image, card, photo, or visual element they are pointing at, and describe it conversationally. Speak directly to them like a friend (e.g. "You're pointing at..." or "Here is..."). Be descriptive but keep your response to exactly 1 or 2 friendly, colloquial sentences maximum.`;

  if (context) {
    prompt += `\nHere is the metadata of the element under the cursor from the DOM to help anchor your description:`;
    if (context.tagName) prompt += `\nHTML Tag: ${context.tagName}`;
    if (context.alt) prompt += `\nAlt Text: ${context.alt}`;
    if (context.outerHTML) prompt += `\nOuter HTML Snippet: ${context.outerHTML}`;
    if (context.textContext) prompt += `\nSurrounding Card Text: ${context.textContext}`;
  }

  return chatWithVlm(streamId, prompt, 120);
}

// ---- Page description for initial orientation ----

async function describePage(streamId) {
  const prompt = `Describe the overall layout and purpose of this webpage concisely and colloquially in 2 to 3 sentences maximum. Start with a warm greeting and mention the website name if visible (e.g., "Welcome to Amazon! We're looking at the homepage..."). Always end your description with an encouraging, proactive question to guide them (e.g., "What should we explore first?" or "What are you looking to find today?").`;

  return chatWithVlm(streamId, prompt, 120);
}

// ---- Q&A / Conversational Tab Query ----

async function ask(streamId, query) {
  const prompt = `The user is asking you: "${query}". Analyze the live page frame and answer their question warmly, clearly, and concisely, speaking directly to them. Keep your explanation extremely user-friendly and limit it to at most 2 or 3 sentences maximum. If they are asking about an item, describe it and proactively ask a follow-up question (e.g., "Would you like me to click on it?").`;

  return chatWithVlm(streamId, prompt, 150);
}

// ---- Frame waiting ----

async function waitForFrames(streamId, { timeoutMs = 45000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (Date.now() < deadline) {
    const status = await getStreamStatus(streamId);
    attempts++;
    if (status.last_frame_at_ms != null) {
      console.log(`[overshoot] First frame received after ${attempts} polls (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)`);
      return status;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new OvershotError(408, `Timed out waiting for first video frame after ${timeoutMs / 1000}s (${attempts} polls)`);
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

