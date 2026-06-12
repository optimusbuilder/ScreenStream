const BASE_URL = process.env.OVERSHOOT_BASE_URL || 'https://api.overshoot.ai/v1';
const API_KEY = () => process.env.OVERSHOOT_API_KEY;
const MODEL = () => process.env.OVERSHOOT_MODEL || 'google/gemma-4-E2B-it';

function headers() {
  return {
    'Authorization': `Bearer ${API_KEY()}`,
    'Content-Type': 'application/json',
  };
}

async function createStream() {
  const res = await fetch(`${BASE_URL}/streams`, {
    method: 'POST',
    headers: headers(),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OvershotError(res.status, body.detail || 'Failed to create stream');
  }

  return res.json();
}

async function keepalive(streamId) {
  const res = await fetch(`${BASE_URL}/streams/${streamId}/keepalive`, {
    method: 'POST',
    headers: headers(),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OvershotError(res.status, body.detail || 'Keepalive failed');
  }

  return res.json();
}

async function deleteStream(streamId) {
  const res = await fetch(`${BASE_URL}/streams/${streamId}`, {
    method: 'DELETE',
    headers: headers(),
  });

  if (res.status === 404) return { deleted: true };

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OvershotError(res.status, body.detail || 'Delete failed');
  }

  return { deleted: true };
}

async function getStreamStatus(streamId) {
  const res = await fetch(`${BASE_URL}/streams/${streamId}`, {
    method: 'GET',
    headers: headers(),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OvershotError(res.status, body.detail || 'Failed to get stream status');
  }

  return res.json();
}

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

  const res = await fetch(`${BASE_URL}/chat/completions`, {
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
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OvershotError(res.status, body.detail || body.message || 'Inference failed');
  }

  const completion = await res.json();
  const raw = completion.choices?.[0]?.message?.content;

  if (!raw) {
    throw new OvershotError(500, 'Empty completion response');
  }

  return JSON.parse(raw);
}

async function listModels() {
  const res = await fetch(`${BASE_URL}/models`, {
    method: 'GET',
  });

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
  infer,
  listModels,
  OvershotError,
};
