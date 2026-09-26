# FastChat - Sacred Architectural Rules & Red Alerts

> This document contains the hardcoded architectural invariants, safety prohibitions, gesture rules, keyboard handling protocols, and deployment mandates for the FastChat codebase.

---

## 1. Sacred Architectural Invariants (DO NOT VIOLATE)

### Rule 1: Mobile Web Viewport & Optical Header Centering
- This application is hosted on Cloudflare Pages (`<your-project>.pages.dev`) for mobile and desktop web browsers.
- Browser draws its own URL bar and status bar outside the webpage viewport.
- Safe-area insets are 0px.
- Header is a compact 54px (`--header-height: 52px;`).
- `#back-btn, .header-back-btn, .chat-info, .chat-header-actions` MUST retain `transform: translateY(-8px)` on mobile websites for vertical optical centering.
- `#sidebar .pane-header` MUST NOT have `translateY` so the main chat list header stays naturally centered.
- NEVER apply global un-scoped top padding to `body` or `#chat-header`.

### Rule 2: 120 FPS Touch & Gesture Architecture
- `#messages-container` MUST have `touch-action: pan-y;` in `style.css` (delegates vertical scrolling directly to the device GPU compositor).
- In `initMessageTouchHandlers()`, `touchmove` MUST be registered with `{ passive: false }`.
- In `handleTouchMove(e)`:
  - If `swipeDirection === 'horizontal'`: MUST call `if (e.cancelable) e.preventDefault();`.
  - If `swipeDirection === 'vertical'`: MUST return immediately with zero DOM overhead.
- NEVER fire button or navigation actions on `pointerdown` (causes fall-through ghost clicks on finger-up). Always use `click`.
- NEVER add custom `.focus()` or `.setSelectionRange()` on `pointerup`/`click`/`pointerdown` for `#message-input`.

### Rule 3: Native Keyboard & Viewport Sync
- `body` MUST have `height: 100vh; overflow: hidden;` and `#app` MUST have `width: 100%; height: 100%; position: relative; display: flex;`.
- On mobile, `#chat-area` MUST be `position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 100;`.
- Keyboard opens ONLY when the user directly taps `#message-input`.
- NEVER call `.focus()` programmatically in `sendMessage()`, `setReplyTo()`, `seekQuote()`, `openGifPicker()`, or `startEditingMessage()`.
- NEVER attach forced `blur()` on message scrolling or touchstart. Users must be able to scroll through chat history freely while keeping the keyboard open.

### Rule 4: Reply-to-Media & Lightbox Reverse-Cache
- `BlobUrlCache` MUST maintain `_reverseCache: new Map()` mapping `blobUrl -> original base64 data`.
- NEVER call `URL.revokeObjectURL()` inside `openChat()` or tab resume handlers (kills thumbnails in memory).
- In `openLightbox(src)`: Resolve `blob:` URLs via `BlobUrlCache._reverseCache.get(src)` for 0ms instant load.
- In `seekQuote(quote)`: Direct O(1) jump using `data-target-id` element lookup (`document.querySelector('[data-id="..."]')`) with smooth centered scrolling and `.highlight-flash`.

### Rule 5: Input Bar DOM Structure & Autofill Prevention
- `#message-form` MUST be a `<div id="message-form" class="input-bar-instagram">`, NOT a `<form>`. (Wrapping inputs in a `<form>` triggers Chromium/Safari password/credit card accessory bars over the keyboard).
- `#message-input` MUST NOT have a `name` attribute.
- When logged in, auth inputs (`#password-input`, `#username-input`) MUST be neutralized (`disabled = true`, `type = 'text'`, `value = ''`).
- Enter-key sending MUST be handled via keydown event listener.

### Rule 6: Sacred Live Peek & Morph Pipeline
- Incoming messages with live peek active MUST morph from `#typing-bubble` to the final message bubble via `morphPeekToMessage()`.
- NEVER send `state.ws.send({ type: 'typing', isTyping: false })` on message submission (kills peek bubble 10ms before message arrives).
- Always call `finalizeMorphingBubbles()` before morphing to prevent rapid-fire message collisions.

### Rule 7: Typography & Vector Icons
- Always preserve Google Font Inter in `index.html` and `style.css`.
- All media placeholders, download cards, and upload cards MUST use clean inline `<svg>` vector icons.
- NEVER use raw Unicode emoji characters in template literals, as they suffer from character encoding mismatches / mojibake across WebViews.

---

## 2. Deployment Mandates

### Cloudflare Pages Production Deployment:
```bash
npx wrangler pages deploy public --branch=main --commit-dirty=true
```
- NEVER omit `--branch=main --commit-dirty=true`. Omitting this creates ephemeral preview aliases and leaves the live production website stale.

### Cloudflare Worker Backend Deployment:
```bash
npx wrangler deploy
```
