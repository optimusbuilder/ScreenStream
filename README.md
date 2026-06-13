# ScreenStream-Access

Accessibility-first Chrome Extension that captures a live video stream of the active browser tab, pushes it to the [Overshoot API](https://docs.overshoot.ai/) via LiveKit WebRTC, tracks mouse movements, and converts real-time spatial analysis into warm, spoken labels and confirmations for blind users or people with accesbility issues navigating complex web interfaces.

---

## 🌟 Key Features

We have built a premium, screen tour guide that navigates websites naturally:

- **📄 DOM Text & Heading Reading**: Direct cursor hover immediately announces the exact text of headings (`H1`-`H6`), paragraphs (`P`), list items (`LI`), and plain text containers, bypassing robotic tags.
- **🗺️ Structural Landmark Context**: Recognizes key semantic landmark containers and announces where elements reside (e.g. `"... in the navigation bar"`, `"... in the sidebar"`, or `"... in the footer"`).
- **🗣️ Natural-Speed Human Voice**: Playback rate is set to a natural `1.0` speed for ElevenLabs narration and local TTS fallbacks, ensuring voice guidance is warm, clear, and human rather than robotic or rushed.
- **🔇 Quiet Empty-Space Exploration**: Silenced distance-in-pixel coordinate descriptions and empty-space ticking noise. The guide is completely silent while traversing empty space, and speaks only when elements are directly hovered, clicked, or when the cursor stops (lingers) near an item.
- **✨ Smart Click Guiding**: Intercepts element clicks to speak natural, action-oriented responses detailing what that click does (e.g., `"Clicking this will lead you to the store page to browse all available products"` or `"Selected: [text]"`).
- **⏳ Lazy Page Description**: The visual language model's detailed page overview is lazily evaluated on load. If the user starts exploring immediately, the pending background overview is cancelled, avoiding delayed audio interruptions.

---

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Chrome Extension │────▶│  Express Server   │────▶│  Overshoot API  │
│                  │◀────│  (localhost:3000) │◀────│  (VLM + LiveKit)│
└─────────────────┘     └──────────────────┘     └─────────────────┘
  │ popup.html           POST /api/session/*       POST /v1/streams
  │ background.js        POST /api/inference       POST /v1/chat/completions
  │ offscreen.js ──────────────────────────────▶  LiveKit Room (video)
  │ content.js
  │   ├─ Mouse tracking (100ms throttle)
  │   ├─ Natural speech labels (instant direct hit / 500ms idle linger)
  │   └─ Window click interception & confirmation guidance
```

---

## ⚙️ Prerequisites

- **Node.js 18+**
- **Google Chrome**
- **Overshoot API key** (`ovs-...`) — get one from the [Overshoot dashboard](https://docs.overshoot.ai/)
- **ElevenLabs API key** (`sk_...`) — for high-quality natural narration (optional, falls back to local Chrome TTS)

---

## 🚀 Setup

### 1. Server

1. Navigate to the `server/` directory:
   ```bash
   cd server
   ```
2. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
3. Edit the `.env` file and paste your `OVERSHOOT_API_KEY` and optional `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`.
4. Install dependencies and start the dev server:
   ```bash
   npm install
   npm run dev
   ```

The server starts on `http://localhost:3000`. You can verify it is healthy with:
```bash
curl http://localhost:3000/api/health
```

### 2. Extension

1. Navigate to the `extension/` directory:
   ```bash
   cd extension
   ```
2. Install dependencies and build the offscreen assets:
   ```bash
   npm install
   npm run build
   ```

---

## 🔌 Load in Chrome

1. Open a new tab and navigate to `chrome://extensions`.
2. Toggle on **Developer mode** in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the `extension/` directory in this workspace.
5. The ScreenStream-Access icon (pink target) will appear in your extensions list.

---

## 🛠️ Testing & Debugging with Chrome DevTools

Developers can inspect different contexts of the extension to verify the guide is tracking mouse coordinates, processing DOM elements, and synthesizing text:

### 1. Inspecting Content Scripts (Content / Webpage)
To see mousemove events, DOM element analysis, structural context matches, and clicked items:
1. Open any webpage (e.g. `https://apple.com/shop/buy-iphone`).
2. Right-click anywhere on the page and select **Inspect** to open Developer Tools.
3. Go to the **Console** tab.
4. Filter by logs or type `[ScreenStream]` to view incoming state transitions, direct hit evaluations, and cursor tracking.

### 2. Inspecting the Service Worker (Background Script)
To inspect server communication, keepalives, VLM frame completions, and audio triggers:
1. Go to `chrome://extensions`.
2. Find the **ScreenStream-Access** card.
3. Click on the **service worker** link (under "Inspect views").
4. A new DevTools window will open showing logs for server connections, LiveKit WebRTC state, and API requests.

### 3. Inspecting the Offscreen Document (Audio Engine)
To verify base64 audio playbacks, ElevenLabs state, and local speech callbacks:
1. Open `chrome://inspect/#other`.
2. Locate the line corresponding to `chrome-extension://.../offscreen.html`.
3. Click **inspect** to open DevTools for the offscreen audio player.
4. Watch the console logs for audio events, playback speeds, and status updates.

---

## 🧑‍💻 Development commands

```bash
# Setup both directories and build in one command (from root):
npm run setup

# Watch mode for compiling offscreen JS on change:
cd extension && npm run watch

# Hot reload development server:
cd server && npm run dev
```

## 📄 License

See [LICENSE](./LICENSE).
