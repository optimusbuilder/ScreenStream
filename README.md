# ScreenStream-Access

Accessibility-first Chrome Extension that captures a live video stream of the active browser tab, pushes it to the [Overshoot API](https://docs.overshoot.ai/) via LiveKit WebRTC, tracks mouse movements, and converts real-time VLM spatial analysis into 3D positional audio beacons and spoken labels for blind users navigating complex web interfaces.

## Architecture

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
  │   ├─ Spatial audio (Web Audio API + HRTF PannerNode)
  │   └─ Speech labels (SpeechSynthesis on 500ms idle)
```

## Prerequisites

- **Node.js 18+**
- **Google Chrome**
- **Overshoot API key** (`ovs-...`) — get one from the [Overshoot dashboard](https://docs.overshoot.ai/)

## Setup

### 1. Server

```bash
cd server
cp .env.example .env
# Edit .env and paste your Overshoot API key
npm install
npm run dev
```

The server starts on `http://localhost:3000`. Verify with:

```bash
curl http://localhost:3000/api/health
```

### 2. Extension

```bash
cd extension
npm install
npm run build
```

This bundles the LiveKit client into `dist/offscreen.bundle.js`.

### 3. Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` directory
5. The ScreenStream-Access icon appears in your toolbar

## Usage

1. Navigate to any web page
2. Click the extension icon
3. Press **Start Session** — this:
   - Creates an Overshoot stream via the backend
   - Captures the active tab's video at 480p/15fps
   - Publishes it to the Overshoot LiveKit room
   - Begins streaming VLM inference results
4. Move your mouse — you'll hear:
   - **Spatial audio beacons**: panned left/right/front/back based on nearest interactive element direction, tick rate based on distance
   - **Spoken labels**: when you pause on a new element for 500ms (toggle in popup)
5. Press **Stop Session** to end

## Configuration

### Server environment (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `OVERSHOOT_API_KEY` | — | Your `ovs-...` API key (required) |
| `PORT` | `3000` | Server port |
| `OVERSHOOT_MODEL` | `google/gemma-4-E2B-it` | VLM model for inference |
| `OVERSHOOT_BASE_URL` | `https://api.overshoot.ai/v1` | API base URL |

### Audio behavior

| Parameter | Value | Location |
|-----------|-------|----------|
| Mouse throttle | 100ms | `content.js` |
| Idle threshold for speech | 500ms | `content.js` |
| Min speech interval | 1500ms | `content.js` |
| Keepalive interval | 90s | `background.js` |
| Inference poll rate | 100ms | `background.js` |
| Capture resolution | 854×480 @ 15fps | `offscreen.js` |

## Spatial Audio Mapping

| VLM Response | Audio Effect |
|-------------|--------------|
| Direction: E | Pan right |
| Direction: W | Pan left |
| Direction: N | Front (lower Z) |
| Direction: S | Back (higher Z) |
| ON_OBJECT | Center, fast ticks |
| `interactive: true` | 880 Hz tone |
| `interactive: false` | 440 Hz tone |
| Small `distance_pixels` | Faster tick rate |
| Large `distance_pixels` | Slower tick rate |

## Development

```bash
# Watch mode for extension bundle
cd extension && npm run watch

# Dev mode for server (auto-restart on changes)
cd server && npm run dev
```

## License

See [LICENSE](./LICENSE).
