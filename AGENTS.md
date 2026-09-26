# FastChat - AI Agent & Developer Architecture Reference

> CRITICAL REFERENCE FOR ALL AI CODING ASSISTANTS (Cursor, Claude, Copilot, ChatGPT, Antigravity).
> Read this document completely before modifying any code. It details the edge-native architecture, Cloudflare Pages hosting, Cloudflare Workers API, SQLite Durable Objects state engine, WebSocket protocols, and sacred frontend UI/UX invariants.

---

## 1. High-Level Architectural Blueprint

FastChat is a zero-knowledge, real-time messaging, calling, and synchronized media web application deployed entirely at the edge on Cloudflare:

| Layer | Technology | Code Location | Production Host |
| :--- | :--- | :--- | :--- |
| **Frontend UI (SPA)** | Vanilla JS, HTML5, CSS3 | `public/` | Cloudflare Pages (`<your-project>.pages.dev`) |
| **Edge API Router** | Cloudflare Workers (V8 Edge Runtime) | `src/worker.js` | Cloudflare Workers (`*.workers.dev`) |
| **Real-time State & DB** | Cloudflare SQLite Durable Objects | `src/chatroom.js`, `src/user_registry.js` | Edge Colocated Instances |
| **Audio/Video Mesh** | WebRTC (P2P + STUN/TURN signaling) | `public/calls.js` | Direct Browser Mesh |
| **Media Synchronization** | Cinema & Watch Party Lockstep Engine | `public/cinema.js`, `public/watchparty.js` | WebRTC / DO WebSocket |

---

## 2. Cloudflare Edge Architecture: Workers, Durable Objects & Pages

### 2.1 Cloudflare Pages (`public/`)
- Cloudflare Pages acts as the global static asset CDN.
- All files inside `public/` are served with global edge caching:
  - `index.html`: Entry point containing the Zero-Knowledge Auth overlay, Chat List pane, Chat Area viewport, Spaces tab, and Pulse Matchmaker.
  - `style.css`: The entire responsive design system, animations, dark mode theme variables, and gesture transitions.
  - `app.js`: Main state orchestrator, WebSocket lifecycle, IndexedDB cache manager, UI renderer, and keyboard sync.
  - `calls.js`: Complete WebRTC peer-to-peer signaling, ICE candidate handling, and call UI.
  - `cinema.js` & `watchparty.js`: Frame-accurate synchronized video and media players.
  - `_headers`: Custom security and caching HTTP response headers.
- **Frontend Deployment Mandate**:
  ```bash
  npx wrangler pages deploy public --branch=main --commit-dirty=true
  ```
  *(Always include `--branch=main --commit-dirty=true` to deploy directly to the live production site. When prompted, enter your own unique project name to get `https://<your-project>.pages.dev`).*

### 2.2 Cloudflare Workers (`src/worker.js`)
- Acts as the stateless API Gateway and WebSocket upgrade router.
- When an incoming HTTP request hits the worker:
  1. Handles CORS preflight (`OPTIONS`) with permissive headers.
  2. Verifies authentication tokens (JWT or HMAC session tokens).
  3. Routes `/api/signup` and `/api/login` to the `USER_REGISTRY` Durable Object.
  4. Routes `/api/chat/:id/*` to the specific `CHAT_ROOM` Durable Object instance.
  5. Routes `/api/pulse/ws` to the anonymous matchmaker Durable Object.
- **Backend Deployment Mandate**:
  ```bash
  npx wrangler deploy
  ```

### 2.3 Cloudflare Durable Objects (`src/chatroom.js`, `src/user_registry.js`)
- **What is a Durable Object?**  
  A Durable Object (DO) is a stateful microservice running in Cloudflare's edge network that combines in-memory compute with embedded SQLite persistent storage.
- **Isolation by Room ID**:
  Each chat room (`roomId`) maps to its own unique DO instance:
  ```javascript
  const id = env.CHAT_ROOM.idFromName(roomId);
  const room = env.CHAT_ROOM.get(id);
  return room.fetch(request);
  ```
  All users in that chat room connect to the exact same DO physical instance, allowing zero-latency WebSocket broadcasting directly from memory without Redis or pub/sub latency.
- **SQLite Storage**:
  Messages, receipts, wallpapers, and chat metadata are saved directly to `state.storage.sql` or `state.storage.put()`, persisting across Worker reboots while offering instant in-memory read speeds.
- **DO Classes Configured in `wrangler.toml`**:
  - `ChatRoomV2` (extended by `ChatRoomConvoo` in `src/chatroom-convoo.js`): Manages messages, reactions, typing state, read receipts, and Pulse matchmaking.
  - `UserRegistry` (extended by `UserRegistryConvoo` in `src/user_registry-convoo.js`): Manages user credentials, password hashes, and mutual contact lists.

---

## 3. WebSocket Lifecycle & Connection Resilience

Mobile browsers aggressively suspend background tabs and kill active TCP sockets. FastChat solves this with a multi-layered resilience engine in `public/app.js`:

1. **Unconditional Reconnect on Tab Resume**:
   - Do NOT trust `ws.readyState === WebSocket.OPEN` after returning from background.
   - When `visibilitychange` fires (`document.visibilityState === 'visible'`) or `window.onfocus` triggers, the app immediately force-closes the socket and establishes a fresh WebSocket connection.
2. **Ping-Pong Heartbeat (Zombie Detection)**:
   - Ping is sent every 25 seconds.
   - If no pong is received within 5 seconds, the socket is declared a zombie and forcefully closed, triggering an immediate exponential reconnect backoff (500ms to 15s).
3. **HTTP Freshness Polling Fallback**:
   - A 30-second background HTTP fetch (`/api/chat/:id/messages`) runs alongside the WebSocket to catch any edge messages sent during brief network switches.
4. **Smart DOM Render Skip**:
   - When messages are received, if the message count and last message ID are unchanged, full DOM re-rendering is skipped to avoid visual flickering.

---

## 4. Sacred UI/UX Invariants & Strict Development Rules

### Rule 1: Dual-Platform Separation (Mobile Web vs Native Android)
- **This is a Mobile Web Application (`<your-project>.pages.dev`)**:
  - The mobile browser draws its own URL bar and status bar outside the webpage viewport.
  - Safe-area insets are 0px.
  - Header is a compact 54px (`--header-height: 52px;`) with `transform: translateY(-8px)` for vertical optical centering and ZERO status bar padding.
  - NEVER add un-scoped top padding to the header or body intended for native Android status bars.

### Rule 2: Sacred Gesture & Touch Architecture (120 FPS GPU Scroll)
- `#messages-container` MUST have `touch-action: pan-y;` in `style.css` (delegates vertical scrolling directly to the device GPU compositor).
- In `initMessageTouchHandlers()`, `touchmove` MUST be registered with `{ passive: false }`.
- In `handleTouchMove(e)`:
  - If `swipeDirection === 'horizontal'`: MUST call `if (e.cancelable) e.preventDefault();` (prevents browser horizontal navigation gestures).
  - If `swipeDirection === 'vertical'`: MUST return immediately with zero DOM overhead.
- NEVER fire UI actions on `pointerdown`. Firing UI actions on `pointerdown` closes/shifts elements while the finger is still down, causing the subsequent `click` on finger-up to fall through and ghost-click whatever element is now underneath. Always use `click`.
- NEVER add custom `.focus()` or `.setSelectionRange()` on `pointerup`/`click`/`pointerdown` for `#message-input`.

### Rule 3: WhatsApp-Grade Native Keyboard & Viewport Sync
- `body` MUST have `height: 100vh; overflow: hidden;` and `#app` MUST have `width: 100%; height: 100%; position: relative; display: flex;`.
- On mobile (`@media (max-width: 768px)`), `#chat-area` MUST be `position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 100;`.
- The keyboard opens ONLY when the user directly taps `#message-input`.
- NEVER call `.focus()` programmatically in `sendMessage()`, `setReplyTo()`, `seekQuote()`, `openGifPicker()`, or `startEditingMessage()`. Programmatic focus calls cause screen jumping and keyboard stutter.
- NEVER attach forced `blur()` on message scrolling or touchstart. Users must be able to scroll through chat history freely while keeping the keyboard open.

### Rule 4: Reply-to-Media & Lightbox Reverse-Cache Architecture
- `BlobUrlCache` MUST maintain `_reverseCache: new Map()` mapping `blobUrl -> original base64 data`.
- NEVER delete `_reverseCache` or call `URL.revokeObjectURL()` inside `openChat()` or tab resume handlers. Revoking blob URLs in memory while thumbnails remain visible causes image clicks to fail.
- In `openLightbox(src)`: Resolve `blob:` URLs via `BlobUrlCache._reverseCache.get(src)` for 0ms load.
- In `seekQuote(quote)`: Direct O(1) jump using `data-target-id` element lookup (`document.querySelector('[data-id="..."]')`) with smooth centered scrolling and `.highlight-flash`.

### Rule 5: Input Bar DOM Structure & Autofill Prevention
- `#message-form` MUST be a `<div id="message-form" class="input-bar-instagram">`, NOT a `<form>`. (Wrapping inputs in a `<form>` triggers Chromium/Safari password/credit card accessory bars over the keyboard).
- `#message-input` MUST NOT have a `name` attribute.
- When logged in, auth inputs (`#password-input`, `#username-input`) MUST be neutralized (`disabled = true`, `type = 'text'`, `value = ''`).
- Enter-key sending MUST be handled via keydown event listener.

### Rule 6: Sacred Live Peek & Morph-to-Message Pipeline
- Incoming messages with live peek active MUST morph from `#typing-bubble` to the final message bubble via `morphPeekToMessage()`.
- NEVER send `state.ws.send({ type: 'typing', isTyping: false })` on message submission (kills peek bubble 10ms before message arrives).
- Always call `finalizeMorphingBubbles()` before morphing to prevent rapid-fire message collisions.

### Rule 7: Typography & Vector Icons
- Always preserve Google Font Inter in `index.html` and `style.css`.
- All icons MUST use clean inline `<svg>` vector graphics.
- NEVER use raw Unicode emoji characters in template literals, as they suffer from character encoding mismatches / mojibake across WebViews and older browsers.

---

## 5. Development & Deployment Reference

### Backend Worker Deployment:
```bash
npx wrangler deploy
```

### Frontend Pages Deployment:
```bash
npx wrangler pages deploy public --branch=main --commit-dirty=true
```
*(Or specify your project name: `npx wrangler pages deploy public --project-name=<your-project> --branch=main --commit-dirty=true`)*

### Live Worker Logs (Streaming):
```bash
npx wrangler tail
```
