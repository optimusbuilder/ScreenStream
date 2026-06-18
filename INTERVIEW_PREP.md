# 🎙️ ScreenStream-Access Technical Guide & Interview Prep

This document serves as a deep dive into the **ScreenStream-Access** architecture, components, design patterns, and features, followed by a targeted **25-question technical interview preparation cheat sheet**.

---

## 🏗️ System Architecture

ScreenStream-Access consists of a Manifest V3 Chrome Extension and a Node.js/Express backend that coordinates interactions with the Overshoot API.

```
┌────────────────────────────────────────────────────────────────────────┐
│                          CHROME EXTENSION                              │
│                                                                        │
│  ┌──────────────┐         Tab Capture         ┌─────────────────────┐  │
│  │  Content     │ ──────────────────────────> │      Offscreen      │  │
│  │  Script      │                             │      Document       │  │
│  │ (content.js) │ <────────────────────────── │    (offscreen.js)   │  │
│  └──────────────┘      3D Audio / TTS Play    └─────────────────────┘  │
└─────────┬─────────────────────────────────────────────────▲────────────┘
          │                                                 │
          │ Client Mouse (100ms)                            │ WebRTC Stream
          │ VLM Queries / Navigation Requests               │ (Tab Capture)
          ▼                                                 │
┌───────────────────────────────────────────────────────────┴────────────┐
│                       EXPRESS BACKEND (Node.js)                        │
│                                                                        │
│  ┌──────────────────────────┐         ┌─────────────────────────────┐  │
│  │    Inference Router      │ ──────> │      Overshoot Service      │  │
│  │      (inference.js)      │         │       (overshoot.js)        │  │
│  └──────────────────────────┘         └─────────────────────────────┘  │
│               │                                      │                 │
│               ▼ TTS Text                             ▼ VLM Prompt      │
│  ┌──────────────────────────┐         ┌─────────────────────────────┐  │
│  │       TTS Service        │         │        Overshoot API        │  │
│  │         (tts.js)         │         │     (LiveKit + VLM Host)    │  │
│  └──────────────────────────┘         └─────────────────────────────┘  │
│               │                                                        │
│               ▼ ElevenLabs Audio Chunks (Base64 MP3)                   │
└────────────────────────────────────────────────────────────────────────┘
```

### End-to-End Data Flow
1. **Initiation**: The user activates the extension on a website. The background script, [background.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/background.js), creates a secure Chrome Offscreen Document, [offscreen.html](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/offscreen.html), and captures the current tab stream token via `chrome.tabCapture.getMediaStreamId`.
2. **Stream Publishing**: The offscreen script, [offscreen.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/offscreen.js), calls `navigator.mediaDevices.getUserMedia` using the token to capture video (optimized at 854x480 resolution, 15fps to save bandwidth and compute overhead). It connects to a dynamically allocated LiveKit Room on Overshoot and publishes the stream.
3. **Establish Connection**: The Node backend server, [index.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/index.js), initiates the session through the session router, [session.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/routes/session.js), and waits for active video frames via `/api/session/:id/wait-for-frames` to ensure the WebRTC pipeline is ready.
4. **Client-Side Fast-Path**: The content script, [content.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/content.js), tracks mouse movements (throttled to 100ms). It performs an instant client-side "direct hit" analysis of the DOM element under the cursor. If the element contains static text or is standard interactive HTML (buttons, inputs, links), it reads it out immediately, bypassing network and model latency.
5. **VLM Deep-Path**: In parallel, the background script runs a loop querying the Express inference router, [inference.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/routes/inference.js), at `POST /api/inference` every 750ms with the current mouse coordinates. The Overshoot service, [overshoot.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/services/overshoot.js), queries the VLM (e.g., `Qwen/Qwen3.6-27B-FP8` or `google/gemma-4-26B-A4B-it`) referencing the live tab frame `ovs://streams/${streamId}?frame_index=-1` and the coordinate coordinates.
6. **Audio Output**: If the backend detects a visual element or detailed coordinate context, it returns the analysis. Text is synthesized into speech using ElevenLabs (via the TTS service, [tts.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/services/tts.js)) or falls back to native `chrome.tts`. The offscreen audio engine plays this narrative using Web Audio API spatialization.

---

## ✨ Key Technical Achievements & UX Design

### 1. Hybrid Client-Server Navigation Engine
* **The Latency Problem**: Standard vision-language models take 500ms–1500ms to return a description. Reading webpage labels with this delay makes real-time exploration unusable.
* **Our Solution**: We implemented a **Parallel Hybrid Engine** in [content.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/content.js):
  * **Instant DOM Reader (Client)**: Instantly grabs semantic text (`H1`-`H6`, `P`, `LI`) and interactive attributes using `document.elementFromPoint(x, y)` and speaks them immediately.
  * **Spatial VLM (Server)**: Continuously evaluates visual elements (images, canvases, videos) and structural contexts in the background.
  * **De-confliction Gate**: If the fast client-side DOM reader triggers, server-side VLM completions are silenced for `1500ms`. This prevents overlapping speech and prioritizes speed.

### 2. Tab Capture in Manifest V3 (Offscreen Documents API)
* **The Constraint**: Chrome Extensions in Manifest V3 use service workers as background scripts. Service workers are headless and **cannot** access DOM APIs (like the Web Audio API) or fetch user media streams (`getUserMedia`).
* **Our Solution**: We created a dedicated **Offscreen Document**, [offscreen.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/offscreen.js). The background script gets a secure stream token, sends it to the offscreen page, which uses the WebRTC client (`livekit-client`) to stream the tab video directly. The offscreen document also acts as the 3D Web Audio player.

### 3. Spatial Acoustic Interface (3D Audio & Sonar Sweeps)
* **Sonar Layout Sweep (`Alt+Shift+S`)**: Sweeps the page layout from left to right. It maps the relative coordinates of all visible interactive elements:
  * **Panning (Left-to-Right)**: Mapped to the audio timeline delay and stereo pan (X-axis).
  * **Frequency (Pitch)**: Mapped to the Y-axis (top of page = high pitch ~1200Hz, bottom of page = low pitch ~440Hz). This creates a distinct melodic landscape, giving blind users a rapid mental map of page density.
* **Proximity Ticking & Target Lock-On**: If the user is searching for an element, the audio engine plays directional clicking ticks. The ticks accelerate as the cursor gets closer to the target (clamped from 800ms down to 80ms). Hovering directly over the target triggers a pleasant double-sine "Target Locked" chord.
* **Quiet Exploration**: All ticking and distance indicators are muted during active narration or when traversing empty space, maintaining a clutter-free, non-distracting user experience.

### 4. Resilient Backend Routing & Concurrency Lock
* **Inference Stampede Prevention**: Rapid mouse movement can cause a flood of concurrent VLM requests. The Express router in [inference.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/routes/inference.js) uses a per-stream concurrency lock `Set`. If an inference request is already in-flight for a stream, new requests are rejected immediately with a `409 Conflict`, keeping resource use clean.
* **Dynamic Model Fallbacks**: If the primary model on Overshoot API fails or returns a `503 Service Unavailable`, [overshoot.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/services/overshoot.js) instantly and transparently attempts fallback models (`Gemma 4`, alternative `Qwen` versions) to maintain live operations.

---

## 🛠️ Codebase Structure

### 🔌 Extension Code
* [manifest.json](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/manifest.json): Declares permissions (`tabCapture`, `offscreen`, `tts`, `storage`, `scripting`) and sets background service worker and content scripts.
* [src/background.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/background.js): The central extension coordinator. Opens offscreen documents, coordinates WebRTC tokens, runs the background inference loop, and communicates with the Express backend.
* [src/content.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/content.js): Handles cursor tracking, keyboard shortcuts, DOM analysis, client-side direct hits, click interception, and page-load description throttling.
* [src/offscreen.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/offscreen.js): Connects to the LiveKit session, streams the tab, and hosts the Web Audio API spatial synthesizer and ElevenLabs player.
* [popup.html](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/popup.html) & [src/popup.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/popup.js): Small dashboard UI to toggle speech, ask questions via keyboard (Tab Q&A), or run spatial queries.

### ⚙️ Server Code
* [index.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/index.js): App entrypoint, CORS configuration, and model route mappings.
* [routes/session.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/routes/session.js): REST interface for LiveKit session creation, keepalive pings, and WebRTC connection verification.
* [routes/inference.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/routes/inference.js): Endpoints for VLM inference, tab question Q&A, spatial element searches, page-overview descriptions, and voice fallbacks.
* [services/overshoot.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/services/overshoot.js): Overshoot API integration, retries, multi-model fallbacks, JSON output schema enforcement, and conversation history buffer.
* [services/tts.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/services/tts.js): ElevenLabs Speech Synthesis service (`eleven_turbo_v2_5` model). Returns Base64-encoded MP3 streams.

---

## 🎯 Interview Cheat Sheet: 25 Hard Technical Questions

Here is the strategic breakdown of questions you are highly likely to face during your 15-minute technical interview, along with clean, architectural answers.

### 🌐 Section 1: Extension Architecture & Chrome APIs

#### Q1: Why did you choose Manifest V3, and what was the hardest constraint you ran into?
* **Answer**: We chose Manifest V3 because it is the modern standard enforced by Google Chrome. The hardest constraint was that background scripts run in headless **Service Workers**, which have no window context and **cannot** access DOM-dependent APIs like the Web Audio API or `navigator.mediaDevices.getUserMedia`. 
* We solved this by implementing Chrome's **Offscreen Documents API**. We spin up an offscreen document (`offscreen.html`), pass the media capture token, and run our WebRTC streaming client and Web Audio API synthesizer there, using Chrome runtime messages to orchestrate the entire lifecycle.

#### Q2: Explain how the tab video stream goes from the user's browser page to the Node server.
* **Answer**: 
  1. The user clicks the extension action icon.
  2. The background script requests a capture token using `chrome.tabCapture.getMediaStreamId({ targetTabId })`.
  3. The token is sent via runtime message to our offscreen script.
  4. The offscreen script calls `navigator.mediaDevices.getUserMedia` using that stream ID token.
  5. The video stream track is fed into a LiveKit WebRTC publisher track and published to an Overshoot room.
  6. The Node backend queries the status and forwards coordinates to the Overshoot VLM endpoints which pull the latest frame from the live WebRTC stream.

#### Q3: Why did you use `chrome.tabCapture` instead of `chrome.desktopCapture` or standard `getDisplayMedia`?
* **Answer**: `chrome.desktopCapture` or standard `navigator.mediaDevices.getDisplayMedia` trigger intrusive, full-screen permission prompts asking the user to select which screen or window to record. 
* `chrome.tabCapture` is an accessibility-first API that captures *only* the specific active browser tab, and it is activated with a single click of the extension icon. This is much less intrusive and provides a safer, sandboxed environment.

#### Q4: Why does the extension icon click start the session, but starting from a popup button is avoided?
* **Answer**: Chrome has a strict user gesture requirement for capturing tabs. The API `chrome.tabCapture.getMediaStreamId` must be called in a gesture chain directly triggered by the user clicking the extension icon. Calling it inside a popup window button click breaks this gesture chain, causing a permission error.

#### Q5: How do the content script, background script, and offscreen document pass data to one another?
* **Answer**: They communicate using the `chrome.runtime` messaging API. 
  * The **Content Script** listens to DOM cursor movements and sends `{ type: "MOUSE_MOVE", x, y }` to the Background Service Worker.
  * The **Background Script** manages sessions, fetches VLM results, and relays them to both the Content Script (to update cursor states/speech) and the Offscreen Document (to trigger spatial tones and ticks).
  * Direct speech messages specify a `target: "offscreen"` parameter to ensure only the offscreen context captures Web Audio commands.

---

### 🧠 Section 2: AI, VLM, and Backend Engineering

#### Q6: How does the model know what element is located at `X, Y` coordinates?
* **Answer**: The VLM does not have direct access to the DOM. Instead, we send the mouse coordinates (`X` and `Y`) as text in the user prompt, along with the live WebRTC video frame. 
* We prompt the model: *"You are an instantaneous web accessibility navigator. The user is hovering their mouse at current viewport coordinates: X, Y. Analyze the current live tab frame and determine the element under the cursor."* We enforce a structured JSON schema output to guarantee we get coordinates, element type, interactive status, and direction.

#### Q7: What is the Overshoot API, and why did you use it instead of calling OpenAI or Anthropic directly?
* **Answer**: Overshoot is a high-performance AI inference engine designed for real-time video streaming inputs. Unlike standard OpenAI/Anthropic APIs where you must manually capture a screenshot, convert it to Base64, and upload a massive image payload on every single request, Overshoot connects directly to our LiveKit WebRTC stream. 
* Our API request only needs to send a stream reference (`ovs://streams/[id]?frame_index=-1`), allowing Overshoot's backend to fetch the frame locally in sub-milliseconds. This reduces our network upload overhead to zero and lowers latency to sub-second levels.

#### Q8: How did you implement model failovers, and why is this important?
* **Answer**: Vision-Language Models can occasionally experience capacity issues (returning `503 Service Unavailable` or `504 Gateway Timeout`). 
* In [overshoot.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/services/overshoot.js), we configure a fast-path model (`Qwen3.6-27B-FP8`) and a list of fallback models (`google/gemma-4`, etc.). If a request fails with a server error, our backend catches the error, logs a warning, and instantly retries the query on the next model in the fallback queue. This ensures a stable user experience.

#### Q9: How does the conversational Q&A feature maintain context?
* **Answer**: In [overshoot.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/services/overshoot.js), we maintain an in-memory session history dictionary `sessionHistories[streamId]`. 
* We append each user prompt and assistant response to this history array, capping it at the last 6 messages to stay within token limits. When a Q&A request comes in, we feed the full history to the model along with the system prompt and the latest WebRTC video frame.

#### Q10: How did you enforce structured outputs from the LLM?
* **Answer**: We use the `response_format` configuration with `type: "json_schema"`. We pass a strict JSON schema describing the required fields (e.g., `element_under_cursor` (string), `interactive` (boolean), `nearest_actionable_direction` (enum), `distance_pixels` (number)). By setting `"strict": true`, the model's output is forced to comply with this schema, avoiding JSON parsing errors on our server.

---

### ⚡ Section 3: Performance, Latency, & Optimization

#### Q11: A VLM request takes 800ms. How does your interface feel instant?
* **Answer**: We solved this with a **Hybrid Navigation Model**. 
* The content script performs an immediate local DOM check (`document.elementFromPoint`) on the client side. If the cursor is directly over a readable text element or standard interactive element (like a button or input field), the client speaks the label instantly. 
* The server-side VLM runs in the background. If the user moves to a non-text graphic or complex interface element, the VLM fills in the visual gaps. 
* To prevent overlapping audio, we use a 1.5-second cooldown gate that mutes server responses if the client-side reader recently spoke.

#### Q12: How do you prevent an "inference stampede" when the user moves the mouse rapidly?
* **Answer**: We have three layers of defense:
  1. **Client throttling**: The content script tracks mousemove events but throttles notifications to the background script to once every 100ms.
  2. **Sequential Background Loop**: The background script's inference loop runs sequentially, meaning it awaits the completion of the current server request before scheduling the next one (every ~750ms).
  3. **Backend Concurrency Lock**: In [inference.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/server/routes/inference.js), we use an in-memory `Set` of active stream IDs (`inFlightStreams`). If a new request arrives for a stream that is already processing, the server immediately returns a `409 Conflict`, preventing redundant API calls.

#### Q13: What optimization settings did you apply to the WebRTC video capture stream?
* **Answer**: Capturing at full desktop resolution and frame rate creates excessive bandwidth and server-side CPU utilization. In [offscreen.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/offscreen.js), we scale down the tab capture to a maximum width of `854` and height of `480` pixels, and limit the frame rate to `15` frames per second. We also disable dynacast and adaptive streams on our LiveKit client to keep the connection payload lightweight.

#### Q14: How does the "Lazy Page Description" logic improve performance and usability?
* **Answer**: When the user opens a page, we trigger a background request to fetch a detailed page overview. However, if the user starts moving their mouse immediately, they want real-time feedback. 
* We check the variable `hasExploredSincePageLoad` in [content.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/content.js). If this is true, we immediately discard the pending page description, preventing audio overlap.

#### Q15: Why did you choose ElevenLabs over the browser's built-in TTS API?
* **Answer**: Native browser Text-to-Speech voices can sound robotic, cold, and repetitive, which can be fatiguing for users who rely on screen readers. 
* ElevenLabs provides incredibly expressive, warm, and natural human voices. To ensure accessibility is always available, we built a graceful fallback to native `chrome.tts` in case the ElevenLabs API key is missing or hits a rate limit.

---

### 🔊 Section 4: Web Audio & Acoustic Design

#### Q16: How does the Sonar Sweep (`Alt+Shift+S`) work under the hood?
* **Answer**: 
  1. The content script collects all visible interactive elements on the screen.
  2. It computes their relative viewport positions on a scale of `[-1.0, 1.0]`.
  3. It sends these elements to the offscreen document, which sorts them by their X-coordinate (left to right).
  4. The offscreen script triggers Web Audio nodes for each element sequentially over a 1.2-second window.
  5. The X-coordinate is mapped to stereo panning (using a `PannerNode` with HRTF).
  6. The Y-coordinate is mapped to pitch (top of screen = high pitch ~1200Hz, bottom of screen = low pitch ~440Hz). This creates a spatialized soundscape representing the page layout.

#### Q17: How does the proximity ticking audio change as the user moves their cursor?
* **Answer**: When a target element is active, we calculate the distance in pixels between the cursor and the target. In [offscreen.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/offscreen.js), we adjust a `setInterval` timer rate based on this distance. 
* As the cursor gets closer, the tick rate accelerates (ranging from a slow 800ms tick to a rapid 80ms tick). The volume and gain also ramp up, creating an auditory "hot and cold" game to guide the user.

#### Q18: Why do you mute the ticking sound when the voice narrator speaks?
* **Answer**: Constant ticking sounds during active narration can cause cognitive overload. In [offscreen.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/offscreen.js), we listen for `SPEECH_STATUS` and `elevenlabsActive` state changes. If either is true, our sound generator returns early, muting all ticks and tones to let the user focus on the voice description.

#### Q19: Why did you use the `HRTF` panning model instead of `equalpower`?
* **Answer**: The default `equalpower` panning model simply adjusts the left and right channel volumes. 
* The `HRTF` (Head-Related Transfer Function) model simulates how sound waves interact with the human head and ears, providing realistic spatial audio. This allows users to accurately perceive whether an element is located to their left, right, front, or back.

#### Q20: How did you implement the "Target Lock-on" audio effect?
* **Answer**: When the cursor gets within 30px of a search target, the content script cancels the target coordinate and notifies the offscreen document. 
* The offscreen document triggers a custom dual-frequency tone: a triangle wave starting at 1000Hz that ramps up to 1300Hz using `linearRampToValueAtTime`. This creates a distinctive, rewarding target confirmation sound.

---

### 🛡️ Section 5: Security, Robustness, & Error Handling

#### Q21: What happens if the backend server crashes during a session?
* **Answer**: The background script runs an inference loop with structured try/catch blocks. If a network request fails, we increment a `consecutiveFailures` counter and apply exponential backoff (up to a max of 8 seconds) before retrying. 
* This prevents overloading a recovering server. If the server is completely unreachable, the content script gracefully falls back to local DOM readings.

#### Q22: What are host permissions, and how did you scope them in your manifest?
* **Answer**: Host permissions allow an extension to make cross-origin network requests and inject content scripts. 
* In [manifest.json](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/manifest.json), we scope our host permissions to `"http://localhost:3000/*"` (for our Node backend) and use `<all_urls>` to allow content script injection on any page the user wants to browse.

#### Q23: Why do we check `/wait-for-frames` on session start?
* **Answer**: Establishing a WebRTC connection can take a few seconds due to ICE candidate gathering and signaling handshakes. If we run inference requests immediately, the VLM will try to pull frames from a blank stream and fail. 
* The `/wait-for-frames` endpoint blocks and polls the stream's status on the backend until it confirms the first frame has successfully arrived.

#### Q24: How does your application clean up resources when a session stops?
* **Answer**: When the user stops a session, [background.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/background.js) calls `handleStopSession()`, which:
  1. Clears the keepalive intervals and background loops.
  2. Sends a `DELETE` request to `/api/session/:id` to release backend stream resources.
  3. Messages the offscreen document to stop WebRTC capture and close the media tracks.
  4. Closes the offscreen document using `chrome.offscreen.closeDocument()`.
  5. Clears tab badges, popups, and cursor highlights.

#### Q25: How do you handle site navigation? What happens when a user clicks a link and a new page loads?
* **Answer**: When the page navigates, the content script re-injects on load, reads the stored session state from `chrome.storage.local`, and sends a `PAGE_NAVIGATED` message to the background service worker. 
* The background script stops any active audio playback and calls `/api/inference/describe` to orient the user to the new page.

#### Q26: Why did you choose LiveKit specifically for the WebRTC layer?
* **Answer**: 
  1. **Ultra-Low Latency**: Traditional streaming protocols (like HLS or RTMP) introduce 2 to 10 seconds of latency. LiveKit leverages WebRTC to stream the browser tab with sub-second latency, allowing the VLM to analyze frames almost instantaneously as the user moves their mouse.
  2. **Zero Infrastructure Overhead**: Setting up custom STUN/TURN servers for NAT traversal, signaling servers, and peer-to-peer connection management from scratch is incredibly complex. LiveKit abstracts all SFU (Selective Forwarding Unit) routing, connection handshakes, and scaling out-of-the-box.
  3. **Overshoot Native Integration**: Overshoot utilizes LiveKit rooms natively to ingest video streams. By publishing the tab track directly to a LiveKit room from [offscreen.js](file:///Users/oluwaferanmioyelude/Documents/ScreenStream/extension/src/offscreen.js), Overshoot's vision models can consume the active tab frames locally with virtually zero ingestion lag.
  4. **Dynamic Bandwidth and Encoding Control**: The `livekit-client` SDK allows us to explicitly configure codec encoding settings. We limit the video track to `maxBitrate: 1,500,000` and `maxFramerate: 15` to ensure the streaming is lightweight, low-power, and stable over typical residential internet connections.

