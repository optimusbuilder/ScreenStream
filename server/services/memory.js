/**
 * Conversation Memory Service
 * 
 * Maintains per-session conversation state including message history,
 * page context, last actions, and cursor position. This enables contextual
 * follow-ups like "click THAT one" or "what was that button you mentioned?"
 */

const MAX_HISTORY_LENGTH = 20;

// Session state keyed by streamId
const sessions = {};

function getSession(streamId) {
  if (!sessions[streamId]) {
    sessions[streamId] = {
      messages: [],          // { role: 'user'|'assistant'|'system', content: string }
      currentPage: {
        url: '',
        title: '',
        lastDescription: '',
      },
      lastAction: null,      // { type, target, coordinates, timestamp, result }
      cursorPosition: { x: 0, y: 0 },
      userPreferences: {
        verbosity: 'normal', // 'brief' | 'normal' | 'detailed'
        speechRate: 1.0,
      },
      createdAt: Date.now(),
    };
  }
  return sessions[streamId];
}

function addMessage(streamId, role, content) {
  const session = getSession(streamId);
  session.messages.push({
    role,
    content,
    timestamp: Date.now(),
  });

  // Trim old messages but keep system messages
  while (session.messages.length > MAX_HISTORY_LENGTH) {
    // Find the first non-system message to remove
    const idx = session.messages.findIndex(m => m.role !== 'system');
    if (idx >= 0) {
      session.messages.splice(idx, 1);
    } else {
      session.messages.shift();
    }
  }
}

function getMessages(streamId) {
  const session = getSession(streamId);
  return session.messages;
}

function updatePageContext(streamId, { url, title, description } = {}) {
  const session = getSession(streamId);
  if (url !== undefined) session.currentPage.url = url;
  if (title !== undefined) session.currentPage.title = title;
  if (description !== undefined) session.currentPage.lastDescription = description;
}

function updateCursorPosition(streamId, x, y) {
  const session = getSession(streamId);
  session.cursorPosition = { x, y };
}

function recordAction(streamId, action) {
  const session = getSession(streamId);
  session.lastAction = {
    ...action,
    timestamp: Date.now(),
  };
}

function updatePreferences(streamId, prefs) {
  const session = getSession(streamId);
  Object.assign(session.userPreferences, prefs);
}

function getContext(streamId) {
  const session = getSession(streamId);
  return {
    currentPage: session.currentPage,
    lastAction: session.lastAction,
    cursorPosition: session.cursorPosition,
    preferences: session.userPreferences,
  };
}

function clearSession(streamId) {
  delete sessions[streamId];
}

/**
 * Build a context summary string for the orchestrator LLM.
 * This gives the model situational awareness on each turn.
 */
function buildContextSummary(streamId) {
  const session = getSession(streamId);
  const parts = [];

  if (session.currentPage.url) {
    parts.push(`Current page: ${session.currentPage.title || 'Unknown'} (${session.currentPage.url})`);
  }

  if (session.currentPage.lastDescription) {
    // Truncate to keep context manageable
    const desc = session.currentPage.lastDescription;
    const truncated = desc.length > 500 ? desc.substring(0, 500) + '...' : desc;
    parts.push(`Page overview: ${truncated}`);
  }

  if (session.lastAction) {
    const a = session.lastAction;
    const ago = Math.round((Date.now() - a.timestamp) / 1000);
    parts.push(`Last action (${ago}s ago): ${a.type} on "${a.target || 'unknown'}" at (${a.coordinates?.x || '?'}, ${a.coordinates?.y || '?'})`);
    if (a.result) {
      parts.push(`Action result: ${a.result}`);
    }
  }

  parts.push(`Cursor position: (${session.cursorPosition.x}, ${session.cursorPosition.y})`);
  parts.push(`Verbosity preference: ${session.userPreferences.verbosity}`);

  return parts.join('\n');
}

module.exports = {
  getSession,
  addMessage,
  getMessages,
  updatePageContext,
  updateCursorPosition,
  recordAction,
  updatePreferences,
  getContext,
  clearSession,
  buildContextSummary,
};
