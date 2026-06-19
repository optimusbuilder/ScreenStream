/**
 * Orchestrator Service — Gemini Flash with Function Calling
 * 
 * This is the "brain" of the conversational tour guide. It receives the user's
 * voice transcript + session context and decides what to do:
 * - Answer questions about the page (using VLM)
 * - Find and navigate to elements (using VLM)
 * - Execute actions (click, scroll, type)
 * - Describe what's under the cursor (using VLM)
 * 
 * Uses Gemini Flash for fast, cheap intent classification and conversation,
 * and calls Overshoot VLM as a tool when visual information is needed.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const overshoot = require('./overshoot');
const memory = require('./memory');

const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY;
const GEMINI_MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const SYSTEM_INSTRUCTION = `You are ScreenStream, a warm and intelligent conversational tour guide helping a blind user navigate a website entirely hands-free. You speak directly to them using clear, imperative language.

CORE PRINCIPLES:
- You ARE the user's eyes. Describe what you see with confidence and specificity.
- Give clear, actionable guidance. Say "Click the blue Sign In button in the top right" not "There appears to be a button."
- When the user asks you to do something, DO IT. Don't ask for confirmation unless the action is destructive (e.g., deleting an account, making a purchase).
- Maintain conversational continuity. Remember what you've discussed and reference it naturally.
- Keep responses concise (1-3 sentences) unless the user asks for detail or it's a page description.
- Never say "I can't see" or "I don't have access." You CAN see — you have a live view of their screen.

RESPONSE STYLE:
- Use warm, direct language: "You're on the Amazon homepage. The search bar is at the top center — I can type your search for you."
- For navigation: "Moving your cursor to the Settings gear icon in the top right corner."
- For actions: "Done! I've clicked the Unsubscribe button. The page now shows a confirmation message."
- For questions: "This page is the account settings panel. From here you can change your password, update your email, or manage subscriptions."

CONTEXTUAL FOLLOW-UPS:
- When the user says "that one", "this", "it", refer to the last element you discussed or acted on.
- When they say "the other one", "no, the next one", look for alternative matches.
- When they say "click it", "open it", "select it", act on the most recently mentioned element.
- Use the conversation history and "Last action" in the session context to resolve these references.

VERBOSITY CONTROL:
- If the user says "be brief", "less detail", "shorter", use set_verbosity with "brief" — then give 1-sentence answers.
- If the user says "more detail", "explain more", "tell me everything", use set_verbosity with "detailed".
- If the user says "normal", reset to default 1-3 sentence responses.
- Check the current verbosity preference in the session context and adapt accordingly.

UNDO & NAVIGATION:
- "Go back", "undo", "previous page" → use navigate_back.
- "Start over", "go to the homepage" → use find_element to locate the home/logo link and click it.

WHEN TO USE TOOLS:
- Use describe_screen when the user asks "what's on this page?", "where am I?", or you need to orient yourself.
- Use find_element when the user mentions a specific UI element to interact with.
- Use describe_element when the user asks about something specific they're pointing at.
- Use click, scroll, or type_text when the user asks you to perform an action.
- Use navigate_back when the user says "go back" or "previous page".
- Use set_verbosity when the user wants to change how much detail you give.

IMPORTANT: You MUST use tools to gather visual information before answering questions about the page. Do not make up what's on the screen.`;

// Tool declarations for Gemini function calling
const TOOL_DECLARATIONS = [
  {
    functionDeclarations: [
      {
        name: 'describe_screen',
        description: 'Get a detailed description of what is currently visible on the user\'s screen. Use this to orient yourself or answer questions about the page layout and content.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'find_element',
        description: 'Find a specific UI element on the screen by name or description. Returns the element\'s coordinates so you can navigate to it or click it. Use this when the user mentions a button, link, menu item, or any named element.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The name or description of the element to find, e.g. "unsubscribe button", "search bar", "settings menu"',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'describe_element',
        description: 'Get a detailed visual description of what is at specific coordinates on the screen. Use when the user asks about something they\'re pointing at.',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate in viewport pixels' },
            y: { type: 'number', description: 'Y coordinate in viewport pixels' },
          },
          required: ['x', 'y'],
        },
      },
      {
        name: 'click',
        description: 'Click on an element at the specified coordinates. The cursor will animate smoothly to the target before clicking. Use this when the user says "click that", "open this", "press the button", etc.',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate to click' },
            y: { type: 'number', description: 'Y coordinate to click' },
            description: { type: 'string', description: 'Brief description of what is being clicked, for narration' },
          },
          required: ['x', 'y', 'description'],
        },
      },
      {
        name: 'scroll',
        description: 'Scroll the page in a direction. Use when the user says "scroll down", "go up", "show me more", etc.',
        parameters: {
          type: 'object',
          properties: {
            direction: {
              type: 'string',
              description: 'Direction to scroll',
              enum: ['up', 'down', 'left', 'right'],
            },
            amount: {
              type: 'string',
              description: 'How much to scroll',
              enum: ['small', 'medium', 'large', 'page'],
            },
          },
          required: ['direction'],
        },
      },
      {
        name: 'type_text',
        description: 'Type text into the currently focused input field. Use when the user wants to search, fill in a form, enter text, etc.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The text to type' },
            pressEnter: { type: 'boolean', description: 'Whether to press Enter after typing (e.g., to submit a search)' },
          },
          required: ['text'],
        },
      },
      {
        name: 'navigate_back',
        description: 'Navigate back to the previous page. Use when the user says "go back", "previous page", "back", or "undo".',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'set_verbosity',
        description: 'Change the verbosity level of responses. Use when the user says "be brief", "more detail", "shorter", "tell me everything", etc.',
        parameters: {
          type: 'object',
          properties: {
            level: {
              type: 'string',
              description: 'The verbosity level',
              enum: ['brief', 'normal', 'detailed'],
            },
          },
          required: ['level'],
        },
      },
    ],
  },
];

/**
 * Execute a tool call by dispatching to the appropriate handler.
 * Returns the tool result as a string.
 */
async function executeTool(name, args, streamId, viewportDimensions) {
  const { width = 1280, height = 720 } = viewportDimensions || {};

  switch (name) {
    case 'describe_screen': {
      const description = await overshoot.describePage(streamId);
      memory.updatePageContext(streamId, { description });
      return JSON.stringify({ success: true, description });
    }

    case 'find_element': {
      const result = await overshoot.navigate(streamId, args.query, width, height);
      if (result.found) {
        return JSON.stringify({
          success: true,
          found: true,
          x: result.x,
          y: result.y,
          element_name: result.element_name,
          guidance: result.guidance,
        });
      }
      return JSON.stringify({
        success: true,
        found: false,
        message: `Could not find "${args.query}" on the current screen.`,
      });
    }

    case 'describe_element': {
      const description = await overshoot.describeElement(streamId, args.x, args.y);
      return JSON.stringify({ success: true, description });
    }

    case 'click': {
      // Record the action — the actual click execution happens on the client side
      memory.recordAction(streamId, {
        type: 'click',
        target: args.description,
        coordinates: { x: args.x, y: args.y },
      });
      return JSON.stringify({
        success: true,
        action: 'click',
        x: args.x,
        y: args.y,
        description: args.description,
        message: `Clicking on "${args.description}" at (${args.x}, ${args.y})`,
      });
    }

    case 'scroll': {
      const amount = args.amount || 'medium';
      memory.recordAction(streamId, {
        type: 'scroll',
        target: `${args.direction} ${amount}`,
        coordinates: memory.getContext(streamId).cursorPosition,
      });
      return JSON.stringify({
        success: true,
        action: 'scroll',
        direction: args.direction,
        amount: amount,
        message: `Scrolling ${args.direction} (${amount})`,
      });
    }

    case 'type_text': {
      memory.recordAction(streamId, {
        type: 'type',
        target: args.text,
        coordinates: memory.getContext(streamId).cursorPosition,
      });
      return JSON.stringify({
        success: true,
        action: 'type_text',
        text: args.text,
        pressEnter: args.pressEnter || false,
        message: `Typing "${args.text}"${args.pressEnter ? ' and pressing Enter' : ''}`,
      });
    }

    case 'navigate_back': {
      memory.recordAction(streamId, {
        type: 'navigate_back',
        target: 'previous page',
        coordinates: { x: 0, y: 0 },
      });
      return JSON.stringify({
        success: true,
        action: 'navigate_back',
        message: 'Navigating back to the previous page',
      });
    }

    case 'set_verbosity': {
      memory.updatePreferences(streamId, { verbosity: args.level });
      return JSON.stringify({
        success: true,
        message: `Verbosity set to "${args.level}"`,
      });
    }

    default:
      return JSON.stringify({ success: false, error: `Unknown tool: ${name}` });
  }
}

/**
 * Main conversation handler.
 * Takes the user's transcript and returns:
 * - reply: the text response to speak
 * - actions: array of DOM actions to execute on the client
 */
async function converse(streamId, transcript, clientContext = {}) {
  const apiKey = GEMINI_API_KEY();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Add it to server/.env');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL(),
    tools: TOOL_DECLARATIONS,
    systemInstruction: SYSTEM_INSTRUCTION,
  });

  // Update session context from client
  if (clientContext.url || clientContext.title) {
    memory.updatePageContext(streamId, {
      url: clientContext.url,
      title: clientContext.title,
    });
  }
  if (clientContext.cursorX != null && clientContext.cursorY != null) {
    memory.updateCursorPosition(streamId, clientContext.cursorX, clientContext.cursorY);
  }

  // Build the conversation history for Gemini
  const contextSummary = memory.buildContextSummary(streamId);
  const history = memory.getMessages(streamId);

  // Convert history to Gemini format
  const geminiHistory = [];
  for (const msg of history) {
    if (msg.role === 'user') {
      geminiHistory.push({ role: 'user', parts: [{ text: msg.content }] });
    } else if (msg.role === 'assistant') {
      geminiHistory.push({ role: 'model', parts: [{ text: msg.content }] });
    }
  }

  // Start a chat session with history
  const chat = model.startChat({
    history: geminiHistory,
  });

  // Build the current user message with context
  const userMessage = `[Session Context]\n${contextSummary}\n\n[User says]: ${transcript}`;

  // Store the user's message in memory (just the transcript, not the context wrapper)
  memory.addMessage(streamId, 'user', transcript);

  // Send to Gemini and handle function calling loop
  let response = await chat.sendMessage(userMessage);
  let result = response.response;

  const collectedActions = [];

  // Function calling loop — keep going until the model gives a text response
  let maxIterations = 10; // Safety limit
  while (maxIterations-- > 0) {
    const candidate = result.candidates?.[0];
    if (!candidate) break;

    const parts = candidate.content?.parts || [];

    // Check if there are function calls
    const functionCalls = parts.filter(p => p.functionCall);
    if (functionCalls.length === 0) break; // Model gave a final text response

    // Execute all function calls
    const functionResponses = [];
    for (const part of functionCalls) {
      const { name, args } = part.functionCall;
      console.log(`[orchestrator] Tool call: ${name}(${JSON.stringify(args)})`);

      try {
        const toolResult = await executeTool(name, args, streamId, {
          width: clientContext.viewportWidth,
          height: clientContext.viewportHeight,
        });

        const parsed = JSON.parse(toolResult);

        // Collect client-side actions
        if (parsed.action) {
          collectedActions.push(parsed);
        }

        functionResponses.push({
          functionResponse: {
            name: name,
            response: JSON.parse(toolResult),
          },
        });
      } catch (err) {
        console.error(`[orchestrator] Tool ${name} failed:`, err.message);
        functionResponses.push({
          functionResponse: {
            name: name,
            response: { success: false, error: err.message },
          },
        });
      }
    }

    // Send tool results back to the model
    response = await chat.sendMessage(functionResponses);
    result = response.response;
  }

  // Extract the final text response
  const textParts = (result.candidates?.[0]?.content?.parts || [])
    .filter(p => p.text)
    .map(p => p.text);
  const reply = textParts.join(' ').trim() || 'I\'m not sure how to help with that. Could you try rephrasing?';

  // Store assistant response in memory
  memory.addMessage(streamId, 'assistant', reply);

  return {
    reply,
    actions: collectedActions,
  };
}

module.exports = {
  converse,
};
