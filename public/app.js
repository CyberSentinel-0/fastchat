function closeLightbox(fromPop = false) {
    if (window._activeLbTapTimer) {
        clearTimeout(window._activeLbTapTimer);
        window._activeLbTapTimer = null;
    }
    if (window._activeLbEscHandler) {
        document.removeEventListener('keydown', window._activeLbEscHandler);
        window._activeLbEscHandler = null;
    }
    if (!fromPop && window.BackNavManager?.has('lightbox')) {
        window.BackNavManager.pop('lightbox');
    }
    const lb = document.getElementById('image-lightbox');
    if (lb) lb.remove();
}

// E2EE Peer Helper
function getPeerFromChatId(chatId) {
    if (!chatId || !state.user) return null;
    const parts = chatId.split(':');
    return parts[0] === state.user ? parts[1] : parts[0];
}

async function decryptMessageObject(m) {
    if (!m || !m.text || !window.FastChatCrypto || !FastChatCrypto.isEncrypted(m.text)) return m;
    const peer = m.from === state.user ? getPeerFromChatId(state.activeChatId) : m.from;
    if (!peer) return m;
    try {
        const decrypted = await FastChatCrypto.decryptPayload(m.text, peer, apiFetch);
        if (typeof decrypted === 'object' && decrypted !== null) {
            m.text = decrypted.text || '';
            if (decrypted.effect) m.effect = decrypted.effect;
            if (decrypted.replyTo) m.replyTo = decrypted.replyTo;
            if (decrypted.media) m.media = decrypted.media;
        } else if (typeof decrypted === 'string') {
            m.text = decrypted;
        }
    } catch (e) {
        console.warn('[E2EE] Message decrypt error:', e);
    }
    return m;
}
const TICK_ICONS = {
    pending: '<svg class="msg-tick pending" viewBox="0 0 16 16" width="15" height="15" fill="none" style="display:inline-block; vertical-align:middle;"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><line class="clock-hour-hand" x1="8" y1="8" x2="8" y2="5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line class="clock-minute-hand" x1="8" y1="8" x2="8" y2="3.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="8" r="0.75" fill="currentColor"/></svg>',
    sent: '<svg class="msg-tick sent" viewBox="0 0 16 15" width="16" height="15" fill="currentColor" style="display:inline-block; vertical-align:middle;"><path d="M12.07 3.93L5.93 10.07L3.07 7.21L1.66 8.62L5.93 12.89L13.48 5.34L12.07 3.93Z"/></svg>',
    read: '<svg class="msg-tick read" viewBox="0 0 19 15" width="19" height="15" fill="currentColor" style="display:inline-block; vertical-align:middle;"><path d="M9.91 3.93L3.77 10.07L1.91 8.21L0.5 9.62L3.77 12.89L11.32 5.34L9.91 3.93Z"/><path d="M14.91 3.93L8.77 10.07L7.36 8.66L5.95 10.07L8.77 12.89L16.32 5.34L14.91 3.93Z"/></svg>'
};

// --- Config ---
const IS_CAPACITOR = window.Capacitor !== undefined;
const IN_DEV = !IS_CAPACITOR && (location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.port === '8080');

// ============================================================================
// 🌐 BACKEND CONFIGURATION
// Replace this with YOUR deployed Cloudflare Worker URL from `npx wrangler deploy`!
// Example: const API_BASE = 'https://my-backend.<your-subdomain>.workers.dev';
// ============================================================================
const API_BASE = 'https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev';
const SERVER_FETCH_LIMIT = 200;
const CACHE_MAX_MESSAGES = 2000;

function escapeHtml(t) {
    if (!t) return '';
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}

// ==========================================================================
// INSTAGRAM URL SANITIZER & RICH OPENGRAPH LINK PREVIEWS (CONVOO)
// ==========================================================================

function sanitizeInstagramUrls(text) {
    if (!text || typeof text !== 'string') return text;
    const igRegex = /(https?:\/\/www\.instagram\.com\/(?:reel|p|tv|stories\/[a-zA-Z0-9_.-]+)\/[a-zA-Z0-9_-]+\/?)(?:\?[^\s<>"'`\)\]]*)?|(https?:\/\/instagram\.com\/(?:reel|p|tv|stories\/[a-zA-Z0-9_.-]+)\/[a-zA-Z0-9_-]+\/?)(?:\?[^\s<>"'`\)\]]*)?/gi;
    return text.replace(igRegex, (match, p1, p2) => {
        const cleanBase = p1 || p2 || match;
        const base = cleanBase.endsWith('/') ? cleanBase : cleanBase + '/';
        return base + '?igsi=';
    });
}

function linkifyText(text) {
    if (!text) return '';
    text = sanitizeInstagramUrls(text);
    const urlPattern = /(https?:\/\/[^\s<>"{}|\\^\[\]`]+)/gi;
    return text.replace(urlPattern, (url) => {
        return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="message-link">${url}</a>`;
    });
}

const LinkPreviewManager = {
    cache: new Map(), // url -> data (LRU capped at 150 entries in RAM)
    pendingPromises: new Map(), // url -> Promise<data>
    _queue: [],
    _activeRequests: 0,
    _maxConcurrency: 3, // Throttled parallel network requests
    _observer: null,
    _observerRoot: null,

    initObserver() {
        if (typeof IntersectionObserver === 'undefined') return;
        const container = document.getElementById('messages-container');
        if (this._observer && this._observerRoot === container) return;
        if (this._observer) {
            this._observer.disconnect();
        }
        this._observerRoot = container;
        this._observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const card = entry.target;
                    this._observer.unobserve(card);
                    const targetUrl = card.dataset.url;
                    if (targetUrl && !card.classList.contains('lp-resolved')) {
                        card.classList.add('lp-resolved');
                        this.resolveSlot(card, targetUrl);
                    }
                }
            });
        }, {
            root: container || null,
            rootMargin: '250px 0px 250px 0px', // 250px viewport pre-fetch threshold
            threshold: 0.01
        });
    },

    observeCard(cardEl) {
        if (!cardEl) return;
        if (typeof IntersectionObserver === 'undefined') {
            const targetUrl = cardEl.dataset.url;
            if (targetUrl) this.resolveSlot(cardEl, targetUrl);
            return;
        }
        this.initObserver();
        if (this._observer) {
            this._observer.observe(cardEl);
        }
    },

    extractUrl(text) {
        if (!text || typeof text !== 'string') return null;
        if (text.startsWith('data:') || text.startsWith('__chunked__:')) return null;

        const cleanText = sanitizeInstagramUrls(text);
        const urlMatch = cleanText.match(/https?:\/\/[^\s<>"{}|\\^\[\]`]+/i);
        if (!urlMatch) return null;

        const url = urlMatch[0];
        if (/\.(jpg|jpeg|png|gif|webp|bmp|svg|mp3|wav|ogg|m4a|mp4|webm|mov)(\?|$)/i.test(url)) {
            if (!url.includes('tenor.com') && !url.includes('giphy.com') && !url.includes('redgifs.com')) {
                return null;
            }
        }
        return url;
    },

    renderInstantCard(targetUrl) {
        if (!targetUrl) return '';

        if (this.cache.has(targetUrl)) {
            return this.renderCard(this.cache.get(targetUrl), targetUrl);
        }

        // 1. YouTube Card (Instant 0ms with high-res thumbnail)
        const isYouTube = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)/i.test(targetUrl);
        if (isYouTube) {
            const ytMatch = targetUrl.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
            const videoId = ytMatch ? ytMatch[1] : '';
            const instantYt = {
                url: targetUrl,
                type: 'youtube',
                videoId,
                title: 'YouTube Video',
                siteName: 'YouTube',
                image: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '',
                favicon: 'https://www.youtube.com/s/desktop/f7be73de/img/favicon.ico'
            };
            return this.renderCard(instantYt, targetUrl);
        }

        // 2. Instagram Card (Instant 0ms branded card with pending enrichment trigger)
        const isInstagram = /(?:instagram\.com\/(?:reel|p|tv|stories\/[a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_-]+))/i.test(targetUrl);
        if (isInstagram) {
            const igMatch = targetUrl.match(/instagram\.com\/(reel|p|tv|stories\/[a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_-]+)/i);
            const igType = igMatch ? (igMatch[1].toLowerCase().includes('reel') ? 'Instagram Reel' : 'Instagram Post') : 'Instagram Post';
            const shortcode = igMatch ? igMatch[2] : '';
            const cleanUrl = `https://www.instagram.com/${igMatch ? igMatch[1].toLowerCase() : 'p'}/${shortcode}/?igsi=`;

            const instantIg = {
                url: cleanUrl,
                type: 'instagram',
                title: igType,
                description: `Watch this ${igType.toLowerCase()} on Instagram`,
                siteName: 'Instagram',
                shortcode,
                image: '',
                isPending: true,
                favicon: 'https://static.cdninstagram.com/rsrc.php/v3/yI/r/VsNE-OHk_8a.png'
            };
            return this.renderCard(instantIg, cleanUrl);
        }

        // 3. General Website Card
        let domain = 'website';
        try { domain = new URL(targetUrl).hostname.replace(/^www\./, ''); } catch (e) {}
        const instantWeb = {
            url: targetUrl,
            type: 'website',
            title: domain,
            siteName: domain,
            isPending: true,
            favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
        };
        return this.renderCard(instantWeb, targetUrl);
    },

    setCache(url, data) {
        if (this.cache.size >= 150) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        this.cache.set(url, data);
    },

    async fetchPreview(url) {
        if (this.cache.has(url)) return this.cache.get(url);
        if (this.pendingPromises.has(url)) return this.pendingPromises.get(url);

        const fetchPromise = new Promise((resolve) => {
            const task = async () => {
                try {
                    if (typeof idb !== 'undefined') {
                        const idbCached = await idb.get('chats', `lp_${url}`).catch(() => null);
                        if (idbCached) {
                            this.setCache(url, idbCached);
                            resolve(idbCached);
                            return;
                        }
                    }

                    const apiBase = (typeof API_BASE !== 'undefined' && API_BASE) ? API_BASE : '';
                    const res = await fetch(`${apiBase}/api/link-preview?url=${encodeURIComponent(url)}`);
                    if (res.ok) {
                        const data = await res.json();
                        this.setCache(url, data);
                        if (typeof idb !== 'undefined') {
                            idb.put('chats', `lp_${url}`, data).catch(() => {});
                        }
                        resolve(data);
                        return;
                    }
                } catch (e) {
                    console.warn('[LinkPreview] Fetch error:', e);
                }
                resolve(null);
            };

            this._enqueue(task);
        });

        this.pendingPromises.set(url, fetchPromise);
        const result = await fetchPromise;
        this.pendingPromises.delete(url);
        return result;
    },

    _enqueue(task) {
        this._queue.push(task);
        this._processQueue();
    },

    _processQueue() {
        if (this._activeRequests >= this._maxConcurrency || this._queue.length === 0) return;
        this._activeRequests++;
        const nextTask = this._queue.shift();
        Promise.resolve()
            .then(() => nextTask())
            .catch(() => {})
            .finally(() => {
                this._activeRequests--;
                this._processQueue();
            });
    },

    async resolveSlot(elementOrUrl, optionalUrl) {
        const targetUrl = typeof elementOrUrl === 'string' ? elementOrUrl : (optionalUrl || elementOrUrl?.dataset?.url || elementOrUrl?.dataset?.lpUrl);
        if (!targetUrl) return;

        const data = await this.fetchPreview(targetUrl);
        if (!data) return;

        requestAnimationFrame(() => {
            const cards = document.querySelectorAll('.link-preview-card');
            cards.forEach(card => {
                if (card.dataset.url === targetUrl || (data.url && card.dataset.url === data.url)) {
                    const freshHtml = this.renderCard(data, data.url || targetUrl);
                    if (freshHtml && card.parentNode) {
                        const temp = document.createElement('div');
                        temp.innerHTML = freshHtml.trim();
                        const newEl = temp.firstElementChild;
                        if (newEl) {
                            newEl.classList.add('lp-resolved');
                            card.parentNode.replaceChild(newEl, card);
                        }
                    }
                }
            });
        });
    },

    renderCard(preview, targetUrl) {
        if (!preview) return '';
        const url = preview.url || targetUrl;
        const type = preview.type || 'website';
        const title = (typeof escapeHtml === 'function' ? escapeHtml(preview.title || url) : (preview.title || url));
        const desc = preview.description ? (typeof escapeHtml === 'function' ? escapeHtml(preview.description) : preview.description) : '';
        let domain = 'website';
        try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch (e) {}
        const siteName = (typeof escapeHtml === 'function' ? escapeHtml(preview.siteName || domain) : (preview.siteName || domain));
        const favicon = preview.favicon ? `<img src="${preview.favicon}" class="lp-favicon" alt="" onerror="this.style.display='none'">` : '';
        const isPending = preview.isPending ? ' lp-pending' : '';

        // 1. YouTube Card
        if (type === 'youtube') {
            const videoId = preview.videoId || '';
            const image = preview.image || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '');
            return `
                <div class="link-preview-card lp-youtube${isPending}" data-url="${escapeHtml(url)}" data-yt-id="${escapeHtml(videoId)}">
                    ${image ? `
                        <div class="lp-media-wrapper lp-yt-media" onclick="window.open('${escapeHtml(url)}', '_blank', 'noopener,noreferrer')">
                            <img src="${escapeHtml(image)}" class="lp-image" alt="YouTube Thumbnail" loading="lazy">
                            <div class="lp-yt-badge">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="#ff0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"/><path d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z" fill="#ffffff"/></svg>
                                <span>YouTube</span>
                            </div>
                        </div>
                    ` : ''}
                    <div class="lp-body" onclick="window.open('${escapeHtml(url)}', '_blank', 'noopener,noreferrer')">
                        <div class="lp-header-row">
                            <img src="https://www.youtube.com/s/desktop/f7be73de/img/favicon.ico" class="lp-favicon" alt="" onerror="this.style.display='none'">
                            <span class="lp-domain">YouTube</span>
                        </div>
                        <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="lp-title" onclick="event.stopPropagation()">${title}</a>
                        ${preview.author ? `<div class="lp-author">By ${escapeHtml(preview.author)}</div>` : ''}
                        ${videoId ? `
                            <div class="lp-actions">
                                <button type="button" class="lp-watch-together-btn" data-yt-id="${escapeHtml(videoId)}" title="Watch Together in Floating PiP" onclick="event.stopPropagation()">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                    <span>Watch Together</span>
                                </button>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }

        // 2. Instagram WhatsApp-grade Card (Clean: clicking anywhere opens Instagram, image click opens Lightbox)
        if (type === 'instagram') {
            const image = preview.image || '';
            return `
                <div class="link-preview-card lp-instagram${isPending}" data-url="${escapeHtml(url)}">
                    ${image ? `
                        <div class="lp-media-wrapper lp-ig-media" onclick="if(window.openLightbox){window.openLightbox('${escapeHtml(image)}');}else{window.open('${escapeHtml(url)}', '_blank', 'noopener,noreferrer');}">
                            <img src="${escapeHtml(image)}" class="lp-image" alt="Instagram Post" loading="lazy" referrerpolicy="no-referrer">
                            <div class="lp-ig-badge">
                                <span class="lp-ig-badge-icon">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="#ffffff"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
                                </span>
                                <span>Instagram</span>
                            </div>
                        </div>
                    ` : ''}
                    <div class="lp-body" onclick="window.open('${escapeHtml(url)}', '_blank', 'noopener,noreferrer')">
                        <div class="lp-header-row">
                            <span class="lp-ig-badge-icon">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="url(#ig-grad)"><defs><linearGradient id="ig-grad" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="#fdf497"/><stop offset="5%" stop-color="#fdf497"/><stop offset="45%" stop-color="#fd5949"/><stop offset="60%" stop-color="#d6249f"/><stop offset="90%" stop-color="#285AEB"/></linearGradient></defs><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
                            </span>
                            <span class="lp-domain">Instagram</span>
                        </div>
                        <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="lp-title" onclick="event.stopPropagation()">${title}</a>
                        ${desc ? `<div class="lp-desc">${desc}</div>` : ''}
                    </div>
                </div>
            `;
        }

        // 3. General Website Card
        return `
            <div class="link-preview-card lp-website${isPending}" data-url="${escapeHtml(url)}">
                ${preview.image ? `
                    <div class="lp-media-wrapper" onclick="if(window.openLightbox){window.openLightbox('${escapeHtml(preview.image)}');}else{window.open('${escapeHtml(url)}', '_blank', 'noopener,noreferrer');}">
                        <img src="${escapeHtml(preview.image)}" class="lp-image" alt="Preview Image" loading="lazy" onerror="this.parentElement.style.display='none'">
                    </div>
                ` : ''}
                <div class="lp-body" onclick="window.open('${escapeHtml(url)}', '_blank', 'noopener,noreferrer')">
                    <div class="lp-header-row">
                        ${favicon}
                        <span class="lp-domain">${siteName}</span>
                    </div>
                    <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="lp-title" onclick="event.stopPropagation()">${title}</a>
                    ${desc ? `<div class="lp-desc">${desc}</div>` : ''}
                </div>
            </div>
        `;
    }
};
// Global click delegation for Watch Together button inside link preview cards
document.addEventListener('click', (e) => {
    const wtBtn = e.target.closest('.lp-watch-together-btn');
    if (wtBtn) {
        e.preventDefault();
        e.stopPropagation();
        const ytId = wtBtn.dataset.ytId;
        if (ytId && window.WatchPartyEngine) {
            if (typeof window.WatchPartyEngine.startWithVideoId === 'function') {
                window.WatchPartyEngine.startWithVideoId(ytId);
            } else if (typeof window.WatchPartyEngine.startParty === 'function') {
                window.WatchPartyEngine.startParty(ytId, `https://youtu.be/${ytId}`, true, 0);
            }
        }
    }
});


// ==========================================================================
// BackNavManager: Universal Android Back Button & Browser History Stack
// ==========================================================================
const BackNavManager = {
    _stack: [],
    _suppressPopstateCount: 0,
    _initialized: false,

    init() {
        if (this._initialized) return;
        this._initialized = true;

        if (typeof window === 'undefined') return;

        // Establish initial baseline state
        try {
            if (!history.state || !history.state.fastchat) {
                history.replaceState({ fastchat: true, root: true, depth: 0 }, '');
            }
        } catch (e) {}

        // Listen to browser popstate (swipe-back / back button on web)
        window.addEventListener('popstate', (e) => {
            this._onPopState(e);
        });

        // Listen to Capacitor / Android system back button
        if (window.Capacitor?.Plugins?.App?.addListener) {
            window.Capacitor.Plugins.App.addListener('backButton', () => {
                this.handleBack();
            });
        } else {
            document.addEventListener('backbutton', () => {
                this.handleBack();
            });
        }
    },

    push(id, closeCallback, metadata = {}) {
        if (!id) return;

        // If already top of stack, just update callback/metadata
        const top = this._stack[this._stack.length - 1];
        if (top && top.id === id) {
            top.closeCallback = closeCallback;
            top.metadata = metadata;
            return;
        }

        // If present earlier in stack, remove prior occurrence
        const existingIdx = this._stack.findIndex(e => e.id === id);
        if (existingIdx !== -1) {
            this._stack.splice(existingIdx, 1);
        }

        const depth = this._stack.length + 1;
        this._stack.push({ id, closeCallback, metadata, depth });

        try {
            history.pushState({ fastchat: true, id, depth }, '');
        } catch (e) {
            console.warn('[BackNav] pushState failed:', e);
        }
    },

    pop(id) {
        const idx = id ? this._stack.findIndex(entry => entry.id === id) : this._stack.length - 1;
        if (idx === -1) return;

        this._stack.splice(idx, 1);

        // Tell _onPopState to ignore the next popstate event caused by this history.back()
        this._suppressPopstateCount++;
        try {
            history.back();
        } catch (e) {
            this._suppressPopstateCount = Math.max(0, this._suppressPopstateCount - 1);
            console.warn('[BackNav] history.back failed:', e);
        }
    },

    _isHandlingBack: false,

    handleBack() {
        if (this._isHandlingBack) return;
        this._isHandlingBack = true;
        setTimeout(() => { this._isHandlingBack = false; }, 320);

        // Check transient popups first (kebab menu, attach menu, reaction bubble)
        if (this._checkTransientPopups()) return;

        // If soft keyboard is open or an input is focused, dismiss it first without closing chat/modal
        const activeInp = document.activeElement;
        const msgInp = document.getElementById('message-input');
        const gifInp = document.getElementById('gif-search-input');
        if (document.body.classList.contains('keyboard-open') || (msgInp && activeInp === msgInp) || (gifInp && activeInp === gifInp)) {
            if (activeInp && typeof activeInp.blur === 'function') activeInp.blur();
            if (msgInp && document.activeElement === msgInp) msgInp.blur();
            if (gifInp && document.activeElement === gifInp) gifInp.blur();
            document.body.classList.remove('keyboard-open');
            return;
        }

        if (this._stack.length > 0) {
            try {
                history.back();
            } catch (e) {
                this._popTopDirectly();
            }
        } else if (document.body.classList.contains('show-chat')) {
            const backBtn = document.getElementById('back-btn');
            if (backBtn) backBtn.click();
        } else {
            if (window.Capacitor?.Plugins?.App?.exitApp) {
                window.Capacitor.Plugins.App.exitApp();
            }
        }
    },

    _checkTransientPopups() {
        // 1. Kebab menu
        const kebabDropdown = document.getElementById('kebab-dropdown');
        if (kebabDropdown && !kebabDropdown.classList.contains('hidden')) {
            kebabDropdown.classList.add('hidden');
            if (typeof window.__closeKebabInternal === 'function') window.__closeKebabInternal();
            return true;
        }
        // 2. Attach menu popover
        const attachMenu = document.getElementById('image-picker-modal');
        if (attachMenu && !attachMenu.classList.contains('hidden')) {
            if (typeof closeImagePicker === 'function') closeImagePicker(false);
            else attachMenu.classList.add('hidden');
            return true;
        }
        // 3. Quick reaction bubble
        const reactionPicker = document.getElementById('reaction-picker');
        if (reactionPicker && !reactionPicker.classList.contains('hidden')) {
            reactionPicker.classList.add('hidden');
            if (typeof hideReactionPicker === 'function') hideReactionPicker();
            return true;
        }
        return false;
    },

    _onPopState(e) {
        if (this._suppressPopstateCount > 0) {
            this._suppressPopstateCount--;
            return;
        }

        // Check transient popups
        if (this._checkTransientPopups()) return;

        if (this._stack.length === 0) {
            if (document.body.classList.contains('show-chat')) {
                if (typeof closeActiveChat === 'function') {
                    closeActiveChat(true);
                } else {
                    const backBtn = document.getElementById('back-btn');
                    if (backBtn) backBtn.click();
                }
            }
            return;
        }

        const entry = this._stack.pop();
        if (entry && typeof entry.closeCallback === 'function') {
            try {
                entry.closeCallback({ fromBack: true });
            } catch (err) {
                console.error('[BackNav] Error in close callback:', err);
            }
        }
    },

    _popTopDirectly() {
        if (this._stack.length === 0) return;
        const entry = this._stack.pop();
        if (entry && typeof entry.closeCallback === 'function') {
            try {
                entry.closeCallback({ fromBack: true });
            } catch (err) {
                console.error('[BackNav] Error in close callback:', err);
            }
        }
    },

    has(id) {
        return this._stack.some(e => e.id === id);
    },

    clear() {
        this._stack = [];
        this._suppressPopstateCount = 0;
    }
};

window.BackNavManager = BackNavManager;
BackNavManager.init();

// Global modal-to-header ghost-click protection shield (prevents touch bleed-through to back-btn or kebab-btn)
let _lastModalCloseTs = 0;
window._markModalClosed = () => { _lastModalCloseTs = Date.now(); };
window._isModalJustClosed = () => (Date.now() - _lastModalCloseTs < 400);


// Mobile Height Fix (debounced to prevent layout thrashing)
let _vhRaf = 0;
const setVh = () => {
    cancelAnimationFrame(_vhRaf);
    _vhRaf = requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
    });
};
window.addEventListener('resize', setVh, { passive: true });
window.addEventListener('orientationchange', setVh, { passive: true });
const closeChatSpecificNetwork = () => {
    const isRandomActive = state.isRandom || (state.activeChatId && state.activeChatId.startsWith('rnd_')) || (window.RandomChatManager && (window.RandomChatManager.isConnected || window.RandomChatManager.isSearching));
    if (isRandomActive) {
        console.log('[Lifecycle] Random chat active: preserving network and WebSocket in background');
        return;
    }
    const callActive = typeof peerConnection !== 'undefined' && peerConnection !== null;
    if (!callActive && state.ws) {
        try {
            state.ws.onclose = null;
            state.ws.onerror = null;
            state.ws.close();
        } catch(e){}
        state.ws = null;
    }
    if (state._freshnessInterval) { clearInterval(state._freshnessInterval); state._freshnessInterval = null; }
    if (state.peerPresenceInterval) { clearInterval(state.peerPresenceInterval); state.peerPresenceInterval = null; }
    if (state.wsPingInterval) { clearInterval(state.wsPingInterval); state.wsPingInterval = null; }
    if (state._pongTimeout) { clearTimeout(state._pongTimeout); state._pongTimeout = null; }
    if (state.wsReconnectTimeout) { clearTimeout(state.wsReconnectTimeout); state.wsReconnectTimeout = null; }
};

let _chatListPollTimer = null;
const startChatListPolling = () => {
    if (_chatListPollTimer) clearInterval(_chatListPollTimer);
    _chatListPollTimer = setInterval(() => {
        if (document.hidden || !state.user || state.activeChatId) return;
        if (typeof refreshChatList === 'function') refreshChatList();
    }, 12000);
};

const suspendNetwork = () => {
    const isRandomActive = state.isRandom || (state.activeChatId && state.activeChatId.startsWith('rnd_')) || (window.RandomChatManager && (window.RandomChatManager.isConnected || window.RandomChatManager.isSearching));
    if (isRandomActive) {
        console.log('[Lifecycle] Random chat active: skipping network suspension in background');
        return;
    }
    state._networkSuspended = true;
    const callActive = typeof peerConnection !== 'undefined' && peerConnection !== null;
    console.log('[Lifecycle] Suspending network. Call active:', callActive);
    closeChatSpecificNetwork();
    if (state.presenceInterval) { clearInterval(state.presenceInterval); state.presenceInterval = null; }
    if (_chatListPollTimer) { clearInterval(_chatListPollTimer); _chatListPollTimer = null; }
};

const resumeNetwork = () => {
    state._networkSuspended = false;
    console.log('[Lifecycle] Resuming network...');
    setVh();
    setTimeout(setVh, 100);
    if (typeof WallpaperEngine !== 'undefined' && typeof WallpaperEngine.resume === 'function') {
        WallpaperEngine.resume();
    }
    if (window.WatchPartyEngine && window.WatchPartyEngine.active && typeof window.WatchPartyEngine.resync === 'function') {
        window.WatchPartyEngine.resync();
    }
    if (state.user) {
        if (state.presenceInterval) clearInterval(state.presenceInterval);
        state.presenceInterval = setInterval(sendPresence, 30000);
        sendPresence();
        if (typeof refreshChatList === 'function') refreshChatList();
        startChatListPolling();
        if (state.activeChatId) {
            const targetChatId = state.activeChatId;
            connectWS(targetChatId);
            apiFetch(`/api/chat/${targetChatId}/read`, { method: 'POST' }).catch(() => {});
            apiFetch(`/api/chat/${targetChatId}/messages?limit=${SERVER_FETCH_LIMIT}`).then(async msgs => {
                if (Array.isArray(msgs) && msgs.length > 0) {
                    _lastChatFetchTs[targetChatId] = Date.now();
                    const m = await ChatCache.appendMessages(targetChatId, msgs);
                    if (state.activeChatId === targetChatId) {
                        const existingList = document.getElementById('messages-list');
                        const existingElements = existingList ? existingList.querySelectorAll('.message') : [];
                        if (existingElements.length > 0) {
                            const existingIds = new Set();
                            existingElements.forEach(el => {
                                if (el.dataset.id) existingIds.add(el.dataset.id);
                                if (el.dataset.clientId) existingIds.add(el.dataset.clientId);
                            });
                            const newMsgs = msgs.filter(msg => {
                                const id = msg.id || '';
                                const cid = msg.clientId || '';
                                return (!id || !existingIds.has(id)) && (!cid || !existingIds.has(cid));
                            });
                            if (newMsgs.length > 0) {
                                renderMessages(newMsgs, true);
                                const mc = document.getElementById('messages-container');
                                const isNearBottom = mc.scrollHeight - mc.scrollTop - mc.clientHeight < 150;
                                if (isNearBottom) scrollToBottom(true);
                            }
                        } else {
                            renderMessages(m);
                            scrollToBottom(true);
                        }
                    }
                }
            }).catch(() => {});
        }
    }
};

let _lastHiddenAt = 0;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        _lastHiddenAt = Date.now();
        suspendNetwork();
    } else {
        resumeNetwork();
    }
});

window.addEventListener('focus', () => {
    if (typeof WallpaperEngine !== 'undefined' && typeof WallpaperEngine.resume === 'function') {
        WallpaperEngine.resume();
    }
    if (state.activeChatId && !document.hidden) {
        apiFetch(`/api/chat/${state.activeChatId}/read`, { method: 'POST' }).catch(() => {});
    }
});

window.addEventListener('pageshow', () => {
    if (typeof WallpaperEngine !== 'undefined' && typeof WallpaperEngine.resume === 'function') {
        WallpaperEngine.resume();
    }
});

if (IS_CAPACITOR && window.Capacitor?.Plugins?.App) {
    try {
        window.Capacitor.Plugins.App.addListener('appStateChange', ({ isActive }) => {
            if (!isActive) {
                suspendNetwork();
                if (typeof WallpaperEngine !== 'undefined' && typeof WallpaperEngine.stopLoop === 'function') {
                    WallpaperEngine.stopLoop();
                }
            } else {
                resumeNetwork();
                if (typeof WallpaperEngine !== 'undefined' && typeof WallpaperEngine.resume === 'function') {
                    WallpaperEngine.resume();
                }
            }
        });
    } catch (e) { console.error('[Lifecycle] Failed to add App State listener', e); }
}
setVh();

// Configure Status Bar and Navigation Bar for Android
if (IS_CAPACITOR && window.Capacitor?.Plugins?.StatusBar) {
    const { StatusBar } = window.Capacitor.Plugins;
    try {
        // Set status bar style and background
        StatusBar.setBackgroundColor({ color: '#181c20' }).catch(() => { });
        StatusBar.setStyle({ style: 'DARK' }).catch(() => { });
    } catch (e) { /* Ignore errors */ }
}

if (IN_DEV && 'serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(r => r.forEach(x => x.unregister()));

// --- IDB (Reduced for brevity, same as before) ---
const DB_NAME = 'fastchat_db';
const idb = {
    db: null,
    async init() {
        return new Promise(r => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = e => { e.target.result.createObjectStore('chats'); e.target.result.createObjectStore('messages'); };
            req.onsuccess = e => { this.db = e.target.result; r(); };
            req.onerror = () => r();
        });
    },
    async get(s, k) { if (!this.db) return null; return new Promise(r => { const rx = this.db.transaction(s).objectStore(s).get(k); rx.onsuccess = () => r(rx.result); rx.onerror = () => r(null); }); },
    async put(s, k, v) {
        if (!this.db) { console.warn('IDB not ready'); return; }
        return new Promise(r => {
            const tx = this.db.transaction(s, 'readwrite');
            const rx = tx.objectStore(s).put(v, k);
            rx.onsuccess = () => r();
            rx.onerror = (e) => { console.error('IDB put error:', e); r(); };
        });
    }
};


// Basic State
const state = {
    user: localStorage.getItem('chat_user') || null,
    receiver: null, // The person we are chatting with
    pushToken: null,
    loadedMessageLimit: 200,
    hasMoreHistory: true,
    isLoadingOlder: false
};
window.state = state;

// Detect Platform & Native App Environment
const isAndroid = /Android/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
if (isAndroid) document.body.classList.add('platform-android');
if (isIOS) document.body.classList.add('platform-ios');

const IS_NATIVE_APP = typeof window !== 'undefined' && (
    (typeof window.Capacitor !== 'undefined' && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) || 
    window.location.protocol === 'file:' ||
    /FastChat/i.test(navigator.userAgent)
);
if (IS_NATIVE_APP) {
    document.body.classList.add('is-native-app');
}

// --- Client Blob URL Memory Cache for large base64 media ---
const _loadedMediaInSession = new Map();

function formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || isNaN(bytesPerSec) || bytesPerSec <= 0) return 'Calculating...';
    if (bytesPerSec >= 1024 * 1024) {
        return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
    }
    return Math.round(bytesPerSec / 1024) + ' KB/s';
}

function renderPlaceholderCard(msgId, mediaType, sizeInBytes) {
    const typeUpper = (mediaType || 'MEDIA').toUpperCase();
    let iconSvg = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>`;
    if (typeUpper.includes('IMAGE') || typeUpper.includes('PHOTO')) {
        iconSvg = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;
    } else if (typeUpper.includes('GIF')) {
        iconSvg = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M11.5 9H13v6h-1.5zM9 9H6c-.6 0-1 .4-1 1v4c0 .6.4 1 1 1h3c.6 0 1-.4 1-1v-2H7.5v1h-1v-3h2.5V9zm10 1.5V9h-4.5v6H16v-2h2v-1.5h-2v-1h3z"/></svg>`;
    } else if (typeUpper.includes('VIDEO')) {
        iconSvg = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`;
    } else if (typeUpper.includes('AUDIO') || typeUpper.includes('VOICE')) {
        iconSvg = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
    }

    const formattedSize = formatBytes(sizeInBytes);
    const displayTitle = (typeUpper === 'IMAGE') ? 'PHOTO' : typeUpper;

    return `
        <div class="media-download-card" data-msg-id="${msgId}">
            <div class="media-card-header">
                <div class="media-card-icon">${iconSvg}</div>
                <div class="media-card-details">
                    <span class="media-card-title">${displayTitle}</span>
                    <span class="media-card-size">${formattedSize}</span>
                </div>
            </div>
            <button class="media-card-btn" onclick="window.downloadMediaMessage('${msgId}', this)">
                <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none" style="pointer-events:none; margin-right:4px; display:inline-block; vertical-align:middle;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                <span>Tap to Load</span>
            </button>
        </div>
    `;
}

function renderFullMediaContent(msg) {
    const rawText = (msg.id && _loadedMediaInSession.get(msg.id)) || (msg.clientId && _loadedMediaInSession.get(msg.clientId)) || msg.text;
    if (rawText && rawText.startsWith('__chunked__:')) {
        const mediaTypeStr = msg.mediaType || 'media';
        const sizeInBytes = msg.mediaSize || 0;
        return renderPlaceholderCard(msg.id || msg.clientId, mediaTypeStr, sizeInBytes);
    }
    const currentMsg = (rawText && rawText !== msg.text) ? { ...msg, text: rawText } : msg;
    const isUrl = currentMsg.text && (currentMsg.text.startsWith('http://') || currentMsg.text.startsWith('https://'));
    const isGif = (currentMsg.text && currentMsg.text.startsWith('data:image/gif')) || currentMsg.mediaType === 'gif' || (isUrl && (currentMsg.text.includes('tenor.com') || currentMsg.text.includes('giphy.com') || /\.(gif|webp)(\?|$)/i.test(currentMsg.text)));
    const isImage = (currentMsg.text && currentMsg.text.startsWith('data:image/')) || currentMsg.mediaType === 'image' || (isUrl && /\.(jpeg|jpg|png|bmp)(\?|$)/i.test(currentMsg.text));
    const isVoice = (currentMsg.text && currentMsg.text.startsWith('data:audio/')) || currentMsg.mediaType === 'audio' || currentMsg.mediaType === 'voice';
    const isVideo = (currentMsg.text && currentMsg.text.startsWith('data:video/')) || currentMsg.mediaType === 'video' || (isUrl && /\.(mp4|webm|mov)(\?|$)/i.test(currentMsg.text));

    const mediaData = (isGif || isImage || isVoice || isVideo) 
        ? BlobUrlCache.get(currentMsg.id || currentMsg.clientId, currentMsg.text) 
        : currentMsg.text;

    if (isGif) {
        return `<img src="${mediaData}" class="message-gif" alt="GIF" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    } else if (isImage) {
        return `<img src="${mediaData}" class="message-image" alt="Image" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    } else if (isVoice) {
        let initialDurationStr = '0:00';
        if (typeof msg.duration === 'number' && msg.duration > 0) {
            const m = Math.floor(msg.duration / 60);
            const s = Math.floor(msg.duration % 60);
            initialDurationStr = `${m}:${s.toString().padStart(2, '0')}`;
        }
        return `
            <div class="voice-message" data-duration="${msg.duration || ''}">
                <button class="voice-play-btn" type="button" aria-label="Play voice note"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
                <div class="voice-progress-container" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                    <div class="voice-progress"><div class="voice-progress-bar"></div></div>
                </div>
                <span class="voice-duration">${initialDurationStr}</span>
                <button class="voice-dl-btn" type="button" title="Download"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>
                <audio data-src="${mediaData}" preload="none"></audio>
            </div>`;
    } else if (isVideo) {
        return `
            <div class="video-message">
                <video class="message-video" preload="none" controls playsinline>
                    <source src="${mediaData}">
                </video>
                <button class="video-dl-btn" title="Download"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>
            </div>`;
    }

        let html = formatMessageText(msg.text);
    if (typeof LinkPreviewManager !== 'undefined') {
        const targetUrl = LinkPreviewManager.extractUrl(msg.text);
        if (targetUrl) {
            html += LinkPreviewManager.renderInstantCard(targetUrl);
        }
    }
    return html;
}

window.downloadMediaMessage = function(msgId, btnElement) {
    const card = btnElement.closest('.media-download-card');
    if (!card || card.classList.contains('downloading')) return;

    // Fast-path: Check if message text is already present locally in memory
    const existingMsg = (state.chatMessages && state.chatMessages[state.activeChatId])
        ? state.chatMessages[state.activeChatId].find(m => (m.id === msgId || m.clientId === msgId))
        : null;

    if (existingMsg && existingMsg.text && !existingMsg.text.startsWith('__chunked__:')) {
        _loadedMediaInSession.set(msgId, existingMsg.text);
        const msgEl = document.querySelector(`[data-id="${msgId}"]`) || document.querySelector(`[data-client-id="${msgId}"]`);
        if (msgEl) {
            const textEl = msgEl.querySelector('.msg-text');
            if (textEl) {
                textEl.innerHTML = renderFullMediaContent(existingMsg);
            }
        }
        return;
    }

    let estTotalBytes = 0;
    const sizeText = card.querySelector('.media-card-size')?.textContent || '';
    if (sizeText) {
        const parts = sizeText.trim().split(' ');
        const val = parseFloat(parts[0]);
        const unit = (parts[1] || '').toUpperCase();
        if (!isNaN(val)) {
            if (unit === 'KB') estTotalBytes = Math.floor(val * 1024);
            else if (unit === 'MB') estTotalBytes = Math.floor(val * 1024 * 1024);
            else if (unit === 'GB') estTotalBytes = Math.floor(val * 1024 * 1024 * 1024);
            else estTotalBytes = Math.floor(val);
        }
    }

    card.classList.add('downloading');

    card.innerHTML = `
        <div class="media-card-header">
            <div class="media-card-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></div>
            <div class="media-card-details">
                <span class="media-card-title">Downloading...</span>
                <span class="media-card-size" id="p-metrics-${msgId}">0% \u2022 Connecting</span>
            </div>
        </div>
        <div class="media-card-progress">
            <div class="media-progress-bar-bg">
                <div class="media-progress-bar-fill" id="p-bar-${msgId}"></div>
            </div>
        </div>
    `;

    const startTime = Date.now();
    let lastLoaded = 0;
    let lastTime = startTime;

    const xhr = new XMLHttpRequest();
    xhr.open('GET', `${API_BASE}/api/chat/${state.activeChatId}/messages?id=${msgId}&full=true`, true);
    const token = localStorage.getItem('fc_token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    
    xhr.onprogress = (e) => {
        const now = Date.now();
        const elapsedTime = (now - lastTime) / 1000;
        if (elapsedTime > 0.1 || e.loaded === e.total) {
            const loaded = e.loaded;
            const total = (e.lengthComputable && e.total > 0) ? e.total : estTotalBytes;
            const deltaLoaded = loaded - lastLoaded;
            const speedBps = elapsedTime > 0 ? (deltaLoaded / elapsedTime) : 0;
            
            const speedText = formatSpeed(speedBps);
            const loadedText = formatBytes(loaded);
            const percent = total ? Math.min(99, Math.round((loaded / total) * 100)) : 0;

            const bar = document.getElementById(`p-bar-${msgId}`);
            const metrics = document.getElementById(`p-metrics-${msgId}`);
            if (bar) bar.style.width = `${percent}%`;
            if (metrics) {
                metrics.textContent = total 
                    ? `${percent}% (${loadedText} / ${formatBytes(total)}) \u2022 ${speedText}`
                    : `${loadedText} \u2022 ${speedText}`;
            }

            lastLoaded = loaded;
            lastTime = now;
        }
    };

    xhr.onload = () => {
        if (xhr.status === 200) {
            try {
                const res = JSON.parse(xhr.responseText);
                const msg = Array.isArray(res) ? res[0] : res;
                if (msg && msg.text && !msg.text.startsWith('__chunked__:')) {
                    _loadedMediaInSession.set(msgId, msg.text);
                    if (msg.id) _loadedMediaInSession.set(msg.id, msg.text);
                    if (msg.clientId) _loadedMediaInSession.set(msg.clientId, msg.text);
                    if (state.chatMessages && state.chatMessages[state.activeChatId]) {
                        const cached = state.chatMessages[state.activeChatId].find(m => (m.id === msgId || m.clientId === msgId));
                        if (cached) cached.text = msg.text;
                    }
                    const msgEl = document.querySelector(`[data-id="${msgId}"]`) || document.querySelector(`[data-client-id="${msgId}"]`);
                    if (msgEl) {
                        const textEl = msgEl.querySelector('.msg-text');
                        if (textEl) {
                            textEl.innerHTML = renderFullMediaContent(msg);
                        }
                    }
                }
            } catch (err) {
                console.error('[DownloadMedia] Error:', err);
                card.innerHTML = `<span style="color:#ff5555;font-size:12px;">Download failed. Tap to retry.</span>`;
            }
        }
    };

    xhr.onerror = () => {
        card.innerHTML = `<span style="color:#ff5555;font-size:12px;">Network error. Tap to retry.</span>`;
    };

    xhr.send();
};

async function sendMediaPayloadWithProgress(base64Text, cid, mediaType, extraOpts = {}) {
    const targetChatId = state.activeChatId;
    if (!targetChatId) return;
    const cidStr = cid || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let effectiveMediaType = mediaType;
    if (!effectiveMediaType || effectiveMediaType === 'image' || effectiveMediaType === 'media') {
        if (typeof base64Text === 'string') {
            if (base64Text.startsWith('data:image/gif')) effectiveMediaType = 'gif';
            else if (base64Text.startsWith('data:video/')) effectiveMediaType = 'video';
            else if (base64Text.startsWith('data:audio/')) effectiveMediaType = 'audio';
            else if (base64Text.startsWith('data:image/')) effectiveMediaType = 'image';
        }
    }

    const m = { from: state.user, text: base64Text, ts: Date.now(), clientId: cidStr, pending: true, mediaType: effectiveMediaType };
    if (extraOpts && extraOpts.duration) m.duration = extraOpts.duration;

    if (typeof replyingTo !== 'undefined' && replyingTo) {
        let resolvedMedia = replyingTo.mediaSrc || null;
        if (resolvedMedia && (resolvedMedia.startsWith('blob:') || resolvedMedia.startsWith('data:'))) {
            resolvedMedia = await BlobUrlCache.resolveForReply(resolvedMedia);
        }
        m.replyTo = {
            id: replyingTo.id || undefined,
            from: replyingTo.from,
            text: (replyingTo.text || '').slice(0, 100),
            media: resolvedMedia || undefined,
            mediaType: replyingTo.mediaType || undefined
        };
        clearReply();
    }
    if (typeof selectedEffect !== 'undefined' && selectedEffect && selectedEffect !== 'none') {
        m.effect = selectedEffect;
        selectedEffect = 'none';
    }
    
    _loadedMediaInSession.set(cidStr, base64Text);

    if (state.activeChatId === targetChatId) {
        renderMessages([m], true);
        scrollToBottom(true);
    }
    ChatCache.appendMessages(targetChatId, [m]).catch(() => { });

    const totalBytes = base64Text.length;
    const CHUNK_SIZE = 500000;

    function updateUploadUI(loaded, total, startTime, lastLoaded, lastTime) {
        if (state.activeChatId !== targetChatId) return;
        const now = Date.now();
        const elapsedTime = (now - lastTime) / 1000;
        const percent = Math.min(99, Math.round((loaded / total) * 100));
        let speedBps = 0;
        if (elapsedTime > 0.05 && loaded > lastLoaded) {
            speedBps = (loaded - lastLoaded) / elapsedTime;
        } else if (now - startTime > 300 && loaded > 0) {
            speedBps = loaded / ((now - startTime) / 1000);
        }
        const speed = formatSpeed(speedBps);
        const loadedStr = formatBytes(loaded);
        const totalStr = formatBytes(total);

        const msgEl = document.querySelector(`[data-client-id="${cidStr}"]`);
        if (msgEl) {
            let fillEl = msgEl.querySelector('.upload-progress-fill');
            let titleEl = msgEl.querySelector('.media-card-title');
            let metricsEl = msgEl.querySelector('.upload-metrics-text');

            if (!fillEl) {
                const textEl = msgEl.querySelector('.msg-text');
                if (textEl) {
                    textEl.innerHTML = `
                        <div class="upload-progress-card">
                            <div class="media-card-header">
                                <div class="media-card-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg></div>
                                <div class="media-card-details">
                                    <span class="media-card-title">Uploading... ${percent}%</span>
                                    <span class="upload-metrics-text">${loadedStr} / ${totalStr} â€¢ ${speed}</span>
                                </div>
                            </div>
                            <div class="media-progress-bar-bg">
                                <div class="upload-progress-fill" style="width:${percent}%"></div>
                            </div>
                        </div>
                    `;
                }
            } else {
                fillEl.style.width = `${percent}%`;
                if (titleEl) titleEl.textContent = `Uploading... ${percent}%`;
                if (metricsEl) metricsEl.textContent = `${loadedStr} / ${totalStr} â€¢ ${speed}`;
            }
        }
    }

    function showUploadError() {
        if (state.activeChatId !== targetChatId) return;
        const msgEl = document.querySelector(`[data-client-id="${cidStr}"]`);
        if (msgEl) {
            const textEl = msgEl.querySelector('.msg-text');
            if (textEl) {
                textEl.innerHTML = `<span style="color:#ff5555;font-size:12px;">Upload failed. Tap to retry.</span>`;
            }
        }
    }

    try {
        if (totalBytes > CHUNK_SIZE) {
            const chunks = [];
            for (let i = 0; i < totalBytes; i += CHUNK_SIZE) {
                chunks.push(base64Text.slice(i, i + CHUNK_SIZE));
            }

            const tempMsgId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const startTime = Date.now();
            let lastLoaded = 0;
            let lastTime = startTime;

            // Initial UI update so user immediately sees 0% and progress card
            updateUploadUI(0, totalBytes, startTime, 0, startTime);

            for (let i = 0; i < chunks.length; i++) {
                let success = false;
                const baseChunkOffset = i * CHUNK_SIZE;

                for (let attempt = 0; attempt < 3; attempt++) {
                    const res = await new Promise((resolve) => {
                        const xhr = new XMLHttpRequest();
                        xhr.open('POST', `${API_BASE}/api/chat/${targetChatId}/upload_chunk`, true);
                        xhr.setRequestHeader('Content-Type', 'application/json');
                        const token = localStorage.getItem('fc_token');
                        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
                        xhr.upload.onprogress = (e) => {
                            if (e.lengthComputable) {
                                const currentLoaded = Math.min(totalBytes, baseChunkOffset + e.loaded);
                                updateUploadUI(currentLoaded, totalBytes, startTime, lastLoaded, lastTime);
                                lastLoaded = currentLoaded;
                                lastTime = Date.now();
                            }
                        };
                        xhr.onload = () => {
                            if (xhr.status === 200) {
                                try { resolve(JSON.parse(xhr.responseText)); } catch (err) { resolve(null); }
                            } else { resolve(null); }
                        };
                        xhr.onerror = () => resolve(null);
                        xhr.send(JSON.stringify({
                            msgId: tempMsgId,
                            tempMsgId: tempMsgId,
                            chunkIndex: i,
                            totalChunks: chunks.length,
                            chunkData: chunks[i]
                        }));
                    });

                    if (res && (res.success || res.status === 'ok')) {
                        success = true;
                        break;
                    }
                    await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                }

                if (!success) {
                    showUploadError();
                    return;
                }

                const currentLoaded = Math.min(totalBytes, (i + 1) * CHUNK_SIZE);
                updateUploadUI(currentLoaded, totalBytes, startTime, lastLoaded, lastTime);
                lastLoaded = currentLoaded;
                lastTime = Date.now();
            }

            const chunkPayload = {
                text: `__chunked__:${chunks.length}`,
                clientId: cidStr,
                mediaType: effectiveMediaType,
                mediaSize: Math.floor(totalBytes * 0.75),
                tempMsgId: tempMsgId
            };
            if (m.replyTo) chunkPayload.replyTo = m.replyTo;
            if (m.effect) chunkPayload.effect = m.effect;
            if (extraOpts && extraOpts.duration) chunkPayload.duration = extraOpts.duration;

            let finalRes = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                finalRes = await apiFetch(`/api/chat/${targetChatId}/send`, {
                    method: 'POST',
                    body: JSON.stringify(chunkPayload)
                });
                if (finalRes && finalRes.id && !finalRes.error) break;
                await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
            }

            if (finalRes && finalRes.id && !finalRes.error) {
                _loadedMediaInSession.set(finalRes.id, base64Text);
                _loadedMediaInSession.set(cidStr, base64Text);
                ChatCache.appendMessages(targetChatId, [{ ...finalRes, text: `__chunked__:${chunks.length}`, pending: false }]).catch(() => { });
                if (state.chatMessages && state.chatMessages[targetChatId]) {
                    const localMsg = state.chatMessages[targetChatId].find(item => (item.id === finalRes.id || item.clientId === cidStr));
                    if (localMsg) localMsg.text = base64Text;
                }
                if (state.activeChatId === targetChatId) {
                    const msgEl = document.querySelector(`[data-client-id="${cidStr}"]`);
                    if (msgEl) {
                        msgEl.dataset.id = finalRes.id;
                        msgEl.classList.remove('pending');
                        const textEl = msgEl.querySelector('.msg-text');
                        if (textEl) {
                            textEl.innerHTML = renderFullMediaContent({ ...finalRes, text: base64Text });
                        }
                        const tickEl = msgEl.querySelector('.ticks');
                        if (tickEl) { tickEl.className = 'ticks'; tickEl.innerHTML = TICK_ICONS.sent; }
                    }
                }
            } else {
                showUploadError();
            }
        } else {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API_BASE}/api/chat/${targetChatId}/send`, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            const token = localStorage.getItem('fc_token');
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

            const startTime = Date.now();
            let lastLoaded = 0;
            let lastTime = startTime;

            // Initial UI update so user immediately sees 0% and progress card
            updateUploadUI(0, totalBytes, startTime, 0, startTime);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    updateUploadUI(e.loaded, e.total, startTime, lastLoaded, lastTime);
                    lastLoaded = e.loaded;
                    lastTime = Date.now();
                }
            };

            xhr.onload = () => {
                if (xhr.status === 200) {
                    try {
                        const s = JSON.parse(xhr.responseText);
                        if (s && s.id && !s.error) {
                            _loadedMediaInSession.set(s.id, base64Text);
                            _loadedMediaInSession.set(cidStr, base64Text);
                            ChatCache.appendMessages(targetChatId, [{ ...s, pending: false }]).catch(() => { });
                            if (state.chatMessages && state.chatMessages[targetChatId]) {
                                const localMsg = state.chatMessages[targetChatId].find(item => (item.id === s.id || item.clientId === cidStr));
                                if (localMsg) localMsg.text = base64Text;
                            }
                            if (state.activeChatId === targetChatId) {
                                const msgEl = document.querySelector(`[data-client-id="${cidStr}"]`);
                                if (msgEl) {
                                    msgEl.dataset.id = s.id;
                                    msgEl.classList.remove('pending');
                                    const textEl = msgEl.querySelector('.msg-text');
                                    if (textEl) {
                                        textEl.innerHTML = renderFullMediaContent({ ...s, text: base64Text });
                                    }
                                    const tickEl = msgEl.querySelector('.ticks');
                                    if (tickEl) { tickEl.className = 'ticks'; tickEl.innerHTML = TICK_ICONS.sent; }
                                }
                            }
                        } else { showUploadError(); }
                    } catch (err) { showUploadError(); }
                } else { showUploadError(); }
            };
            xhr.onerror = showUploadError;

            const sendPayload = { text: base64Text, clientId: cidStr, mediaType: effectiveMediaType };
            if (m.replyTo) sendPayload.replyTo = m.replyTo;
            if (m.effect) sendPayload.effect = m.effect;
            if (extraOpts && extraOpts.duration) sendPayload.duration = extraOpts.duration;
            xhr.send(JSON.stringify(sendPayload));
        }
    } catch (e) {
        showUploadError();
    }
}

const BlobUrlCache = {
    _cache: new Map(),
    _reverseCache: new Map(), // blobUrl -> original base64 data
    get(msgId, base64Data) {
        if (this._cache.has(msgId)) return this._cache.get(msgId);
        if (base64Data && base64Data.startsWith('data:')) {
            try {
                const parts = base64Data.split(',');
                const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
                const bstr = atob(parts[1]);
                let n = bstr.length;
                const u8arr = new Uint8Array(n);
                while (n--) u8arr[n] = bstr.charCodeAt(n);
                const blob = new Blob([u8arr], { type: mime });
                const url = URL.createObjectURL(blob);
                this._cache.set(msgId, url);
                this._reverseCache.set(url, base64Data);
                // Bound JS heap: keep at most 100 media base64 strings in memory to prevent OOM
                if (this._reverseCache.size > 100) {
                    const oldestUrl = this._reverseCache.keys().next().value;
                    if (oldestUrl) this._reverseCache.delete(oldestUrl);
                }
                return url;
            } catch (e) {
                console.error('[BlobCache] Conversion error:', e);
                return base64Data;
            }
        }
        return base64Data;
    },
    // Convert a blob URL (or data: URL) to a crisp, high-DPI base64 thumbnail for reply quotes
    resolveForReply(src) {
        if (!src) return Promise.resolve(null);
        const dataUrl = src.startsWith('blob:') ? (this._reverseCache.get(src) || src) : src;
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    const size = 200; // High-DPI crisp thumbnail
                    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
                    if (w > h) { h = Math.round(h * size / w); w = size; }
                    else { w = Math.round(w * size / h); h = size; }
                    canvas.width = Math.max(1, w);
                    canvas.height = Math.max(1, h);
                    const ctx = canvas.getContext('2d');
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/jpeg', 0.85));
                } catch (e) {
                    resolve((dataUrl && dataUrl.startsWith('data:') && dataUrl.length < 65000) ? dataUrl : null);
                }
            };
            img.onerror = () => {
                resolve((dataUrl && dataUrl.startsWith('data:') && dataUrl.length < 65000) ? dataUrl : null);
            };
            img.src = dataUrl;
        });
    }
};

// --- Cache ---
const ChatCache = {
    chats: [],
    hiddenChats: new Set(),
    _activeMsgs: new Map(), // In-memory cache: cid -> message array
    _saveTimer: null,
    _pendingSaveCids: new Set(),

    async loadChats() {
        this.chats = await idb.get('chats', `list_${state.user}`) || [];
        // Load hidden chats list
        const hidden = await idb.get('chats', `hidden_${state.user}`);
        this.hiddenChats = new Set(hidden || []);
        return this.chats;
    },

    async saveChats(list) {
        this.chats = list;
        await idb.put('chats', `list_${state.user}`, list);
    },

    async addChat(peer, existsCheck = false) {
        // Unhide if was hidden
        if (this.hiddenChats.has(peer)) {
            this.hiddenChats.delete(peer);
            await idb.put('chats', `hidden_${state.user}`, [...this.hiddenChats]);
        }

        if (!this.chats.find(c => c.other === peer)) {
            if (existsCheck) {
                const check = await apiFetch(`/api/users/${peer}/check`);
                if (!check.exists) return false;
            }
            this.chats.unshift({ other: peer, lastTs: Date.now(), unread: 0 });
            await this.saveChats(this.chats);
            return true;
        }
        return true;
    },

    async hideChat(peer) {
        this.hiddenChats.add(peer);
        await idb.put('chats', `hidden_${state.user}`, [...this.hiddenChats]);
        // Remove from visible list
        this.chats = this.chats.filter(c => c.other !== peer);
        await this.saveChats(this.chats);
    },

    getVisibleChats() {
        return this.chats.filter(c => !this.hiddenChats.has(c.other));
    },

    async getMessages(cid) {
        if (this._activeMsgs.has(cid)) {
            return this._activeMsgs.get(cid);
        }
        const msgs = await idb.get('messages', `msgs_${cid}`) || [];
        this._activeMsgs.set(cid, msgs);
        return msgs;
    },

    async getAllMessageCount(cid) {
        const msgs = await this.getMessages(cid);
        return msgs.length;
    },

    _scheduleSave(cid) {
        this._pendingSaveCids.add(cid);
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            for (const saveCid of this._pendingSaveCids) {
                const msgs = this._activeMsgs.get(saveCid);
                if (msgs) {
                    idb.put('messages', `msgs_${saveCid}`, msgs.slice(-CACHE_MAX_MESSAGES)).catch(() => {});
                }
            }
            this._pendingSaveCids.clear();
        }, 300);
    },

    async appendMessages(cid, newMsgs) {
        let existing = this._activeMsgs.get(cid);
        if (!existing) {
            existing = await idb.get('messages', `msgs_${cid}`) || [];
        }
        const merged = [...existing];
        let changed = false;
        newMsgs.forEach(m => {
            const idx = merged.findIndex(x => (x.id && x.id === m.id) || (x.clientId && x.clientId === m.clientId));
            if (idx > -1) {
                if (merged[idx].pending && !m.pending) { merged[idx] = m; changed = true; }
            } else {
                merged.push(m);
                changed = true;
            }
        });
        if (changed) {
            merged.sort((a, b) => (a.ts - b.ts) || ((a.id || a.clientId || '').localeCompare(b.id || b.clientId || '')));
            this._activeMsgs.set(cid, merged);
            this._scheduleSave(cid);
        } else {
            this._activeMsgs.set(cid, merged);
        }
        return merged;
    },

    async markRead(cid, ts) {
        let msgs = this._activeMsgs.get(cid);
        if (!msgs) {
            msgs = await idb.get('messages', `msgs_${cid}`) || [];
            this._activeMsgs.set(cid, msgs);
        }
        let c = false;
        msgs.forEach(m => { if (m.from === state.user && m.ts <= ts && !m.read) { m.read = true; c = true; } });
        if (c) {
            this._scheduleSave(cid);
        }
        return msgs;
    },

    async deleteMessage(cid, targetId, clientId) {
        const targets = new Set([String(targetId || ''), String(clientId || '')].filter(Boolean));
        let msgs = this._activeMsgs.get(cid);
        if (!msgs) {
            msgs = await idb.get('messages', `msgs_${cid}`) || [];
        }
        const remaining = msgs.filter(m => !targets.has(String(m.id || '')) && !targets.has(String(m.clientId || '')));
        this._activeMsgs.set(cid, remaining);
        await idb.put('messages', `msgs_${cid}`, remaining.slice(-CACHE_MAX_MESSAGES));
        return remaining;
    },

    async syncWithServer(cid, serverMsgs) {
        if (!Array.isArray(serverMsgs)) return this.getMessages(cid);
        
        let local = this._activeMsgs.get(cid);
        if (!local) {
            local = await idb.get('messages', `msgs_${cid}`) || [];
        }

        // Map server messages by ID and clientId
        const serverMap = new Map();
        serverMsgs.forEach(m => {
            if (m.id) serverMap.set(String(m.id), m);
            if (m.clientId) serverMap.set(String(m.clientId), m);
        });

        // Retain local pending messages that haven't reached server yet
        const pendingLocal = local.filter(m => m.pending && m.clientId && !serverMap.has(String(m.clientId)));

        // Build the reconciled message list from serverMsgs (server truth) + pendingLocal
        const reconciled = [...serverMsgs, ...pendingLocal];
        reconciled.sort((a, b) => (a.ts - b.ts) || ((a.id || a.clientId || '').localeCompare(b.id || b.clientId || '')));

        this._activeMsgs.set(cid, reconciled);
        await idb.put('messages', `msgs_${cid}`, reconciled.slice(-CACHE_MAX_MESSAGES));
        return reconciled;
    },

    async clearMessages(cid) {
        this._activeMsgs.set(cid, []);
        this._pendingSaveCids.delete(cid);
        await idb.put('messages', `msgs_${cid}`, []);
    }
};

// --- API ---
async function apiFetch(path, ops = {}) {
    const token = localStorage.getItem("fc_token");
    const headers = { 'Content-Type': 'application/json', ...ops.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
        const r = await fetch(API_BASE + path, { ...ops, headers });
        const t = await r.text();
        if (!r.ok) return { error: t, status: r.status };
        if (!t || !t.trim()) return {};
        try {
            return JSON.parse(t);
        } catch {
            return { text: t };
        }
    } catch (e) { return { error: "Network Error" }; }
}
window.apiFetch = apiFetch;

function saveToken(t) { if (t) { localStorage.setItem('fc_token', t); } }

// --- Auth ---
async function checkSession() {
    await idb.init();
    if (!localStorage.getItem("fc_token")) return showAuth();
    const d = await apiFetch('/api/me');
    if (d.username) { state.user = d.username; initApp(); } else logout();
}

function logout() { localStorage.removeItem("fc_token"); location.reload(); }
function showAuth() { document.getElementById('auth-screen').classList.remove('hidden'); document.getElementById('main-layout').classList.add('hidden'); }

function initApp() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-layout').classList.remove('hidden');
    document.getElementById('my-username').textContent = state.user;
    document.getElementById('my-avatar').textContent = state.user[0].toUpperCase();

    // Neutralize & detach auth screen so Chrome Android autofill (key/credit card bar) has 0 targets
    const authScreen = document.getElementById('auth-screen');
    if (authScreen) authScreen.remove();

    // Save username for background notification polling (combined app JS bridge)
    if (window.StealthNotify && window.StealthNotify.saveUsername) {
        try { window.StealthNotify.saveUsername(state.user); } catch (e) { }
    }

    // Load cached chats immediately (fast)
    ChatCache.loadChats().then(cached => {
        if (cached.length > 0) renderChatList(cached);
    });

    // Sync with server in background (non-blocking)
    refreshChatList();
    startChatListPolling();

    // Load my profile picture
    if (typeof loadMyProfilePic === 'function') loadMyProfilePic();

    // Start presence heartbeat (non-blocking) - 60 seconds
    sendPresence();
    if (typeof initPushNotifications === 'function') initPushNotifications();
    state.presenceInterval = setInterval(sendPresence, 30000);
}

async function sendPresence() {
    apiFetch('/api/presence', { method: 'POST', body: JSON.stringify({ username: state.user }) }).catch(() => { });
}

// Stealth notify ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â send innocent notification to peer's hidden app
async function sendStealthNotify() {
    if (!state.activeChatId) return;
    const btn = document.getElementById('stealth-notify-btn');
    if (btn) { btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none'; }
    try {
        const res = await apiFetch(`/api/chat/${state.activeChatId}/stealth_notify`, { method: 'POST' });
        console.log('[StealthNotify] Response:', JSON.stringify(res));
        if (btn) btn.style.color = res.error ? '#ff4444' : '#22c55e';
    } catch (e) {
        console.error('[StealthNotify] Failed:', e);
        if (btn) btn.style.color = '#ff4444';
    }
    setTimeout(() => { if (btn) { btn.style.opacity = '1'; btn.style.pointerEvents = 'auto'; btn.style.color = ''; } }, 3000);
}

// --- UI Logic ---
async function refreshChatList() {
    const serverList = await apiFetch('/api/chats');

    if (Array.isArray(serverList)) {
        // Merge server chats with local cache (server is source of truth for chat existence)
        // But keep local unread counts if server doesn't have them
        const localChats = await ChatCache.loadChats();
        const localMap = new Map(localChats.map(c => [c.other, c]));

        // Build merged list - server chats take priority
        const mergedList = serverList.map(serverChat => {
            const localChat = localMap.get(serverChat.other);
            return {
                ...serverChat,
                // Preserve local cache data if server is missing some fields
                lastMessage: serverChat.lastMessage || (localChat?.lastMessage || ''),
            };
        });

        await ChatCache.saveChats(mergedList);
        renderChatList(mergedList);
    } else {
        // Fallback to local cache if server fails
        renderChatList(await ChatCache.loadChats());
    }
}

function renderChatList(list) {
    if (!list) list = ChatCache.chats;
    // Filter out hidden chats
    list = list.filter(c => !ChatCache.hiddenChats.has(c.other));

    const activeTab = state.activeView || 'direct';
    if (activeTab === 'groups' || activeTab === 'spaces') {
        list = list.filter(c => c.isGroup || c.isSpace || (typeof c.other === 'string' && c.other.startsWith('grp_')));
        // User directive: all groups listed from top to bottom on high user group on top
        list.sort((a, b) => (b.memberCount || 1) - (a.memberCount || 1));
    } else if (activeTab === 'direct') {
        list = list.filter(c => !c.isGroup && !c.isSpace && !(typeof c.other === 'string' && (c.other.startsWith('grp_') || c.other.startsWith('rnd_'))));
    } else if (activeTab === 'random') {
        // Random tab is exclusively for matchmaking; do not list direct contacts in the sidebar
        list = [];
    }

    const c = document.getElementById('conversations-list');
    const frag = document.createDocumentFragment();
    const now = Date.now();
    const todayStr = new Date().toDateString();

    list.forEach(chat => {
        const div = document.createElement('div');
        div.className = `chat-item ${state.activePeer === chat.other ? 'active' : ''}`;
        div.dataset.peer = chat.other;

        // Time Calc
        const diff = now - (chat.otherLastSeen || 0);
        const isOnline = diff < 65000;

        let lastMsgTime = '';
        if (chat.lastTs) {
            const d = new Date(chat.lastTs);
            lastMsgTime = (d.toDateString() === todayStr) ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) : d.toLocaleDateString();
        }

        const isGroupChat = chat.isGroup || chat.isSpace || (typeof chat.other === 'string' && chat.other.startsWith('grp_'));
        const displayName = isGroupChat ? (chat.name || 'Group') : chat.other;
        const avatarContent = isGroupChat
            ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`
            : (chat.other ? chat.other[0].toUpperCase() : '?');

        div.innerHTML = `
            <div class="avatar-circle small" data-user="${chat.other}">${avatarContent}</div>
            <div class="chat-item-info">
                <div class="chat-item-top">
                    <span class="chat-item-name">${escapeHtml(displayName)}${isGroupChat ? '<span class="group-badge"><svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>GROUP</span>' : ''}</span>
                    <span class="chat-item-time">${lastMsgTime}</span>
                </div>
                <div class="chat-item-bottom">
                    <span class="chat-item-preview">${escapeHtml(chat.lastMessage || '')}</span>
                    ${isGroupChat && chat.memberCount ? `<span class="group-member-count">${chat.memberCount} members</span>` : ''}
                    ${chat.unread ? `<span class="unread-badge">${chat.unread}</span>` : ''}
                </div>
            </div>
            ${isOnline && !isGroupChat ? '<div class="online-dot"></div>' : ''}
        `;

        // Load profile picture for this chat item (direct chats only)
        if (!isGroupChat) {
            const avatarEl = div.querySelector('.avatar-circle');
            const cachedPic = localStorage.getItem(`profile_pic_${chat.other}`);
            if (cachedPic && avatarEl) {
                avatarEl.style.backgroundImage = `url(${cachedPic})`;
                avatarEl.classList.add('has-pic');
                avatarEl.textContent = '';
            }
        }

        // Long press / Hold state to delete chat
        let pressTimer = null;
        let didLongPress = false;

        const startPress = () => {
            didLongPress = false;
            pressTimer = setTimeout(() => {
                didLongPress = true;
                if (navigator.vibrate) navigator.vibrate(40);
                showDeleteModal(chat.other);
            }, 550);
        };

        const cancelPress = () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        };

        div.addEventListener('touchstart', startPress, { passive: true });
        div.addEventListener('touchend', cancelPress, { passive: true });
        div.addEventListener('touchcancel', cancelPress, { passive: true });
        div.addEventListener('touchmove', cancelPress, { passive: true });

        // Desktop right-click / context menu
        div.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showDeleteModal(chat.other);
        });

        // Click to open chat (only if not triggered by a long press)
        div.onclick = () => {
            if (didLongPress) {
                didLongPress = false;
                return;
            }
            openChat(chat.other, chat.otherLastSeen);
        };

        frag.appendChild(div);
    });

    if (list.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-chat-list-notice';
        if (activeTab === 'groups' || activeTab === 'spaces') {
            emptyDiv.innerHTML = `
                <div class="empty-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
                <span>No groups yet</span>
                <small>Tap + to create a group</small>
            `;
        } else if (activeTab === 'random') {
            emptyDiv.innerHTML = `
                <div class="empty-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg></div>
                <span>Random Match</span>
                <small>Find and chat with strangers 1-on-1</small>
                <button type="button" class="btn-sidebar-random-start" id="btn-sidebar-random-start" style="margin-top:14px;padding:9px 20px;background:var(--accent);color:#000;font-weight:600;font-size:13px;border:none;border-radius:24px;cursor:pointer;">Start Random Chat</button>
            `;
            setTimeout(() => {
                emptyDiv.querySelector('#btn-sidebar-random-start')?.addEventListener('click', () => {
                    if (window.RandomChatManager) window.RandomChatManager.openRandomChat();
                });
            }, 0);
        } else {
            emptyDiv.innerHTML = `
                <div class="empty-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
                <span>No direct messages</span>
                <small>Tap + to start a conversation</small>
            `;
        }
        frag.appendChild(emptyDiv);
    }

    c.innerHTML = '';
    c.appendChild(frag);
}

// Open Chat & Last Seen Logic
let _lastChatFetchTs = {};
let _lastWpSyncTs = {};
async function openChat(peer, lastSeenTs) {
    if (state.activeView === 'random' && peer !== 'random' && (!peer || !peer.startsWith('rnd_'))) {
        return;
    }
    const cachedChat = ChatCache.chats ? ChatCache.chats.find(c => c.other === peer) : null;
    const isGroup = (typeof peer === 'string' && peer.startsWith('grp_')) || Boolean(cachedChat && cachedChat.isGroup);
    const isRandom = (typeof peer === 'string' && peer.startsWith('rnd_')) || peer === 'random';
    const targetChatId = (isGroup || isRandom) ? peer : [state.user, peer].sort().join(':');
    const prevChatId = state.activeChatId;
    state.activePeer = peer;
    state.activeChatId = targetChatId;
    state.isGroup = isGroup;
    state.isSpace = isGroup;
    state.isRandom = isRandom;
    state.isPulse = isRandom;
    const isSameChat = prevChatId === targetChatId;
    if (window.CinemaManager) {
        window.CinemaManager.resetSessionReadiness();
    }

    document.body.classList.add('show-chat');
    if (window.innerWidth <= 768 || document.body.classList.contains('show-chat')) {
        BackNavManager.push('chat', () => {
            closeActiveChat(true);
        });
    }
    // Clear unread badge in local cache immediately
    if (cachedChat && cachedChat.unread > 0) {
        cachedChat.unread = 0;
        ChatCache.saveChats(ChatCache.chats).catch(() => {});
    }
    renderChatList(ChatCache.chats); // Update active class and clear badge

    document.getElementById('no-chat-selected').classList.add('hidden');
    document.getElementById('pulse-container')?.classList.add('hidden');
    document.getElementById('active-chat-container').classList.remove('hidden');

    const chatMsgInp = document.getElementById('message-input');
    const hasInitialText = chatMsgInp ? chatMsgInp.value.trim().length > 0 : false;
    if (typeof updateActionAndGifState === 'function') {
        updateActionAndGifState(hasInitialText, true);
    }

    const randomActionBar = document.getElementById('random-action-bar');
    const randomCenterMenu = document.getElementById('random-center-menu');
    const stdHdrActions = document.getElementById('standard-header-actions');
    const chatTitle = document.getElementById('chat-title');
    const chatAvatar = document.getElementById('chat-avatar');
    const connStatus = document.getElementById('connection-status');

    const chatHeader = document.getElementById('chat-header');
    if (chatHeader) {
        chatHeader.classList.toggle('is-group', isGroup);
        chatHeader.classList.toggle('is-random', isRandom);
    }

    if (isRandom) {
        if (stdHdrActions) stdHdrActions.classList.remove('hidden');
        const isMatched = typeof peer === 'string' && peer.startsWith('rnd_') && window.RandomChatManager?.isConnected;
        if (isMatched) {
            if (randomActionBar) randomActionBar.classList.remove('hidden');
            if (randomCenterMenu) randomCenterMenu.classList.add('hidden');
            document.getElementById('active-chat-container')?.classList.add('has-random-bar');
            chatTitle.textContent = 'Anonymous';
            connStatus.textContent = 'Online';
        } else {
            if (randomActionBar) randomActionBar.classList.add('hidden');
            if (randomCenterMenu) randomCenterMenu.classList.remove('hidden');
            document.getElementById('active-chat-container')?.classList.remove('has-random-bar');
            chatTitle.textContent = '-';
            connStatus.textContent = 'Looking for someone...';
        }
        chatAvatar.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/></svg>`;
        chatAvatar.style.backgroundImage = '';
        chatAvatar.classList.remove('has-pic');
    } else if (isGroup) {
        if (randomActionBar) randomActionBar.classList.add('hidden');
        if (randomCenterMenu) randomCenterMenu.classList.add('hidden');
        if (stdHdrActions) stdHdrActions.classList.remove('hidden');
        chatTitle.textContent = cachedChat?.name || 'Group';
        connStatus.textContent = `${cachedChat?.memberCount ? cachedChat.memberCount + ' members • ' : ''}Tap for Group Details`;
        chatAvatar.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
        chatAvatar.style.backgroundImage = '';
        chatAvatar.classList.remove('has-pic');

        // Fetch fresh group info in background if uncached
        if (!cachedChat || !cachedChat.name || cachedChat.name === 'Group') {
            apiFetch(`/api/groups/${peer}/info`).then(gInfo => {
                if (gInfo && !gInfo.error && state.activeChatId === peer) {
                    if (gInfo.name) chatTitle.textContent = gInfo.name;
                    const mCount = gInfo.memberCount || (Array.isArray(gInfo.memberList) ? gInfo.memberList.length : (gInfo.members ? Object.keys(gInfo.members).length : 1));
                    connStatus.textContent = `${mCount} members • Tap for Group Details`;
                    if (cachedChat) {
                        cachedChat.name = gInfo.name || cachedChat.name;
                        cachedChat.memberCount = mCount;
                        ChatCache.saveChats(ChatCache.chats).catch(() => {});
                    }
                }
            }).catch(() => {});
        }
    } else {
        if (randomActionBar) randomActionBar.classList.add('hidden');
        if (randomCenterMenu) randomCenterMenu.classList.add('hidden');
        if (stdHdrActions) stdHdrActions.classList.remove('hidden');
        chatTitle.textContent = peer;
        chatAvatar.innerHTML = '';
        chatAvatar.textContent = peer[0].toUpperCase();
        chatAvatar.style.backgroundImage = '';
        chatAvatar.classList.remove('has-pic');
        if (typeof loadPeerProfilePic === 'function') loadPeerProfilePic(peer);
        updateHeaderStatus(lastSeenTs);
    }

    // Load wallpaper from cache FIRST (instant, no flash)
    const wpCacheKey = `wp_${targetChatId}`;
    const cachedWp = localStorage.getItem(wpCacheKey);
    if (cachedWp) {
        try {
            const cached = JSON.parse(cachedWp);
            if (cached.image) setWallpaper(cached.image, cached.opacity);
            else setWallpaper(null, 0);
        } catch (e) { setWallpaper(null, 0); }
    } else {
        setWallpaper(null, 0);
    }

    // Load theme from cache FIRST (instant, zero flash)
    const themeCacheKey = `theme_${targetChatId}`;
    const cachedTheme = localStorage.getItem(themeCacheKey) || 'default';
    if (typeof window.setTheme === 'function') window.setTheme(cachedTheme);

    // Reset pagination state for this newly opened chat
    state.loadedMessageLimit = SERVER_FETCH_LIMIT;
    state.hasMoreHistory = true;
    state.isLoadingOlder = false;

    // Attach scroll and pull-to-refresh listener to messages-container for infinite scroll-up
    const msgContainer = document.getElementById('messages-container');
    if (msgContainer && !msgContainer._scrollPaginationAttached) {
        msgContainer._scrollPaginationAttached = true;
        let _olderScrollRaf = 0;
        msgContainer.addEventListener('scroll', () => {
            window._lastUserScrollTs = Date.now();
            if (_olderScrollRaf) return;
            _olderScrollRaf = requestAnimationFrame(() => {
                _olderScrollRaf = 0;
                if (msgContainer.scrollTop < 120 && !state.isLoadingOlder && state.hasMoreHistory) {
                    loadOlderMessages();
                }
            });
        }, { passive: true });
    }

    // If re-opening same chat within 5s, skip heavy server fetches
    const now = Date.now();
    const skipServerFetch = isSameChat && _lastChatFetchTs[targetChatId] && (now - _lastChatFetchTs[targetChatId] < 5000);

    if (!skipServerFetch) {
        const localAll = await ChatCache.getMessages(targetChatId);
        // Guard: if user switched to another chat while reading local cache, abort rendering
        if (state.activeChatId !== targetChatId) return;

        renderMessages(localAll.slice(-state.loadedMessageLimit));
        scrollToBottom();

        apiFetch(`/api/chat/${targetChatId}/read`, { method: 'POST' }).catch(() => {});
        connectWS(targetChatId);

        const serverMsgs = await apiFetch(`/api/chat/${targetChatId}/messages?limit=${SERVER_FETCH_LIMIT}`);
        _lastChatFetchTs[targetChatId] = Date.now();
        if (Array.isArray(serverMsgs)) {
            if (serverMsgs.length === 0) {
                const localMsgs = await ChatCache.getMessages(targetChatId);
                if (localMsgs.length > 0) {
                    await ChatCache.clearMessages(targetChatId);
                    if (state.activeChatId === targetChatId) {
                        document.getElementById('messages-list').innerHTML = '';
                    }
                }
            } else {
                const m = await ChatCache.syncWithServer(targetChatId, serverMsgs);
                if (serverMsgs.length < SERVER_FETCH_LIMIT && m.length <= state.loadedMessageLimit) {
                    state.hasMoreHistory = false;
                }
                // Guard: only render to DOM if this chat is still currently open on screen
                if (state.activeChatId === targetChatId) {
                    const mc = document.getElementById('messages-container');
                    const isNearBottom = mc ? (mc.scrollHeight - mc.scrollTop - mc.clientHeight < 150) : true;
                    // Skip redundant 2nd DOM re-render if server returned identical message set as local cache
                    const isSameAsLocal = localAll && localAll.length === m.length && (
                        m.length === 0 || (
                            (localAll[localAll.length - 1].id || localAll[localAll.length - 1].clientId) === (m[m.length - 1].id || m[m.length - 1].clientId) &&
                            (localAll[0].id || localAll[0].clientId) === (m[0].id || m[0].clientId)
                        )
                    );
                    if (!isSameAsLocal) {
                        renderMessages(m.slice(-state.loadedMessageLimit));
                        if (isNearBottom) {
                            scrollToBottom();
                        }
                    }
                }
            }
        }

        // Sync wallpaper from server (only if >60s since last sync)
        const skipWpSync = _lastWpSyncTs[targetChatId] && (now - _lastWpSyncTs[targetChatId] < 60000);
        if (!skipWpSync) {
            _lastWpSyncTs[targetChatId] = Date.now();
            apiFetch(`/api/chat/${targetChatId}/wallpaper`).then(wp => {
                if (wp && wp.image) {
                    const oldCache = localStorage.getItem(wpCacheKey);
                    const newCache = JSON.stringify(wp);
                    if (oldCache !== newCache) {
                        localStorage.setItem(wpCacheKey, newCache);
                        if (state.activeChatId === targetChatId) {
                            setWallpaper(wp.image, wp.opacity);
                        }
                    }
                } else if (wp && !wp.image) {
                    localStorage.removeItem(wpCacheKey);
                    if (state.activeChatId === targetChatId) {
                        setWallpaper(null, 0);
                    }
                }
            }).catch(() => { });

            // Sync theme from server
            apiFetch(`/api/chat/${targetChatId}/theme`).then(res => {
                if (res && res.theme) {
                    localStorage.setItem(themeCacheKey, res.theme);
                    if (state.activeChatId === targetChatId && typeof window.setTheme === 'function') {
                        window.setTheme(res.theme);
                    }
                }
            }).catch(() => { });

            // Sync active Watch Party session
            apiFetch(`/api/chat/${targetChatId}/watch_party`).then(res => {
                if (res && res.active && res.session && window.WatchPartyEngine) {
                    if (state.activeChatId === targetChatId && !window.WatchPartyEngine.active) {
                        if (res.session.mode !== 'local' && res.session.videoId) {
                            window.WatchPartyEngine.startParty(res.session.videoId, res.session.url, false, res.session.calculatedTime || 0);
                        }
                    }
                }
            }).catch(() => { });
        }
    } else {
        // Same chat Ã¢â‚¬â€ DOM already has messages, just show and scroll
        document.body.classList.add('show-chat');
        scrollToBottom();
        // Ensure WS is alive
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            connectWS(targetChatId);
        }
    }
}

let _peerLastSeenTs = 0;
let _statusRefreshTimer = null;

function updateHeaderStatus(lastSeenTs) {
    const el = document.getElementById('connection-status');
    if (!el) return;

    if (state.isGroup || (state.activeChatId && state.activeChatId.startsWith('grp_'))) {
        const cached = ChatCache.chats ? ChatCache.chats.find(c => c.other === state.activeChatId || c.other === state.activePeer) : null;
        el.textContent = `${cached?.memberCount ? cached.memberCount + ' members • ' : ''}Tap for Group Details`;
        el.classList.remove('online');
        return;
    }

    if (state.isRandom || (state.activeChatId && state.activeChatId.startsWith('rnd_'))) {
        if (window.RandomChatManager?.isConnected) {
            el.textContent = 'Online';
            el.classList.add('online');
        } else {
            el.textContent = 'Looking for someone...';
            el.classList.remove('online');
        }
        return;
    }

    if (lastSeenTs) _peerLastSeenTs = lastSeenTs;

    if (!_peerLastSeenTs) {
        el.textContent = 'Offline';
        el.classList.remove('online');
        return;
    }

    const diff = Date.now() - _peerLastSeenTs;
    if (diff < 65000) {
        el.textContent = 'Online';
        el.classList.add('online');
    } else {
        el.classList.remove('online');
        const secs = Math.floor(diff / 1000);
        if (secs < 60) el.textContent = 'Last seen just now';
        else {
            const mins = Math.floor(diff / 60000);
            if (mins < 60) el.textContent = `Last seen ${mins}m ago`;
            else {
                const hrs = Math.floor(mins / 60);
                if (hrs < 24) el.textContent = `Last seen ${hrs}h ago`;
                else el.textContent = `Last seen ${Math.floor(hrs / 24)}d ago`;
            }
        }
    }

        // Auto-refresh the counter every 10s so "Xm ago" stays live
    if (!_statusRefreshTimer) {
        _statusRefreshTimer = setInterval(() => {
            if (state.activePeer && _peerLastSeenTs) {
                updateHeaderStatus();
            } else {
                clearInterval(_statusRefreshTimer);
                _statusRefreshTimer = null;
            }
        }, 10000);
    }
}

// ðŸš¨ðŸš¨ðŸš¨ SUPER RED ALERT: SACRED LIVE PEEK & MORPH ENGINE 2.0 (CONVOO) ðŸš¨ðŸš¨ðŸš¨
// REMADE FOR ZERO-LAG, ZERO-SNAP, 120 FPS FLUIDITY & RAPID-FIRE MESSAGE QUEUEING
let _typingAutoHide = null;
const _peekGraphemeSegmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function renderPeekStream(text) {
    if (!text || typeof text !== 'string' || text.length === 0) {
        return '<span class="peek-caret"></span>';
    }
    // Enhanced visible contrast: older text distinctly dimmer (0.50 floor), newest text bright white (1.0)
    const decayStep = 0.028;
    const minOp = 0.50;
    
    const lines = text.split('\n');
    const totalLines = lines.length;
    
    // Split each line into grapheme clusters so emojis aren't split across UTF-16 surrogates
    const lineGraphemes = lines.map(line => {
        return _peekGraphemeSegmenter
            ? Array.from(_peekGraphemeSegmenter.segment(line), s => s.segment)
            : Array.from(line);
    });
    
    let totalChars = 0;
    for (let l = 0; l < totalLines; l++) totalChars += lineGraphemes[l].length;
    
    let html = '';
    let charIdx = 0;
    for (let l = 0; l < totalLines; l++) {
        const chars = lineGraphemes[l];
        for (let i = 0; i < chars.length; i++) {
            const char = chars[i];
            const distFromEnd = (totalChars - 1 - charIdx);
            const opacity = Math.max(minOp, (1.0 - (distFromEnd * decayStep))).toFixed(2);
            const isHead = distFromEnd < 1;
            const headClass = isHead ? ' peek-head-char' : '';
            const glowStyle = isHead ? 'color:#ffffff;text-shadow:0 0 8px rgba(0,168,132,0.65),0 0 2px #ffffff;' : '';
            
            // Standard space inside white-space: pre-wrap preserves full glyph width while wrapping naturally at word boundaries
            const displayChar = escapeHtml(char);
            html += `<span class="peek-char${headClass}" style="opacity:${opacity};${glowStyle}">${displayChar}</span>`;
            charIdx++;
        }
        if (l < totalLines - 1) {
            html += '<br>';
        }
    }
    html += '<span class="peek-caret"></span>';
    return html;
}

function finalizeMorphingBubbles() {
    document.querySelectorAll('.message.morphing').forEach(b => {
        if (b._morphTimer) {
            clearTimeout(b._morphTimer);
            b._morphTimer = null;
        }
        b.classList.remove('typing-indicator', 'peek-open', 'morphing', 'peer-paused');
        // Instantly hide collapsing header & tag with zero DOM reconstruction/snap
        const header = b.querySelector('.typing-bubble-header');
        if (header) header.style.display = 'none';
        const tag = b.querySelector('.peek-header-tag');
        if (tag) tag.style.display = 'none';
        const caret = b.querySelector('.peek-caret');
        if (caret) caret.remove();
        b.querySelectorAll('.peek-char').forEach(c => {
            c.style.opacity = '1';
            c.style.textShadow = 'none';
            c.style.color = 'inherit';
        });
        const footer = b.querySelector('.peek-msg-footer');
        if (footer) {
            footer.className = 'msg-footer';
            footer.style.opacity = '1';
        }
    });
}

function morphPeekToMessage(m, bubble) {
    if (!bubble) return;
    clearTimeout(_typingAutoHide);

    // Finalize any previous morph in-flight so rapid-fire messages don't collide
    finalizeMorphingBubbles();

    // 1. Mark as morphing
    bubble.classList.add('morphing', 'morphed');
    bubble.removeAttribute('id');

    // 2. Set official message attributes
    bubble.dataset.id = m.id || '';
    bubble.dataset.clientId = m.clientId || '';
    bubble.dataset.from = m.from || '';
    bubble.dataset.ts = m.ts ? String(m.ts) : String(Date.now());
    const t = new Date(m.ts || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });

    // 3. Smoothly collapse header chrome & draft tag
    const header = bubble.querySelector('.typing-bubble-header');
    if (header) header.classList.add('collapsed');

    const draftTag = bubble.querySelector('.peek-header-tag');
    if (draftTag) draftTag.classList.add('collapsed');

    // 4. Dissolve caret & solidify character colors
    const caret = bubble.querySelector('.peek-caret');
    if (caret) caret.classList.add('dissolved');

    bubble.querySelectorAll('.peek-char').forEach(c => {
        c.style.opacity = '1';
        c.style.textShadow = 'none';
        c.style.color = 'inherit';
    });

    // Ensure final delivered text is cleanly synchronized without destroying layout
    const streamEl = bubble.querySelector('#peek-text-stream') || bubble.querySelector('.peek-text-stream');
    if (streamEl && m.text !== undefined) {
        const lines = (m.text || '').split('\n');
        streamEl.innerHTML = lines.map(line => escapeHtml(line)).join('<br>');
    }

    // 5. Reveal timestamp inline
    const footer = bubble.querySelector('#peek-msg-footer') || bubble.querySelector('.peek-msg-footer');
    if (footer) {
        footer.innerHTML = `<span class="timestamp">${t}</span>`;
        footer.classList.add('revealed');
    }

    // 6. Inject standard hover menu & swipe actions if missing
    const hoverMenu = `<div class="message-hover-menu">
        <button class="hover-btn hover-reply" title="Reply">\u21A9</button>
        <button class="hover-btn hover-react" title="React">\uD83D\uDE0A</button>
        <button class="hover-btn hover-delete" title="Delete">\uD83D\uDDD1\uFE0F</button>
    </div>`;
    const swipeActionsHtml = `
        <div class="message-swipe-actions single-action">
            <button type="button" class="swipe-act-btn delete-act" title="Delete message">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
            </button>
        </div>`;

    if (!bubble.querySelector('.message-hover-menu')) {
        bubble.insertAdjacentHTML('afterbegin', `<span class="swipe-reply-icon">\u21A9</span>${hoverMenu}`);
        bubble.insertAdjacentHTML('beforeend', swipeActionsHtml);
    }

    // 7. Finalize classes and clean up after transition finishes (260ms)
    // NO DESTRUCTIVE innerHTML REWRITE - preserves exact text placement and subpixel geometry
    bubble._morphTimer = setTimeout(() => {
        bubble.classList.remove('typing-indicator', 'peek-open', 'morphing', 'peer-paused');
        if (header) header.style.display = 'none';
        if (draftTag) draftTag.style.display = 'none';
        if (caret) caret.remove();
        if (footer) {
            footer.className = 'msg-footer';
            footer.style.opacity = '1';
        }
        bubble._morphTimer = null;
    }, 260);

    // 8. Restore header
    updateHeaderStatus();
}

let _typingScrollRaf = null;

function ensureTypingVisible(bubble, mc, force = false) {
    if (!mc || !bubble || !bubble.isConnected) return;
    
    // Strict guard: If user is actively touching screen with their finger, never hijack
    if (window._isUserTouching) return;

    if (!force) {
        const distFromBottom = mc.scrollHeight - mc.scrollTop - mc.clientHeight;
        if (distFromBottom > 75) return;
    }

    if (_typingScrollRaf) cancelAnimationFrame(_typingScrollRaf);
    _typingScrollRaf = requestAnimationFrame(() => {
        _typingScrollRaf = null;
        if (!mc || !bubble || !bubble.isConnected || window._isUserTouching) return;
        if (!force) {
            const dist = mc.scrollHeight - mc.scrollTop - mc.clientHeight;
            if (dist > 75) return;
        }
        // Align the bottom layer of the peek bar flush at the end of the viewport
        mc.scrollTop = mc.scrollHeight;

        // Double RAF ensures post-reflow layout stability on mobile Chrome
        requestAnimationFrame(() => {
            if (!mc || !bubble || !bubble.isConnected || window._isUserTouching) return;
            if (force || (mc.scrollHeight - mc.scrollTop - mc.clientHeight < 75)) {
                mc.scrollTop = mc.scrollHeight;
            }
        });
    });
}

function handlePeerTyping(user, isTyping, text, isPaused = false, immediate = false) {
    const el = document.getElementById('connection-status');
    const mc = document.getElementById('messages-container');
    const list = document.getElementById('messages-list');

    if (isTyping) {
        // Update header
        if (el) {
            if (state.isGroup || (state.activeChatId && state.activeChatId.startsWith('grp_'))) {
                el.textContent = `${user || 'Someone'} is typing...`;
            } else if (state.isRandom || (state.activeChatId && state.activeChatId.startsWith('rnd_'))) {
                el.textContent = 'Anonymous is typing...';
            } else {
                el.textContent = 'typing...';
            }
            el.classList.add('online');
        }

        if (!list) return;

        let bubble = document.getElementById('typing-bubble');
        
        // Determine if user was resting at/near bottom BEFORE inserting or expanding bubble
        const isRestingAtBottom = mc ? (
            !window._isUserTouching &&
            (mc.scrollHeight - mc.scrollTop - mc.clientHeight < 120)
        ) : false;

        if (!bubble) {
            bubble = document.createElement('div');
            bubble.id = 'typing-bubble';
            bubble.className = 'message received typing-indicator bubble-enter' + 
                (state._peekActive ? ' peek-open' : '') +
                (isPaused ? ' peer-paused' : '');
            bubble.innerHTML = `
                <div class="msg-content typing-bubble-content">
                    <div class="typing-bubble-header">
                        <div class="typing-dots">
                            <span></span><span></span><span></span>
                        </div>
                        <button type="button" class="typing-peek-btn ${state._peekActive ? 'active' : ''}" id="typing-peek-btn" title="Peek">
                            <svg viewBox="0 0 24 24">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"></path>
                                <circle cx="12" cy="12" r="3"></circle>
                            </svg>
                            <span class="peek-btn-label">${state._peekActive ? 'Hide' : 'Peek'}</span>
                        </button>
                    </div>
                    <div class="peek-drawer ${state._peekActive ? 'open' : ''}" id="peek-reveal-box">
                        <div class="peek-drawer-inner">
                            <div class="peek-header-tag">
                                <span class="peek-live-dot"></span> Live Draft
                            </div>
                            <div class="peek-body">
                                <div class="msg-text peek-text-stream" id="peek-text-stream">${renderPeekStream(text || '')}</div>
                                <div class="msg-footer peek-msg-footer" id="peek-msg-footer"><span class="timestamp"></span></div>
                            </div>
                        </div>
                    </div>
                </div>`;
            list.appendChild(bubble);

            // Eye click listener
            const peekBtn = bubble.querySelector('#typing-peek-btn');
            peekBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                state._peekActive = !state._peekActive;
                const box = bubble.querySelector('#peek-reveal-box');
                const label = bubble.querySelector('.peek-btn-label');
                if (state._peekActive) {
                    box?.classList.add('open');
                    peekBtn.classList.add('active');
                    bubble.classList.add('peek-open');
                    if (label) label.textContent = 'Hide';
                } else {
                    box?.classList.remove('open');
                    peekBtn.classList.remove('active');
                    bubble.classList.remove('peek-open');
                    if (label) label.textContent = 'Peek';
                }
                ensureTypingVisible(bubble, mc, true);
            });

            // On new peek arrival, align bottom layer of peek bar at end if resting at bottom
            if (isRestingAtBottom) {
                ensureTypingVisible(bubble, mc, true);
            }
        } else {
            // Ensure bubble is always at the very bottom of list
            if (bubble.nextSibling) {
                list.appendChild(bubble);
            }
            // Update paused state
            if (isPaused) {
                bubble.classList.add('peer-paused');
            } else {
                bubble.classList.remove('peer-paused');
            }
            // Update existing stream
            const streamEl = bubble.querySelector('#peek-text-stream');
            if (streamEl && text !== undefined) {
                streamEl.innerHTML = renderPeekStream(text || '');
            }
            if (state._peekActive) {
                const wasOpen = bubble.classList.contains('peek-open');
                bubble.classList.add('peek-open');
                bubble.querySelector('#peek-reveal-box')?.classList.add('open');
                bubble.querySelector('#typing-peek-btn')?.classList.add('active');
                const label = bubble.querySelector('.peek-btn-label');
                if (label) label.textContent = 'Hide';
                // If it just transitioned from closed to open while user is at bottom, align bottom layer at end
                if (!wasOpen && isRestingAtBottom) {
                    ensureTypingVisible(bubble, mc, true);
                }
            }
            // While live typing continues, smoothly keep bottom line aligned if still resting at bottom
            if (isRestingAtBottom) {
                ensureTypingVisible(bubble, mc, false);
            }
        }

        // Auto-hide after 25s (safety net if stop event is missed during prolonged inactivity)
        clearTimeout(_typingAutoHide);
        _typingAutoHide = setTimeout(() => handlePeerTyping(user, false), 25000);
    } else {
        clearTimeout(_typingAutoHide);
        const bubble = document.getElementById('typing-bubble') || document.querySelector('.typing-indicator:not(.morphed)');
        if (bubble && !bubble.classList.contains('morphed') && !bubble.classList.contains('morphing')) {
            if (immediate) {
                bubble.remove();
            } else {
                bubble.classList.add('fading-out');
                setTimeout(() => {
                    if (bubble.parentNode && !bubble.classList.contains('morphed')) {
                        bubble.remove();
                    }
                }, 220);
            }
        }
        updateHeaderStatus();
    }
}

const CINEMA_CARD_ICONS = {
    clapper: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg>`,
    play: `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
    folder: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
    filmLarge: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg>`,
    eye: `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    eyeOff: `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
};
window.CINEMA_CARD_ICONS = CINEMA_CARD_ICONS;

function renderCinemaMatchedHtml(res, invite) {
    if (!res) return '';
    const runtimeFormatted = res.inviteDurFormatted || 
        (window.CinemaManager?.formatRuntime ? window.CinemaManager.formatRuntime(res.inviteDur || invite.duration) : 
         (window.CinemaManager?.formatDuration ? window.CinemaManager.formatDuration(res.inviteDur || invite.duration) : ''));
    
    let sizeHtml = '';
    const userSizeFormatted = res.localSizeFormatted || (window.CinemaManager?.formatFileSize ? window.CinemaManager.formatFileSize(res.localSize) : '');
    const hostSizeFormatted = res.inviteSizeFormatted || (invite.sizeFormatted || (window.CinemaManager?.formatFileSize ? window.CinemaManager.formatFileSize(invite.size) : ''));
    
    if (res.isExactSize) {
        sizeHtml = `<div class="cinema-size-row size-identical"><span class="cinema-diff-pill pill-match">Size: Identical (${escapeHtml(userSizeFormatted)})</span></div>`;
    } else {
        const sign = (res.sizeDiffBytes || 0) >= 0 ? '+' : '-';
        const diffMB = Math.abs(parseFloat(res.sizeDiffMB || 0)).toFixed(0);
        sizeHtml = `<div class="cinema-size-row size-different"><span class="cinema-diff-pill pill-amber">Size: ${escapeHtml(userSizeFormatted)} (Host: ${escapeHtml(hostSizeFormatted)}, ${sign}${diffMB} MB diff - Quality difference allowed)</span></div>`;
    }

    return `
        <div class="cinema-match-row">
            <span class="cinema-status-dot green"></span>
            <span class="cinema-match-text">Runtime matched (~${escapeHtml(runtimeFormatted)})</span>
        </div>
        ${sizeHtml}
    `;
}

function renderCinemaMismatchHtml(comp, inviteId) {
    if (!comp) return '';

    const hostDur = comp.hostDurationFormatted || 
        (window.CinemaManager?.formatRuntime ? window.CinemaManager.formatRuntime(comp.hostDuration) : (comp.expectedDurationFormatted || 'Unknown'));
    const userDur = comp.userDurationFormatted || 
        (window.CinemaManager?.formatRuntime ? window.CinemaManager.formatRuntime(comp.userDuration) : (comp.selectedDurationFormatted || 'Unknown'));
    const diffDur = comp.durationDiffFormatted || 
        (window.CinemaManager?.formatRuntime ? window.CinemaManager.formatRuntime(comp.durationDiff) : 
         (window.CinemaManager?.formatDuration ? window.CinemaManager.formatDuration(comp.durationDiff) : `${Math.round(comp.durationDiff || 0)}s`));

    return `
        <div class="cinema-mismatch-box">
            <div class="cinema-mismatch-header">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                <span class="cinema-mismatch-title">Duration Mismatch</span>
            </div>
            <div class="cinema-mismatch-desc">
                âŒ <strong>Duration Mismatch:</strong> Host movie is ${escapeHtml(hostDur)}, but your file is ${escapeHtml(userDur)} (Diff: ${escapeHtml(diffDur)}).
            </div>
            <div class="cinema-mismatch-hint">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#38bdf8" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <span>Please select the matching movie file.</span>
            </div>
        </div>
    `;
}

function renderCinemaInviteCard(invite, isMe) {
    if (!invite) return '';

    const hostName = escapeHtml(invite.from || 'Friend');
    let statusHtml = '';
    let actionButtonsHtml = '';

    const isPlayerActive = Boolean(
        window.WatchPartyEngine?.active &&
        window.WatchPartyEngine?.cinemaId === invite.id
    );

    const hasMyFile = Boolean(
        window.CinemaManager?.matchedPeerFiles?.has(invite.id) ||
        window.CinemaManager?.pendingMatches?.has(invite.id)
    );

    const isPeerReady = Boolean(
        window.CinemaManager?.peerReadyInvites?.has(invite.id)
    );

    const isPeerInRoom = Boolean(window.CinemaManager?.isPeerInRoom);

    if (isPlayerActive) {
        statusHtml = `
            <div class="cinema-card-status">
                <span class="cinema-status-dot green"></span>
                <span>Cinema Player active in floating window.</span>
            </div>
        `;
        actionButtonsHtml = `
            <div class="cinema-card-actions">
                <button type="button" class="cinema-action-btn cinema-launch-btn" data-cinema-id="${escapeHtml(invite.id)}">
                    ${CINEMA_CARD_ICONS.play}
                    <span>Bring Player to Front</span>
                </button>
            </div>
        `;
    } else if (!hasMyFile) {
        statusHtml = `
            <div class="cinema-card-status">
                <span class="cinema-status-dot blue"></span>
                <span>${isMe ? 'Select your local movie file to prepare watch party.' : 'Wants to watch this movie with you.'}</span>
            </div>
        `;
        actionButtonsHtml = `
            <div class="cinema-card-actions">
                <button type="button" class="cinema-action-btn cinema-match-btn" data-cinema-id="${escapeHtml(invite.id)}">
                    ${CINEMA_CARD_ICONS.folder}
                    <span>Choose Movie File</span>
                </button>
            </div>
        `;
    } else if (!isPeerReady) {
        statusHtml = `
            <div class="cinema-card-status">
                <span class="cinema-status-dot amber"></span>
                <span>Your file is ready! Waiting for friend to select movie file...</span>
            </div>
        `;
        actionButtonsHtml = `
            <div class="cinema-card-actions">
                <button type="button" class="cinema-action-btn cinema-waiting-btn" disabled style="opacity: 0.75; cursor: not-allowed;">
                    <span class="cinema-status-dot amber"></span>
                    <span>Waiting for Friend's File...</span>
                </button>
            </div>
        `;
    } else if (!isPeerInRoom) {
        statusHtml = `
            <div class="cinema-card-status">
                <span class="cinema-status-dot amber"></span>
                <span>Both files ready! Waiting for friend to enter chat...</span>
            </div>
        `;
        actionButtonsHtml = `
            <div class="cinema-card-actions">
                <button type="button" class="cinema-action-btn cinema-waiting-btn" disabled style="opacity: 0.75; cursor: not-allowed;">
                    <span class="cinema-status-dot amber"></span>
                    <span>Friend Not in Chat</span>
                </button>
            </div>
        `;
    } else {
        statusHtml = `
            <div class="cinema-card-status matched-status">
                <span class="cinema-status-dot green"></span>
                <span>Movie ready on both devices! Either can start now.</span>
            </div>
        `;
        actionButtonsHtml = `
            <div class="cinema-card-actions">
                <button type="button" class="cinema-action-btn cinema-launch-btn cinema-ready-start-btn" data-cinema-id="${escapeHtml(invite.id)}" style="background: linear-gradient(135deg, #10b981, #059669); color: #fff;">
                    ${CINEMA_CARD_ICONS.play}
                    <span>Start Movie Together</span>
                </button>
            </div>
        `;
    }

    return `
        <div class="message-cinema-card" id="cinema-card-${escapeHtml(invite.id)}" data-cinema-id="${escapeHtml(invite.id)}" data-cinema-name="${escapeHtml(invite.name || '')}" data-cinema-size="${invite.size || 0}" data-cinema-duration="${invite.duration || 0}" data-cinema-from="${escapeHtml(invite.from || '')}">
            <div class="cinema-card-header">
                <span class="cinema-card-tag">${CINEMA_CARD_ICONS.clapper} Cinema Sync</span>
                <span class="cinema-card-host">Host: ${hostName}</span>
            </div>
            <div class="cinema-card-body">
                <div class="cinema-card-film-icon">${CINEMA_CARD_ICONS.filmLarge}</div>
                <div class="cinema-card-info">
                    <div class="cinema-card-title" title="Tap to reveal full movie name">${escapeHtml(invite.name || 'Movie')}</div>
                    <div class="cinema-card-specs">
                        ${invite.sizeFormatted ? `<span class="cinema-card-pill">${escapeHtml(invite.sizeFormatted)}</span>` : ''}
                        ${invite.durationFormatted ? `<span class="cinema-card-pill">${escapeHtml(invite.durationFormatted)}</span>` : ''}
                        <button type="button" class="cinema-reveal-name-btn" data-cinema-id="${escapeHtml(invite.id)}" title="Reveal full movie name">
                            ${CINEMA_CARD_ICONS.eye}
                            <span class="cinema-reveal-text">Full Name</span>
                        </button>
                    </div>
                </div>
            </div>
            ${statusHtml}
            ${actionButtonsHtml}
        </div>
    `;
}

function renderFriendRequestBubble(friendReq, isMe, msgId, originalText) {
    const fromUser = (friendReq && friendReq.from) ? friendReq.from : 'Anonymous';
    const status = (friendReq && friendReq.status) ? friendReq.status : (window.RandomChatManager?.friendState === 'accepted' ? 'accepted' : 'pending');

    const iconAddFriend = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:6px;"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`;
    const iconCheck = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:6px;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
    const iconClose = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:6px;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;

    if (status === 'accepted' || (window.RandomChatManager && window.RandomChatManager.friendState === 'accepted')) {
        return `
            <div class="inline-friend-req-box accepted">
                <div class="inline-friend-req-text">${iconCheck}Friend request accepted! You are now friends.</div>
            </div>
        `;
    }

    if (status === 'declined') {
        return `
            <div class="inline-friend-req-box declined">
                <div class="inline-friend-req-text">${iconClose}Friend request declined.</div>
            </div>
        `;
    }

    if (isMe) {
        return `
            <div class="inline-friend-req-box sent">
                <div class="inline-friend-req-text">${iconAddFriend}Friend request sent. Waiting for acceptance...</div>
            </div>
        `;
    }

    // Received by stranger
    return `
        <div class="inline-friend-req-box received" id="inline-freq-${escapeHtml(fromUser)}">
            <div class="inline-friend-req-text">
                ${iconAddFriend}<strong>${escapeHtml(fromUser)}</strong> sent you a friend request!
            </div>
            <div class="inline-friend-req-actions">
                <button type="button" class="btn-inline-freq-accept" onclick="if(window.RandomChatManager) window.RandomChatManager.acceptFriendRequest('${escapeHtml(fromUser)}', this.closest('.inline-friend-req-box'))">Accept</button>
                <button type="button" class="btn-inline-freq-decline" onclick="if(window.RandomChatManager) window.RandomChatManager.declineFriendRequest('${escapeHtml(fromUser)}', this.closest('.inline-friend-req-box'))">Decline</button>
            </div>
        </div>
    `;
}

function renderMessages(msgs, append = false) {
    const list = document.getElementById('messages-list');
    if (!list) return;

    if (state.isRandom && (!window.RandomChatManager || !window.RandomChatManager.isConnected || !window.RandomChatManager.activeRoomId)) {
        list.innerHTML = '';
        document.getElementById('load-history-banner')?.remove();
        return;
    }

// Fast-path: skip full re-render if nothing changed (compare all IDs)
    if (!append && msgs.length > 0) {
        const existingMessages = list.querySelectorAll('.message');
        if (existingMessages.length === msgs.length) {
            const newIds = msgs.map(m => m.id || m.clientId).join(',');
            const oldIds = [...existingMessages].map(el => el.dataset.id || el.dataset.clientId).join(',');
            if (newIds === oldIds) return; // Truly identical, skip
        }
    }

    const frag = document.createDocumentFragment();

    // Full re-render only when needed
    if (!append) {
        list.innerHTML = '';
    }

    const existingEls = append ? list.querySelectorAll('.message') : [];
    const existingIds = new Set();
    existingEls.forEach(el => {
        if (el.dataset.id) existingIds.add(el.dataset.id);
        if (el.dataset.clientId) existingIds.add(el.dataset.clientId);
    });

    let lastDateStr = append ? (list.dataset.lastDate || '') : '';
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    msgs.forEach(msg => {
        const msgId = msg.id || msg.clientId;
        const isAlreadyRendered = (msg.id && existingIds.has(msg.id)) || (msg.clientId && existingIds.has(msg.clientId));

        // Skip if already rendered (for append mode)
        if (append && isAlreadyRendered) {
            // Update existing message if it was pending
            const existing = (msg.clientId && list.querySelector(`[data-client-id="${msg.clientId}"]`)) || (msg.id && list.querySelector(`[data-id="${msg.id}"]`));
            if (existing && !msg.pending && existing.classList.contains('pending')) {
                existing.classList.remove('pending');
                if (msg.id) existing.dataset.id = msg.id;
                const tickEl = existing.querySelector('.ticks');
                if (tickEl) { tickEl.className = 'ticks'; tickEl.innerHTML = TICK_ICONS.sent; }
            }
            return;
        }

        // Date separator logic (only for full re-render to avoid duplicates)
        if (!append) {
            const msgDate = new Date(msg.ts);
            const dateStr = msgDate.toDateString();
            if (dateStr !== lastDateStr) {
                lastDateStr = dateStr;
                const sep = document.createElement('div');
                sep.className = 'date-separator';
                if (dateStr === today) sep.textContent = 'Today';
                else if (dateStr === yesterday) sep.textContent = 'Yesterday';
                else sep.textContent = msgDate.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
                frag.appendChild(sep);
            }
        }

        const ytVideoId = (window.WatchPartyEngine && typeof msg.text === 'string') ? window.WatchPartyEngine.extractYouTubeId(msg.text) : null;
        const ytBtnHtml = ytVideoId ? `
            <button type="button" class="yt-watch-btn" data-yt-id="${escapeHtml(ytVideoId)}" title="Watch Together in Floating PiP">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </button>
        ` : '';

        const div = document.createElement('div');
        const isMe = msg.from === state.user;
        const ytClass = ytVideoId ? ' has-yt-btn' : '';
        const cinemaClass = msg.cinemaInvite ? ' cinema-message' : '';
        div.className = `message ${isMe ? 'sent' : 'received'}${msg.pending ? ' pending' : ''}${ytClass}${cinemaClass}`;
        div.dataset.id = msg.id || '';
        div.dataset.clientId = msg.clientId || '';
        div.dataset.from = msg.from || '';
        div.dataset.ts = msg.ts ? String(msg.ts) : '';

        const t = new Date(msg.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
        let ticksHtml = '';
        if (isMe) {
            if (msg.pending) {
                ticksHtml = `<span class="ticks pending">${TICK_ICONS.pending}</span>`;
            } else if (msg.read) {
                ticksHtml = `<span class="ticks read">${TICK_ICONS.read}</span>`;
            } else {
                ticksHtml = `<span class="ticks">${TICK_ICONS.sent}</span>`;
            }
        }

        // Check if message is a GIF URL or Base64 GIF or WebP URL (many search GIFs are WebPs)
        const isUrl = msg.text && (msg.text.startsWith('http://') || msg.text.startsWith('https://'));
        const isGif = (msg.text && (
            msg.text.startsWith('data:image/gif') ||
            (isUrl && (
                msg.text.includes('tenor.com') ||
                msg.text.includes('giphy.com') ||
                msg.text.includes('gify.com') ||
                msg.text.includes('klipy.com') ||
                /\.(gif|webp)(\?|$)/i.test(msg.text)
            ))
        )) || msg.mediaType === 'gif';

        // Check if message is a Base64 image or a static image URL (like gstatic thumbnails)
        const isImage = (msg.text && (
            msg.text.startsWith('data:image/') ||
            (isUrl && (
                /\.(jpeg|jpg|png|bmp)(\?|$)/i.test(msg.text) ||
                msg.text.includes('images?q=tbn:') ||
                msg.text.includes('gstatic.com/images')
            ))
        )) || msg.mediaType === 'image';

        // Check if message is a Base64 audio (voice note)
        const isVoice = (msg.text && msg.text.startsWith('data:audio/')) || msg.mediaType === 'audio' || msg.mediaType === 'voice';

        // Check if message is a Base64 video or a RedGifs/MP4 URL video
        const isUrlVideo = msg.text && (
            isUrl && (
                msg.text.includes('redgifs.com') ||
                /\.(mp4|webm|mov)(\?|$)/i.test(msg.text)
            )
        );
        const isVideo = (msg.text && msg.text.startsWith('data:video/')) || msg.mediaType === 'video' || isUrlVideo;

        // Create Blob URL for raw base64 data to optimize browser rendering memory
        const mediaData = (isGif || isImage || isVoice || (isVideo && !isUrlVideo)) 
            ? BlobUrlCache.get(msg.id || msg.clientId, msg.text) 
            : msg.text;

        // Check if message has a reply/quote
        let quoteHtml = '';
        if (msg.replyTo) {
            // Use explicit media field if available, or fallback to text inspection
            let mediaSrc = msg.replyTo.media || (msg.replyTo.text && (
                msg.replyTo.text.startsWith('data:image/') ||
                msg.replyTo.text.includes('tenor.com') ||
                msg.replyTo.text.includes('giphy.com')
            ) ? msg.replyTo.text : null);

            // Filter out broken/invalid media sources:
            // - blob: URLs are session-local and dead after page reload or on other devices
            // - Truncated data: URLs (from backend's 100-char slice) are not valid images
            if (mediaSrc) {
                if (mediaSrc.startsWith('blob:')) mediaSrc = null;
                else if (mediaSrc.startsWith('data:') && mediaSrc.length < 200) mediaSrc = null;
            }

            // Convert quote base64 to Blob URL
            const replyMediaSrc = mediaSrc && mediaSrc.startsWith('data:') 
                ? BlobUrlCache.get((msg.id || msg.clientId) + '_reply', mediaSrc)
                : mediaSrc;

            const quoteTargetId = msg.replyTo.id || '';
            const quoteTextStr = (msg.replyTo.text && msg.replyTo.text !== '[Image]' && msg.replyTo.text !== '[Media]')
                ? msg.replyTo.text 
                : (replyMediaSrc ? 'Photo' : (msg.replyTo.text || 'Message'));

            let quoteMediaHtml = '';
            if (replyMediaSrc) {
                quoteMediaHtml = `<img src="${escapeHtml(replyMediaSrc)}" class="quote-media" alt="Thumbnail">`;
            } else if (msg.replyTo.mediaType === 'video' || (msg.replyTo.text && msg.replyTo.text.toLowerCase().includes('video'))) {
                quoteMediaHtml = `<div class="quote-media" style="background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;color:#3b82f6;"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg></div>`;
            } else if (msg.replyTo.mediaType === 'audio' || (msg.replyTo.text && (msg.replyTo.text.toLowerCase().includes('voice') || msg.replyTo.text.toLowerCase().includes('audio')))) {
                quoteMediaHtml = `<div class="quote-media" style="background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;color:#10b981;"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg></div>`;
            }

            // Color: green (#00a884) if quoting yourself, purple (#7f66ff) if quoting the other person
            const quoteNameColor = (msg.replyTo.from === state.user) ? '#00a884' : '#7f66ff';
            quoteHtml = `<div class="message-quote" data-target-id="${escapeHtml(quoteTargetId)}" style="border-left-color:${quoteNameColor}"><div class="quote-content-wrapper"><div class="quote-text-col"><span class="quote-name" style="color:${quoteNameColor}">${escapeHtml(msg.replyTo.from)}</span><span class="quote-text">${escapeHtml(quoteTextStr)}</span></div>${quoteMediaHtml}</div></div>`;
        }

        // Check if message is a media item (image, gif, video, voice, chunked card, gift)
        const isChunked = msg.text && msg.text.startsWith('__chunked__:');
        const isCinemaInvite = Boolean(msg.cinemaInvite);
        const isMediaMessage = isGif || isImage || isVoice || isVideo || isChunked || isCinemaInvite || msg.effect === 'gift';

        // Desktop hover menu (hide edit for media since media cannot be edited as plain text)
        const hoverMenu = `<div class="message-hover-menu">
            <button class="hover-btn hover-reply" title="Reply">\u21A9</button>
            <button class="hover-btn hover-react" title="React">\uD83D\uDE0A</button>
            ${(isMe && !isMediaMessage) ? `<button class="hover-btn hover-edit" title="Edit">\u270F\uFE0F</button>` : ''}
            <button class="hover-btn hover-delete" title="Delete">\uD83D\uDDD1\uFE0F</button>
        </div>`;

        // Mobile swipe action dock (revealed on RTL swipe - Linear / Raycast Luxury Minimal):
        // - Sent plain text: Edit + Delete in deep zinc pill
        // - Sent media or Received message: Single Delete in deep zinc pill
        const swipeActionsHtml = (isMe && !isMediaMessage) ? `
            <div class="message-swipe-actions">
                <button type="button" class="swipe-act-btn edit-act" title="Edit message">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                    </svg>
                </button>
                <button type="button" class="swipe-act-btn delete-act" title="Delete message">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 6h18"/>
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        <path d="M10 11v6"/>
                        <path d="M14 11v6"/>
                        <path d="M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14"/>
                    </svg>
                </button>
            </div>
        ` : `
            <div class="message-swipe-actions single-action">
                <button type="button" class="swipe-act-btn delete-act" title="Delete message">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 6h18"/>
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        <path d="M10 11v6"/>
                        <path d="M14 11v6"/>
                        <path d="M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14"/>
                    </svg>
                </button>
            </div>
        `;

        // Check if this media item should render as placeholder card (Tap to Load)
        let bodyHtml;
        const sessionMedia = _loadedMediaInSession.get(msgId) || (msg.clientId ? _loadedMediaInSession.get(msg.clientId) : null);
        const displayMsg = sessionMedia ? { ...msg, text: sessionMedia } : msg;
        if (msg.cinemaInvite) {
            bodyHtml = renderCinemaInviteCard(msg.cinemaInvite, isMe);
        } else if (msg.friendRequest) {
            bodyHtml = renderFriendRequestBubble(msg.friendRequest, isMe, msgId, msg.text);
        } else if (isChunked && !sessionMedia) {
            const chunkCount = parseInt(msg.text.split(':')[1]) || 1;
            const mediaTypeStr = msg.mediaType || (isGif ? 'gif' : (isVideo ? 'video' : (isVoice ? 'audio' : (isImage ? 'image' : 'media'))));
            const sizeInBytes = msg.mediaSize || Math.floor(chunkCount * 500000 * 0.75);
            bodyHtml = renderPlaceholderCard(msgId, mediaTypeStr, sizeInBytes);
        } else if (msg.effect === 'gift') {
            bodyHtml = `
                <div class="gift-container" onclick="this.classList.toggle('open')">
                    <div class="gift-lid"></div>
                    <div class="gift-box">Tap to open <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display:inline-block;vertical-align:middle;margin-left:4px;"><path d="M20 6h-2.18c.11-.31.18-.65.18-1 0-1.66-1.34-3-3-3-1.05 0-1.96.54-2.5 1.35l-.5.65-.5-.65C10.96 2.54 10.05 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1h-2.22l.8-1.06c.33-.42.84-.94 1.42-.94zm-6 0c.58 0 1.09.52 1.42.94l.8 1.06H9c-.55 0-1-.45-1-1s.45-1 1-1zm11 15H4v-2h16v2zm0-5H4V8h5.08L7 10.83 8.62 12 11 8.76V12h2V8.76L15.38 12 17 10.83 14.92 8H20v6z"/></svg></div>
                    <div class="gift-content">${renderFullMediaContent(displayMsg)}</div>
                </div>`;
        } else {
            bodyHtml = renderFullMediaContent(displayMsg);
        }

        const isSpaceMsg = state.activeChatId && state.activeChatId.startsWith('grp_');
        const spaceSenderHtml = (isSpaceMsg && !isMe) ? `<div class="space-sender-tag">${escapeHtml(msg.from)}</div>` : '';

        div.innerHTML = `
            <span class="swipe-reply-icon">\u21A9</span>
            ${ytBtnHtml}
            ${quoteHtml}
            ${hoverMenu}
            <div class="msg-content">
                ${spaceSenderHtml}
                <div class="msg-text">${bodyHtml}</div>
                <div class="msg-footer">
                    ${msg.edited ? '<span class="msg-edited-badge">Edited</span>' : ''}
                    <span class="timestamp">${t}</span>
                    ${ticksHtml}
                </div>
            </div>
            ${swipeActionsHtml}
        `;

        // Display existing reactions
        if (msg.reactions && Object.keys(msg.reactions).length > 0) {
            updateReactionDisplay(div, msg.id || msg.clientId, msg.reactions);
        }

        frag.appendChild(div);
    });

    // Batch-insert all elements at once (single reflow)
    list.appendChild(frag);

    // Ultra-optimized IntersectionObserver observation (zero off-screen overhead)
    if (typeof LinkPreviewManager !== 'undefined') {
        const pendingCards = list.querySelectorAll('.link-preview-card[data-url]:not(.lp-observed)');
        pendingCards.forEach(card => {
            card.classList.add('lp-observed');
            LinkPreviewManager.observeCard(card);
        });
    }
    // In append mode, if active typing bubble exists, keep it pinned at the very bottom
    const typingBubble = document.getElementById('typing-bubble');
    if (typingBubble && !typingBubble.classList.contains('morphed') && !typingBubble.classList.contains('fading-out') && !typingBubble.classList.contains('morphing')) {
        list.appendChild(typingBubble);
    }

    // Store last date for append operations
    if (!append && msgs.length > 0) {
        list.dataset.lastDate = new Date(msgs[msgs.length - 1].ts).toDateString();
    }

    updateHistoryBanner();
}

function updateHistoryBanner() {
    const list = document.getElementById('messages-list');
    if (!list) return;
    let banner = document.getElementById('load-history-banner');
    if (!state.hasMoreHistory || state.isRandom) {
        if (banner) banner.remove();
        return;
    }
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'load-history-banner';
        banner.className = 'load-history-banner';
        banner.innerHTML = `<button type="button" class="load-history-btn">Load earlier messages</button>`;
        banner.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!state.isLoadingOlder && state.hasMoreHistory) {
                loadOlderMessages();
            }
        });
        list.prepend(banner);
    } else if (list.firstChild !== banner) {
        list.prepend(banner);
    }
    const btn = banner.querySelector('.load-history-btn');
    if (btn) {
        btn.textContent = state.isLoadingOlder ? 'Loading earlier messages...' : 'Load earlier messages';
        btn.disabled = !!state.isLoadingOlder;
    }
}

async function loadOlderMessages() {
    if (state.isLoadingOlder || !state.hasMoreHistory || !state.activeChatId || state.isRandom) return;
    const targetChatId = state.activeChatId;
    const container = document.getElementById('messages-container');
    const list = document.getElementById('messages-list');
    if (!container || !list) return;

    state.isLoadingOlder = true;
    updateHistoryBanner();

    // Show subtle top loading indicator
    let spinner = document.getElementById('history-top-spinner');
    if (!spinner) {
        spinner = document.createElement('div');
        spinner.id = 'history-top-spinner';
        spinner.className = 'history-top-spinner';
        spinner.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" class="spinner-svg"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="31.4 31.4" /></svg>`;
        list.prepend(spinner);
    }
    spinner.style.display = 'flex';

    const prevScrollHeight = container.scrollHeight;
    const prevScrollTop = container.scrollTop;

    try {
        const allLocal = await ChatCache.getMessages(targetChatId);
        const currentRenderedCount = state.loadedMessageLimit;
        const newLimit = currentRenderedCount + 200;

        let olderSlice = [];
        if (allLocal.length > currentRenderedCount) {
            // We already have older messages in local cache!
            state.loadedMessageLimit = newLimit;
            olderSlice = allLocal.slice(-newLimit);
        } else {
            // We need to fetch from Cloudflare DO cursor!
            // Find oldest message with a valid server ID (skip purely client-side temporary IDs if possible)
            const validOldest = allLocal.find(m => m && m.id && typeof m.id === 'string' && !m.id.startsWith('client_') && m.id.length > 8);
            const oldestId = validOldest ? validOldest.id : (allLocal[0]?.id || allLocal[0]?.clientId || '');
            const url = oldestId 
                ? `/api/chat/${targetChatId}/messages?before=${encodeURIComponent(oldestId)}&limit=200`
                : `/api/chat/${targetChatId}/messages?limit=200`;
            
            const olderServerMsgs = await apiFetch(url);
            if (Array.isArray(olderServerMsgs)) {
                if (olderServerMsgs.length > 0) {
                    const merged = await ChatCache.appendMessages(targetChatId, olderServerMsgs);
                    state.loadedMessageLimit = newLimit;
                    olderSlice = merged.slice(-newLimit);
                    if (olderServerMsgs.length < 200) {
                        state.hasMoreHistory = false;
                    }
                } else {
                    // Server explicitly confirmed no older messages exist
                    state.hasMoreHistory = false;
                }
            } else {
                // Network error, 500, or offline: DO NOT set hasMoreHistory = false!
                // Allow the user to retry by scrolling or tapping the banner again.
                console.warn('[Pagination] Transient error loading older messages:', olderServerMsgs);
            }
        }

        if (state.activeChatId === targetChatId && olderSlice.length > 0) {
            renderMessages(olderSlice);
            // Zero-jump scroll anchor lock
            requestAnimationFrame(() => {
                container.scrollTop = (container.scrollHeight - prevScrollHeight) + prevScrollTop;
            });
        }
    } catch (err) {
        console.warn('[Pagination] Error loading older messages:', err);
    } finally {
        if (spinner) spinner.style.display = 'none';
        state.isLoadingOlder = false;
        updateHistoryBanner();
    }
}

function scrollToBottom(smooth = false) {
    requestAnimationFrame(() => {
        const c = document.getElementById('messages-container');
        c.scrollTop = c.scrollHeight;
    });
}

async function sendMessage() {
    const inp = document.getElementById('message-input');
    const txt = inp.value.trim();
    if (!txt || !state.activeChatId) return;
    const targetChatId = state.activeChatId;

    // Send friend request as text command in random chat
    if (state.isRandom && (txt === '/friend' || txt === '/add' || txt === '/addfriend')) {
        inp.value = '';
        if (window.RandomChatManager) {
            window.RandomChatManager.sendFriendRequest();
        }
        return;
    }

    // If currently editing a message, submit the edit instead of sending a new message
    if (state.editingMessageRef || state.editingMessageId) {
        const editRef = state.editingMessageRef || state.editingMessageId;
        cancelEditing();
        submitMessageEdit(editRef, txt);
        return;
    }

    // INSTANT: Clear input immediately and reset Instagram-style layout
    inp.value = '';
    // Reset typing indicator state so next keystroke sends fresh isTyping:true
    clearTimeout(state._typingTimeout);
    clearTimeout(state._typingTextThrottle);
    state._typingSent = false;
    state._lastSentTypingText = '';
    // Preserved: don't prematurely kill typing bubble before message is delivered so morphPeekToMessage can animate
    inp.closest('.input-wrapper')?.classList.remove('has-text');

    // Reset layout & trigger morph animation back to mic
    if (typeof updateActionAndGifState === 'function') {
        updateActionAndGifState(false);
    } else {
        document.getElementById('img-btn')?.classList.remove('hidden');
        document.getElementById('search-effects-btn')?.classList.add('hidden');
        document.getElementById('right-media-icons')?.classList.remove('hidden');
        document.getElementById('send-btn')?.classList.add('hidden');
    }

    const cid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const m = { from: state.user, text: txt, ts: Date.now(), clientId: cid, pending: true };

    // Include reply data if replying
    if (typeof replyingTo !== 'undefined' && replyingTo) {
        // Resolve blob URLs or raw data to high-DPI thumbnails before sending
        let resolvedMedia = replyingTo.mediaSrc || null;
        if (resolvedMedia && (resolvedMedia.startsWith('blob:') || resolvedMedia.startsWith('data:'))) {
            resolvedMedia = await BlobUrlCache.resolveForReply(resolvedMedia);
        }
        m.replyTo = {
            id: replyingTo.id || undefined,
            from: replyingTo.from,
            text: (replyingTo.text || '').slice(0, 100),
            // Include media source if available (for thumbnail)
            media: resolvedMedia || undefined,
            mediaType: replyingTo.mediaType || undefined
        };
        clearReply();
    }

    // INSTANT: Render message with clock icon if user is still on this chat
    if (state.activeChatId === targetChatId) {
        renderMessages([m], true);
        scrollToBottom(true);
    }

    // FIRE-AND-FORGET: Save to cache in background (don't await)
    ChatCache.appendMessages(targetChatId, [m]).catch(() => { });

    // FIRE-AND-FORGET: Send to server in background
    const sendPayload = { text: txt, clientId: cid };
    if (m.replyTo) sendPayload.replyTo = m.replyTo;

    // Check for active effect from modal OR detect magic words
    // Priority: Explicit modal effect > Magic word detection
    if (selectedEffect && selectedEffect !== 'none') {
        sendPayload.effect = selectedEffect;
        m.effect = selectedEffect; // Update local optimistically
    } else {
        // Only use full-bubble effects for certain keywords if desired, 
        // OR rely on partial highlighting in renderMessages
        const magic = detectMagicWord(txt);
        if (magic) {
            // New logic: Only send effect metadata if it's a "whole bubble" effect 
            // OR if we want to trigger the fullscreen animation.
            // Partial highlighting is handled client-side during rendering.

            // However, to trigger the partner's fullscreen animation, we still need to send the effect.
            sendPayload.effect = magic.class.replace('magic-', '');
            m.effect = sendPayload.effect;
        }
    }

    // Reset selected effect after sending
    selectedEffect = 'none';

    apiFetch(`/api/chat/${targetChatId}/send`, {
        method: 'POST',
        body: JSON.stringify(sendPayload)
    }).then(s => {
        if (s && s.error) throw new Error(s.error);
        if (state.activeChatId === targetChatId) {
            // Update message in DOM - clock to single tick (sent)
            const msgEl = document.querySelector(`[data-client-id="${cid}"]`);
            if (msgEl) {
                if (s && s.id) msgEl.dataset.id = s.id;
                msgEl.classList.remove('pending');
                const tickEl = msgEl.querySelector('.ticks');
                if (tickEl) { tickEl.className = 'ticks'; tickEl.innerHTML = TICK_ICONS.sent; }
            }
        }
        // Update cache in background
        if (s && s.id) {
            ChatCache.appendMessages(targetChatId, [{ ...s, pending: false }]).catch(() => { });
        }
    }).catch(e => {
        console.error('Send failed:', e);
        if (state.activeChatId === targetChatId) {
            // Even on error, remove pending state to avoid stuck clocks
            const msgEl = document.querySelector(`[data-client-id="${cid}"]`);
            if (msgEl) {
                msgEl.classList.remove('pending');
                const tickEl = msgEl.querySelector('.ticks');
                if (tickEl) tickEl.textContent = '!'; // Error indicator
            }
        }
    });
}

window.sendDirectCustomMessage = function(text, extraPayload = {}) {
    if (!state.activeChatId) return;
    const targetChatId = state.activeChatId;
    const cid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const m = { from: state.user, text: text, ts: Date.now(), clientId: cid, pending: true, ...extraPayload };

    renderMessages([m], true);
    scrollToBottom(true);
    ChatCache.appendMessages(targetChatId, [m]).catch(() => { });

    // Send immediate WebSocket event if connected for zero-latency peer delivery
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        try {
            if (extraPayload.friendRequest) {
                state.ws.send(JSON.stringify({
                    type: 'friend_request',
                    fromUser: state.user,
                    chatId: targetChatId,
                    message: { from: state.user, text: text, ts: Date.now(), clientId: cid, ...extraPayload }
                }));
            } else {
                state.ws.send(JSON.stringify({
                    type: 'watch_party',
                    action: 'cinema_invite_live',
                    chatId: targetChatId,
                    message: { from: state.user, text: text, ts: Date.now(), clientId: cid, ...extraPayload }
                }));
            }
        } catch(e) {}
    }

    const sendPayload = { text: text, clientId: cid, ...extraPayload };
    apiFetch(`/api/chat/${targetChatId}/send`, {
        method: 'POST',
        body: JSON.stringify(sendPayload)
    }).then(s => {
        if (s && s.error) throw new Error(s.error);
        if (state.activeChatId === targetChatId) {
            const msgEl = document.querySelector(`[data-client-id="${cid}"]`);
            if (msgEl) {
                if (s && s.id) msgEl.dataset.id = s.id;
                msgEl.classList.remove('pending');
                const tickEl = msgEl.querySelector('.ticks');
                if (tickEl) { tickEl.className = 'ticks'; tickEl.innerHTML = TICK_ICONS.sent; }
            }
        }
        if (s && s.id) {
            ChatCache.appendMessages(targetChatId, [{ ...s, pending: false }]).catch(() => { });
        }
    }).catch(e => {
        console.error('sendDirectCustomMessage failed:', e);
    });
};

function connectWS(cid) {
    if (state.ws) {
        // If socket is already OPEN and connected to this exact cid, DO NOT destroy it
        if (state.ws.readyState === WebSocket.OPEN && state._connectedChatId === cid) {
            console.log('[WS] Socket already open and connected for room:', cid);
            return;
        }
        // If socket is currently connecting to this exact cid, allow it to complete
        if (state.ws.readyState === WebSocket.CONNECTING && state._connectedChatId === cid) {
            console.log('[WS] Socket currently connecting for room:', cid);
            return;
        }
        try {
            state.ws.onclose = null;
            state.ws.onerror = null;
            state.ws.close();
        } catch(e){}
        state.ws = null;
    }
    state._connectedChatId = cid;
    if (state.wsReconnectTimeout) { clearTimeout(state.wsReconnectTimeout); state.wsReconnectTimeout = null; }
    if (state.peerPresenceInterval) { clearInterval(state.peerPresenceInterval); state.peerPresenceInterval = null; }
    if (state._freshnessInterval) { clearInterval(state._freshnessInterval); state._freshnessInterval = null; }

    let host = API_BASE ? new URL(API_BASE).host : location.host;
    const proto = (location.protocol === 'https:' || API_BASE.startsWith('https')) ? 'wss:' : 'ws:';
    let reconnectAttempts = 0;
    function updateWsLatencyUI(ms) {
        const badge = document.getElementById('ws-latency-badge');
        const valEl = document.getElementById('ws-latency-val');
        if (!badge || !valEl) return;

        if (ms === null || typeof ms !== 'number') {
            badge.className = 'ws-latency-badge latency-offline';
            valEl.textContent = 'Offline';
            badge.title = 'WebSocket Disconnected';
            badge.classList.remove('hidden');
            return;
        }

        badge.classList.remove('hidden');
        valEl.textContent = `${ms} ms`;

        badge.classList.remove('latency-good', 'latency-fair', 'latency-poor', 'latency-offline');
        if (ms < 75) {
            badge.classList.add('latency-good');
            badge.title = `WebSocket Ping: ${ms}ms (Excellent)`;
        } else if (ms < 160) {
            badge.classList.add('latency-fair');
            badge.title = `WebSocket Ping: ${ms}ms (Good)`;
        } else {
            badge.classList.add('latency-poor');
            badge.title = `WebSocket Ping: ${ms}ms (Slow)`;
        }
    }

    function sendWsPing() {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state._lastPingTs = performance.now();
            state.ws.send(JSON.stringify({ type: 'ping' }));
            if (state._pongTimeout) clearTimeout(state._pongTimeout);
            state._pongTimeout = setTimeout(() => {
                console.log('[WS] Pong timeout â€” connection dead, force reconnecting...');
                updateWsLatencyUI(null);
                if (state.ws) { try { state.ws.close(); } catch(e) {} }
            }, 10000);
        }
    }

    function createWS() {
        console.log('[WS] Connecting to', cid);
        state.ws = new WebSocket(`${proto}//${host}/api/chat/${cid}/ws`);

        state.ws.onopen = () => {
            console.log('[WS] Connected');
            // If reconnect, catch up on missed messages (only if not already fetched within last 5 seconds)
            const recentFetch = _lastChatFetchTs[cid] && (Date.now() - _lastChatFetchTs[cid] < 5000);
            if (reconnectAttempts > 0 && !recentFetch) {
                console.log('[WS] Reconnected ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â  fetching missed messages...');
                apiFetch(`/api/chat/${cid}/messages?limit=${SERVER_FETCH_LIMIT}`).then(async serverMsgs => {
                    if (Array.isArray(serverMsgs) && serverMsgs.length > 0) {
                        _lastChatFetchTs[cid] = Date.now();
                        const merged = await ChatCache.appendMessages(cid, serverMsgs);
                        if (cid === state.activeChatId) {
                            const existingList = document.getElementById('messages-list');
                            const existingElements = existingList ? existingList.querySelectorAll('.message') : [];
                            if (existingElements.length > 0) {
                                const existingIds = new Set();
                                existingElements.forEach(el => {
                                    if (el.dataset.id) existingIds.add(el.dataset.id);
                                    if (el.dataset.clientId) existingIds.add(el.dataset.clientId);
                                });
                                const newMsgs = serverMsgs.filter(msg => {
                                    const id = msg.id || '';
                                    const cId = msg.clientId || '';
                                    return (!id || !existingIds.has(id)) && (!cId || !existingIds.has(cId));
                                });
                                if (newMsgs.length > 0) {
                                    renderMessages(newMsgs, true);
                                    const mc = document.getElementById('messages-container');
                                    const isNearBottom = mc.scrollHeight - mc.scrollTop - mc.clientHeight < 150;
                                    if (isNearBottom) scrollToBottom(true);
                                }
                            } else {
                                renderMessages(merged);
                                scrollToBottom(true);
                            }
                        }
                    }
                }).catch(() => {});
            }
            reconnectAttempts = 0;
            // Send immediate latency ping on connection
            sendWsPing();

            // Start real-time ping latency check: every 1s while active, every 20s while backgrounded
            if (state.wsPingInterval) clearInterval(state.wsPingInterval);
            let _lastHiddenPingTs = 0;
            state.wsPingInterval = setInterval(() => {
                if (document.hidden) {
                    const now = Date.now();
                    // In background, ping every 20s to keep Cloudflare DO TCP socket alive
                    if (now - _lastHiddenPingTs >= 20000) {
                        _lastHiddenPingTs = now;
                        sendWsPing();
                    }
                    return;
                }
                sendWsPing();
            }, 1000);
        };

        state.ws.onmessage = async (e) => {
            try {
                const m = JSON.parse(e.data);

                // Any WS event from peer means they're online right now
                state.lastWsMessageTs = Date.now();
                const peerName = (m.from && m.from !== state.user) ? m.from : ((m.user && m.user !== state.user) ? m.user : ((m.by && m.by !== state.user) ? m.by : null));
                if (peerName) {
                    _peerLastSeenTs = Date.now();
                    updateHeaderStatus();
                    if (ChatCache.chats) {
                        const targetChat = ChatCache.chats.find(c => c.other === peerName);
                        if (targetChat) targetChat.otherLastSeen = _peerLastSeenTs;
                    }
                }

                // Pong response â€” calculate RTT & clear dead-connection timeout
                if (m.type === 'pong') {
                    if (state._pongTimeout) { clearTimeout(state._pongTimeout); state._pongTimeout = null; }
                    if (state._lastPingTs) {
                        const rtt = Math.round(performance.now() - state._lastPingTs);
                        updateWsLatencyUI(rtt);
                    }
                    return;
                }

                // Route WebRTC signaling to calls.js if it exists
                if (['offer', 'answer', 'ice_candidate', 'call_end', 'call_status'].includes(m.type)) {
                    if (window.handleWebRTCSignal) window.handleWebRTCSignal(m);
                    return;
                }

                // Read receipt
                if (m.type === 'read_receipt' && m.by !== state.user) {
                    document.querySelectorAll('.message.sent .ticks:not(.read)').forEach(el => {
                        el.classList.add('read');
                        el.innerHTML = TICK_ICONS.read;
                    });
                    await ChatCache.markRead(cid, m.ts);
                    return;
                }

                // Reaction update
                if (m.type === 'reaction_update' && m.msgId) {
                    const msgEl = document.querySelector(`[data-id="${m.msgId}"], [data-client-id="${m.msgId}"]`);
                    if (msgEl) {
                        updateReactionDisplay(msgEl, m.msgId, m.reactions);
                    }
                    if (state.activeChatId) {
                        const msgs = ChatCache._activeMsgs.get(state.activeChatId);
                        if (msgs) {
                            const target = msgs.find(x => x.id === m.msgId || x.clientId === m.msgId);
                            if (target) {
                                target.reactions = m.reactions;
                                ChatCache._scheduleSave(state.activeChatId);
                            }
                        }
                    }
                    return;
                }

                // Message edited live
                if (m.type === 'message_edited') {
                    handleMessageEditedLive(m);
                    return;
                }

                // Friend request in Random Chat
                if ((m.type === 'friend_request' || m.type === 'friend_request_received') && m.fromUser) {
                    if (m.fromUser !== state.user && window.RandomChatManager) {
                        if (m.message && cid === state.activeChatId) {
                            const existing = document.querySelector(`[data-client-id="${m.message.clientId}"]`);
                            if (!existing) {
                                renderMessages([m.message], true);
                                scrollToBottom(true);
                                ChatCache.appendMessages(cid, [m.message]).catch(() => {});
                            }
                        }
                        window.RandomChatManager.onFriendRequestReceived(m.fromUser);
                    }
                    return;
                }

                if (m.type === 'friend_confirmed' || m.type === 'friend_accept') {
                    if (window.RandomChatManager) {
                        window.RandomChatManager.onFriendConfirmed(m.userA || m.fromUser, m.userB || m.targetUser);
                    }
                    return;
                }

                if (m.type === 'friend_declined' || m.type === 'friend_decline') {
                    if (window.RandomChatManager) {
                        window.RandomChatManager.onFriendDeclined(m.fromUser);
                    }
                    return;
                }

                if (m.type === 'peer_disconnected') {
                    if (state.isRandom && window.RandomChatManager) {
                        window.RandomChatManager.handlePeerDisconnected();
                    }
                    return;
                }

                // Message deleted for everyone live
                if (m.type === 'message_deleted') {
                    handleMessageDeletedLive(m);
                    return;
                }

                // Wallpaper update
                if (m.type === 'wallpaper') {
                    setWallpaper(m.image, m.opacity);
                    return;
                }

                // Theme update
                if (m.type === 'theme') {
                    const themeId = m.theme || 'default';
                    localStorage.setItem(`theme_${cid}`, themeId);
                    if (typeof window.setTheme === 'function') window.setTheme(themeId);
                    return;
                }

                // Stealth notification ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â  show innocent notes-app notification
                if (m.type === 'stealth_notify' && m.from !== state.user) {
                    if (IS_CAPACITOR && window.StealthNotify) {
                        window.StealthNotify.show();
                    }
                    return;
                }

                // Room Presence (Both users actively in chat window)
                if (m.type === 'room_presence') {
                    const isTwoInRoom = (m.count >= 2);
                    if (window.CinemaManager) {
                        window.CinemaManager.setPeerInRoom(isTwoInRoom);
                        if (isTwoInRoom && state.ws && state.ws.readyState === WebSocket.OPEN) {
                            window.CinemaManager.announceReadiness(state.ws);
                        }
                    }
                    return;
                }

                // Watch Party & Cinema Sync synchronization from peer
                if (m.type === 'watch_party') {
                    // Ignore self-broadcasts
                    if (m.sender && state.user && m.sender === state.user) return;

                    if ((m.action === 'cinema_matched' || m.action === 'cinema_ready' || m.action === 'cinema_ready_ack') && m.cinemaId) {
                        if (window.CinemaManager) {
                            window.CinemaManager.markPeerReady(m.cinemaId);
                            // If peer sent cinema_ready and we also have the movie file, reply with cinema_ready_ack so peer knows we are ready
                            if (m.action === 'cinema_ready') {
                                const hasLocal = Boolean(
                                    window.CinemaManager.matchedPeerFiles?.has(m.cinemaId) ||
                                    window.CinemaManager.pendingMatches?.has(m.cinemaId)
                                );
                                if (hasLocal && state.ws && state.ws.readyState === WebSocket.OPEN) {
                                    state.ws.send(JSON.stringify({
                                        type: 'watch_party',
                                        action: 'cinema_ready_ack',
                                        cinemaId: m.cinemaId,
                                        sender: state.user
                                    }));
                                }
                            }
                            window.CinemaManager.updateCardUI(m.cinemaId);
                        }
                        return;
                    }
                    if (m.action === 'cinema_invite_live' && m.message) {
                        const liveMsg = m.message;
                        if (liveMsg.from !== state.user && cid === state.activeChatId) {
                            const existing = document.querySelector(`[data-client-id="${liveMsg.clientId}"]`);
                            if (!existing) {
                                renderMessages([liveMsg], true);
                                scrollToBottom(true);
                                ChatCache.appendMessages(cid, [liveMsg]).catch(() => {});
                            }
                        }
                        return;
                    }
                    if (window.WatchPartyEngine) {
                        window.WatchPartyEngine.handleSignal(m);
                    }
                    return;
                }

                // Gaming presence updates from peer
                if (m.type === 'gaming_presence') {
                    if (typeof handleGamingPresenceSignal === 'function') {
                        handleGamingPresenceSignal(m);
                    }
                    return;
                }

                // Typing indicator from peer
                if (m.type === 'typing' && m.user !== state.user) {
                    const activePeer = state.activePeer || (state.activeChatId ? getPeerFromChatId(state.activeChatId) : null);
                    const isCurrentGroup = (state.isGroup || (state.activeChatId && state.activeChatId.startsWith('grp_'))) && (cid === state.activeChatId);
                    const isCurrentRandom = (state.isRandom || (state.activeChatId && state.activeChatId.startsWith('rnd_'))) && (cid === state.activeChatId);

                    if (m.user === activePeer || isCurrentGroup || isCurrentRandom) {
                        const now = Date.now();
                        const lastMsg = state._lastPeerDeliveredMsg;
                        // Strict Stale Packet Watermark Shield:
                        // If a message was delivered in the last 2.5 seconds, discard typing packets that are prefixes or match the delivered message
                        if (lastMsg && (now - lastMsg.ts) < 2500) {
                            const typingText = (m.text || '').trim();
                            if (!typingText || lastMsg.text === typingText || lastMsg.text.startsWith(typingText)) {
                                return; // Ignore stale delayed typing packet
                            }
                        }
                        const displayName = isCurrentRandom ? 'Anonymous' : m.user;
                        handlePeerTyping(displayName, !!m.isTyping, m.text, !!m.paused);
                    }
                    return;
                }

                // Presence update from peer
                if (m.type === 'presence' && m.lastSeen) {
                    updateHeaderStatus(m.lastSeen);
                    return;
                }

                // Chat cleared by other user
                if (m.type === 'chat_cleared') {
                    await ChatCache.clearMessages(cid);
                    if (ChatCache.chats) {
                        const targetChat = ChatCache.chats.find(c => c.other === state.activePeer || (cid && cid.includes(c.other)));
                        if (targetChat) {
                            targetChat.lastMessage = '';
                            targetChat.unread = 0;
                            ChatCache.saveChats(ChatCache.chats);
                        }
                    }
                    if (cid === state.activeChatId) {
                        document.getElementById('messages-list').innerHTML = '';
                        state.hasMoreHistory = false;
                        state.loadedMessageLimit = SERVER_FETCH_LIMIT;
                    }
                    if (typeof refreshChatList === 'function') refreshChatList();
                    return;
                }

                // Large media notification ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â  fetch full message via HTTP
                if (m.type === 'new_large_message') {
                    apiFetch(`/api/chat/${cid}/messages?id=${m.id}`).then(async serverMsgs => {
                        if (Array.isArray(serverMsgs) && serverMsgs.length > 0) {
                            await ChatCache.appendMessages(cid, serverMsgs);
                            if (cid === state.activeChatId) {
                                renderMessages(serverMsgs, true);
                                // Smart scroll: only auto-scroll if user is near bottom
                                const mc = document.getElementById('messages-container');
                                const isNearBottom = mc.scrollHeight - mc.scrollTop - mc.clientHeight < 150;
                                if (isNearBottom) {
                                    scrollToBottom(true);
                                }
                            }
                            // Send read receipt
                            apiFetch(`/api/chat/${cid}/read`, { method: 'POST' });
                        }
                    }).catch(() => {});
                    return;
                }

                // Incoming message
                if (m.from && m.from !== state.user) {
                    // Record delivered message to filter out-of-order stale typing packets in slow networks
                    state._lastPeerDeliveredMsg = { text: (m.text || '').trim(), ts: Date.now() };

                    // Dedicated Cinema Sync invite handling: render immediately without peek morphing
                    if (m.cinemaInvite) {
                        const typingBubble = document.getElementById('typing-bubble') || document.querySelector('.typing-indicator:not(.morphed)');
                        if (typingBubble) typingBubble.remove();
                        handlePeerTyping(m.from, false, null, false, true);
                        if (cid === state.activeChatId) {
                            const existing = document.querySelector(`[data-id="${m.id}"], [data-client-id="${m.clientId}"]`);
                            if (!existing) {
                                renderMessages([m], true);
                                scrollToBottom(true);
                            }
                        }
                        if (await ChatCache.addChat(m.from)) refreshChatList();
                        await ChatCache.appendMessages(cid, [m]);
                        apiFetch(`/api/chat/${cid}/read`, { method: 'POST' }).catch(() => {});
                        return;
                    }

                    const typingBubble = document.getElementById('typing-bubble') || document.querySelector('.typing-indicator:not(.morphed)');
                    const isPeekOpen = typingBubble && (typingBubble.classList.contains('peek-open') || state._peekActive);
                    const isPlainNonMedia = m.text && !m.text.startsWith('data:') && !m.text.startsWith('http://') && !m.text.startsWith('https://') && !m.replyTo && (!m.effect || m.effect === 'none') && !m.cinemaInvite;

                    if (typingBubble && isPeekOpen && isPlainNonMedia && cid === state.activeChatId) {
                        morphPeekToMessage(m, typingBubble);
                        const mc = document.getElementById('messages-container');
                        const isNearBottom = mc.scrollHeight - mc.scrollTop - mc.clientHeight < 150;
                        if (isNearBottom) scrollToBottom(true);
                    } else {
                        handlePeerTyping(m.from, false, null, false, true);
                        if (cid === state.activeChatId) {
                            renderMessages([m], true);
                            const mc = document.getElementById('messages-container');
                            const isNearBottom = mc.scrollHeight - mc.scrollTop - mc.clientHeight < 150;
                            if (isNearBottom) {
                                scrollToBottom(true);
                            } else {
                                incrementUnreadScrollBadge();
                            }
                        }
                    }

                    if (await ChatCache.addChat(m.from)) refreshChatList();
                    await ChatCache.appendMessages(cid, [m]);

                    apiFetch(`/api/chat/${cid}/read`, { method: 'POST' }).catch(() => {});
                }
            } catch (z) { console.error('WS message error:', z); }
        };

        state.ws.onclose = (e) => {
            console.log('[WS] Closed', e.code, e.reason);
            if (window.CinemaManager) window.CinemaManager.setPeerInRoom(false);
            updateWsLatencyUI(null);
            if (state.wsPingInterval) { clearInterval(state.wsPingInterval); state.wsPingInterval = null; }
            if (state._pongTimeout) { clearTimeout(state._pongTimeout); state._pongTimeout = null; }

            const isRandomActive = state.isRandom || (cid && cid.startsWith('rnd_')) || (window.RandomChatManager && window.RandomChatManager.isConnected);
            // Don't reconnect if network was intentionally suspended (background) for regular chats
            if (state._networkSuspended && !isRandomActive) return;

            // Only reconnect if this chat is still active and under attempt limit (unlimited for random chat)
            if (cid === state.activeChatId && (isRandomActive || reconnectAttempts < 10)) {
                reconnectAttempts++;
                const delay = isRandomActive ? Math.min(1000, 500 * reconnectAttempts) : Math.min(500 * Math.pow(2, reconnectAttempts), 15000);
                console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
                state.wsReconnectTimeout = setTimeout(createWS, delay);
            }
        };

        state.ws.onerror = (e) => {
            console.error('[WS] Error', e);
        };
    }

    createWS();

    // Message freshness poll â€” lightweight check via chat list, only fetch full messages if new ones exist
    if (state._freshnessInterval) clearInterval(state._freshnessInterval);
    state._freshnessInterval = setInterval(async () => {
        if (document.hidden) return; // Skip polling when tab is inactive
        if (!state.activeChatId || cid !== state.activeChatId) return;

        // Skip HTTP poll only if WebSocket is active and receiving live packets
        const isWsStalled = !state.ws || state.ws.readyState !== WebSocket.OPEN || (Date.now() - (state.lastWsMessageTs || 0) > 35000);
        if (!isWsStalled) return;
        
        try {
            // Lightweight: chat list is ~1KB vs full messages which can be 100MB+
            const chats = await apiFetch('/api/chats');
            if (!Array.isArray(chats)) return;
            if (!state.activeChatId || cid !== state.activeChatId) return;
            const chat = chats.find(c => c.other === state.activePeer);
            if (!chat || !chat.ts) return;
            const lastRendered = document.querySelector('#messages-list .message:last-child');
            const lastRenderedTs = lastRendered ? parseInt(lastRendered.dataset.ts || '0', 10) : 0;
            if (chat.ts > lastRenderedTs) {
                const msgs = await apiFetch(`/api/chat/${cid}/messages?limit=${SERVER_FETCH_LIMIT}`);
                if (Array.isArray(msgs) && msgs.length > 0) {
                    _lastChatFetchTs[cid] = Date.now();
                    const m = await ChatCache.appendMessages(cid, msgs);
                    if (state.activeChatId === cid) {
                        renderMessages(m);
                        const mc = document.getElementById('messages-container');
                        const isNearBottom = mc.scrollHeight - mc.scrollTop - mc.clientHeight < 150;
                        if (isNearBottom) scrollToBottom(true);
                    }
                }
            }
        } catch (e) {}
    }, 12000);

    // Poll peer presence every 15s for live online status
    async function pollPeerPresence() {
        if (document.hidden) return;
        if (state.activePeer && cid === state.activeChatId) {
            try {
                const chats = await apiFetch('/api/chats');
                if (Array.isArray(chats)) {
                    const peerChat = chats.find(c => c.other === state.activePeer);
                    if (peerChat) {
                        updateHeaderStatus(peerChat.otherLastSeen);
                        if (ChatCache.chats) {
                            const tc = ChatCache.chats.find(c => c.other === state.activePeer);
                            if (tc) tc.otherLastSeen = peerChat.otherLastSeen;
                        }
                    }
                }
            } catch (e) { }
        }
    }
    pollPeerPresence();
    state.peerPresenceInterval = setInterval(pollPeerPresence, 25000);
}

// --- Notification Sound (Disabled) ---
function playNotificationSound() {}

// --- Morphing Action Button (Mic <-> Send) & Collapsible GIF Controller ---
let _actionBtnState = 'mic'; // 'mic' | 'plane'
let _actionBtnAnimTimeout = null;

function updateActionAndGifState(hasText, forceInstant = false) {
    const actionBtn = document.getElementById('action-btn');
    const gifBtn = document.getElementById('gif-btn');
    const imgBtn = document.getElementById('img-btn');
    const searchBtn = document.getElementById('search-effects-btn');

    // Ensure search effects button remains disabled
    if (searchBtn) {
        searchBtn.classList.add('hidden');
        searchBtn.style.display = 'none';
    }

    // Toggle GIF button collapsing
    if (gifBtn) {
        if (hasText) {
            gifBtn.classList.add('collapsed');
        } else {
            gifBtn.classList.remove('collapsed');
        }
    }

    if (!actionBtn) return;

    if (forceInstant) {
        if (_actionBtnAnimTimeout) {
            clearTimeout(_actionBtnAnimTimeout);
            _actionBtnAnimTimeout = null;
        }
        actionBtn.classList.remove('anim-to-plane', 'anim-to-mic');
        if (hasText) {
            _actionBtnState = 'plane';
            actionBtn.classList.remove('state-mic');
            actionBtn.classList.add('state-plane');
            actionBtn.setAttribute('title', 'Send Message');
            actionBtn.setAttribute('aria-label', 'Send Message');
        } else {
            _actionBtnState = 'mic';
            actionBtn.classList.remove('state-plane');
            actionBtn.classList.add('state-mic');
            actionBtn.setAttribute('title', 'Voice Note');
            actionBtn.setAttribute('aria-label', 'Voice Note');
        }
        return;
    }

    if (hasText && _actionBtnState !== 'plane') {
        _actionBtnState = 'plane';
        if (_actionBtnAnimTimeout) clearTimeout(_actionBtnAnimTimeout);
        actionBtn.classList.remove('state-mic', 'state-plane', 'anim-to-mic');
        actionBtn.classList.add('anim-to-plane');
        actionBtn.setAttribute('title', 'Send Message');
        actionBtn.setAttribute('aria-label', 'Send Message');

        _actionBtnAnimTimeout = setTimeout(() => {
            actionBtn.classList.remove('anim-to-plane');
            actionBtn.classList.add('state-plane');
            _actionBtnAnimTimeout = null;
        }, 400);
    } else if (!hasText && _actionBtnState !== 'mic') {
        _actionBtnState = 'mic';
        if (_actionBtnAnimTimeout) clearTimeout(_actionBtnAnimTimeout);
        actionBtn.classList.remove('state-mic', 'state-plane', 'anim-to-plane');
        actionBtn.classList.add('anim-to-mic');
        actionBtn.setAttribute('title', 'Voice Note');
        actionBtn.setAttribute('aria-label', 'Voice Note');

        _actionBtnAnimTimeout = setTimeout(() => {
            actionBtn.classList.remove('anim-to-mic');
            actionBtn.classList.add('state-mic');
            _actionBtnAnimTimeout = null;
        }, 420);
    }
}

// --- Input Bar: Hide media buttons when typing ---
// --- Input Bar: Instagram-style dynamic layout ---
document.getElementById('message-input')?.addEventListener('input', (e) => {
    const hasText = e.target.value.trim().length > 0;
    const rawVal = e.target.value;

    updateActionAndGifState(hasText);

    // Legacy support
    const wrapper = e.target.closest('.input-wrapper');
    if (wrapper) {
        if (hasText) {
            wrapper.classList.add('has-text');
        } else {
            wrapper.classList.remove('has-text');
        }
    }

    // Typing indicator & Live Keystroke: send via WS
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        if (hasText) {
            // Send isTyping:true immediately on first keystroke, then every 2s while still typing
            const now = Date.now();
            const typingUser = (state.isRandom || (state.activeChatId && state.activeChatId.startsWith('rnd_'))) ? 'Anonymous' : state.user;
            const typingChatId = state.activeChatId;
            if (!state._typingSent || (now - (state._lastTypingSendTs || 0) > 2000)) {
                state.ws.send(JSON.stringify({ type: 'typing', user: typingUser, chatId: typingChatId, isTyping: true, text: rawVal }));
                state._typingSent = true;
                state._lastTypingSendTs = now;
                state._lastSentTypingText = rawVal;
            } else if (state._lastSentTypingText !== rawVal) {
                clearTimeout(state._typingTextThrottle);
                state._typingTextThrottle = setTimeout(() => {
                    if (state.ws && state.ws.readyState === WebSocket.OPEN && hasText) {
                        state.ws.send(JSON.stringify({ type: 'typing', user: typingUser, chatId: typingChatId, isTyping: true, text: e.target.value }));
                        state._lastSentTypingText = e.target.value;
                    }
                }, 40);
            }
            // Reset the pause/stop-typing timeout on every keystroke
            clearTimeout(state._typingTimeout);
            state._typingTimeout = setTimeout(() => {
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    const currentVal = (document.getElementById('message-input')?.value || '').trim();
                    if (currentVal) {
                        // User paused, but draft text is still in input: signal pause without destroying receiver's live draft!
                        state.ws.send(JSON.stringify({ type: 'typing', user: typingUser, chatId: typingChatId, isTyping: true, paused: true, text: currentVal }));
                    } else {
                        state.ws.send(JSON.stringify({ type: 'typing', user: typingUser, chatId: typingChatId, isTyping: false, text: '' }));
                    }
                }
                state._typingSent = false;
            }, 2800);
        }
        if (!hasText && state._typingSent) {
            const typingUser = (state.isRandom || (state.activeChatId && state.activeChatId.startsWith('rnd_'))) ? 'Anonymous' : state.user;
            state.ws.send(JSON.stringify({ type: 'typing', user: typingUser, chatId: state.activeChatId, isTyping: false, text: '' }));
            state._typingSent = false;
            state._lastSentTypingText = '';
            clearTimeout(state._typingTimeout);
            clearTimeout(state._typingTextThrottle);
        }
    }
});

// Clipboard paste listener to upload copied images/GIFs directly
document.getElementById('message-input')?.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
                e.preventDefault();
                handleImageFile(file);
            }
        }
    }
});

// --- Prevent keyboard from closing when tapping messages area or input bar ---
function preventBlur(e) {
    // 1. If keyboard is NOT open, blur prevention must NEVER run
    if (!document.body.classList.contains('keyboard-open')) return;

    const input = document.getElementById('message-input');
    if (input && document.activeElement === input && e.target !== input) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        // Top header buttons blur the input and leave/action
        if (e.target.closest('#back-btn') || e.target.closest('#chat-kebab-btn') || e.target.closest('#phone-btn') || e.target.closest('#video-btn')) {
            input.blur();
            document.body.classList.remove('keyboard-open');
            return;
        }
        // Media elements (images, gifs, videos) to be opened in lightbox or played: blur input and close keyboard
        if (e.target.classList.contains('message-image') || e.target.classList.contains('message-gif') || e.target.closest('.message-image, .message-gif, .msg-video')) {
            input.blur();
            document.body.classList.remove('keyboard-open');
            return;
        }
        // Quoted messages ("replay"): prevent blur so keyboard stays open while jumping to replied message!
        if (e.target.closest('.message-quote')) {
            e.preventDefault();
            return;
        }
        e.preventDefault();
    }
}

const chatAreaEl = document.getElementById('chat-area');
if (chatAreaEl) {
    chatAreaEl.addEventListener('pointerdown', preventBlur);
    chatAreaEl.addEventListener('mousedown', preventBlur);
}

// Tapping the input wrapper or message bar area focuses the input directly
document.querySelector('.input-wrapper-ig')?.addEventListener('click', (e) => {
    const input = document.getElementById('message-input');
    if (e.target !== input && input) {
        input.focus();
    }
});

// --- Listeners ---
const msgInput = document.getElementById('message-input');
if (msgInput) {
    msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
}
const sendBtn = document.getElementById('send-btn');
if (sendBtn) {
    // Prevent button press from stealing focus away on desktop
    sendBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
    });
    sendBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (Date.now() - _lastLowerBarTapTs < 400) return;
        sendMessage();
    });
}

const actionBtn = document.getElementById('action-btn');
if (actionBtn) {
    actionBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
    });
    actionBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (Date.now() - _lastLowerBarTapTs < 350) return;
        _lastLowerBarTapTs = Date.now();
        if (_actionBtnState === 'plane') {
            sendMessage();
        } else {
            if (typeof startVoiceRecording === 'function') {
                startVoiceRecording();
            }
        }
    });
}

// ==========================================================================
// V6 Auth Screen Interactive Controller (Pure Sandboxed / Anti-Autofill)
// ==========================================================================
function setAuthMode(register) {
    state.isSignup = register;
    const tabSlider = document.getElementById('tab-slider');
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const authTitle = document.getElementById('auth-title');
    const authSubtitle = document.getElementById('auth-subtitle');
    const btnText = document.getElementById('btn-text');
    const authError = document.getElementById('auth-error');

    if (authError) authError.classList.add('hidden');

    if (state.isSignup) {
        if (tabSlider) tabSlider.style.transform = 'translateX(100%)';
        if (tabRegister) { tabRegister.classList.add('active'); tabRegister.setAttribute('aria-selected', 'true'); }
        if (tabLogin) { tabLogin.classList.remove('active'); tabLogin.setAttribute('aria-selected', 'false'); }
        if (authTitle) authTitle.textContent = 'Create Handle';
        if (authSubtitle) authSubtitle.textContent = 'Register an anonymous handle on the zero-knowledge mesh network';
        if (btnText) btnText.textContent = 'Register Anonymous Account';
    } else {
        if (tabSlider) tabSlider.style.transform = 'translateX(0%)';
        if (tabLogin) { tabLogin.classList.add('active'); tabLogin.setAttribute('aria-selected', 'true'); }
        if (tabRegister) { tabRegister.classList.remove('active'); tabRegister.setAttribute('aria-selected', 'false'); }
        if (authTitle) authTitle.textContent = 'Welcome Back';
        if (authSubtitle) authSubtitle.textContent = 'Enter your secret credentials to sync chat history';
        if (btnText) btnText.textContent = 'Authenticate & Enter';
    }
}

document.getElementById('tab-login')?.addEventListener('click', () => setAuthMode(false));
document.getElementById('tab-register')?.addEventListener('click', () => setAuthMode(true));

// Real-Time Input Validation Indicator
document.getElementById('username-input')?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    const statusDot = document.getElementById('username-status');
    if (statusDot) {
        if (val.length >= 3) {
            statusDot.classList.add('valid');
        } else {
            statusDot.classList.remove('valid');
        }
    }
});

// Password Visibility Eye Toggle
let isPasswordVisible = false;
document.getElementById('toggle-password-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    const passwordInput = document.getElementById('password-input');
    const eyeIcon = document.getElementById('eye-icon');
    if (!passwordInput || !eyeIcon) return;

    isPasswordVisible = !isPasswordVisible;
    if (isPasswordVisible) {
        passwordInput.style.webkitTextSecurity = 'none';
        passwordInput.style.textSecurity = 'none';
        eyeIcon.innerHTML = `
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
        `;
    } else {
        passwordInput.style.webkitTextSecurity = 'disc';
        passwordInput.style.textSecurity = 'disc';
        eyeIcon.innerHTML = `
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
        `;
    }
});

async function handleAuthSubmit(e) {
    if (e) e.preventDefault();
    const btn = document.getElementById('auth-btn');
    const btnText = document.getElementById('btn-text');
    const originalText = btnText ? btnText.textContent : (btn ? btn.textContent : 'Authenticate & Enter');

    // Show loading state
    if (btn) btn.disabled = true;
    if (btnText) btnText.innerHTML = '<span class="spinner"></span> Please wait...';
    document.getElementById('auth-error')?.classList.add('hidden');

    try {
        const usernameInput = document.getElementById('username-input');
        const passwordInput = document.getElementById('password-input');
        const u = usernameInput ? usernameInput.value.trim() : '';
        const p = passwordInput ? passwordInput.value.trim() : '';
        if (!u || !p) {
            const err = document.getElementById('auth-error');
            const errMsg = document.getElementById('auth-error-msg') || err;
            if (errMsg) errMsg.textContent = 'Please enter both username and password';
            if (err) err.classList.remove('hidden');
            if (btn) btn.disabled = false;
            if (btnText) btnText.textContent = originalText;
            return;
        }

        const ep = state.isSignup ? '/api/signup' : '/api/login';
        const res = await apiFetch(ep, { method: 'POST', body: JSON.stringify({ username: u, password: p }) });

        if (res.token) {
            // Neutralize inputs immediately
            if (usernameInput) { usernameInput.disabled = true; usernameInput.value = ''; }
            if (passwordInput) { passwordInput.disabled = true; passwordInput.value = ''; }
            saveToken(res.token);
            checkSession();
        } else {
            const err = document.getElementById('auth-error');
            const errMsg = document.getElementById('auth-error-msg') || err;
            if (errMsg) errMsg.textContent = res.error || 'Authentication failed';
            if (err) err.classList.remove('hidden');
            if (btn) btn.disabled = false;
            if (btnText) btnText.textContent = originalText;
        }
    } catch (error) {
        const err = document.getElementById('auth-error');
        const errMsg = document.getElementById('auth-error-msg') || err;
        if (errMsg) errMsg.textContent = 'Connection failed';
        if (err) err.classList.remove('hidden');
        if (btn) btn.disabled = false;
        if (btnText) btnText.textContent = originalText;
    }
}

document.getElementById('auth-btn')?.addEventListener('click', handleAuthSubmit);
document.getElementById('username-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('password-input')?.focus();
    }
});
document.getElementById('password-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        handleAuthSubmit(e);
    }
});

function openUserModal() {
    document.getElementById('user-modal').classList.remove('hidden');
    BackNavManager.push('user-modal', () => {
        closeUserModal(true);
    });
}

function closeUserModal(fromPop = false) {
    if (!fromPop) {
        BackNavManager.pop('user-modal');
    }
    document.getElementById('user-modal').classList.add('hidden');
    document.getElementById('modal-error').classList.add('hidden');
}

document.getElementById('new-chat-btn').onclick = openUserModal;
document.getElementById('modal-close').onclick = () => closeUserModal(false);

document.getElementById('start-chat-confirm').onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const peerInput = document.getElementById('target-user-input');
    const peer = peerInput.value.trim();
    const err = document.getElementById('modal-error');

    if (!peer) {
        err.textContent = "Please enter a username";
        err.classList.remove('hidden');
        return;
    }

    // Check user exists
    const check = await apiFetch(`/api/users/${peer}/check`);
    if (check.exists) {
        await ChatCache.addChat(peer, false);
        closeUserModal(false);
        peerInput.value = '';
        refreshChatList();
        openChat(peer, 0);
    } else {
        err.textContent = "User not found";
        err.classList.remove('hidden');
    }
};

function closeActiveChat(fromPop = false) {
    const msgInp = document.getElementById('message-input');
    if (msgInp) msgInp.blur();
    document.body.classList.remove('keyboard-open');

    if (!fromPop && BackNavManager.has('chat')) {
        BackNavManager.pop('chat');
    }
    document.body.classList.remove('show-chat');
    state.activeChatId = null;
    state.activePeer = null;

    if ((state.isRandom || state.isPulse) && window.RandomChatManager) {
        window.RandomChatManager.onChatClosed();
    }
    state.isRandom = false;
    state.isPulse = false;
    state.isGroup = false;
    state.isSpace = false;
    document.getElementById('random-action-bar')?.classList.add('hidden');
    document.getElementById('random-center-menu')?.classList.add('hidden');
    document.getElementById('active-chat-container')?.classList.remove('has-random-bar');

    if (window.WatchPartyEngine?.pauseLocalOnChatExit) {
        window.WatchPartyEngine.pauseLocalOnChatExit();
    }
    if (window.CinemaManager) {
        window.CinemaManager.resetSessionReadiness();
    }
    closeChatSpecificNetwork();
    if (typeof WallpaperEngine !== 'undefined' && typeof WallpaperEngine.stopLoop === 'function') {
        WallpaperEngine.stopLoop();
    }
    if (state.user && !state.presenceInterval) {
        state.presenceInterval = setInterval(sendPresence, 30000);
        sendPresence();
    }
    startChatListPolling();
    refreshChatList();
}

document.getElementById('back-btn').onclick = (e) => {
    if (typeof window._isModalJustClosed === 'function' && window._isModalJustClosed()) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        return;
    }
    closeActiveChat(false);
};
document.getElementById('logout-btn').onclick = logout;

// --- Delete Chat Modal ---
let pendingDeletePeer = null;

function showDeleteModal(peer) {
    pendingDeletePeer = peer;
    document.getElementById('delete-modal').classList.remove('hidden');
    BackNavManager.push('delete-modal', () => {
        closeDeleteModal(true);
    });
}

function closeDeleteModal(fromPop = false) {
    if (!fromPop) {
        BackNavManager.pop('delete-modal');
    }
    document.getElementById('delete-modal').classList.add('hidden');
    pendingDeletePeer = null;
}

document.getElementById('delete-cancel').onclick = () => closeDeleteModal(false);

document.getElementById('delete-confirm').onclick = async () => {
    if (!pendingDeletePeer) return;

    const peerToDelete = pendingDeletePeer;
    closeDeleteModal(false);

    // Hide chat locally (clears from view)
    await ChatCache.hideChat(peerToDelete);

    // Clear messages from local cache
    const cid = [state.user, peerToDelete].sort().join(':');
    await ChatCache.clearMessages(cid);

    // If this was the active chat, close it
    if (state.activePeer === peerToDelete) {
        closeActiveChat(false);
        document.getElementById('active-chat-container').classList.add('hidden');
        document.getElementById('no-chat-selected').classList.remove('hidden');
    }

    refreshChatList();
};

// --- Chat Search ---
document.getElementById('search-input').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const allChats = ChatCache.chats;

    if (!query) {
        renderChatList(allChats);
        return;
    }

    const filtered = allChats.filter(chat =>
        chat.other.toLowerCase().includes(query) ||
        (chat.name && chat.name.toLowerCase().includes(query)) ||
        (chat.topic && chat.topic.toLowerCase().includes(query)) ||
        (chat.lastMessage && chat.lastMessage.toLowerCase().includes(query))
    );
    renderChatList(filtered);
});

// --- Copy Message on Double-Click / Watch Party Click ---
document.getElementById('messages-list').addEventListener('click', (e) => {
    const ytBtn = e.target.closest('.yt-watch-btn');
    if (ytBtn) {
        e.preventDefault();
        e.stopPropagation();
        const ytId = ytBtn.dataset.ytId;
        if (ytId && window.WatchPartyEngine) {
            window.WatchPartyEngine.startParty(ytId, `https://youtu.be/${ytId}`, true, 0);
        }
    }

    // Cinema Sync: Reveal/Hide Full Movie Name
    const revealBtn = e.target.closest('.cinema-reveal-name-btn');
    const cardTitle = e.target.closest('.cinema-card-title');
    if (revealBtn || cardTitle) {
        e.preventDefault();
        e.stopPropagation();
        const card = (revealBtn || cardTitle).closest('.message-cinema-card');
        if (!card) return;
        const titleEl = card.querySelector('.cinema-card-title');
        const btn = card.querySelector('.cinema-reveal-name-btn');
        if (!titleEl) return;
        const isRevealed = titleEl.classList.toggle('is-revealed');
        if (btn) {
            btn.innerHTML = (isRevealed ? CINEMA_CARD_ICONS.eyeOff : CINEMA_CARD_ICONS.eye) +
                `<span class="cinema-reveal-text">${isRevealed ? 'Hide Name' : 'Full Name'}</span>`;
        }
        return;
    }

    // Cinema Sync: Peer movie file matcher
    const matchBtn = e.target.closest('.cinema-match-btn');
    if (matchBtn) {
        e.preventDefault();
        e.stopPropagation();
        const card = matchBtn.closest('.message-cinema-card');
        if (!card) return;
        const invite = {
            id: card.dataset.cinemaId,
            name: card.dataset.cinemaName,
            size: Number(card.dataset.cinemaSize) || 0,
            duration: Number(card.dataset.cinemaDuration) || 0,
            hash: card.dataset.cinemaHash,
            from: card.dataset.cinemaFrom
        };

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'video/mp4,video/mkv,video/webm,video/x-matroska,video/quicktime,video/*';
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);

        fileInput.onchange = async () => {
            const file = fileInput.files?.[0];
            fileInput.remove();
            if (!file) return;

            const statusEl = card.querySelector('.cinema-card-status');
            if (statusEl) {
                statusEl.innerHTML = `
                    <span class="cinema-status-dot blue"></span>
                    <span>Verifying local file fingerprint...</span>
                `;
            }

            if (window.CinemaManager) {
                const res = await window.CinemaManager.matchPeerMovieFile(invite, file);
                if (res.match) {
                    if (window.CinemaManager) {
                        window.CinemaManager.updateCardUI(invite.id);
                    }
                } else {
                    if (statusEl) {
                        statusEl.className = 'cinema-card-status';
                        if (res.comparison) {
                            statusEl.innerHTML = renderCinemaMismatchHtml(res.comparison, invite.id);
                        } else {
                            statusEl.innerHTML = `
                                <div class="cinema-mismatch-box">
                                    <div class="cinema-mismatch-header">
                                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                                        <span class="cinema-mismatch-title">Duration Mismatch</span>
                                    </div>
                                    <div class="cinema-mismatch-desc">${escapeHtml(res.reason || 'Movie duration does not match.')}</div>
                                    <div class="cinema-mismatch-hint">
                                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#38bdf8" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                                        <span>Please select the matching movie file.</span>
                                    </div>
                                </div>
                            `;
                        }
                    }
                    const actionsEl = card.querySelector('.cinema-card-actions');
                    if (actionsEl) {
                        actionsEl.innerHTML = `
                            <button type="button" class="cinema-action-btn cinema-match-btn cinema-retry-btn" data-cinema-id="${escapeHtml(invite.id)}">
                                ${CINEMA_CARD_ICONS.folder}
                                <span>Choose Different Movie File</span>
                            </button>
                        `;
                    }
                }
            }
        };

        fileInput.click();
        return;
    }

    // Cinema Sync: Launch player
    const launchBtn = e.target.closest('.cinema-launch-btn');
    if (launchBtn) {
        e.preventDefault();
        e.stopPropagation();
        const card = launchBtn.closest('.message-cinema-card');
        if (!card) return;
        const isHost = launchBtn.dataset.cinemaHost !== 'false';
        const invite = {
            id: card.dataset.cinemaId,
            name: card.dataset.cinemaName,
            size: Number(card.dataset.cinemaSize) || 0,
            duration: Number(card.dataset.cinemaDuration) || 0,
            hash: card.dataset.cinemaHash,
            from: card.dataset.cinemaFrom
        };
        if (window.CinemaManager) {
            window.CinemaManager.launchParty(invite);
        }
        return;
    }
});

document.getElementById('messages-list').addEventListener('dblclick', (e) => {
    const msgEl = e.target.closest('.message');
    if (msgEl) {
        const text = msgEl.querySelector('.msg-text')?.textContent || '';
        if (text) {
            navigator.clipboard.writeText(text).then(() => {
                // Visual feedback
                msgEl.style.opacity = '0.5';
                setTimeout(() => msgEl.style.opacity = '1', 150);
            }).catch(() => { });
        }
    }
});

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

// ==========================================================================
// PURE LIQUID GLASS GIF SELECTION (KLIPY ONLY)
// ==========================================================================
const KLIPY_API_KEY = 'plUybyFTfZaD7Q9NjW9I6BtzsdvgcbmzlhtktOLAhvy64vcYXCiDmlZ8Oex0bPBK';
let gifSearchTimeout = null;
let gifAbortController = null;
let gifCurrentQuery = '';
let gifPage = 1;
let gifLoadingMore = false;
let gifHasMore = true;
let _lastGifPickerOpenTs = 0;
const GIF_PAGE_SIZE = 24;

const GifCache = {
    cachedResults: {},
    async init() { const r = await idb.get('chats', 'gif_cache'); if (r) this.cachedResults = r; },
    get(query) { return this.cachedResults[query.toLowerCase().trim()]; },
    set(query, results) { const q = query.toLowerCase().trim(); this.cachedResults[q] = results; idb.put('chats', 'gif_cache', this.cachedResults).catch(() => {}); },
    append(query, newResults) { const q = query.toLowerCase().trim(); this.cachedResults[q] = [...(this.cachedResults[q]||[]), ...newResults]; idb.put('chats', 'gif_cache', this.cachedResults).catch(() => {}); }
};
GifCache.init();

function openGifPicker() {
    const picker = document.getElementById('gif-picker');
    if (!picker) return;
    if (!picker.classList.contains('hidden')) return; // Re-entry guard

    _lastGifPickerOpenTs = Date.now();
    picker.classList.remove('hidden');

    const resultsEl = document.getElementById('gif-results');
    if (resultsEl) {
        resultsEl.removeEventListener('scroll', onGifScroll);
        resultsEl.addEventListener('scroll', onGifScroll, { passive: true });
        // Rule: Don't show any GIF on opening GIF menu!
        resultsEl.innerHTML = `
            <div class="gif-empty-prompt">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <span>Type above to search GIFs</span>
            </div>`;
    }

    BackNavManager.push('gif-picker', () => {
        closeGifPicker(true, true);
    });

    const searchInput = document.getElementById('gif-search-input');
    const clearBtn = document.getElementById('gif-search-clear');
    if (searchInput) {
        searchInput.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        // Rule: Land keyboard directly on search bar of GIF!
        setTimeout(() => {
            searchInput.focus();
        }, 80);
    }
}

function closeGifPicker(clearSearch = true, fromPop = false) {
    if (typeof window._markModalClosed === 'function') window._markModalClosed();
    if (!fromPop && BackNavManager.has('gif-picker')) {
        BackNavManager.pop('gif-picker');
    }
    if (gifAbortController) {
        gifAbortController.abort();
        gifAbortController = null;
    }
    const picker = document.getElementById('gif-picker');
    if (picker) picker.classList.add('hidden');

    const searchInput = document.getElementById('gif-search-input');
    if (searchInput && document.activeElement === searchInput) {
        searchInput.blur();
    }

    document.getElementById('gif-results')?.removeEventListener('scroll', onGifScroll);
    if (clearSearch) {
        if (searchInput) searchInput.value = '';
        const clearBtn = document.getElementById('gif-search-clear');
        if (clearBtn) clearBtn.classList.add('hidden');
        const resultsEl = document.getElementById('gif-results');
        if (resultsEl) resultsEl.innerHTML = '';
        gifCurrentQuery = '';
        gifPage = 1;
        gifHasMore = true;
    }
}

function onGifScroll() {
    const el = document.getElementById('gif-results');
    if (!el || gifLoadingMore || !gifHasMore || !gifCurrentQuery) return;
    const distanceToBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    if (distanceToBottom <= 400) {
        loadMoreGifs();
    }
}

async function searchKlipyGifs(query) {
    const resultsEl = document.getElementById('gif-results');
    if (!resultsEl) return;

    if (gifAbortController) gifAbortController.abort();
    gifAbortController = new AbortController();

    const trimmed = (query || '').trim();
    if (!trimmed) {
        gifCurrentQuery = '';
        gifPage = 1;
        gifHasMore = true;
        resultsEl.innerHTML = `
            <div class="gif-empty-prompt">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <span>Type above to search GIFs</span>
            </div>`;
        return;
    }

    gifCurrentQuery = trimmed;
    gifPage = 1;
    gifHasMore = true;

    const cached = GifCache.get(trimmed);
    if (cached && cached.length > 0) {
        resultsEl.innerHTML = '';
        resultsEl.scrollTop = 0;
        appendGifResults(cached, resultsEl);
        gifPage = Math.ceil(cached.length / GIF_PAGE_SIZE);
        return;
    }

    resultsEl.innerHTML = '<div class="gif-loading">Searching GIFs...</div>';

    try {
        const endpoint = `https://api.klipy.com/api/v1/${KLIPY_API_KEY}/gifs/search?q=${encodeURIComponent(trimmed)}&limit=${GIF_PAGE_SIZE}&page=1`;
        const res = await fetch(endpoint, { signal: gifAbortController.signal });
        const json = await res.json();

        if (!json.data?.data || json.data.data.length === 0) {
            resultsEl.innerHTML = '<div class="gif-empty">No GIFs found for "' + escapeHtml(trimmed) + '"</div>';
            gifHasMore = false;
            return;
        }

        const gifs = json.data.data;
        gifPage = 1;
        gifHasMore = gifs.length >= GIF_PAGE_SIZE;

        GifCache.set(trimmed, gifs);

        resultsEl.innerHTML = '';
        resultsEl.scrollTop = 0;
        appendGifResults(gifs, resultsEl);

        // If results don't fill viewport on tall devices, pre-load page 2 so user can scroll immediately
        if (resultsEl.scrollHeight <= resultsEl.clientHeight + 100 && gifHasMore) {
            loadMoreGifs();
        }
    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error('KLIPY search failed:', e);
        resultsEl.innerHTML = '<div class="gif-empty">Failed to load GIFs</div>';
    }
}

async function loadMoreGifs() {
    if (gifLoadingMore || !gifHasMore || !gifCurrentQuery) return;
    gifLoadingMore = true;

    const resultsEl = document.getElementById('gif-results');
    const loader = document.getElementById('gif-loading-more');
    if (loader) loader.classList.remove('hidden');

    try {
        const nextPage = gifPage + 1;
        const endpoint = `https://api.klipy.com/api/v1/${KLIPY_API_KEY}/gifs/search?q=${encodeURIComponent(gifCurrentQuery)}&limit=${GIF_PAGE_SIZE}&page=${nextPage}`;
        const res = await fetch(endpoint);
        const json = await res.json();

        if (loader) loader.classList.add('hidden');

        if (!json.data?.data || json.data.data.length === 0) {
            gifHasMore = false;
            gifLoadingMore = false;
            return;
        }

        const gifs = json.data.data;
        gifPage = nextPage;
        gifHasMore = gifs.length >= GIF_PAGE_SIZE;

        GifCache.append(gifCurrentQuery, gifs);
        appendGifResults(gifs, resultsEl);
    } catch (e) {
        if (loader) loader.classList.add('hidden');
        console.error('KLIPY load more failed:', e);
    } finally {
        gifLoadingMore = false;
    }
}

function appendGifResults(results, container) {
    if (!results || results.length === 0 || !container) return;

    let columnsContainer = container.querySelector('.gif-columns-container');
    let cols = [];
    const numCols = window.innerWidth >= 600 ? 3 : 2;

    if (!columnsContainer) {
        columnsContainer = document.createElement('div');
        columnsContainer.className = 'gif-columns-container';
        for (let i = 0; i < numCols; i++) {
            const col = document.createElement('div');
            col.className = 'gif-column';
            col.id = `gif-col-${i}`;
            columnsContainer.appendChild(col);
            cols.push(col);
        }
        container.appendChild(columnsContainer);

        // Add loading more indicator at bottom if not already present
        let loader = container.querySelector('#gif-loading-more');
        if (!loader) {
            loader = document.createElement('div');
            loader.id = 'gif-loading-more';
            loader.className = 'gif-loading-more hidden';
            loader.textContent = 'Loading more...';
            container.appendChild(loader);
        }
    } else {
        cols = Array.from(columnsContainer.querySelectorAll('.gif-column'));
    }

    if (cols.length === 0) return;

    // Track column heights based on child aspect ratios without forced DOM layout reflow
    const colHeights = cols.map(col => {
        let total = 0;
        col.querySelectorAll('.gif-card').forEach(c => {
            const ar = c.style.aspectRatio;
            if (ar && ar.includes('/')) {
                const parts = ar.split('/').map(n => parseFloat(n.trim()));
                if (parts[0] && parts[1]) total += (parts[1] / parts[0]);
                else total += 1;
            } else {
                total += 1;
            }
        });
        return total;
    });

    results.forEach(gif => {
        const previewUrl = gif.file?.sm?.webp?.url || gif.file?.sm?.gif?.url || gif.file?.xs?.webp?.url;
        const sendUrl = gif.file?.sm?.gif?.url || gif.file?.md?.gif?.url || gif.file?.sm?.webp?.url;
        if (!previewUrl) return;

        const card = document.createElement('div');
        card.className = 'gif-card';

        // Dynamically adjust box aspect ratio for each GIF so user can see it whole
        const w = gif.file?.sm?.webp?.width || gif.file?.sm?.gif?.width || gif.file?.md?.gif?.width;
        const h = gif.file?.sm?.webp?.height || gif.file?.sm?.gif?.height || gif.file?.md?.gif?.height;
        if (w && h) {
            card.style.aspectRatio = `${w} / ${h}`;
        }

        const img = document.createElement('img');
        img.src = previewUrl;
        img.alt = gif.title || 'GIF';
        img.loading = 'lazy';
        img.decoding = 'async';
        if (w && h) {
            img.width = w;
            img.height = h;
        }

        card.appendChild(img);
        card.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (Date.now() - _lastGifPickerOpenTs < 450) return; // Ghost-click protection shield!
            sendGif(sendUrl || previewUrl);
        };

        // Find shortest column
        const ratio = (w && h) ? (h / w) : 1;
        let minIdx = 0;
        for (let i = 1; i < colHeights.length; i++) {
            if (colHeights[i] < colHeights[minIdx]) {
                minIdx = i;
            }
        }
        cols[minIdx].appendChild(card);
        colHeights[minIdx] += ratio;
    });
}

async function sendGif(gifUrl) {
    if (!gifUrl || !state.activeChatId) return;
    if (Date.now() - _lastGifPickerOpenTs < 450) return; // Ghost-click protection shield!
    const targetChatId = state.activeChatId;

    closeGifPicker(false);

    const cid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (typeof gifUrl === "string" && gifUrl.startsWith("data:")) {
        sendMediaPayloadWithProgress(gifUrl, cid, "gif");
    } else if (typeof gifUrl === "string" && (gifUrl.startsWith("http://") || gifUrl.startsWith("https://"))) {
        const m = { from: state.user, text: gifUrl, ts: Date.now(), clientId: cid, pending: true, mediaType: "gif" };
        if (typeof replyingTo !== 'undefined' && replyingTo) {
            let resolvedMedia = replyingTo.mediaSrc || null;
            if (resolvedMedia && (resolvedMedia.startsWith('blob:') || resolvedMedia.startsWith('data:'))) {
                resolvedMedia = await BlobUrlCache.resolveForReply(resolvedMedia);
            }
            m.replyTo = {
                id: replyingTo.id || undefined,
                from: replyingTo.from,
                text: (replyingTo.text || '').slice(0, 100),
                media: resolvedMedia || undefined,
                mediaType: replyingTo.mediaType || undefined
            };
            clearReply();
        }
        if (state.activeChatId === targetChatId) {
            renderMessages([m], true);
            scrollToBottom(true);
        }
        ChatCache.appendMessages(targetChatId, [m]).catch(() => { });
        const sendPayload = { text: gifUrl, clientId: cid, mediaType: "gif" };
        if (m.replyTo) sendPayload.replyTo = m.replyTo;
        apiFetch(`/api/chat/${targetChatId}/send`, {
            method: "POST",
            body: JSON.stringify(sendPayload)
        }).then(s => {
            if (s && s.id) {
                if (state.activeChatId === targetChatId) {
                    const msgEl = document.querySelector(`[data-client-id="${cid}"]`);
                    if (msgEl) {
                        msgEl.dataset.id = s.id;
                        msgEl.classList.remove("pending");
                        const tickEl = msgEl.querySelector(".ticks");
                        if (tickEl) { tickEl.className = 'ticks'; tickEl.innerHTML = TICK_ICONS.sent; }
                    }
                }
                ChatCache.appendMessages(targetChatId, [{ ...s, pending: false }]).catch(() => { });
            }
        }).catch(err => console.error("GIF send failed:", err));
    }
}

// GIF Event Listeners
document.getElementById('gif-btn')?.addEventListener('click', (e) => {
    if (Date.now() - _lastLowerBarTapTs < 400) {
        e.stopPropagation();
        e.preventDefault();
        return;
    }
    openGifPicker();
});

document.getElementById('gif-close-btn')?.addEventListener('click', (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (typeof window._markModalClosed === 'function') window._markModalClosed();
    closeGifPicker(true, false);
});

const gifSearchInputEl = document.getElementById('gif-search-input');
const gifSearchClearEl = document.getElementById('gif-search-clear');

gifSearchInputEl?.addEventListener('input', (e) => {
    clearTimeout(gifSearchTimeout);
    if (gifAbortController) gifAbortController.abort();
    const query = (e.target.value || '').trim();
    if (gifSearchClearEl) {
        if (query) gifSearchClearEl.classList.remove('hidden');
        else gifSearchClearEl.classList.add('hidden');
    }
    gifSearchTimeout = setTimeout(() => searchKlipyGifs(query), 300);
});

gifSearchClearEl?.addEventListener('click', (e) => {
    e.preventDefault();
    if (gifSearchInputEl) {
        gifSearchInputEl.value = '';
        gifSearchInputEl.focus();
    }
    gifSearchClearEl.classList.add('hidden');
    searchKlipyGifs('');
});

// =========================================
// Apple macOS Style Attachment Menu & Dedicated Media Preview
// =========================================
let pendingMediaData = null;

function showImagePicker() {
    const picker = document.getElementById('image-picker-modal');
    if (!picker) return;
    if (!picker.classList.contains('hidden')) {
        closeImagePicker();
        return;
    }
    if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
    }
    picker.classList.remove('hidden');
}

function closeImagePicker() {
    const picker = document.getElementById('image-picker-modal');
    if (picker) picker.classList.add('hidden');
}

function openImagePicker() {
    showImagePicker();
}

let pendingMediaList = [];
let pendingMediaIndex = 0;

function updateMediaModalViewport() {
    const modal = document.getElementById('media-preview-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (window.visualViewport) {
        const vv = window.visualViewport;
        modal.style.height = `${vv.height}px`;
        modal.style.top = `${vv.offsetTop}px`;
        modal.style.left = `${vv.offsetLeft}px`;
        modal.style.width = `${vv.width}px`;
    }
}

function openMediaPreview(items, initialIndex = 0) {
    if (!items || items.length === 0) return;
    pendingMediaList = Array.isArray(items) ? [...items] : [items];
    pendingMediaIndex = Math.max(0, Math.min(initialIndex, pendingMediaList.length - 1));

    closeImagePicker(false);

    const modal = document.getElementById('media-preview-modal');
    if (!modal) return;

    renderMediaPreviewCurrent(pendingMediaIndex);
    renderMediaTray();

    modal.classList.remove('hidden');
    updateMediaModalViewport();
    BackNavManager.push('media-preview', () => {
        closeMediaPreview(true);
    });
}

function closeMediaPreview(fromPop = false) {
    if (!fromPop && BackNavManager.has('media-preview')) {
        BackNavManager.pop('media-preview');
    }
    const modal = document.getElementById('media-preview-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.height = '';
        modal.style.top = '';
        modal.style.left = '';
        modal.style.width = '';
    }

    const imgEl = document.getElementById('media-preview-image');
    const audioEl = document.getElementById('media-preview-audio');
    const videoEl = document.getElementById('media-preview-video');
    if (imgEl) { imgEl.src = ''; imgEl.classList.add('hidden'); }
    if (audioEl) { audioEl.pause(); audioEl.src = ''; audioEl.classList.add('hidden'); }
    if (videoEl) { videoEl.pause(); videoEl.src = ''; videoEl.classList.add('hidden'); }

    const captionInp = document.getElementById('media-caption-input');
    if (captionInp) captionInp.value = '';
    pendingMediaList = [];
    pendingMediaIndex = 0;
}

function renderMediaPreviewCurrent(index) {
    if (!pendingMediaList || pendingMediaList.length === 0) {
        closeMediaPreview();
        return;
    }
    pendingMediaIndex = Math.max(0, Math.min(index, pendingMediaList.length - 1));
    const item = pendingMediaList[pendingMediaIndex];
    if (!item) return;

    const modal = document.getElementById('media-preview-modal');
    if (!modal) return;

    const titleEl = modal.querySelector('.media-preview-title');
    if (titleEl) {
        if (pendingMediaList.length > 1) {
            titleEl.textContent = `${pendingMediaIndex + 1} of ${pendingMediaList.length}`;
        } else {
            if (item.type === 'gif') titleEl.textContent = 'Send GIF';
            else if (item.type === 'image') titleEl.textContent = 'Send Photo';
            else if (item.type === 'video') titleEl.textContent = 'Send Video';
            else if (item.type === 'audio') titleEl.textContent = 'Send Audio';
            else titleEl.textContent = 'Send Media';
        }
    }

    const deleteBtn = document.getElementById('media-preview-delete-btn');
    if (deleteBtn) {
        deleteBtn.style.display = pendingMediaList.length > 1 ? 'flex' : 'none';
    }

    const imgEl = document.getElementById('media-preview-image');
    const audioEl = document.getElementById('media-preview-audio');
    const videoEl = document.getElementById('media-preview-video');

    if (imgEl) { imgEl.classList.add('hidden'); imgEl.src = ''; }
    if (audioEl) { audioEl.classList.add('hidden'); audioEl.src = ''; audioEl.pause(); }
    if (videoEl) { videoEl.classList.add('hidden'); videoEl.src = ''; videoEl.pause(); }

    if ((item.type === 'image' || item.type === 'gif') && imgEl) {
        imgEl.src = item.dataUrl;
        imgEl.classList.remove('hidden');
    } else if (item.type === 'video' && videoEl) {
        videoEl.src = item.dataUrl;
        videoEl.classList.remove('hidden');
        videoEl.play().catch(() => {});
    } else if (item.type === 'audio' && audioEl) {
        audioEl.src = item.dataUrl;
        audioEl.classList.remove('hidden');
        audioEl.play().catch(() => {});
    }

    // Update active highlight on tray thumbnails
    const trayItems = document.querySelectorAll('.media-tray-item');
    trayItems.forEach((el, i) => {
        el.classList.toggle('active', i === pendingMediaIndex);
        if (i === pendingMediaIndex) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    });
}

function renderMediaTray() {
    const tray = document.getElementById('media-preview-tray');
    const itemsContainer = document.getElementById('media-tray-items');
    if (!tray || !itemsContainer) return;

    if (pendingMediaList.length <= 1) {
        tray.classList.add('hidden');
        itemsContainer.innerHTML = '';
        return;
    }

    tray.classList.remove('hidden');
    itemsContainer.innerHTML = '';

    pendingMediaList.forEach((item, idx) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = `media-tray-item ${idx === pendingMediaIndex ? 'active' : ''}`;
        
        let previewHtml = '';
        if (item.type === 'image' || item.type === 'gif') {
            previewHtml = `<img src="${item.dataUrl}" alt="Thumb">`;
        } else if (item.type === 'video') {
            previewHtml = `<video src="${item.dataUrl}" muted preload="metadata"></video><span class="media-tray-badge">\u25B6</span>`;
        } else if (item.type === 'audio') {
            previewHtml = `<div class="media-tray-audio-badge"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>`;
        }

        itemDiv.innerHTML = `
            ${previewHtml}
            <button type="button" class="media-tray-item-remove" data-index="${idx}" aria-label="Remove item">\u2715</button>
        `;

        itemDiv.addEventListener('click', (e) => {
            if (e.target.closest('.media-tray-item-remove')) return;
            renderMediaPreviewCurrent(idx);
        });

        const removeBtn = itemDiv.querySelector('.media-tray-item-remove');
        removeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            removeMediaItem(idx);
        });

        itemsContainer.appendChild(itemDiv);
    });
}

function removeMediaItem(index) {
    if (!pendingMediaList || index < 0 || index >= pendingMediaList.length) return;
    pendingMediaList.splice(index, 1);
    if (pendingMediaList.length === 0) {
        closeMediaPreview();
    } else {
        if (pendingMediaIndex >= pendingMediaList.length) {
            pendingMediaIndex = pendingMediaList.length - 1;
        }
        renderMediaPreviewCurrent(pendingMediaIndex);
        renderMediaTray();
    }
}

// Compress image to max ~250KB
async function compressImage(file, maxSizeKB = 250) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let { width, height } = img;

                const maxDim = 1280;
                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round(height * maxDim / width);
                        width = maxDim;
                    } else {
                        width = Math.round(width * maxDim / height);
                        height = maxDim;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                const maxBytes = maxSizeKB * 1024 * 1.37;
                let quality = 0.8;
                let dataUrl = canvas.toDataURL('image/jpeg', quality);

                // Accelerated step-down: calculate reduction directly instead of 8 sequential while iterations
                if (dataUrl.length > maxBytes) {
                    const ratio = maxBytes / dataUrl.length;
                    quality = Math.max(0.15, Math.min(0.65, quality * ratio));
                    dataUrl = canvas.toDataURL('image/jpeg', quality);
                }

                resolve(dataUrl);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function processFile(file) {
    if (!file) return null;
    const isGif = file.type === 'image/gif' || file.name?.toLowerCase().endsWith('.gif');
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(file.name);
    const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac)$/i.test(file.name);

    if (isGif) {
        if (file.size > 50 * 1024 * 1024) return null;
        const dataUrl = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = e => res(e.target.result);
            r.onerror = err => rej(err);
            r.readAsDataURL(file);
        });
        return { dataUrl, type: 'gif', fileName: file.name, isGif: true };
    } else if (isImage) {
        const dataUrl = await compressImage(file);
        return { dataUrl, type: 'image', fileName: file.name };
    } else if (isVideo) {
        if (file.size > 100 * 1024 * 1024) {
            alert(`Video "${file.name}" exceeds 100MB.`);
            return null;
        }
        const dataUrl = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = e => res(e.target.result);
            r.onerror = err => rej(err);
            r.readAsDataURL(file);
        });
        return { dataUrl, type: 'video', fileName: file.name };
    } else if (isAudio) {
        if (file.size > 50 * 1024 * 1024) {
            alert(`Audio "${file.name}" exceeds 50MB.`);
            return null;
        }
        const dataUrl = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = e => res(e.target.result);
            r.onerror = err => rej(err);
            r.readAsDataURL(file);
        });
        return { dataUrl, type: 'audio', fileName: file.name };
    }
    return null;
}

async function handleFiles(files, append = false) {
    if (!files || files.length === 0) return;
    const fileArr = Array.from(files);
    
    const processed = [];
    for (const f of fileArr) {
        try {
            const item = await processFile(f);
            if (item) processed.push(item);
        } catch (e) {
            console.error("Error processing file:", f.name, e);
        }
    }

    if (processed.length === 0) return;

    if (append && pendingMediaList && pendingMediaList.length > 0) {
        const startIndex = pendingMediaList.length;
        pendingMediaList.push(...processed);
        renderMediaPreviewCurrent(startIndex);
        renderMediaTray();
    } else {
        openMediaPreview(processed, 0);
    }
}

async function sendMediaPreview() {
    if (!pendingMediaList || pendingMediaList.length === 0 || !state.activeChatId) return;
    const targetChatId = state.activeChatId;

    const listToSend = [...pendingMediaList];
    const captionInp = document.getElementById('media-caption-input');
    const caption = captionInp ? captionInp.value.trim() : '';

    closeMediaPreview();

    for (let i = 0; i < listToSend.length; i++) {
        const item = listToSend[i];
        const cid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // Route through sendMediaPayloadWithProgress for chunking, progress bar, speed & bytes
        sendMediaPayloadWithProgress(item.dataUrl, cid, item.isGif ? 'gif' : item.type).catch(e => {
            console.error("Media preview send error:", e);
        });

        if (i < listToSend.length - 1) {
            await new Promise(r => setTimeout(r, 60));
        }
    }

    if (caption) {
        setTimeout(async () => {
            const capCid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const capM = { from: state.user, text: caption, ts: Date.now(), clientId: capCid, pending: true };
            if (state.activeChatId === targetChatId) {
                renderMessages([capM], true);
                scrollToBottom(true);
            }
            ChatCache.appendMessages(targetChatId, [capM]).catch(() => {});
            try {
                const res = await apiFetch(`/api/chat/${targetChatId}/send`, {
                    method: 'POST',
                    body: JSON.stringify({ text: caption, clientId: capCid })
                });
                if (res && res.id) {
                    if (state.activeChatId === targetChatId) {
                        const el = document.querySelector(`[data-client-id="${capCid}"]`);
                        if (el) {
                            el.dataset.id = res.id;
                            el.classList.remove('pending');
                            const tickEl = el.querySelector('.ticks');
                            if (tickEl) { tickEl.className = 'ticks'; tickEl.innerHTML = TICK_ICONS.sent; }
                        }
                    }
                    ChatCache.appendMessages(targetChatId, [{ ...res, pending: false }]).catch(() => {});
                }
            } catch (err) {
                console.error("Caption send error:", err);
            }
        }, 120);
    }
}

// =========================================
// Image Viewer with Zoom + Download
// =========================================
function openLightbox(src) {
    const activeInp = document.getElementById('message-input');
    if (activeInp) activeInp.blur();
    document.body.classList.remove('keyboard-open');

    let lb = document.getElementById('image-lightbox');
    if (lb) lb.remove();

    lb = document.createElement('div');
    lb.id = 'image-lightbox';
    lb.className = 'image-lightbox';

    const SVG_DOWNLOAD = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none" style="pointer-events:none;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
    const SVG_CHECK = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none" style="pointer-events:none;"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    const SVG_CLOSE = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none" style="pointer-events:none;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    const SVG_ERROR = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none" style="pointer-events:none;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'lightbox-toolbar';
    toolbar.innerHTML = `
        <button class="lb-btn lb-download" title="Download" aria-label="Download image">${SVG_DOWNLOAD}</button>
        <button class="lb-btn lb-close" title="Close" aria-label="Close lightbox">${SVG_CLOSE}</button>
    `;
    lb.appendChild(toolbar);

    // Resolve original base64 if it was a blob
    const resolvedSrc = (src && src.startsWith('blob:')) ? (BlobUrlCache._reverseCache.get(src) || src) : src;

    // Image container for zoom/pan
    const imgWrap = document.createElement('div');
    imgWrap.className = 'lb-img-wrap';
    const img = document.createElement('img');
    img.src = resolvedSrc;
    img.alt = 'Full Image';
    img.draggable = false;
    imgWrap.appendChild(img);
    lb.appendChild(imgWrap);

    document.body.appendChild(lb);
    BackNavManager.push('lightbox', () => {
        closeLightbox(true);
    });

    toolbar.querySelector('.lb-close')?.addEventListener('click', () => {
        closeLightbox(false);
    });

    // Zoom & Tap state
    let scale = 1, posX = 0, posY = 0;
    let startDist = 0, startScale = 1;
    let isDragging = false, dragStartX = 0, dragStartY = 0, startPosX = 0, startPosY = 0;
    let didMove = false;
    let lastTapTime = 0, lastTapX = 0, lastTapY = 0;

    function applyTransform(withTransition = false) {
        if (withTransition) {
            img.style.transition = 'transform 0.25s cubic-bezier(0.2, 0, 0.2, 1)';
            setTimeout(() => { if (img) img.style.transition = ''; }, 260);
        } else {
            img.style.transition = 'none';
        }
        img.style.transform = `translate(${posX}px, ${posY}px) scale(${scale})`;
    }

    function resetZoom(animated = true) {
        scale = 1; posX = 0; posY = 0;
        applyTransform(animated);
    }

    // Double-tap to zoom, single-tap to close
    imgWrap.addEventListener('click', (e) => {
        if (e.target.closest('.lightbox-toolbar')) return;
        if (didMove) {
            didMove = false;
            return;
        }

        const now = Date.now();
        const tapX = e.clientX;
        const tapY = e.clientY;
        const timeDiff = now - lastTapTime;
        const distDiff = Math.hypot(tapX - lastTapX, tapY - lastTapY);

        if (timeDiff < 300 && distDiff < 40) {
            // Double-tap detected: cancel single-tap close
            if (window._activeLbTapTimer) {
                clearTimeout(window._activeLbTapTimer);
                window._activeLbTapTimer = null;
            }
            lastTapTime = 0;

            if (scale > 1.05) {
                resetZoom(true);
            } else {
                scale = 2.5;
                const rect = img.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const offsetX = tapX - centerX;
                const offsetY = tapY - centerY;
                posX = -offsetX * (scale - 1);
                posY = -offsetY * (scale - 1);
                applyTransform(true);
            }
        } else {
            // Potential single tap
            lastTapTime = now;
            lastTapX = tapX;
            lastTapY = tapY;

            if (window._activeLbTapTimer) clearTimeout(window._activeLbTapTimer);

            if (scale <= 1.05) {
                window._activeLbTapTimer = setTimeout(() => {
                    window._activeLbTapTimer = null;
                    closeLightbox(false);
                }, 280);
            }
        }
    });

    // Pinch to zoom & pan
    imgWrap.addEventListener('touchstart', (e) => {
        didMove = false;
        if (e.touches.length === 2) {
            e.preventDefault();
            if (window._activeLbTapTimer) {
                clearTimeout(window._activeLbTapTimer);
                window._activeLbTapTimer = null;
            }
            lastTapTime = 0;
            startDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            startScale = scale;
        } else if (e.touches.length === 1) {
            dragStartX = e.touches[0].clientX;
            dragStartY = e.touches[0].clientY;
            startPosX = posX;
            startPosY = posY;
            if (scale > 1.05) {
                isDragging = true;
            }
        }
    }, { passive: false });

    imgWrap.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
            e.preventDefault();
            didMove = true;
            const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            scale = Math.min(5, Math.max(0.5, startScale * (dist / startDist)));
            applyTransform(false);
        } else if (e.touches.length === 1 && isDragging && scale > 1.05) {
            e.preventDefault();
            const dx = e.touches[0].clientX - dragStartX;
            const dy = e.touches[0].clientY - dragStartY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                didMove = true;
            }
            posX = startPosX + dx;
            posY = startPosY + dy;
            applyTransform(false);
        }
    }, { passive: false });

    imgWrap.addEventListener('touchend', () => {
        isDragging = false;
        if (scale < 1) { resetZoom(true); }
    });

    // Download button
    toolbar.querySelector('.lb-download').onclick = async (e) => {
        e.stopPropagation();
        const btn = toolbar.querySelector('.lb-download');
        try {
            let mimeType = 'image/jpeg';
            let ext = 'jpg';
            if (src.startsWith('data:')) {
                mimeType = src.split(',')[0].split(':')[1].split(';')[0];
                ext = mimeType.split('/')[1] || 'jpg';
            } else if (src.includes('.gif') || src.includes('tenor.com') || src.includes('giphy.com')) {
                mimeType = 'image/gif';
                ext = 'gif';
            }
            const fileName = `${Date.now()}${Math.floor(Math.random()*9000+1000)}.${ext}`;

            // Resolve blob/remote URLs to base64 for native saving
            let base64ToSave = resolvedSrc;
            if (base64ToSave.startsWith('blob:') || base64ToSave.startsWith('http://') || base64ToSave.startsWith('https://')) {
                const response = await fetch(base64ToSave);
                const blob = await response.blob();
                base64ToSave = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
            }

            // Use native plugin on Capacitor (saves directly to gallery)
            if (IS_CAPACITOR && window.Capacitor?.Plugins?.SaveImage) {
                const result = await window.Capacitor.Plugins.SaveImage.saveToGallery({
                    base64: base64ToSave,
                    fileName: fileName,
                    mimeType: mimeType
                });
                if (result.saved) {
                    btn.innerHTML = SVG_CHECK;
                    setTimeout(() => { btn.innerHTML = SVG_DOWNLOAD; }, 2000);
                    return;
                }
            }

            // Fallback for combined-app (FastChat runs in separate WebView with JS bridge)
            if (window.StealthNotify?.saveBase64Image) {
                const saved = window.StealthNotify.saveBase64Image(base64ToSave, fileName, mimeType);
                if (saved) {
                    btn.innerHTML = SVG_CHECK;
                    setTimeout(() => { btn.innerHTML = SVG_DOWNLOAD; }, 2000);
                    return;
                }
            }

            // Browser fallback: blob download
            let blob;
            if (base64ToSave.startsWith('data:')) {
                const byteString = atob(base64ToSave.split(',')[1]);
                const ab = new ArrayBuffer(byteString.length);
                const ia = new Uint8Array(ab);
                for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
                blob = new Blob([ab], { type: mimeType });
            } else {
                const res = await fetch(base64ToSave);
                blob = await res.blob();
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            btn.innerHTML = SVG_CHECK;
            setTimeout(() => { btn.innerHTML = SVG_DOWNLOAD; }, 2000);
        } catch (err) {
            console.error('Download failed:', err);
            btn.innerHTML = SVG_ERROR;
            setTimeout(() => { btn.innerHTML = SVG_DOWNLOAD; }, 2000);
        }
    };

    window._activeLbEscHandler = (e) => {
        if (e.key === 'Escape') {
            closeLightbox(false);
        }
    };
    document.addEventListener('keydown', window._activeLbEscHandler);
}

// =========================================
// Multi-Image Queue Send (up to 25)
// =========================================
let _imageQueueActive = false;

function showQueueBar(current, total) {
    let bar = document.getElementById('image-queue-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'image-queue-bar';
        bar.className = 'image-queue-bar';
        const chatHeader = document.querySelector('.chat-header');
        if (chatHeader) chatHeader.after(bar);
        else document.body.appendChild(bar);
    }
    const pct = Math.round((current / total) * 100);
    bar.innerHTML = `
        <div class="iqb-text">ðŸ“· Sending ${current}/${total} images...</div>
        <div class="iqb-progress"><div class="iqb-fill" style="width:${pct}%"></div></div>
    `;
    bar.classList.remove('hidden');
}

function hideQueueBar() {
    const bar = document.getElementById('image-queue-bar');
    if (bar) bar.classList.add('hidden');
}

async function sendImageQueue(files) {
    if (_imageQueueActive || !state.activeChatId) return;
    const targetChatId = state.activeChatId;
    _imageQueueActive = true;
    const fileList = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, 25);
    const total = fileList.length;
    if (total === 0) { _imageQueueActive = false; return; }

    let sent = 0, failed = 0;
    showQueueBar(0, total);

    for (let i = 0; i < fileList.length; i++) {
        showQueueBar(i + 1, total);
        try {
            const file = fileList[i];
            const isGif = file.type === 'image/gif' || file.name?.toLowerCase().endsWith('.gif');
            
            let fileData;
            if (isGif) {
                if (file.size > 50 * 1024 * 1024) {
                    console.warn(`Skipping GIF "${file.name}" because it exceeds 50MB limit.`);
                    failed++;
                    continue;
                }
                fileData = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (e) => resolve(e.target.result);
                    reader.onerror = (err) => reject(err);
                    reader.readAsDataURL(file);
                });
            } else {
                fileData = await compressImage(file);
            }

            const cid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const m = { from: state.user, text: fileData, ts: Date.now(), clientId: cid, pending: true };

            if (state.activeChatId === targetChatId) {
                renderMessages([m], true);
                scrollToBottom(true);
            }
            ChatCache.appendMessages(targetChatId, [m]).catch(() => {});

            let success = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const s = await apiFetch(`/api/chat/${targetChatId}/send`, {
                        method: 'POST',
                        body: JSON.stringify({ text: fileData, clientId: cid })
                    });
                    if (s && s.id) {
                        if (state.activeChatId === targetChatId) {
                            const msgEl = document.querySelector(`[data-client-id="${cid}"]`);
                            if (msgEl) {
                                msgEl.dataset.id = s.id;
                                msgEl.classList.remove('pending');
                                const tickEl = msgEl.querySelector('.ticks');
                                if (tickEl) { tickEl.className = 'ticks'; tickEl.innerHTML = TICK_ICONS.sent; }
                            }
                        }
                        ChatCache.appendMessages(targetChatId, [{ ...s, pending: false }]).catch(() => {});
                        success = true;
                        sent++;
                        break;
                    }
                } catch (e) {
                    console.warn(`Image ${i+1} attempt ${attempt+1} failed:`, e);
                    if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
                }
            }
            if (!success) {
                failed++;
                if (state.activeChatId === targetChatId) {
                    const msgEl = document.querySelector(`[data-client-id="${cid}"]`);
                    if (msgEl) {
                        msgEl.classList.remove('pending');
                        const tickEl = msgEl.querySelector('.ticks');
                        if (tickEl) { tickEl.textContent = '!'; tickEl.style.color = '#ff4444'; }
                    }
                }
            }
        } catch (e) {
            console.error(`Image ${i+1} processing/compression failed:`, e);
            failed++;
        }
    }

    hideQueueBar();
    _imageQueueActive = false;
    if (failed > 0) console.warn(`Image queue: ${sent} sent, ${failed} failed`);
}

// Attachment Popover & Media Preview Event Listeners
document.getElementById('img-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (Date.now() - _lastLowerBarTapTs < 400) {
        e.preventDefault();
        return;
    }
    showImagePicker();
});

// Dismiss attachment popover on outside click
document.addEventListener('click', (e) => {
    const popover = document.getElementById('image-picker-modal');
    const imgBtn = document.getElementById('img-btn');
    if (popover && !popover.classList.contains('hidden')) {
        if (!popover.contains(e.target) && e.target !== imgBtn && !imgBtn?.contains(e.target)) {
            closeImagePicker();
        }
    }
});
document.getElementById('image-picker-close')?.addEventListener('click', closeImagePicker);
document.getElementById('camera-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = document.getElementById('camera-input');
    if (input) {
        input.value = '';
        input.click();
    }
    closeImagePicker();
});
document.getElementById('gallery-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = document.getElementById('gallery-input');
    if (input) {
        input.value = '';
        input.click();
    }
    closeImagePicker();
});
document.getElementById('video-file-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = document.getElementById('video-file-input');
    if (input) {
        input.value = '';
        input.click();
    }
    closeImagePicker();
});
document.getElementById('audio-file-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = document.getElementById('audio-file-input');
    if (input) {
        input.value = '';
        input.click();
    }
    closeImagePicker();
});

document.getElementById('camera-input')?.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files);
    e.target.value = '';
});
document.getElementById('gallery-input')?.addEventListener('change', (e) => {
    const isAppend = e.target._isAppend || false;
    e.target._isAppend = false;
    if (e.target.files && e.target.files.length > 0) {
        handleFiles(e.target.files, isAppend);
    }
    e.target.value = '';
});
document.getElementById('video-file-input')?.addEventListener('change', (e) => {
    const isAppend = e.target._isAppend || false;
    e.target._isAppend = false;
    if (e.target.files && e.target.files.length > 0) {
        handleFiles(e.target.files, isAppend);
    }
    e.target.value = '';
});
document.getElementById('audio-file-input')?.addEventListener('change', (e) => {
    const isAppend = e.target._isAppend || false;
    e.target._isAppend = false;
    if (e.target.files && e.target.files.length > 0) {
        handleFiles(e.target.files, isAppend);
    }
    e.target.value = '';
});

// Dedicated Media Preview Modal Listeners
document.getElementById('media-preview-cancel')?.addEventListener('click', closeMediaPreview);
document.querySelector('.media-preview-backdrop')?.addEventListener('click', closeMediaPreview);
document.getElementById('media-preview-delete-btn')?.addEventListener('click', () => {
    removeMediaItem(pendingMediaIndex);
});
document.getElementById('media-tray-add-btn')?.addEventListener('click', () => {
    const galInput = document.getElementById('gallery-input');
    if (galInput) {
        galInput._isAppend = true;
        galInput.click();
    }
});
document.getElementById('media-preview-send-btn')?.addEventListener('click', sendMediaPreview);
document.getElementById('media-caption-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendMediaPreview();
    }
});

window.visualViewport?.addEventListener('resize', updateMediaModalViewport);
window.visualViewport?.addEventListener('scroll', updateMediaModalViewport);

// Close Image Attachment Popover when clicking outside
document.addEventListener('click', (e) => {
    const picker = document.getElementById('image-picker-modal');
    const imgBtn = document.getElementById('img-btn');
    if (picker && !picker.classList.contains('hidden')) {
        if (!picker.contains(e.target) && !imgBtn?.contains(e.target)) {
            closeImagePicker();
        }
    }
});

// Click on image/gif in chat to open lightbox (only if not swiping)
document.getElementById('messages-container')?.addEventListener('click', (e) => {
    if (typeof _lastSwipeEndTime === 'number' && Date.now() - _lastSwipeEndTime < 350) return;
    if (e.target.classList.contains('message-image') || e.target.classList.contains('message-gif')) {
        openLightbox(e.target.src);
    }
});

// =========================================
// Voice Notes Feature
// =========================================
let mediaRecorder = null;
let audioChunks = [];
let voiceRecordingTimer = null;
let voiceRecordingSeconds = 0;

async function startVoiceRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        // Try WebM/Opus first, fallback to default
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';

        mediaRecorder = new MediaRecorder(stream, { mimeType });
        audioChunks = [];
        voiceRecordingSeconds = 0;

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start(100); // Collect data every 100ms

        // Show recording UI
        document.getElementById('voice-modal').classList.remove('hidden');
        document.getElementById('voice-btn')?.classList.add('recording');
        document.getElementById('action-btn')?.classList.add('recording');
        BackNavManager.push('voice-modal', () => {
            cancelVoiceRecording(true);
        });

        // Start timer
        updateVoiceTimer();
        voiceRecordingTimer = setInterval(() => {
            voiceRecordingSeconds++;
            updateVoiceTimer();

            // Max 60 seconds
            if (voiceRecordingSeconds >= 60) {
                sendVoiceNote();
            }
        }, 1000);

    } catch (err) {
        console.error('Microphone access denied:', err);
        alert('Please allow microphone access to record voice notes.');
    }
}

function updateVoiceTimer() {
    const mins = Math.floor(voiceRecordingSeconds / 60);
    const secs = voiceRecordingSeconds % 60;
    document.querySelector('.voice-timer').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
}

function stopVoiceRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    clearInterval(voiceRecordingTimer);
    document.getElementById('voice-modal').classList.add('hidden');
    document.getElementById('voice-btn')?.classList.remove('recording');
    document.getElementById('action-btn')?.classList.remove('recording');
}

function cancelVoiceRecording(fromPop = false) {
    if (!fromPop && BackNavManager.has('voice-modal')) {
        BackNavManager.pop('voice-modal');
    }
    stopVoiceRecording();
    audioChunks = [];
}

async function sendVoiceNote() {
    if (!mediaRecorder || !state.activeChatId) return;

    // Stop recording
    mediaRecorder.stop();
    clearInterval(voiceRecordingTimer);

    // Wait for final data
    await new Promise(resolve => setTimeout(resolve, 200));

    if (audioChunks.length === 0) {
        document.getElementById('voice-modal').classList.add('hidden');
        document.getElementById('voice-btn')?.classList.remove('recording');
        document.getElementById('action-btn')?.classList.remove('recording');
        return;
    }

    // Create blob and convert to Base64
    const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
    const reader = new FileReader();

    reader.onloadend = () => {
        const base64Audio = reader.result;

        // Hide modal
        document.getElementById('voice-modal').classList.add('hidden');
        document.getElementById('voice-btn')?.classList.remove('recording');
        document.getElementById('action-btn')?.classList.remove('recording');

        const targetChatId = state.activeChatId;
        if (!targetChatId) return;

        // Send as message
        const cid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const duration = voiceRecordingSeconds;
        const m = { from: state.user, text: base64Audio, ts: Date.now(), clientId: cid, pending: true, duration };

        if (state.activeChatId === targetChatId) {
            renderMessages([m], true);
            scrollToBottom(true);
        }

        // Route voice note through sendMediaPayloadWithProgress for progress bar and chunking
        sendMediaPayloadWithProgress(base64Audio, cid, 'audio', { duration: Math.round(duration) });

        audioChunks = [];
    };

    reader.readAsDataURL(audioBlob);
}

// Voice Note Event Listeners
document.getElementById('voice-btn')?.addEventListener('click', startVoiceRecording);
document.getElementById('voice-cancel')?.addEventListener('click', cancelVoiceRecording);
document.getElementById('voice-send')?.addEventListener('click', sendVoiceNote);

// Video Download Button (delegated)
document.getElementById('messages-container')?.addEventListener('click', (e) => {
    const dlBtn = e.target.closest('.video-dl-btn');
    if (!dlBtn) return;
    const video = dlBtn.closest('.video-message')?.querySelector('video source, video');
    if (!video) return;
    const src = video.src || video.closest('video')?.querySelector('source')?.src;
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    if (src.startsWith('http://') || src.startsWith('https://')) {
        a.target = '_blank';
    }
    a.download = 'video_' + Date.now() + '.mp4';
    document.body.appendChild(a);
    a.click();
    a.remove();
});

// Audio Download Button (delegated)
document.getElementById('messages-container')?.addEventListener('click', (e) => {
    const dlBtn = e.target.closest('.voice-dl-btn');
    if (!dlBtn) return;
    const audio = dlBtn.closest('.voice-message')?.querySelector('audio');
    if (!audio) return;
    const src = audio.src || audio.dataset.src;
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = 'audio_' + Date.now() + (src.includes('audio/mpeg') || src.includes('audio/mp3') ? '.mp3' : '.webm');
    document.body.appendChild(a);
    a.click();
    a.remove();
});

// Helper to seek voice note audio and update UI
function seekVoiceAudio(progressContainer, clientX) {
    const voiceMessage = progressContainer.closest('.voice-message');
    if (!voiceMessage) return;
    const audio = voiceMessage.querySelector('audio');
    if (!audio) return;

    // Ensure audio src is loaded
    if ((!audio.src || audio.src === window.location.href) && audio.dataset.src) {
        audio.src = audio.dataset.src;
    }

    const rect = progressContainer.getBoundingClientRect();
    if (rect.width <= 0) return;
    const clickX = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const pct = clickX / rect.width;

    const rawMsgDuration = parseFloat(voiceMessage.dataset.duration || '0');
    const duration = (isFinite(audio.duration) && audio.duration > 0)
        ? audio.duration
        : (isFinite(rawMsgDuration) && rawMsgDuration > 0 ? rawMsgDuration : 0);

    const progressBar = voiceMessage.querySelector('.voice-progress-bar');
    if (progressBar) progressBar.style.width = (pct * 100) + '%';

    if (duration > 0) {
        audio.currentTime = pct * duration;
        const durationEl = voiceMessage.querySelector('.voice-duration');
        if (durationEl) {
            const mins = Math.floor(audio.currentTime / 60);
            const secs = Math.floor(audio.currentTime % 60);
            durationEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        }
    }
}

let _activeVoiceScrub = null;

// Voice audio scrubber seeking (delegated pointer events)
document.getElementById('messages-container')?.addEventListener('pointerdown', (e) => {
    const progressContainer = e.target.closest('.voice-progress-container');
    if (!progressContainer) return;

    e.stopPropagation();
    _activeVoiceScrub = progressContainer;
    seekVoiceAudio(progressContainer, e.clientX);

    try {
        progressContainer.setPointerCapture(e.pointerId);
    } catch (_) {}
});

document.getElementById('messages-container')?.addEventListener('pointermove', (e) => {
    if (!_activeVoiceScrub) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    seekVoiceAudio(_activeVoiceScrub, e.clientX);
});

const _endVoiceScrub = (e) => {
    if (_activeVoiceScrub) {
        try {
            _activeVoiceScrub.releasePointerCapture(e.pointerId);
        } catch (_) {}
        _activeVoiceScrub = null;
    }
};
document.getElementById('messages-container')?.addEventListener('pointerup', _endVoiceScrub);
document.getElementById('messages-container')?.addEventListener('pointercancel', _endVoiceScrub);

// Audio Player Controls (delegated)
document.getElementById('messages-container')?.addEventListener('click', (e) => {
    const playBtn = e.target.closest('.voice-play-btn');
    if (!playBtn) return;

    const voiceMessage = playBtn.closest('.voice-message');
    const audio = voiceMessage.querySelector('audio');
    const progressBar = voiceMessage.querySelector('.voice-progress-bar');
    const durationEl = voiceMessage.querySelector('.voice-duration');

    if (playBtn.dataset.playing === 'true') {
        // Pause
        audio.pause();
        playBtn.dataset.playing = 'false';
        playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    } else {
        // Stop any other playing audio
        document.querySelectorAll('.voice-play-btn[data-playing="true"]').forEach(btn => {
            btn.dataset.playing = 'false';
            btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
            btn.closest('.voice-message').querySelector('audio').pause();
        });

        // Play â€” lazy-load src from data-src on first play
        if ((!audio.src || audio.src === window.location.href) && audio.dataset.src) {
            audio.src = audio.dataset.src;
        }
        audio.play();
        playBtn.dataset.playing = 'true';
        playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

        // Update progress
        audio.ontimeupdate = () => {
            if (isFinite(audio.duration) && audio.duration > 0) {
                const pct = (audio.currentTime / audio.duration) * 100;
                progressBar.style.width = pct + '%';
            }
            const mins = Math.floor(audio.currentTime / 60);
            const secs = Math.floor(audio.currentTime % 60);
            durationEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        };

        audio.onended = () => {
            playBtn.dataset.playing = 'false';
            playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
            progressBar.style.width = '0%';
            const totalDur = (isFinite(audio.duration) && audio.duration > 0) ? audio.duration : parseFloat(voiceMessage.dataset.duration || '0');
            if (totalDur > 0) {
                const mins = Math.floor(totalDur / 60);
                const secs = Math.floor(totalDur % 60);
                durationEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
            }
        };
    }
});

// Show audio duration on load
document.getElementById('messages-container')?.addEventListener('loadedmetadata', (e) => {
    if (e.target.tagName === 'AUDIO') {
        const voiceMessage = e.target.closest('.voice-message');
        if (voiceMessage) {
            const duration = e.target.duration;
            if (isFinite(duration) && !isNaN(duration) && duration > 0) {
                voiceMessage.dataset.duration = String(duration);
                const durationEl = voiceMessage.querySelector('.voice-duration');
                if (durationEl && (durationEl.textContent === '0:00' || durationEl.textContent === '0:--')) {
                    const mins = Math.floor(duration / 60);
                    const secs = Math.floor(duration % 60);
                    durationEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
                }
            }
        }
    }
}, true);

// =========================================
// =========================================
// Luxury Dynamic & 3D Gyroscope Wallpaper Engine
// =========================================
const WallpaperEngine = {
    currentMode: 'dynamic', // 'dynamic' | 'patterns' | 'custom'
    selectedPreset: 'aurora', // 'aurora' | 'cyberpunk' | 'obsidian' | 'sunset' | 'nebula' | 'ocean' | 'solar' | 'matrix' | 'crimson' | 'glacier' | 'amethyst' | 'solarflare'
    selectedPattern: 'doodle', // 'doodle' | 'topography' | 'hexgrid' | 'constellations' | 'seigaiha' | 'carbon' | 'circuit' | 'geometric'
    customImageData: null,
    gyroEnabled: true,
    dimmerOpacity: 0.4,
    
    // Low-overhead rendering state
    _rafId: null,
    _simTime: 0,
    _gyroListening: false,
    _targetTiltX: 0,
    _targetTiltY: 0,
    _currentTiltX: 0,
    _currentTiltY: 0,
    _chatCtx: null,
    _previewCtx: null,

    // Pre-allocated presets with closed harmonic orbits (100% seamless, ZERO snaps)
    PRESETS: {
        aurora: {
            bg: '#050d09',
            orbs: [
                { c0: 'rgba(5, 150, 105, 0.85)', c1: 'rgba(5, 150, 105, 0.28)', speed: 0.16, phase: 0.0, r: 0.55, cx: 0.35, cy: 0.25, rx: 0.18, ry: 0.15 },
                { c0: 'rgba(13, 148, 136, 0.80)', c1: 'rgba(13, 148, 136, 0.25)', speed: 0.13, phase: 2.1, r: 0.58, cx: 0.65, cy: 0.75, rx: 0.18, ry: 0.16 },
                { c0: 'rgba(67, 56, 202, 0.75)', c1: 'rgba(67, 56, 202, 0.25)', speed: 0.18, phase: 4.2, r: 0.50, cx: 0.70, cy: 0.35, rx: 0.16, ry: 0.18 },
                { c0: 'rgba(4, 120, 87, 0.70)', c1: 'rgba(4, 120, 87, 0.22)', speed: 0.14, phase: 1.3, r: 0.48, cx: 0.30, cy: 0.70, rx: 0.16, ry: 0.15 }
            ]
        },
        cyberpunk: {
            bg: '#0c0412',
            orbs: [
                { c0: 'rgba(236, 72, 153, 0.85)', c1: 'rgba(236, 72, 153, 0.28)', speed: 0.16, phase: 0.0, r: 0.55, cx: 0.35, cy: 0.25, rx: 0.18, ry: 0.15 },
                { c0: 'rgba(6, 182, 212, 0.80)', c1: 'rgba(6, 182, 212, 0.25)', speed: 0.13, phase: 2.1, r: 0.58, cx: 0.65, cy: 0.75, rx: 0.18, ry: 0.16 },
                { c0: 'rgba(139, 92, 246, 0.75)', c1: 'rgba(139, 92, 246, 0.25)', speed: 0.18, phase: 4.2, r: 0.50, cx: 0.70, cy: 0.35, rx: 0.16, ry: 0.18 },
                { c0: 'rgba(79, 70, 229, 0.70)', c1: 'rgba(79, 70, 229, 0.22)', speed: 0.14, phase: 1.3, r: 0.48, cx: 0.30, cy: 0.70, rx: 0.16, ry: 0.15 }
            ]
        },
        obsidian: {
            bg: '#08080a',
            orbs: [
                { c0: 'rgba(63, 63, 70, 0.90)', c1: 'rgba(63, 63, 70, 0.30)', speed: 0.16, phase: 0.0, r: 0.55, cx: 0.35, cy: 0.25, rx: 0.18, ry: 0.15 },
                { c0: 'rgba(51, 65, 85, 0.85)', c1: 'rgba(51, 65, 85, 0.26)', speed: 0.13, phase: 2.1, r: 0.58, cx: 0.65, cy: 0.75, rx: 0.18, ry: 0.16 },
                { c0: 'rgba(39, 39, 42, 0.80)', c1: 'rgba(39, 39, 42, 0.25)', speed: 0.18, phase: 4.2, r: 0.50, cx: 0.70, cy: 0.35, rx: 0.16, ry: 0.18 },
                { c0: 'rgba(24, 24, 27, 0.75)', c1: 'rgba(24, 24, 27, 0.22)', speed: 0.14, phase: 1.3, r: 0.48, cx: 0.30, cy: 0.70, rx: 0.16, ry: 0.15 }
            ]
        },
        sunset: {
            bg: '#120508',
            orbs: [
                { c0: 'rgba(225, 29, 72, 0.85)', c1: 'rgba(225, 29, 72, 0.28)', speed: 0.16, phase: 0.0, r: 0.55, cx: 0.35, cy: 0.25, rx: 0.18, ry: 0.15 },
                { c0: 'rgba(245, 158, 11, 0.80)', c1: 'rgba(245, 158, 11, 0.25)', speed: 0.13, phase: 2.1, r: 0.58, cx: 0.65, cy: 0.75, rx: 0.18, ry: 0.16 },
                { c0: 'rgba(234, 88, 12, 0.75)', c1: 'rgba(234, 88, 12, 0.25)', speed: 0.18, phase: 4.2, r: 0.50, cx: 0.70, cy: 0.35, rx: 0.16, ry: 0.18 },
                { c0: 'rgba(136, 19, 55, 0.70)', c1: 'rgba(136, 19, 55, 0.22)', speed: 0.14, phase: 1.3, r: 0.48, cx: 0.30, cy: 0.70, rx: 0.16, ry: 0.15 }
            ]
        },
        nebula: {
            bg: '#04020a',
            orbs: [
                { c0: 'rgba(168, 85, 247, 0.85)', c1: 'rgba(168, 85, 247, 0.28)', speed: 0.15, phase: 0.0, r: 0.55, cx: 0.35, cy: 0.25, rx: 0.18, ry: 0.15 },
                { c0: 'rgba(59, 130, 246, 0.80)', c1: 'rgba(59, 130, 246, 0.25)', speed: 0.12, phase: 2.3, r: 0.58, cx: 0.65, cy: 0.75, rx: 0.18, ry: 0.16 },
                { c0: 'rgba(217, 70, 239, 0.75)', c1: 'rgba(217, 70, 239, 0.25)', speed: 0.17, phase: 4.1, r: 0.50, cx: 0.70, cy: 0.35, rx: 0.16, ry: 0.18 },
                { c0: 'rgba(56, 189, 248, 0.70)', c1: 'rgba(56, 189, 248, 0.22)', speed: 0.14, phase: 1.2, r: 0.48, cx: 0.30, cy: 0.70, rx: 0.16, ry: 0.15 }
            ]
        },
        ocean: {
            bg: '#020b14',
            orbs: [
                { c0: 'rgba(6, 182, 212, 0.85)', c1: 'rgba(6, 182, 212, 0.28)', speed: 0.16, phase: 0.0, r: 0.55, cx: 0.35, cy: 0.25, rx: 0.18, ry: 0.15 },
                { c0: 'rgba(37, 99, 235, 0.80)', c1: 'rgba(37, 99, 235, 0.25)', speed: 0.13, phase: 2.1, r: 0.58, cx: 0.65, cy: 0.75, rx: 0.18, ry: 0.16 },
                { c0: 'rgba(20, 184, 166, 0.75)', c1: 'rgba(20, 184, 166, 0.25)', speed: 0.18, phase: 4.2, r: 0.50, cx: 0.70, cy: 0.35, rx: 0.16, ry: 0.18 },
                { c0: 'rgba(30, 58, 138, 0.70)', c1: 'rgba(30, 58, 138, 0.22)', speed: 0.14, phase: 1.3, r: 0.48, cx: 0.30, cy: 0.70, rx: 0.16, ry: 0.15 }
            ]
        },
        solar: {
            bg: '#120d03',
            orbs: [
                { c0: 'rgba(245, 158, 11, 0.85)', c1: 'rgba(245, 158, 11, 0.28)', speed: 0.15, phase: 0.0, r: 0.55, cx: 0.35, cy: 0.25, rx: 0.18, ry: 0.15 },
                { c0: 'rgba(251, 191, 36, 0.80)', c1: 'rgba(251, 191, 36, 0.25)', speed: 0.13, phase: 2.2, r: 0.58, cx: 0.65, cy: 0.75, rx: 0.18, ry: 0.16 },
                { c0: 'rgba(194, 65, 12, 0.75)', c1: 'rgba(194, 65, 12, 0.25)', speed: 0.18, phase: 4.1, r: 0.50, cx: 0.70, cy: 0.35, rx: 0.16, ry: 0.18 },
                { c0: 'rgba(253, 230, 138, 0.65)', c1: 'rgba(253, 230, 138, 0.20)', speed: 0.14, phase: 1.4, r: 0.48, cx: 0.30, cy: 0.70, rx: 0.16, ry: 0.15 }
            ]
        },
        matrix: {
            bg: '#021208',
            orbs: [
                { c0: 'rgba(132, 204, 22, 0.85)', c1: 'rgba(132, 204, 22, 0.28)', speed: 0.16, phase: 0.0, r: 0.55, cx: 0.35, cy: 0.25, rx: 0.18, ry: 0.15 },
                { c0: 'rgba(16, 185, 129, 0.80)', c1: 'rgba(16, 185, 129, 0.25)', speed: 0.13, phase: 2.1, r: 0.58, cx: 0.65, cy: 0.75, rx: 0.18, ry: 0.16 },
                { c0: 'rgba(20, 184, 166, 0.75)', c1: 'rgba(20, 184, 166, 0.25)', speed: 0.18, phase: 4.2, r: 0.50, cx: 0.70, cy: 0.35, rx: 0.16, ry: 0.18 },
                { c0: 'rgba(6, 78, 59, 0.70)', c1: 'rgba(6, 78, 59, 0.22)', speed: 0.14, phase: 1.3, r: 0.48, cx: 0.30, cy: 0.70, rx: 0.16, ry: 0.15 }
            ]
        },
        crimson: {
            bg: '#140306',
            orbs: [
                { c0: 'rgba(244, 63, 94, 0.85)', c1: 'rgba(244, 63, 94, 0.28)', speed: 0.16, phase: 0.0, r: 0.55, cx: 0.35, cy: 0.25, rx: 0.18, ry: 0.15 },
                { c0: 'rgba(190, 18, 60, 0.80)', c1: 'rgba(190, 18, 60, 0.25)', speed: 0.13, phase: 2.1, r: 0.58, cx: 0.65, cy: 0.75, rx: 0.18, ry: 0.16 },
                { c0: 'rgba(251, 113, 133, 0.75)', c1: 'rgba(251, 113, 133, 0.25)', speed: 0.18, phase: 4.2, r: 0.50, cx: 0.70, cy: 0.35, rx: 0.16, ry: 0.18 },
                { c0: 'rgba(76, 5, 25, 0.70)', c1: 'rgba(76, 5, 25, 0.22)', speed: 0.14, phase: 1.3, r: 0.48, cx: 0.30, cy: 0.70, rx: 0.16, ry: 0.15 }
            ]
        },
        glacier: {
            bg: '#040a12',
            orbs: [
                { c0: 'rgba(56, 189, 248, 0.85)', c1: 'rgba(56, 189, 248, 0.28)', speed: 0.16, phase: 0.0, r: 0.55, cx: 0.35, cy: 0.25, rx: 0.18, ry: 0.15 },
                { c0: 'rgba(45, 212, 191, 0.80)', c1: 'rgba(45, 212, 191, 0.25)', speed: 0.13, phase: 2.1, r: 0.58, cx: 0.65, cy: 0.75, rx: 0.18, ry: 0.16 },
                { c0: 'rgba(224, 242, 254, 0.75)', c1: 'rgba(224, 242, 254, 0.25)', speed: 0.18, phase: 4.2, r: 0.50, cx: 0.70, cy: 0.35, rx: 0.16, ry: 0.18 },
                { c0: 'rgba(99, 102, 241, 0.65)', c1: 'rgba(99, 102, 241, 0.20)', speed: 0.14, phase: 1.3, r: 0.48, cx: 0.30, cy: 0.70, rx: 0.16, ry: 0.15 }
            ]
        },
        amethyst: {
            bg: '#0a0414',
            orbs: [
                { c0: 'rgba(147, 51, 234, 0.85)', c1: 'rgba(147, 51, 234, 0.28)', speed: 0.16, phase: 0.0, r: 0.55, cx: 0.35, cy: 0.25, rx: 0.18, ry: 0.15 },
                { c0: 'rgba(192, 132, 252, 0.80)', c1: 'rgba(192, 132, 252, 0.25)', speed: 0.13, phase: 2.1, r: 0.58, cx: 0.65, cy: 0.75, rx: 0.18, ry: 0.16 },
                { c0: 'rgba(232, 121, 249, 0.75)', c1: 'rgba(232, 121, 249, 0.25)', speed: 0.18, phase: 4.2, r: 0.50, cx: 0.70, cy: 0.35, rx: 0.16, ry: 0.18 },
                { c0: 'rgba(88, 28, 135, 0.70)', c1: 'rgba(88, 28, 135, 0.22)', speed: 0.14, phase: 1.3, r: 0.48, cx: 0.30, cy: 0.70, rx: 0.16, ry: 0.15 }
            ]
        },
        solarflare: {
            bg: '#140602',
            orbs: [
                { c0: 'rgba(249, 115, 22, 0.85)', c1: 'rgba(249, 115, 22, 0.28)', speed: 0.16, phase: 0.0, r: 0.55, cx: 0.35, cy: 0.25, rx: 0.18, ry: 0.15 },
                { c0: 'rgba(250, 204, 21, 0.80)', c1: 'rgba(250, 204, 21, 0.25)', speed: 0.13, phase: 2.1, r: 0.58, cx: 0.65, cy: 0.75, rx: 0.18, ry: 0.16 },
                { c0: 'rgba(239, 68, 68, 0.75)', c1: 'rgba(239, 68, 68, 0.25)', speed: 0.18, phase: 4.2, r: 0.50, cx: 0.70, cy: 0.35, rx: 0.16, ry: 0.18 },
                { c0: 'rgba(254, 215, 170, 0.65)', c1: 'rgba(254, 215, 170, 0.20)', speed: 0.14, phase: 1.3, r: 0.48, cx: 0.30, cy: 0.70, rx: 0.16, ry: 0.15 }
            ]
        }
    },

    // Curated Luxury Vector Patterns (Crisp, zero latency, ultra-sharp vector art)
    PATTERNS: {
        doodle: {
            name: 'Chat Doodles',
            desc: 'WhatsApp / Telegram Classic',
            bgColor: '#0b141a',
            bgSize: '220px 220px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220"><path d="M25 35 h30 a8 8 0 0 1 8 8 v14 a8 8 0 0 1 -8 8 h-18 l-8 7 v-7 h-6 a8 8 0 0 1 -8 -8 v-14 a8 8 0 0 1 8 -8 z" fill="none" stroke="rgba(255,255,255,0.11)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M95 38 c-4 -6 -12 -5 -15 0 c-3 5 0 10 15 20 c15 -10 18 -15 15 -20 c-3 -5 -11 -6 -15 0 z" fill="none" stroke="rgba(255,255,255,0.11)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M155 45 a15 15 0 0 1 30 0 v14 h-4 a4 4 0 0 1 -4 -4 v-6 a4 4 0 0 1 4 -4 h4 M155 45 v14 h4 a4 4 0 0 0 4 -4 v-6 a4 4 0 0 0 -4 -4 h-4" fill="none" stroke="rgba(255,255,255,0.11)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M30 110 l40 -20 l-18 42 l-6 -14 z M52 104 l18 -14" fill="none" stroke="rgba(255,255,255,0.11)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M100 105 h22 v16 a6 6 0 0 1 -6 6 h-10 a6 6 0 0 1 -6 -6 z M122 109 h5 a3 3 0 0 1 3 3 v2 a3 3 0 0 1 -3 3 h-5 M98 131 h26" fill="none" stroke="rgba(255,255,255,0.11)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M165 110 v18 a5 5 0 1 1 -4 -3 h4 v-15 h16 v18 a5 5 0 1 1 -4 -3 h4 v-15 z" fill="none" stroke="rgba(255,255,255,0.11)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M35 180 l3 7 l7 1 l-5 5 l1 7 l-6 -4 l-6 4 l1 -7 l-5 -5 l7 -1 z" fill="none" stroke="rgba(255,255,255,0.11)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M92 175 h36 a7 7 0 0 1 7 7 v8 a12 12 0 0 1 -12 12 l-4 -6 h-18 l-4 6 a12 12 0 0 1 -12 -12 v-8 a7 7 0 0 1 7 -7 z M100 183 v8 M96 187 h8 M124 186 a2 2 0 1 1 -4 0 a2 2 0 0 1 4 0 M130 190 a2 2 0 1 1 -4 0 a2 2 0 0 1 4 0" fill="none" stroke="rgba(255,255,255,0.11)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M162 175 h7 l3 -4 h12 l3 4 h7 a5 5 0 0 1 5 5 v18 a5 5 0 0 1 -5 5 h-32 a5 5 0 0 1 -5 -5 v-18 a5 5 0 0 1 5 -5 z M178 184 a6 6 0 1 0 0 12 a6 6 0 0 0 0 -12 z" fill="none" stroke="rgba(255,255,255,0.11)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="70" cy="45" r="1.5" fill="rgba(255,255,255,0.14)"/><circle cx="138" cy="40" r="1.5" fill="rgba(255,255,255,0.14)"/><circle cx="85" cy="115" r="1.5" fill="rgba(255,255,255,0.14)"/><circle cx="150" cy="120" r="1.5" fill="rgba(255,255,255,0.14)"/><circle cx="72" cy="175" r="1.5" fill="rgba(255,255,255,0.14)"/><circle cx="145" cy="185" r="1.5" fill="rgba(255,255,255,0.14)"/></svg>`
        },
        topography: {
            name: 'Luxury Topo',
            desc: 'Minimal Contour Curves',
            bgColor: '#09090b',
            bgSize: '280px 280px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280" viewBox="0 0 280 280"><path d="M-20 60 C40 30, 80 90, 140 50 C200 10, 240 70, 300 40" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.6"/><path d="M-20 90 C50 60, 90 120, 150 80 C210 40, 250 100, 300 70" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.6"/><path d="M-20 120 C60 90, 100 150, 160 110 C220 70, 260 130, 300 100" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.6"/><path d="M-20 170 C50 130, 110 200, 170 160 C230 120, 260 190, 300 150" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.6"/><path d="M-20 200 C60 160, 120 230, 180 190 C240 150, 270 220, 300 180" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.6"/><path d="M-20 230 C70 190, 130 260, 190 220 C250 180, 280 250, 300 210" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.6"/><path d="M70 20 C100 40, 140 10, 170 30 C190 45, 170 80, 130 70 C90 60, 50 0, 70 20 Z" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="1.6"/><path d="M120 230 C150 200, 200 210, 210 240 C220 270, 170 280, 140 260 C110 240, 100 250, 120 230 Z" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="1.6"/></svg>`
        },
        hexgrid: {
            name: 'Cyber Hex Grid',
            desc: 'Sci-Fi Honeycomb Mesh',
            bgColor: '#050912',
            bgSize: '120px 104px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="104" viewBox="0 0 120 104"><path d="M30 0 L60 17.3 L60 52 L30 69.3 L0 52 L0 17.3 Z" fill="none" stroke="rgba(34,211,238,0.18)" stroke-width="1.4"/><path d="M90 0 L120 17.3 L120 52 L90 69.3 L60 52 L60 17.3 Z" fill="none" stroke="rgba(34,211,238,0.18)" stroke-width="1.4"/><path d="M30 69.3 L60 86.6 L60 121.3 L30 138.6 L0 121.3 L0 86.6 Z" fill="none" stroke="rgba(34,211,238,0.18)" stroke-width="1.4"/><path d="M90 69.3 L120 86.6 L120 121.3 L90 138.6 L60 121.3 L60 86.6 Z" fill="none" stroke="rgba(34,211,238,0.18)" stroke-width="1.4"/><path d="M0 34.6 L30 52 L30 86.6 L0 104 L-30 86.6 L-30 52 Z" fill="none" stroke="rgba(34,211,238,0.18)" stroke-width="1.4"/><path d="M60 34.6 L90 52 L90 86.6 L60 104 L30 86.6 L30 52 Z" fill="none" stroke="rgba(34,211,238,0.18)" stroke-width="1.4"/><circle cx="30" cy="52" r="2.2" fill="rgba(34,211,238,0.45)"/><circle cx="90" cy="52" r="2.2" fill="rgba(34,211,238,0.45)"/><circle cx="60" cy="0" r="2.2" fill="rgba(34,211,238,0.45)"/><circle cx="60" cy="104" r="2.2" fill="rgba(34,211,238,0.45)"/></svg>`
        },
        constellations: {
            name: 'Constellations',
            desc: 'Celestial Star Charts',
            bgColor: '#030712',
            bgSize: '200px 200px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><path d="M20 30 L55 50 L90 35 L120 70 M55 50 L40 90 M140 130 L170 110 L185 150 L150 170 Z M170 110 L160 80 M70 140 L95 165 L115 150" fill="none" stroke="rgba(147,197,253,0.16)" stroke-width="1.2" stroke-linecap="round"/><circle cx="20" cy="30" r="2" fill="#fff"/><circle cx="55" cy="50" r="2.5" fill="rgba(191,219,254,0.9)"/><circle cx="90" cy="35" r="2" fill="#fff"/><circle cx="120" cy="70" r="2.2" fill="rgba(191,219,254,0.9)"/><circle cx="40" cy="90" r="1.8" fill="#fff"/><circle cx="140" cy="130" r="2" fill="rgba(191,219,254,0.9)"/><circle cx="170" cy="110" r="2.5" fill="#fff"/><circle cx="185" cy="150" r="2" fill="#fff"/><circle cx="150" cy="170" r="2.2" fill="rgba(191,219,254,0.9)"/><circle cx="160" cy="80" r="1.8" fill="#fff"/><circle cx="70" cy="140" r="2" fill="#fff"/><circle cx="95" cy="165" r="2.2" fill="rgba(191,219,254,0.9)"/><circle cx="115" cy="150" r="2" fill="#fff"/><circle cx="15" cy="170" r="1" fill="rgba(255,255,255,0.4)"/><circle cx="100" cy="90" r="1" fill="rgba(255,255,255,0.4)"/><circle cx="180" cy="25" r="1" fill="rgba(255,255,255,0.4)"/></svg>`
        },
        seigaiha: {
            name: 'Zen Waves',
            desc: 'Japanese Seigaiha Arcs',
            bgColor: '#070a14',
            bgSize: '120px 60px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><defs><g id="swave"><path d="M-60 0 A60 60 0 0 1 60 0" fill="none" stroke="rgba(129,140,248,0.16)" stroke-width="1.5"/><path d="M-45 0 A45 45 0 0 1 45 0" fill="none" stroke="rgba(129,140,248,0.16)" stroke-width="1.5"/><path d="M-30 0 A30 30 0 0 1 30 0" fill="none" stroke="rgba(129,140,248,0.16)" stroke-width="1.5"/><path d="M-15 0 A15 15 0 0 1 15 0" fill="none" stroke="rgba(129,140,248,0.16)" stroke-width="1.5"/></g></defs><use href="#swave" x="0" y="0"/><use href="#swave" x="60" y="0"/><use href="#swave" x="120" y="0"/><use href="#swave" x="30" y="30"/><use href="#swave" x="90" y="30"/><use href="#swave" x="0" y="60"/><use href="#swave" x="60" y="60"/><use href="#swave" x="120" y="60"/></svg>`
        },
        carbon: {
            name: 'Carbon Fiber',
            desc: 'Hypercar Stealth Twill',
            bgColor: '#080808',
            bgSize: '24px 24px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" fill="#08080a"/><path d="M0 0 L12 12 M12 0 L24 12 M0 12 L12 24 M12 12 L24 24" stroke="rgba(255,255,255,0.07)" stroke-width="5.5"/><path d="M12 0 L0 12 M24 0 L12 12 M12 12 L0 24 M24 12 L12 24" stroke="rgba(0,0,0,0.6)" stroke-width="5.5"/></svg>`
        },
        circuit: {
            name: 'Cyber Circuit',
            desc: 'Digital Microchip Bus',
            bgColor: '#020d09',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><path d="M0 30 h40 l20 20 h60 l15 -15 h25 M30 80 h30 l15 -15 v-25 M110 50 v40 l20 20 h30 M0 120 h50 l25 25 h85 M80 120 v20 l10 10 h50" fill="none" stroke="rgba(16,185,129,0.20)" stroke-width="1.6" stroke-linecap="round"/><circle cx="40" cy="30" r="3" fill="rgba(16,185,129,0.4)" stroke="rgba(16,185,129,0.7)" stroke-width="1"/><circle cx="120" cy="50" r="3" fill="rgba(16,185,129,0.4)" stroke="rgba(16,185,129,0.7)" stroke-width="1"/><circle cx="60" cy="65" r="2.5" fill="rgba(16,185,129,0.6)"/><circle cx="130" cy="110" r="3" fill="rgba(16,185,129,0.4)" stroke="rgba(16,185,129,0.7)" stroke-width="1"/><circle cx="50" cy="120" r="2.5" fill="rgba(16,185,129,0.6)"/><circle cx="90" cy="150" r="2.5" fill="rgba(16,185,129,0.6)"/></svg>`
        },
        geometric: {
            name: 'Bauhaus Arcs',
            desc: 'Modernist Curves & Flow',
            bgColor: '#0d0b14',
            bgSize: '120px 120px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><path d="M0 60 A60 60 0 0 1 60 0 M60 0 A60 60 0 0 1 120 60 M120 60 A60 60 0 0 1 60 120 M60 120 A60 60 0 0 1 0 60 M0 60 A60 60 0 0 0 60 120 M60 0 A60 60 0 0 0 120 60" fill="none" stroke="rgba(244,114,182,0.16)" stroke-width="1.5"/><circle cx="60" cy="60" r="4" fill="rgba(244,114,182,0.35)"/><circle cx="0" cy="0" r="3" fill="rgba(244,114,182,0.2)"/><circle cx="120" cy="0" r="3" fill="rgba(244,114,182,0.2)"/><circle cx="0" cy="120" r="3" fill="rgba(244,114,182,0.2)"/><circle cx="120" cy="120" r="3" fill="rgba(244,114,182,0.2)"/></svg>`
        },
        dna: {
            name: 'DNA Helix',
            desc: 'Rotating 3D Strands',
            bgColor: '#040d1a',
            bgSize: '120px 120px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><path d="M30 0 C45 30, 75 30, 90 60 C75 90, 45 90, 30 120" fill="none" stroke="rgba(56,189,248,0.4)" stroke-width="2.2"/><path d="M90 0 C75 30, 45 30, 30 60 C45 90, 75 90, 90 120" fill="none" stroke="rgba(192,132,252,0.4)" stroke-width="2.2"/><line x1="38" y1="15" x2="82" y2="15" stroke="rgba(56,189,248,0.3)" stroke-width="1.6"/><line x1="52" y1="30" x2="68" y2="30" stroke="rgba(192,132,252,0.3)" stroke-width="1.6"/><line x1="52" y1="60" x2="68" y2="60" stroke="rgba(56,189,248,0.3)" stroke-width="1.6"/><line x1="38" y1="75" x2="82" y2="75" stroke="rgba(192,132,252,0.3)" stroke-width="1.6"/><line x1="30" y1="90" x2="90" y2="90" stroke="rgba(56,189,248,0.3)" stroke-width="1.6"/><line x1="38" y1="105" x2="82" y2="105" stroke="rgba(192,132,252,0.3)" stroke-width="1.6"/><circle cx="38" cy="15" r="2.8" fill="#38bdf8"/><circle cx="82" cy="15" r="2.8" fill="#c084fc"/><circle cx="30" cy="60" r="3.2" fill="#c084fc"/><circle cx="90" cy="60" r="3.2" fill="#38bdf8"/><circle cx="38" cy="105" r="2.8" fill="#38bdf8"/><circle cx="82" cy="105" r="2.8" fill="#c084fc"/></svg>`
        },
        moire: {
            name: 'MoirÃ© Rings',
            desc: 'Interference Waves',
            bgColor: '#0b0614',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><circle cx="65" cy="80" r="70" fill="none" stroke="rgba(192,132,252,0.2)" stroke-width="1.2"/><circle cx="65" cy="80" r="50" fill="none" stroke="rgba(192,132,252,0.2)" stroke-width="1.2"/><circle cx="65" cy="80" r="30" fill="none" stroke="rgba(192,132,252,0.2)" stroke-width="1.2"/><circle cx="65" cy="80" r="15" fill="none" stroke="rgba(192,132,252,0.2)" stroke-width="1.2"/><circle cx="95" cy="80" r="70" fill="none" stroke="rgba(147,51,234,0.2)" stroke-width="1.2"/><circle cx="95" cy="80" r="50" fill="none" stroke="rgba(147,51,234,0.2)" stroke-width="1.2"/><circle cx="95" cy="80" r="30" fill="none" stroke="rgba(147,51,234,0.2)" stroke-width="1.2"/><circle cx="95" cy="80" r="15" fill="none" stroke="rgba(147,51,234,0.2)" stroke-width="1.2"/></svg>`
        },
        isometric: {
            name: 'Isometric Voxel',
            desc: 'Tumbling 3D Cubes',
            bgColor: '#0a0a10',
            bgSize: '100px 100px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M50 15 L75 30 L50 45 L25 30 Z" fill="rgba(250,204,21,0.25)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/><path d="M25 30 L50 45 L50 75 L25 60 Z" fill="rgba(234,179,8,0.18)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/><path d="M50 45 L75 30 L75 60 L50 75 Z" fill="rgba(161,98,7,0.14)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/></svg>`
        },
        mandala: {
            name: 'Sacred Mandala',
            desc: 'Kaleidoscope Petals',
            bgColor: '#120309',
            bgSize: '180px 180px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><circle cx="90" cy="90" r="75" fill="none" stroke="rgba(244,63,94,0.2)" stroke-width="1.3"/><circle cx="90" cy="90" r="50" fill="none" stroke="rgba(244,63,94,0.25)" stroke-width="1.3"/><circle cx="90" cy="90" r="25" fill="none" stroke="rgba(244,63,94,0.3)" stroke-width="1.3"/><path d="M90 15 A75 75 0 0 1 90 165 M90 15 A75 75 0 0 0 90 165 M15 90 A75 75 0 0 1 165 90 M15 90 A75 75 0 0 0 165 90" fill="none" stroke="rgba(251,113,133,0.22)" stroke-width="1.3"/><circle cx="90" cy="90" r="4.5" fill="#f43f5e"/></svg>`
        },
        ripples: {
            name: 'Rain Ripples',
            desc: 'Expanding Wave Drops',
            bgColor: '#020b14',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><ellipse cx="45" cy="50" rx="38" ry="26" fill="none" stroke="rgba(34,211,238,0.28)" stroke-width="1.4"/><ellipse cx="45" cy="50" rx="24" ry="16" fill="none" stroke="rgba(34,211,238,0.36)" stroke-width="1.5"/><ellipse cx="45" cy="50" rx="10" ry="7" fill="none" stroke="rgba(56,189,248,0.5)" stroke-width="1.6"/><circle cx="45" cy="50" r="2.2" fill="#38bdf8"/><ellipse cx="120" cy="115" rx="34" ry="24" fill="none" stroke="rgba(34,211,238,0.26)" stroke-width="1.4"/><ellipse cx="120" cy="115" rx="18" ry="13" fill="none" stroke="rgba(34,211,238,0.36)" stroke-width="1.5"/><circle cx="120" cy="115" r="2.2" fill="#38bdf8"/><ellipse cx="130" cy="35" rx="20" ry="14" fill="none" stroke="rgba(34,211,238,0.22)" stroke-width="1.3"/><circle cx="130" cy="35" r="1.6" fill="#38bdf8"/></svg>`
        },
        glitch: {
            name: 'Cyber Glitch',
            desc: 'Digital Tech Bursts',
            bgColor: '#030f09',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><rect x="10" y="20" width="40" height="6" fill="rgba(74,222,128,0.35)"/><rect x="70" y="20" width="60" height="6" fill="rgba(74,222,128,0.18)"/><rect x="25" y="45" width="80" height="6" fill="rgba(52,211,153,0.3)"/><rect x="0" y="70" width="55" height="8" fill="rgba(74,222,128,0.4)"/><rect x="80" y="70" width="45" height="8" fill="rgba(74,222,128,0.2)"/><rect x="35" y="95" width="70" height="6" fill="rgba(52,211,153,0.3)"/><rect x="15" y="118" width="50" height="6" fill="rgba(74,222,128,0.35)"/><line x1="0" y1="35" x2="140" y2="35" stroke="rgba(74,222,128,0.12)" stroke-width="1"/><line x1="0" y1="85" x2="140" y2="85" stroke="rgba(74,222,128,0.12)" stroke-width="1"/></svg>`
        },
        tessellation: {
            name: 'Arabesque Stars',
            desc: 'Islamic Octagrams',
            bgColor: '#120a02',
            bgSize: '120px 120px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect x="22" y="22" width="36" height="36" transform="rotate(45 40 40)" fill="none" stroke="rgba(245,158,11,0.28)" stroke-width="1.4"/><rect x="22" y="22" width="36" height="36" fill="none" stroke="rgba(245,158,11,0.28)" stroke-width="1.4"/><rect x="82" y="22" width="36" height="36" transform="rotate(45 100 40)" fill="none" stroke="rgba(245,158,11,0.28)" stroke-width="1.4"/><rect x="82" y="22" width="36" height="36" fill="none" stroke="rgba(245,158,11,0.28)" stroke-width="1.4"/><rect x="52" y="82" width="36" height="36" transform="rotate(45 70 100)" fill="none" stroke="rgba(245,158,11,0.28)" stroke-width="1.4"/><rect x="52" y="82" width="36" height="36" fill="none" stroke="rgba(245,158,11,0.28)" stroke-width="1.4"/><circle cx="40" cy="40" r="2.2" fill="#fbbf24"/><circle cx="100" cy="40" r="2.2" fill="#fbbf24"/><circle cx="70" cy="100" r="2.2" fill="#fbbf24"/></svg>`
        },
        sonar: {
            name: 'Radar Sonar',
            desc: '360Â° Sweep Echo',
            bgColor: '#020e06',
            bgSize: '180px 180px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><circle cx="90" cy="90" r="75" fill="none" stroke="rgba(34,197,94,0.2)" stroke-width="1.3"/><circle cx="90" cy="90" r="50" fill="none" stroke="rgba(34,197,94,0.2)" stroke-width="1.3"/><circle cx="90" cy="90" r="25" fill="none" stroke="rgba(34,197,94,0.2)" stroke-width="1.3"/><line x1="15" y1="90" x2="165" y2="90" stroke="rgba(34,197,94,0.2)" stroke-width="1.2"/><line x1="90" y1="15" x2="90" y2="165" stroke="rgba(34,197,94,0.2)" stroke-width="1.2"/><line x1="90" y1="90" x2="145" y2="35" stroke="rgba(134,239,172,0.8)" stroke-width="1.8"/><circle cx="120" cy="55" r="3" fill="#86efac"/></svg>`
        },
        // 16 Brand-New Luxury Procedural Patterns
        matrix: {
            name: 'Matrix Rain',
            desc: 'Digital Stream Code',
            bgColor: '#020d06',
            bgSize: '120px 120px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><text x="15" y="20" fill="rgba(74,222,128,0.9)" font-family="monospace" font-size="12">1</text><text x="15" y="38" fill="rgba(34,197,94,0.6)" font-family="monospace" font-size="12">0</text><text x="15" y="56" fill="rgba(34,197,94,0.3)" font-family="monospace" font-size="12">1</text><text x="15" y="74" fill="rgba(34,197,94,0.15)" font-family="monospace" font-size="12">0</text><text x="55" y="35" fill="rgba(74,222,128,0.9)" font-family="monospace" font-size="12">0</text><text x="55" y="53" fill="rgba(34,197,94,0.6)" font-family="monospace" font-size="12">1</text><text x="55" y="71" fill="rgba(34,197,94,0.4)" font-family="monospace" font-size="12">1</text><text x="55" y="89" fill="rgba(34,197,94,0.2)" font-family="monospace" font-size="12">0</text><text x="95" y="15" fill="rgba(74,222,128,0.9)" font-family="monospace" font-size="12">1</text><text x="95" y="33" fill="rgba(34,197,94,0.6)" font-family="monospace" font-size="12">0</text><text x="95" y="51" fill="rgba(34,197,94,0.3)" font-family="monospace" font-size="12">1</text></svg>`
        },
        plasma: {
            name: 'Neon Plasma',
            desc: 'Fluid Chromatic Flow',
            bgColor: '#090314',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><path d="M-20 40 Q40 100, 80 40 T180 40" fill="none" stroke="rgba(236,72,153,0.32)" stroke-width="2"/><path d="M-20 80 Q40 20, 80 80 T180 80" fill="none" stroke="rgba(6,182,212,0.32)" stroke-width="2"/><path d="M-20 120 Q40 180, 80 120 T180 120" fill="none" stroke="rgba(139,92,246,0.32)" stroke-width="2"/><circle cx="80" cy="80" r="30" fill="none" stroke="rgba(236,72,153,0.22)" stroke-width="1.8"/><circle cx="80" cy="80" r="50" fill="none" stroke="rgba(6,182,212,0.18)" stroke-width="1.5"/></svg>`
        },
        synthwave: {
            name: 'Retro Synthwave',
            desc: 'Outrun Neon Horizon',
            bgColor: '#0d0218',
            bgSize: '160px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="140" viewBox="0 0 160 140"><circle cx="80" cy="60" r="32" fill="none" stroke="rgba(244,63,94,0.4)" stroke-width="2"/><line x1="48" y1="60" x2="112" y2="60" stroke="#0d0218" stroke-width="3"/><line x1="52" y1="68" x2="108" y2="68" stroke="#0d0218" stroke-width="3"/><line x1="58" y1="76" x2="102" y2="76" stroke="#0d0218" stroke-width="3"/><line x1="0" y1="88" x2="160" y2="88" stroke="rgba(236,72,153,0.6)" stroke-width="1.5"/><line x1="0" y1="98" x2="160" y2="98" stroke="rgba(147,51,234,0.4)" stroke-width="1.2"/><line x1="0" y1="114" x2="160" y2="114" stroke="rgba(147,51,234,0.3)" stroke-width="1.2"/><line x1="80" y1="88" x2="80" y2="140" stroke="rgba(6,182,212,0.4)" stroke-width="1.2"/><line x1="80" y1="88" x2="20" y2="140" stroke="rgba(6,182,212,0.4)" stroke-width="1.2"/><line x1="80" y1="88" x2="140" y2="140" stroke="rgba(6,182,212,0.4)" stroke-width="1.2"/></svg>`
        },
        quantum: {
            name: 'Quantum Orbitals',
            desc: 'Atomic Electron Shells',
            bgColor: '#040914',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><ellipse cx="80" cy="80" rx="65" ry="24" fill="none" stroke="rgba(56,189,248,0.3)" stroke-width="1.5"/><ellipse cx="80" cy="80" rx="65" ry="24" transform="rotate(60 80 80)" fill="none" stroke="rgba(129,140,248,0.3)" stroke-width="1.5"/><ellipse cx="80" cy="80" rx="65" ry="24" transform="rotate(120 80 80)" fill="none" stroke="rgba(45,212,191,0.3)" stroke-width="1.5"/><circle cx="80" cy="80" r="4.5" fill="#38bdf8"/><circle cx="140" cy="80" r="3" fill="#60a5fa"/><circle cx="50" cy="30" r="2.8" fill="#a78bfa"/></svg>`
        },
        nebula: {
            name: 'Cosmic Stardust',
            desc: 'Deep Space Stellar Nursery',
            bgColor: '#05020c',
            bgSize: '180px 180px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><path d="M40 90 Q70 30, 120 60 T150 120 T80 150 Z" fill="none" stroke="rgba(168,85,247,0.24)" stroke-width="1.5"/><path d="M60 80 Q90 50, 130 80 T120 130 T70 120 Z" fill="none" stroke="rgba(59,130,246,0.24)" stroke-width="1.5"/><circle cx="90" cy="85" r="2.5" fill="#fff"/><line x1="90" y1="75" x2="90" y2="95" stroke="#fff" stroke-width="1"/><line x1="80" y1="85" x2="100" y2="85" stroke="#fff" stroke-width="1"/><circle cx="45" cy="45" r="1.5" fill="#e9d5ff"/><circle cx="140" cy="140" r="1.5" fill="#bae6fd"/><circle cx="130" cy="40" r="1" fill="#fff"/></svg>`
        },
        voronoi: {
            name: 'Bio Voronoi',
            desc: 'Living Cellular Crystals',
            bgColor: '#020d0e',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M20 30 L60 20 L90 45 L75 85 L35 75 Z" fill="none" stroke="rgba(45,212,191,0.28)" stroke-width="1.4"/><path d="M90 45 L130 35 L145 75 L110 100 L75 85 Z" fill="none" stroke="rgba(45,212,191,0.28)" stroke-width="1.4"/><path d="M35 75 L75 85 L65 125 L15 115 Z" fill="none" stroke="rgba(45,212,191,0.28)" stroke-width="1.4"/><circle cx="56" cy="51" r="2.5" fill="#2dd4bf"/><circle cx="110" cy="68" r="2.5" fill="#2dd4bf"/><circle cx="47" cy="100" r="2.5" fill="#2dd4bf"/></svg>`
        },
        origami: {
            name: 'Prismatic Shards',
            desc: '3D Low-Poly Diamond',
            bgColor: '#090712',
            bgSize: '120px 120px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><polygon points="60,20 20,60 60,60" fill="rgba(168,85,247,0.2)" stroke="rgba(255,255,255,0.16)" stroke-width="1.2"/><polygon points="60,20 100,60 60,60" fill="rgba(147,51,234,0.3)" stroke="rgba(255,255,255,0.16)" stroke-width="1.2"/><polygon points="20,60 60,100 60,60" fill="rgba(126,34,206,0.24)" stroke="rgba(255,255,255,0.16)" stroke-width="1.2"/><polygon points="100,60 60,100 60,60" fill="rgba(192,132,252,0.16)" stroke="rgba(255,255,255,0.16)" stroke-width="1.2"/></svg>`
        },
        soundwave: {
            name: 'Audio Harmonics',
            desc: 'Fluid Resonance Spectrum',
            bgColor: '#030c10',
            bgSize: '140px 120px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="120" viewBox="0 0 140 120"><line x1="20" y1="45" x2="20" y2="75" stroke="rgba(20,184,166,0.4)" stroke-width="3" stroke-linecap="round"/><line x1="35" y1="30" x2="35" y2="90" stroke="rgba(20,184,166,0.55)" stroke-width="3" stroke-linecap="round"/><line x1="50" y1="15" x2="50" y2="105" stroke="rgba(45,212,191,0.7)" stroke-width="3" stroke-linecap="round"/><line x1="65" y1="35" x2="65" y2="85" stroke="rgba(245,158,11,0.6)" stroke-width="3" stroke-linecap="round"/><line x1="80" y1="20" x2="80" y2="100" stroke="rgba(45,212,191,0.75)" stroke-width="3" stroke-linecap="round"/><line x1="95" y1="40" x2="95" y2="80" stroke="rgba(20,184,166,0.5)" stroke-width="3" stroke-linecap="round"/><line x1="110" y1="25" x2="110" y2="95" stroke="rgba(245,158,11,0.65)" stroke-width="3" stroke-linecap="round"/><line x1="125" y1="50" x2="125" y2="70" stroke="rgba(20,184,166,0.4)" stroke-width="3" stroke-linecap="round"/></svg>`
        },
        hypercube: {
            name: '4D Tesseract',
            desc: 'Hypercube 4D Projection',
            bgColor: '#060714',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><rect x="25" y="25" width="90" height="90" fill="none" stroke="rgba(99,102,241,0.32)" stroke-width="1.5"/><rect x="50" y="50" width="40" height="40" fill="none" stroke="rgba(129,140,248,0.45)" stroke-width="1.5"/><line x1="25" y1="25" x2="50" y2="50" stroke="rgba(99,102,241,0.32)" stroke-width="1.5"/><line x1="115" y1="25" x2="90" y2="50" stroke="rgba(99,102,241,0.32)" stroke-width="1.5"/><line x1="115" y1="115" x2="90" y2="90" stroke="rgba(99,102,241,0.32)" stroke-width="1.5"/><line x1="25" y1="115" x2="50" y2="90" stroke="rgba(99,102,241,0.32)" stroke-width="1.5"/><circle cx="50" cy="50" r="2.5" fill="#818cf8"/><circle cx="90" cy="50" r="2.5" fill="#818cf8"/><circle cx="90" cy="90" r="2.5" fill="#818cf8"/><circle cx="50" cy="90" r="2.5" fill="#818cf8"/></svg>`
        },
        fibonacci: {
            name: 'Golden Spiral',
            desc: 'Sacred Fibonacci Flower',
            bgColor: '#120902',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><path d="M80 80 A5 5 0 0 1 85 85 A10 10 0 0 1 75 95 A20 20 0 0 1 65 75 A35 35 0 0 1 100 50 A55 55 0 0 1 135 105 A85 85 0 0 1 50 150" fill="none" stroke="rgba(245,158,11,0.35)" stroke-width="1.8"/><circle cx="80" cy="80" r="3" fill="#f59e0b"/><circle cx="85" cy="85" r="2" fill="#fbbf24"/><circle cx="75" cy="95" r="2" fill="#fbbf24"/><circle cx="65" cy="75" r="2" fill="#fbbf24"/><circle cx="100" cy="50" r="2" fill="#fbbf24"/></svg>`
        },
        synapse: {
            name: 'Neural Synapse',
            desc: 'AI Synaptic Impulse Mesh',
            bgColor: '#030c14',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><line x1="40" y1="40" x2="80" y2="80" stroke="rgba(56,189,248,0.28)" stroke-width="1.4"/><line x1="80" y1="80" x2="130" y2="50" stroke="rgba(56,189,248,0.28)" stroke-width="1.4"/><line x1="80" y1="80" x2="70" y2="135" stroke="rgba(56,189,248,0.28)" stroke-width="1.4"/><line x1="130" y1="50" x2="140" y2="120" stroke="rgba(56,189,248,0.22)" stroke-width="1.2"/><line x1="70" y1="135" x2="140" y2="120" stroke="rgba(56,189,248,0.22)" stroke-width="1.2"/><circle cx="40" cy="40" r="3.5" fill="#38bdf8"/><circle cx="80" cy="80" r="5" fill="#60a5fa"/><circle cx="130" cy="50" r="3.5" fill="#38bdf8"/><circle cx="70" cy="135" r="3.5" fill="#38bdf8"/><circle cx="140" cy="120" r="3.5" fill="#38bdf8"/></svg>`
        },
        prism: {
            name: 'Laser Optics',
            desc: 'Refracting Chromatic Beams',
            bgColor: '#0c0410',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><polygon points="75,30 35,110 115,110" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1.6"/><line x1="10" y1="90" x2="55" y2="70" stroke="rgba(255,255,255,0.7)" stroke-width="2"/><line x1="85" y1="70" x2="140" y2="55" stroke="rgba(244,63,94,0.6)" stroke-width="1.5"/><line x1="85" y1="70" x2="140" y2="65" stroke="rgba(234,179,8,0.6)" stroke-width="1.5"/><line x1="85" y1="70" x2="140" y2="75" stroke="rgba(34,197,94,0.6)" stroke-width="1.5"/><line x1="85" y1="70" x2="140" y2="85" stroke="rgba(6,182,212,0.6)" stroke-width="1.5"/><line x1="85" y1="70" x2="140" y2="95" stroke="rgba(168,85,247,0.6)" stroke-width="1.5"/></svg>`
        },
        dunes: {
            name: 'Velvet Dunes',
            desc: 'Saharan Wind Contours',
            bgColor: '#140a04',
            bgSize: '160px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="140" viewBox="0 0 160 140"><path d="M-20 40 Q40 20, 80 50 T180 30" fill="none" stroke="rgba(217,119,6,0.32)" stroke-width="1.8"/><path d="M-20 70 Q50 90, 100 65 T180 80" fill="none" stroke="rgba(245,158,11,0.38)" stroke-width="1.8"/><path d="M-20 110 Q30 85, 90 115 T180 100" fill="none" stroke="rgba(180,83,9,0.32)" stroke-width="1.8"/><circle cx="120" cy="30" r="12" fill="none" stroke="rgba(251,191,36,0.25)" stroke-width="1.2"/></svg>`
        },
        megacity: {
            name: 'Tokyo Metro',
            desc: 'Cyberpunk Transit Grid',
            bgColor: '#050810',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><path d="M0 30 H60 L90 60 H150" fill="none" stroke="rgba(6,182,212,0.38)" stroke-width="2"/><path d="M0 120 H50 L80 90 H150" fill="none" stroke="rgba(236,72,153,0.38)" stroke-width="2"/><path d="M30 0 V60 L60 90 V150" fill="none" stroke="rgba(245,158,11,0.38)" stroke-width="2"/><path d="M120 0 V50 L90 80 V150" fill="none" stroke="rgba(16,185,129,0.38)" stroke-width="2"/><circle cx="60" cy="60" r="3.5" fill="#06b6d4"/><circle cx="80" cy="90" r="3.5" fill="#ec4899"/><circle cx="60" cy="90" r="3.5" fill="#f59e0b"/><circle cx="90" cy="80" r="3.5" fill="#10b981"/></svg>`
        },
        vortex: {
            name: 'Hyperspace Warp',
            desc: 'Wormhole Star Tunnel',
            bgColor: '#04020a',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><ellipse cx="80" cy="80" rx="70" ry="60" fill="none" stroke="rgba(168,85,247,0.22)" stroke-width="1.2"/><ellipse cx="80" cy="80" rx="50" ry="40" transform="rotate(20 80 80)" fill="none" stroke="rgba(147,51,234,0.28)" stroke-width="1.3"/><ellipse cx="80" cy="80" rx="32" ry="24" transform="rotate(40 80 80)" fill="none" stroke="rgba(99,102,241,0.32)" stroke-width="1.4"/><ellipse cx="80" cy="80" rx="16" ry="11" transform="rotate(60 80 80)" fill="none" stroke="rgba(56,189,248,0.42)" stroke-width="1.5"/><circle cx="80" cy="80" r="3" fill="#38bdf8"/></svg>`
        },
        aurora_ribbon: {
            name: 'Polar Curtains',
            desc: 'Ethereal Northern Lights',
            bgColor: '#020e0c',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><path d="M10 20 Q45 80, 80 40 T150 50 L150 140 Q115 100, 80 140 T10 130 Z" fill="rgba(16,185,129,0.14)" stroke="rgba(16,185,129,0.38)" stroke-width="1.5"/><path d="M20 40 Q60 100, 95 60 T160 70 L160 120 Q125 80, 95 120 T20 110 Z" fill="rgba(168,85,247,0.14)" stroke="rgba(168,85,247,0.38)" stroke-width="1.5"/></svg>`
        },
        blackhole: {
            name: 'Event Horizon',
            desc: 'Relativistic Singularity',
            bgColor: '#020005',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><ellipse cx="80" cy="80" rx="72" ry="32" fill="none" stroke="rgba(245,158,11,0.4)" stroke-width="2.5"/><ellipse cx="80" cy="80" rx="55" ry="24" fill="none" stroke="rgba(251,191,36,0.55)" stroke-width="2"/><ellipse cx="80" cy="80" rx="38" ry="16" fill="none" stroke="rgba(254,240,138,0.7)" stroke-width="1.8"/><circle cx="80" cy="80" r="20" fill="#000"/><circle cx="80" cy="80" r="21" fill="none" stroke="rgba(245,158,11,0.9)" stroke-width="1.5"/><line x1="80" y1="10" x2="80" y2="50" stroke="rgba(56,189,248,0.6)" stroke-width="1.5"/><line x1="80" y1="110" x2="80" y2="150" stroke="rgba(56,189,248,0.6)" stroke-width="1.5"/></svg>`
        },
        circuit_gold: {
            name: 'Royal Circuit',
            desc: '24K Gold Motherboard',
            bgColor: '#090703',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M15 15 H50 L80 45 H125" fill="none" stroke="rgba(251,191,36,0.45)" stroke-width="2"/><path d="M125 15 H90 L60 45 H15" fill="none" stroke="rgba(217,119,6,0.4)" stroke-width="1.8"/><path d="M15 125 H50 L80 95 H125" fill="none" stroke="rgba(251,191,36,0.45)" stroke-width="2"/><path d="M70 0 V40 M70 100 V140" fill="none" stroke="rgba(245,158,11,0.4)" stroke-width="2"/><rect x="52" y="52" width="36" height="36" rx="4" fill="none" stroke="rgba(251,191,36,0.6)" stroke-width="2"/><circle cx="15" cy="15" r="3" fill="#fbbf24"/><circle cx="125" cy="15" r="3" fill="#fbbf24"/><circle cx="15" cy="125" r="3" fill="#fbbf24"/><circle cx="125" cy="125" r="3" fill="#fbbf24"/><circle cx="70" cy="70" r="4" fill="#fbbf24"/></svg>`
        },
        liquid_mercury: {
            name: 'Liquid Mercury',
            desc: 'Fluid Chrome Ripples',
            bgColor: '#050508',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><path d="M0 45 Q35 20, 75 45 T150 45" fill="none" stroke="rgba(228,228,231,0.4)" stroke-width="2.2"/><path d="M0 90 Q40 115, 75 90 T150 90" fill="none" stroke="rgba(148,163,184,0.38)" stroke-width="2"/><circle cx="35" cy="75" r="10" fill="rgba(228,228,231,0.35)" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><circle cx="115" cy="65" r="14" fill="rgba(148,163,184,0.3)" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/><circle cx="75" cy="125" r="7" fill="rgba(228,228,231,0.3)" stroke="rgba(255,255,255,0.5)" stroke-width="1.2"/></svg>`
        },
        crystal_lattice: {
            name: 'Emerald Lattice',
            desc: 'Hexagonal Beryl Prisms',
            bgColor: '#010c08',
            bgSize: '130px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="130" height="150" viewBox="0 0 130 150"><polygon points="65,15 110,40 110,90 65,115 20,90 20,40" fill="rgba(5,150,105,0.12)" stroke="rgba(52,211,153,0.45)" stroke-width="1.8"/><polygon points="65,35 95,52 95,85 65,102 35,85 35,52" fill="none" stroke="rgba(16,185,129,0.35)" stroke-width="1.2"/><line x1="65" y1="15" x2="65" y2="35" stroke="rgba(52,211,153,0.5)" stroke-width="1.5"/><line x1="110" y1="40" x2="95" y2="52" stroke="rgba(52,211,153,0.5)" stroke-width="1.5"/><line x1="110" y1="90" x2="95" y2="85" stroke="rgba(52,211,153,0.5)" stroke-width="1.5"/><line x1="65" y1="115" x2="65" y2="102" stroke="rgba(52,211,153,0.5)" stroke-width="1.5"/><line x1="20" y1="90" x2="35" y2="85" stroke="rgba(52,211,153,0.5)" stroke-width="1.5"/><line x1="20" y1="40" x2="35" y2="52" stroke="rgba(52,211,153,0.5)" stroke-width="1.5"/><circle cx="65" cy="68" r="4" fill="#34d399"/></svg>`
        },
        hologram_globe: {
            name: 'Holo Terrestrial',
            desc: '3D Wireframe Cyber Earth',
            bgColor: '#020914',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><circle cx="75" cy="75" r="55" fill="none" stroke="rgba(6,182,212,0.45)" stroke-width="1.8"/><ellipse cx="75" cy="75" rx="55" ry="24" fill="none" stroke="rgba(56,189,248,0.35)" stroke-width="1.2"/><ellipse cx="75" cy="75" rx="24" ry="55" fill="none" stroke="rgba(56,189,248,0.35)" stroke-width="1.2"/><ellipse cx="75" cy="75" rx="55" ry="42" fill="none" stroke="rgba(6,182,212,0.22)" stroke-width="1"/><line x1="20" y1="75" x2="130" y2="75" stroke="rgba(6,182,212,0.4)" stroke-width="1.2"/><line x1="75" y1="20" x2="75" y2="130" stroke="rgba(6,182,212,0.4)" stroke-width="1.2"/><circle cx="75" cy="51" r="3" fill="#38bdf8"/><circle cx="99" cy="75" r="3" fill="#06b6d4"/></svg>`
        },
        neon_poly: {
            name: 'Neon Low-Poly',
            desc: 'Crystalline Violet Peaks',
            bgColor: '#080214',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><polygon points="20,20 70,50 40,90" fill="rgba(168,85,247,0.18)" stroke="rgba(168,85,247,0.5)" stroke-width="1.4"/><polygon points="70,50 120,20 100,80" fill="rgba(236,72,153,0.18)" stroke="rgba(236,72,153,0.5)" stroke-width="1.4"/><polygon points="70,50 100,80 70,120" fill="rgba(99,102,241,0.2)" stroke="rgba(99,102,241,0.5)" stroke-width="1.4"/><polygon points="70,50 70,120 40,90" fill="rgba(168,85,247,0.25)" stroke="rgba(168,85,247,0.55)" stroke-width="1.4"/><circle cx="70" cy="50" r="3.5" fill="#f472b6"/><circle cx="40" cy="90" r="3" fill="#a855f7"/><circle cx="100" cy="80" r="3" fill="#818cf8"/></svg>`
        },
        sakura: {
            name: 'Sakura Drift',
            desc: 'Twilight Cherry Petals',
            bgColor: '#08050e',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M40 30 C30 15, 15 25, 25 40 C15 50, 30 65, 40 50 C50 65, 65 50, 55 40 C65 25, 50 15, 40 30 Z" fill="rgba(244,114,182,0.3)" stroke="rgba(251,113,133,0.5)" stroke-width="1.2"/><path d="M100 80 C93 70, 82 77, 89 87 C82 94, 93 104, 100 94 C107 104, 118 94, 111 87 C118 77, 107 70, 100 80 Z" fill="rgba(244,114,182,0.25)" stroke="rgba(251,113,133,0.45)" stroke-width="1.2"/><ellipse cx="50" cy="110" rx="8" ry="4" transform="rotate(-30 50 110)" fill="rgba(253,242,248,0.4)" stroke="rgba(244,114,182,0.6)" stroke-width="1"/><ellipse cx="110" cy="35" rx="7" ry="3.5" transform="rotate(25 110 35)" fill="rgba(253,242,248,0.4)" stroke="rgba(244,114,182,0.6)" stroke-width="1"/></svg>`
        },
        fractal_tree: {
            name: 'L-System Fractal',
            desc: 'Branching Tree of Light',
            bgColor: '#030c10',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><line x1="75" y1="140" x2="75" y2="90" stroke="rgba(45,212,191,0.6)" stroke-width="2.5"/><line x1="75" y1="90" x2="50" y2="60" stroke="rgba(45,212,191,0.5)" stroke-width="2"/><line x1="75" y1="90" x2="100" y2="60" stroke="rgba(45,212,191,0.5)" stroke-width="2"/><line x1="50" y1="60" x2="35" y2="35" stroke="rgba(52,211,153,0.45)" stroke-width="1.5"/><line x1="50" y1="60" x2="60" y2="35" stroke="rgba(52,211,153,0.45)" stroke-width="1.5"/><line x1="100" y1="60" x2="90" y2="35" stroke="rgba(52,211,153,0.45)" stroke-width="1.5"/><line x1="100" y1="60" x2="115" y2="35" stroke="rgba(52,211,153,0.45)" stroke-width="1.5"/><circle cx="35" cy="35" r="3" fill="#fbbf24"/><circle cx="60" cy="35" r="3" fill="#fbbf24"/><circle cx="90" cy="35" r="3" fill="#fbbf24"/><circle cx="115" cy="35" r="3" fill="#fbbf24"/></svg>`
        },
        superconductor: {
            name: 'Quantum Flux',
            desc: 'Meissner Levitation Lines',
            bgColor: '#030718',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><path d="M10 75 Q75 15, 140 75" fill="none" stroke="rgba(56,189,248,0.5)" stroke-width="2"/><path d="M10 75 Q75 135, 140 75" fill="none" stroke="rgba(56,189,248,0.5)" stroke-width="2"/><path d="M25 75 Q75 35, 125 75" fill="none" stroke="rgba(37,99,235,0.45)" stroke-width="1.8"/><path d="M25 75 Q75 115, 125 75" fill="none" stroke="rgba(37,99,235,0.45)" stroke-width="1.8"/><polygon points="75,55 95,75 75,95 55,75" fill="rgba(56,189,248,0.25)" stroke="#38bdf8" stroke-width="2"/><circle cx="75" cy="75" r="4" fill="#ffffff"/></svg>`
        },
        astrolabe: {
            name: 'Astrolabe Chrono',
            desc: 'Renaissance Celestial Gears',
            bgColor: '#0d0802',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><circle cx="80" cy="80" r="65" fill="none" stroke="rgba(217,119,6,0.5)" stroke-width="2.2"/><circle cx="80" cy="80" r="50" fill="none" stroke="rgba(245,158,11,0.4)" stroke-width="1.5"/><circle cx="80" cy="80" r="35" fill="none" stroke="rgba(251,191,36,0.4)" stroke-width="1.5"/><circle cx="80" cy="80" r="18" fill="rgba(217,119,6,0.15)" stroke="rgba(245,158,11,0.6)" stroke-width="1.8"/><line x1="80" y1="15" x2="80" y2="145" stroke="rgba(217,119,6,0.3)" stroke-width="1"/><line x1="15" y1="80" x2="145" y2="80" stroke="rgba(217,119,6,0.3)" stroke-width="1"/><line x1="80" y1="80" x2="115" y2="45" stroke="#fbbf24" stroke-width="2.5"/><circle cx="80" cy="80" r="5" fill="#fef08a"/></svg>`
        },
        deep_abyss: {
            name: 'Deep Abyss',
            desc: 'Bioluminescent Jellyfish',
            bgColor: '#010512',
            bgSize: '150px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="160" viewBox="0 0 150 160"><path d="M40 60 Q75 15, 110 60 Q95 70, 75 65 Q55 70, 40 60 Z" fill="rgba(34,211,238,0.22)" stroke="rgba(34,211,238,0.6)" stroke-width="1.8"/><path d="M50 65 Q45 110, 55 145" fill="none" stroke="rgba(192,132,252,0.45)" stroke-width="1.5"/><path d="M65 65 Q60 100, 70 140" fill="none" stroke="rgba(34,211,238,0.55)" stroke-width="1.5"/><path d="M85 65 Q90 100, 80 140" fill="none" stroke="rgba(34,211,238,0.55)" stroke-width="1.5"/><path d="M100 65 Q105 110, 95 145" fill="none" stroke="rgba(192,132,252,0.45)" stroke-width="1.5"/><circle cx="65" cy="50" r="3" fill="#22d3ee"/><circle cx="85" cy="50" r="3" fill="#22d3ee"/></svg>`
        },
        particle_vortex: {
            name: 'Stellar Whirlpool',
            desc: 'Orbital Particle Convergence',
            bgColor: '#060210',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><path d="M80 80 Q110 60, 130 90 T70 140 T25 80 T80 20 T150 80" fill="none" stroke="rgba(139,92,246,0.4)" stroke-width="1.8"/><circle cx="130" cy="90" r="3" fill="#d946ef"/><circle cx="70" cy="140" r="2.5" fill="#06b6d4"/><circle cx="25" cy="80" r="3" fill="#8b5cf6"/><circle cx="80" cy="20" r="3.5" fill="#f43f5e"/><circle cx="80" cy="80" r="6" fill="#ffffff" stroke="#8b5cf6" stroke-width="2"/></svg>`
        },
        quantum_cube: {
            name: 'Rubik Quantum',
            desc: '4D Translucent Hypercube',
            bgColor: '#080c14',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><polygon points="70,25 110,48 70,71 30,48" fill="rgba(0,240,255,0.18)" stroke="rgba(0,240,255,0.6)" stroke-width="1.8"/><polygon points="30,48 70,71 70,117 30,94" fill="rgba(255,0,127,0.18)" stroke="rgba(255,0,127,0.6)" stroke-width="1.8"/><polygon points="70,71 110,48 110,94 70,117" fill="rgba(57,255,20,0.18)" stroke="rgba(57,255,20,0.6)" stroke-width="1.8"/><circle cx="70" cy="71" r="5" fill="#ffffff"/></svg>`
        },
        art_deco: {
            name: 'Gatsby Deco',
            desc: '1920s Golden Sunburst Arches',
            bgColor: '#08080a',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M10 130 Q70 10, 130 130" fill="none" stroke="rgba(250,204,21,0.5)" stroke-width="2.2"/><path d="M25 130 Q70 35, 115 130" fill="none" stroke="rgba(202,138,4,0.45)" stroke-width="1.8"/><path d="M40 130 Q70 60, 100 130" fill="none" stroke="rgba(250,204,21,0.4)" stroke-width="1.5"/><line x1="70" y1="20" x2="70" y2="130" stroke="rgba(250,204,21,0.45)" stroke-width="1.8"/><line x1="40" y1="45" x2="70" y2="130" stroke="rgba(202,138,4,0.35)" stroke-width="1.5"/><line x1="100" y1="45" x2="70" y2="130" stroke="rgba(202,138,4,0.35)" stroke-width="1.5"/></svg>`
        },
        chrono_halo: {
            name: 'Chrono Halo',
            desc: 'Spectral Aberration Rings',
            bgColor: '#02040c',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><ellipse cx="75" cy="75" rx="60" ry="45" fill="none" stroke="rgba(239,68,68,0.45)" stroke-width="1.6"/><ellipse cx="75" cy="75" rx="55" ry="41" fill="none" stroke="rgba(234,179,8,0.45)" stroke-width="1.6"/><ellipse cx="75" cy="75" rx="50" ry="37" fill="none" stroke="rgba(16,185,129,0.45)" stroke-width="1.6"/><ellipse cx="75" cy="75" rx="45" ry="33" fill="none" stroke="rgba(6,182,212,0.55)" stroke-width="1.8"/><ellipse cx="75" cy="75" rx="40" ry="29" fill="none" stroke="rgba(139,92,246,0.45)" stroke-width="1.6"/><line x1="15" y1="75" x2="135" y2="75" stroke="rgba(255,255,255,0.7)" stroke-width="1.5"/></svg>`
        },
        solar_corona: {
            name: 'Magnetic Corona',
            desc: 'Incandescent Plasma Loops',
            bgColor: '#0f0302',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><path d="M15 135 Q50 30, 85 135" fill="none" stroke="rgba(239,68,68,0.55)" stroke-width="2.2"/><path d="M65 135 Q105 45, 135 135" fill="none" stroke="rgba(249,115,22,0.55)" stroke-width="2.2"/><path d="M30 135 Q65 60, 95 135" fill="none" stroke="rgba(250,204,21,0.6)" stroke-width="1.8"/><circle cx="50" cy="80" r="3.5" fill="#facc15"/><circle cx="105" cy="90" r="3.5" fill="#f97316"/><rect x="0" y="135" width="150" height="15" fill="#180402"/></svg>`
        },
        zen_garden: {
            name: 'Zen Sand Garden',
            desc: 'Meditative Raked Waves',
            bgColor: '#070a0e',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><path d="M0 40 Q80 20, 160 40 M0 80 Q80 60, 160 80 M0 120 Q80 100, 160 120" fill="none" stroke="rgba(148,163,184,0.3)" stroke-width="1.8"/><circle cx="50" cy="75" r="14" fill="rgba(30,41,59,0.9)" stroke="rgba(203,213,225,0.4)" stroke-width="1.5"/><circle cx="120" cy="60" r="10" fill="rgba(30,41,59,0.9)" stroke="rgba(203,213,225,0.4)" stroke-width="1.5"/><circle cx="50" cy="75" r="26" fill="none" stroke="rgba(148,163,184,0.35)" stroke-width="1.4"/><circle cx="50" cy="75" r="38" fill="none" stroke="rgba(148,163,184,0.25)" stroke-width="1.2"/><circle cx="120" cy="60" r="20" fill="none" stroke="rgba(148,163,184,0.35)" stroke-width="1.4"/></svg>`
        },
        koi_pond: {
            name: 'Bioluminescent Koi',
            desc: 'Serene Deep Waters',
            bgColor: '#020b12',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><path d="M45 110 Q65 70, 95 65 Q115 60, 120 40 Q95 50, 70 75 Q50 95, 45 110 Z" fill="rgba(6,182,212,0.3)" stroke="rgba(56,189,248,0.7)" stroke-width="1.5"/><path d="M95 65 Q110 80, 125 75 Q105 70, 95 65 Z" fill="rgba(244,114,182,0.4)" stroke="#f472b6" stroke-width="1"/><circle cx="35" cy="45" r="24" fill="rgba(16,185,129,0.18)" stroke="rgba(52,211,153,0.5)" stroke-width="1.4"/><path d="M35 45 L50 35" stroke="#020b12" stroke-width="2"/><circle cx="35" cy="45" r="3" fill="#34d399"/></svg>`
        },
        fireflies: {
            name: 'Enchanted Fireflies',
            desc: 'Twilight Meadow Drift',
            bgColor: '#040a08',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><circle cx="45" cy="50" r="18" fill="rgba(250,204,21,0.1)"/><circle cx="45" cy="50" r="4" fill="#fde047" stroke="rgba(250,204,21,0.8)" stroke-width="2"/><circle cx="110" cy="85" r="22" fill="rgba(74,222,128,0.1)"/><circle cx="110" cy="85" r="4.5" fill="#4ade80" stroke="rgba(74,222,128,0.8)" stroke-width="2"/><circle cx="80" cy="120" r="14" fill="rgba(250,204,21,0.08)"/><circle cx="80" cy="120" r="3" fill="#facc15"/><circle cx="125" cy="35" r="12" fill="rgba(74,222,128,0.08)"/><circle cx="125" cy="35" r="2.5" fill="#86efac"/></svg>`
        },
        rain_window: {
            name: 'Rain on Glass',
            desc: 'Calming Water Droplets',
            bgColor: '#06080e',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><line x1="30" y1="20" x2="30" y2="80" stroke="rgba(148,163,184,0.3)" stroke-width="2" stroke-linecap="round"/><ellipse cx="30" cy="84" rx="4" ry="6" fill="rgba(226,232,240,0.6)"/><line x1="85" y1="40" x2="85" y2="120" stroke="rgba(148,163,184,0.25)" stroke-width="2.5" stroke-linecap="round"/><ellipse cx="85" cy="124" rx="5" ry="7" fill="rgba(226,232,240,0.6)"/><ellipse cx="115" cy="45" rx="3.5" ry="4.5" fill="rgba(226,232,240,0.4)"/><ellipse cx="55" cy="110" rx="3" ry="4" fill="rgba(226,232,240,0.35)"/></svg>`
        },
        mandala_breathe: {
            name: 'Sacred Mandala',
            desc: 'Meditative Gear Morph',
            bgColor: '#080703',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><circle cx="80" cy="80" r="60" fill="none" stroke="rgba(251,191,36,0.4)" stroke-width="1.6"/><circle cx="80" cy="80" r="42" fill="none" stroke="rgba(245,158,11,0.45)" stroke-width="1.4"/><circle cx="80" cy="80" r="24" fill="none" stroke="rgba(252,211,77,0.55)" stroke-width="1.6"/><polygon points="80,20 95,65 140,80 95,95 80,140 65,95 20,80 65,65" fill="rgba(217,119,6,0.12)" stroke="rgba(251,191,36,0.6)" stroke-width="1.4"/><circle cx="80" cy="80" r="6" fill="#fef08a"/></svg>`
        },
        silk_flow: {
            name: 'Liquid Silk Waves',
            desc: 'Ethereal Satin Ribbons',
            bgColor: '#06020c',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><path d="M-20 40 Q40 110, 90 50 T180 60 L180 100 Q130 90, 90 140 T-20 80 Z" fill="rgba(168,85,247,0.22)" stroke="rgba(192,132,252,0.5)" stroke-width="1.5"/><path d="M-20 80 Q50 140, 100 80 T180 110 L180 140 Q130 110, 100 160 T-20 120 Z" fill="rgba(244,114,182,0.18)" stroke="rgba(244,114,182,0.5)" stroke-width="1.5"/></svg>`
        },
        celestial_clock: {
            name: 'Orrery Spheres',
            desc: 'Harmonious Astrometry',
            bgColor: '#02040b',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><circle cx="80" cy="80" r="68" fill="none" stroke="rgba(56,189,248,0.3)" stroke-width="1.2"/><circle cx="80" cy="80" r="48" fill="none" stroke="rgba(129,140,248,0.35)" stroke-width="1.2"/><circle cx="80" cy="80" r="28" fill="none" stroke="rgba(251,191,36,0.4)" stroke-width="1.4"/><circle cx="80" cy="80" r="8" fill="#fbbf24"/><circle cx="108" cy="80" r="4" fill="#38bdf8"/><circle cx="80" cy="32" r="5" fill="#a78bfa"/><circle cx="32" cy="80" r="6" fill="#34d399"/><line x1="80" y1="80" x2="108" y2="80" stroke="rgba(255,255,255,0.4)" stroke-width="1"/></svg>`
        },
        ferrofluid: {
            name: 'Magnetic Ferrofluid',
            desc: 'Velvet Liquid Chrome',
            bgColor: '#050608',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><path d="M75 25 Q85 55, 105 45 Q100 65, 125 75 Q100 85, 105 105 Q85 95, 75 125 Q65 95, 45 105 Q50 85, 25 75 Q50 65, 45 45 Q65 55, 75 25 Z" fill="rgba(71,85,105,0.35)" stroke="rgba(226,232,240,0.6)" stroke-width="1.8"/><circle cx="75" cy="75" r="22" fill="rgba(15,23,42,0.9)" stroke="rgba(255,255,255,0.5)" stroke-width="1.5"/><circle cx="75" cy="75" r="7" fill="#ffffff"/></svg>`
        },
        ocean_caustics: {
            name: 'Ocean Caustics',
            desc: 'Sunlit Coral Reef',
            bgColor: '#010d14',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><path d="M20 30 Q50 60, 80 20 T140 40 Q110 80, 130 120 T70 130 Q50 90, 20 120 T20 30 Z" fill="none" stroke="rgba(6,182,212,0.45)" stroke-width="2"/><path d="M45 50 Q75 30, 95 65 T55 105 Z" fill="rgba(6,182,212,0.12)" stroke="rgba(56,189,248,0.5)" stroke-width="1.6"/><circle cx="75" cy="65" r="4" fill="#a5f3fc"/></svg>`
        },
        sand_dune_drift: {
            name: 'Stardust Dunes',
            desc: 'Wind-Swept Sahara Curves',
            bgColor: '#0b0602',
            bgSize: '160px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="150" viewBox="0 0 160 150"><path d="M0 60 Q45 25, 95 55 T160 35 L160 150 L0 150 Z" fill="rgba(217,119,6,0.2)" stroke="rgba(245,158,11,0.55)" stroke-width="1.8"/><path d="M0 95 Q60 65, 115 100 T160 85 L160 150 L0 150 Z" fill="rgba(180,83,9,0.3)" stroke="rgba(251,191,36,0.6)" stroke-width="2"/><circle cx="120" cy="30" r="2.5" fill="#fef08a"/><circle cx="45" cy="20" r="2" fill="#fde047"/><circle cx="75" cy="15" r="1.5" fill="#ffffff"/></svg>`
        },
        harmonic_pendulum: {
            name: 'Harmonic Pendulums',
            desc: 'Snake Wave Convergence',
            bgColor: '#030208',
            bgSize: '150px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="160" viewBox="0 0 150 160"><line x1="20" y1="20" x2="130" y2="20" stroke="rgba(148,163,184,0.4)" stroke-width="2"/><circle cx="35" cy="55" r="5" fill="#f43f5e"/><circle cx="50" cy="75" r="5" fill="#fb923c"/><circle cx="65" cy="95" r="5" fill="#facc15"/><circle cx="80" cy="115" r="5" fill="#4ade80"/><circle cx="95" cy="100" r="5" fill="#38bdf8"/><circle cx="110" cy="80" r="5" fill="#a855f7"/><path d="M35 55 Q65 115, 80 115 T110 80" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.2" stroke-dasharray="3,3"/></svg>`
        },
        biolum_waves: {
            name: 'Bioluminescent Surf',
            desc: 'Electric Plankton Tides',
            bgColor: '#010810',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><path d="M0 60 Q35 40, 75 60 T150 60" fill="none" stroke="rgba(6,182,212,0.6)" stroke-width="2.2"/><path d="M0 95 Q40 75, 80 95 T150 95" fill="none" stroke="rgba(56,189,248,0.7)" stroke-width="2.5"/><circle cx="35" cy="48" r="2.5" fill="#22d3ee"/><circle cx="75" cy="60" r="3" fill="#67e8f9"/><circle cx="115" cy="52" r="2.5" fill="#22d3ee"/><circle cx="45" cy="85" r="3" fill="#38bdf8"/><circle cx="95" cy="95" r="3.5" fill="#a5f3fc"/><circle cx="130" cy="88" r="2.5" fill="#38bdf8"/></svg>`
        },
        autumn_amber: {
            name: 'Autumn Drift',
            desc: 'Floating Maple Canopy',
            bgColor: '#0c0603',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M45 25 Q35 45, 55 55 Q35 60, 45 75 Q60 65, 70 85 Q75 65, 90 70 Q80 55, 95 45 Q75 40, 70 20 Q60 35, 45 25 Z" fill="rgba(249,115,22,0.3)" stroke="rgba(251,146,60,0.7)" stroke-width="1.5"/><path d="M95 90 Q85 105, 100 115 Q85 120, 95 130 Q105 125, 115 135 Q115 120, 125 125 Q120 110, 130 105 Q115 105, 110 90 Q105 100, 95 90 Z" fill="rgba(234,179,8,0.3)" stroke="rgba(250,204,21,0.7)" stroke-width="1.5"/><circle cx="70" cy="55" r="3" fill="#fb923c"/></svg>`
        },
        nebula_cloud: {
            name: 'Cosmic Stargaze',
            desc: 'Deep Space Chromatic Gas',
            bgColor: '#020108',
            bgSize: '160px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><ellipse cx="65" cy="70" rx="55" ry="35" transform="rotate(-20 65 70)" fill="rgba(217,70,239,0.18)" stroke="rgba(232,121,249,0.4)" stroke-width="1.5"/><ellipse cx="95" cy="85" rx="50" ry="30" transform="rotate(25 95 85)" fill="rgba(6,182,212,0.18)" stroke="rgba(103,232,249,0.4)" stroke-width="1.5"/><circle cx="65" cy="55" r="3.5" fill="#ffffff"/><line x1="65" y1="47" x2="65" y2="63" stroke="#fff" stroke-width="1"/><line x1="57" y1="55" x2="73" y2="55" stroke="#fff" stroke-width="1"/><circle cx="105" cy="95" r="2.5" fill="#fbcfe8"/><circle cx="35" cy="105" r="2" fill="#a5f3fc"/></svg>`
        },
        kinetic_chime: {
            name: 'Kinetic Mobiles',
            desc: 'Calder Wind Balance',
            bgColor: '#07070a',
            bgSize: '150px 160px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="160" viewBox="0 0 150 160"><line x1="75" y1="10" x2="75" y2="40" stroke="rgba(250,204,21,0.6)" stroke-width="1.5"/><line x1="30" y1="40" x2="120" y2="40" stroke="rgba(250,204,21,0.8)" stroke-width="2"/><line x1="30" y1="40" x2="30" y2="70" stroke="rgba(250,204,21,0.5)" stroke-width="1.2"/><circle cx="30" cy="78" r="9" fill="rgba(244,63,94,0.4)" stroke="#f43f5e" stroke-width="1.5"/><line x1="120" y1="40" x2="120" y2="65" stroke="rgba(250,204,21,0.5)" stroke-width="1.2"/><line x1="90" y1="65" x2="140" y2="65" stroke="rgba(250,204,21,0.7)" stroke-width="1.5"/><circle cx="90" cy="95" r="7" fill="rgba(6,182,212,0.4)" stroke="#06b6d4" stroke-width="1.5"/><circle cx="140" cy="85" r="11" fill="rgba(250,204,21,0.35)" stroke="#facc15" stroke-width="1.5"/></svg>`
        },
        prism_caustic: {
            name: 'Prism Caustics',
            desc: 'Wandering Spectral Bands',
            bgColor: '#040406',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><path d="M15 45 Q75 15, 135 65" fill="none" stroke="rgba(239,68,68,0.6)" stroke-width="3"/><path d="M15 55 Q75 25, 135 75" fill="none" stroke="rgba(234,179,8,0.6)" stroke-width="3"/><path d="M15 65 Q75 35, 135 85" fill="none" stroke="rgba(34,197,94,0.6)" stroke-width="3"/><path d="M15 75 Q75 45, 135 95" fill="none" stroke="rgba(6,182,212,0.6)" stroke-width="3"/><path d="M15 85 Q75 55, 135 105" fill="none" stroke="rgba(168,85,247,0.6)" stroke-width="3"/></svg>`
        },
        stained_glass: {
            name: 'Cathedral Glass',
            desc: 'Gothic Polygons & Jewel Beams',
            bgColor: '#06060c',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><polygon points="40,20 70,50 40,80 10,50" fill="rgba(185,28,28,0.4)" stroke="#ef4444" stroke-width="1.8"/><polygon points="70,50 100,20 130,50 100,80" fill="rgba(29,78,216,0.4)" stroke="#3b82f6" stroke-width="1.8"/><polygon points="40,80 70,110 40,140 10,110" fill="rgba(4,120,87,0.4)" stroke="#10b981" stroke-width="1.8"/><polygon points="70,110 100,80 130,110 100,140" fill="rgba(180,83,9,0.4)" stroke="#f59e0b" stroke-width="1.8"/><line x1="70" y1="10" x2="70" y2="140" stroke="#000" stroke-width="2.5"/></svg>`
        },
        circuit_board: {
            name: 'Cyberpunk PCB',
            desc: 'Gold Bus Lines & Data Packets',
            bgColor: '#040907',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><path d="M20 30 L60 30 L80 50 L130 50" fill="none" stroke="#eab308" stroke-width="2.5"/><path d="M20 90 L70 90 L90 70 L130 70" fill="none" stroke="#06b6d4" stroke-width="2.5"/><rect x="45" y="55" width="30" height="30" fill="rgba(234,179,8,0.2)" stroke="#eab308" stroke-width="1.8"/><line x1="52" y1="50" x2="52" y2="55" stroke="#eab308" stroke-width="1.5"/><line x1="68" y1="50" x2="68" y2="55" stroke="#eab308" stroke-width="1.5"/><line x1="52" y1="85" x2="52" y2="90" stroke="#eab308" stroke-width="1.5"/><line x1="68" y1="85" x2="68" y2="90" stroke="#eab308" stroke-width="1.5"/></svg>`
        },
        topographic_canyon: {
            name: 'Canyon Strata',
            desc: 'Hypnotic Sandstone Contour Bands',
            bgColor: '#120703',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><path d="M0 25 Q40 10, 80 30 T150 20" fill="none" stroke="#c2410c" stroke-width="2.5"/><path d="M0 55 Q45 75, 85 50 T150 65" fill="none" stroke="#ea580c" stroke-width="2.5"/><path d="M0 90 Q35 70, 75 95 T150 85" fill="none" stroke="#d97706" stroke-width="2.5"/><path d="M0 125 Q50 140, 95 120 T150 130" fill="none" stroke="#ca8a04" stroke-width="2.5"/></svg>`
        },
        sumi_mountains: {
            name: 'Sumi-e Ink Fog',
            desc: 'Japanese Layered Mountain Ridges',
            bgColor: '#080a0f',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><path d="M0 70 L35 45 L70 65 L110 35 L150 65 L150 150 L0 150 Z" fill="rgba(148,163,184,0.22)" stroke="rgba(148,163,184,0.6)" stroke-width="1.5"/><path d="M0 105 L45 85 L85 100 L125 80 L150 95 L150 150 L0 150 Z" fill="rgba(71,85,105,0.35)" stroke="rgba(100,116,139,0.8)" stroke-width="1.8"/></svg>`
        },
        shoji_bamboo: {
            name: 'Shoji Bamboo',
            desc: 'Wind-Swayed Shadows on Rice Paper',
            bgColor: '#16120d',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><line x1="0" y1="50" x2="150" y2="50" stroke="rgba(217,119,6,0.4)" stroke-width="1.5"/><line x1="0" y1="100" x2="150" y2="100" stroke="rgba(217,119,6,0.4)" stroke-width="1.5"/><line x1="75" y1="0" x2="75" y2="150" stroke="rgba(217,119,6,0.4)" stroke-width="1.5"/><line x1="45" y1="15" x2="45" y2="140" stroke="#16a34a" stroke-width="3"/><path d="M45 50 Q65 40, 75 45 Q65 52, 45 50 Z" fill="#22c55e"/><path d="M45 95 Q25 85, 15 90 Q25 97, 45 95 Z" fill="#22c55e"/></svg>`
        },
        synthwave_grid: {
            name: 'Outrun Highway',
            desc: 'Infinite 3D Neon Horizon Grid',
            bgColor: '#090314',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><line x1="0" y1="80" x2="150" y2="80" stroke="#ec4899" stroke-width="2.5"/><line x1="75" y1="80" x2="0" y2="150" stroke="#a855f7" stroke-width="1.8"/><line x1="75" y1="80" x2="40" y2="150" stroke="#a855f7" stroke-width="1.8"/><line x1="75" y1="80" x2="75" y2="150" stroke="#a855f7" stroke-width="1.8"/><line x1="75" y1="80" x2="110" y2="150" stroke="#a855f7" stroke-width="1.8"/><line x1="75" y1="80" x2="150" y2="150" stroke="#a855f7" stroke-width="1.8"/><line x1="15" y1="100" x2="135" y2="100" stroke="#06b6d4" stroke-width="1.5"/><line x1="5" y1="122" x2="145" y2="122" stroke="#06b6d4" stroke-width="1.8"/><line x1="0" y1="145" x2="150" y2="145" stroke="#06b6d4" stroke-width="2"/></svg>`
        },
        bauhaus_canvas: {
            name: 'De Stijl Canvas',
            desc: 'Mondrian Modernist Geometry',
            bgColor: '#101014',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><rect x="15" y="15" width="55" height="50" fill="#dc2626"/><rect x="75" y="15" width="50" height="75" fill="#2563eb"/><rect x="15" y="70" width="55" height="55" fill="#f5f5f4"/><rect x="75" y="95" width="50" height="30" fill="#eab308"/><line x1="70" y1="10" x2="70" y2="130" stroke="#000" stroke-width="4"/><line x1="10" y1="65" x2="130" y2="65" stroke="#000" stroke-width="4"/><line x1="70" y1="90" x2="130" y2="90" stroke="#000" stroke-width="4"/></svg>`
        },
        audio_spectrogram: {
            name: 'Audio Waterfall',
            desc: 'Spectral Cascading Resonance',
            bgColor: '#030206',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><rect x="15" y="20" width="110" height="12" fill="#4f46e5"/><rect x="15" y="36" width="110" height="12" fill="#7c3aed"/><rect x="15" y="52" width="110" height="12" fill="#db2777"/><rect x="15" y="68" width="110" height="12" fill="#ea580c"/><rect x="15" y="84" width="110" height="12" fill="#ca8a04"/><rect x="15" y="100" width="110" height="12" fill="#16a34a"/><rect x="15" y="116" width="110" height="12" fill="#0284c7"/></svg>`
        },
        weaving_loom: {
            name: 'Jacquard Weave',
            desc: 'Interlaced Tartan Textile Threads',
            bgColor: '#0a0d0a',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><line x1="28" y1="10" x2="28" y2="130" stroke="#15803d" stroke-width="7"/><line x1="52" y1="10" x2="52" y2="130" stroke="#1e3a8a" stroke-width="7"/><line x1="76" y1="10" x2="76" y2="130" stroke="#b91c1c" stroke-width="7"/><line x1="100" y1="10" x2="100" y2="130" stroke="#ca8a04" stroke-width="7"/><line x1="10" y1="35" x2="130" y2="35" stroke="rgba(244,63,94,0.7)" stroke-width="6"/><line x1="10" y1="70" x2="130" y2="70" stroke="rgba(56,189,248,0.7)" stroke-width="6"/><line x1="10" y1="105" x2="130" y2="105" stroke="rgba(250,204,21,0.7)" stroke-width="6"/></svg>`
        },
        venetian_blinds: {
            name: 'Noir Blinds',
            desc: 'Cinematic Swaying Shadow Slats',
            bgColor: '#0d0d12',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><rect x="10" y="20" width="130" height="12" fill="rgba(0,0,0,0.65)"/><rect x="10" y="44" width="130" height="12" fill="rgba(0,0,0,0.65)"/><rect x="10" y="68" width="130" height="12" fill="rgba(0,0,0,0.65)"/><rect x="10" y="92" width="130" height="12" fill="rgba(0,0,0,0.65)"/><rect x="10" y="116" width="130" height="12" fill="rgba(0,0,0,0.65)"/></svg>`
        },
        kinetic_facade: {
            name: 'Kinetic Louvers',
            desc: 'Pivoting Architectural Tiles',
            bgColor: '#0a0d10',
            bgSize: '150px 150px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><polygon points="25,25 45,20 45,60 25,65" fill="rgba(203,213,225,0.7)" stroke="#cbd5e1" stroke-width="1.2"/><polygon points="65,22 85,25 85,65 65,62" fill="rgba(148,163,184,0.7)" stroke="#94a3b8" stroke-width="1.2"/><polygon points="105,20 125,23 125,63 105,60" fill="rgba(203,213,225,0.7)" stroke="#cbd5e1" stroke-width="1.2"/><polygon points="25,85 45,82 45,122 25,125" fill="rgba(148,163,184,0.7)" stroke="#94a3b8" stroke-width="1.2"/><polygon points="65,80 85,85 85,125 65,120" fill="rgba(203,213,225,0.7)" stroke="#cbd5e1" stroke-width="1.2"/><polygon points="105,82 125,80 125,120 105,122" fill="rgba(148,163,184,0.7)" stroke="#94a3b8" stroke-width="1.2"/></svg>`
        },
        basalt_waterfall: {
            name: 'Basalt Cascade',
            desc: 'Vertical Water Curtains on Stone',
            bgColor: '#060a0f',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><polygon points="30,20 48,12 65,20 65,130 48,138 30,130" fill="#1e293b" stroke="#334155" stroke-width="1.5"/><polygon points="75,20 93,12 110,20 110,130 93,138 75,130" fill="#0f172a" stroke="#1e293b" stroke-width="1.5"/><line x1="48" y1="20" x2="48" y2="130" stroke="#38bdf8" stroke-width="2.5"/><line x1="93" y1="20" x2="93" y2="130" stroke="#7dd3fc" stroke-width="2.5"/></svg>`
        },
        retro_terminal: {
            name: 'Mainframe CRT',
            desc: 'Phosphor Green Terminal Telemetry',
            bgColor: '#010f08',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><rect x="15" y="15" width="110" height="110" rx="4" fill="#022c22" stroke="#22c55e" stroke-width="2"/><rect x="25" y="28" width="60" height="5" fill="#4ade80"/><rect x="25" y="40" width="85" height="5" fill="#22c55e"/><rect x="25" y="52" width="70" height="5" fill="#4ade80"/><rect x="25" y="64" width="45" height="5" fill="#22c55e"/><rect x="25" y="76" width="10" height="10" fill="#86efac"/></svg>`
        },
        origami_facets: {
            name: 'Origami Terrain',
            desc: '3D Low-Poly Shifting Triangles',
            bgColor: '#0b0912',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><polygon points="20,20 70,40 35,80" fill="rgba(129,140,248,0.5)" stroke="#818cf8" stroke-width="1.2"/><polygon points="70,40 120,20 105,80" fill="rgba(52,211,153,0.5)" stroke="#34d399" stroke-width="1.2"/><polygon points="70,40 35,80 105,80" fill="rgba(244,114,182,0.5)" stroke="#f472b6" stroke-width="1.2"/><polygon points="35,80 70,125 105,80" fill="rgba(251,191,36,0.5)" stroke="#fbbf24" stroke-width="1.2"/></svg>`
        },
        vhs_drift: {
            name: 'VHS Analog Drift',
            desc: '90s CRT Scanlines & Tracking Bands',
            bgColor: '#08080c',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><rect x="15" y="25" width="110" height="8" fill="rgba(239,68,68,0.7)"/><rect x="20" y="27" width="110" height="8" fill="rgba(59,130,246,0.7)"/><line x1="15" y1="55" x2="125" y2="55" stroke="rgba(255,255,255,0.8)" stroke-width="2"/><rect x="15" y="75" width="110" height="16" fill="rgba(255,255,255,0.2)"/><line x1="15" y1="105" x2="125" y2="105" stroke="rgba(255,255,255,0.8)" stroke-width="2"/></svg>`
        },
        penrose_isometric: {
            name: 'Isometric Prisms',
            desc: 'Escher Architectural Diamond Blocks',
            bgColor: '#0a0a0e',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><polygon points="70,20 95,36 70,52 45,36" fill="#f8fafc"/><polygon points="45,36 70,52 70,84 45,68" fill="#94a3b8"/><polygon points="70,52 95,36 95,68 70,84" fill="#475569"/><polygon points="45,68 70,84 45,100 20,84" fill="#f8fafc"/><polygon points="20,84 45,100 45,132 20,116" fill="#94a3b8"/><polygon points="45,100 70,84 70,116 45,132" fill="#475569"/></svg>`
        },
        fluted_glass: {
            name: 'Fluted Reeded Glass',
            desc: 'Architectural Light Columns',
            bgColor: '#080c10',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><rect x="15" y="10" width="16" height="120" fill="rgba(56,189,248,0.25)" stroke="rgba(255,255,255,0.4)" stroke-width="1.2"/><rect x="35" y="10" width="16" height="120" fill="rgba(251,146,60,0.25)" stroke="rgba(255,255,255,0.4)" stroke-width="1.2"/><rect x="55" y="10" width="16" height="120" fill="rgba(168,85,247,0.25)" stroke="rgba(255,255,255,0.4)" stroke-width="1.2"/><rect x="75" y="10" width="16" height="120" fill="rgba(52,211,153,0.25)" stroke="rgba(255,255,255,0.4)" stroke-width="1.2"/><rect x="95" y="10" width="16" height="120" fill="rgba(56,189,248,0.25)" stroke="rgba(255,255,255,0.4)" stroke-width="1.2"/><line x1="23" y1="10" x2="23" y2="130" stroke="#fff" stroke-width="1.5"/><line x1="43" y1="10" x2="43" y2="130" stroke="#fff" stroke-width="1.5"/><line x1="63" y1="10" x2="63" y2="130" stroke="#fff" stroke-width="1.5"/><line x1="83" y1="10" x2="83" y2="130" stroke="#fff" stroke-width="1.5"/><line x1="103" y1="10" x2="103" y2="130" stroke="#fff" stroke-width="1.5"/></svg>`
        },
        wood_marquetry: {
            name: 'Herringbone Wood',
            desc: 'Inlaid Architectural Veneer',
            bgColor: '#140c08',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><polygon points="35,20 70,55 50,75 15,40" fill="#78350f" stroke="#291305" stroke-width="1.5"/><polygon points="70,55 105,20 125,40 90,75" fill="#a16207" stroke="#291305" stroke-width="1.5"/><polygon points="35,80 70,115 50,135 15,100" fill="#92400e" stroke="#291305" stroke-width="1.5"/><polygon points="70,115 105,80 125,100 90,135" fill="#451a03" stroke="#291305" stroke-width="1.5"/></svg>`
        },
        seismic_drum: {
            name: 'Seismograph Drum',
            desc: 'Analog Needle Waveform Recorder',
            bgColor: '#070a0e',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><line x1="10" y1="35" x2="130" y2="35" stroke="rgba(148,163,184,0.3)" stroke-width="1"/><line x1="10" y1="70" x2="130" y2="70" stroke="rgba(148,163,184,0.3)" stroke-width="1"/><line x1="10" y1="105" x2="130" y2="105" stroke="rgba(148,163,184,0.3)" stroke-width="1"/><path d="M10 35 L40 35 L48 15 L56 55 L64 25 L72 45 L80 35 L130 35" fill="none" stroke="#ef4444" stroke-width="2"/><path d="M10 70 L30 70 L38 55 L46 85 L54 60 L62 80 L70 70 L130 70" fill="none" stroke="#10b981" stroke-width="2"/><path d="M10 105 L50 105 L58 90 L66 120 L74 98 L82 112 L90 105 L130 105" fill="none" stroke="#38bdf8" stroke-width="2"/></svg>`
        },
        isometric_city: {
            name: 'Isometric Megacity',
            desc: 'Cyberpunk Transit & Towers',
            bgColor: '#06060c',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><polygon points="35,40 55,28 75,40 55,52" fill="#06b6d4"/><polygon points="35,40 55,52 55,100 35,88" fill="#0e7490"/><polygon points="75,40 55,52 55,100 75,88" fill="#155e75"/><polygon points="75,60 95,48 115,60 95,72" fill="#ec4899"/><polygon points="75,60 95,72 95,115 75,103" fill="#be185d"/><polygon points="115,60 95,72 95,115 115,103" fill="#9d174d"/><line x1="15" y1="120" x2="125" y2="55" stroke="#eab308" stroke-width="2.5"/></svg>`
        },
        papercraft_layers: {
            name: 'Papercraft Shadowbox',
            desc: 'Layered Cutout Paper Scape',
            bgColor: '#0a0d0d',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M10 20 Q70 50, 130 15 L130 130 L10 130 Z" fill="#1e293b" stroke="rgba(255,255,255,0.4)" stroke-width="1.2"/><path d="M10 50 Q70 80, 130 45 L130 130 L10 130 Z" fill="#334155" stroke="rgba(255,255,255,0.4)" stroke-width="1.2"/><path d="M10 80 Q70 110, 130 75 L130 130 L10 130 Z" fill="#475569" stroke="rgba(255,255,255,0.4)" stroke-width="1.2"/><path d="M10 105 Q70 125, 130 100 L130 130 L10 130 Z" fill="#64748b" stroke="rgba(255,255,255,0.4)" stroke-width="1.2"/></svg>`
        },
        hex_cipher: {
            name: 'Hex Data Stream',
            desc: 'Cybernetic Security Matrix',
            bgColor: '#020d06',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><rect x="18" y="20" width="22" height="10" fill="#22c55e"/><rect x="18" y="38" width="22" height="10" fill="#15803d"/><rect x="18" y="56" width="22" height="10" fill="#22c55e"/><rect x="58" y="20" width="22" height="10" fill="#15803d"/><rect x="58" y="38" width="22" height="10" fill="#22c55e"/><rect x="58" y="56" width="22" height="10" fill="#15803d"/><rect x="98" y="20" width="22" height="10" fill="#22c55e"/><rect x="98" y="38" width="22" height="10" fill="#15803d"/><rect x="98" y="56" width="22" height="10" fill="#22c55e"/><line x1="29" y1="10" x2="29" y2="130" stroke="rgba(34,197,94,0.4)" stroke-width="1.5"/><line x1="69" y1="10" x2="69" y2="130" stroke="rgba(34,197,94,0.4)" stroke-width="1.5"/><line x1="109" y1="10" x2="109" y2="130" stroke="rgba(34,197,94,0.4)" stroke-width="1.5"/></svg>`
        },
        laser_grating: {
            name: 'Laser Interference',
            desc: 'Optical Laboratory MoirÃ© Grid',
            bgColor: '#060208',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><line x1="15" y1="10" x2="125" y2="130" stroke="#ef4444" stroke-width="2"/><line x1="35" y1="10" x2="145" y2="130" stroke="#ef4444" stroke-width="2"/><line x1="-5" y1="10" x2="105" y2="130" stroke="#ef4444" stroke-width="2"/><line x1="125" y1="10" x2="15" y2="130" stroke="#3b82f6" stroke-width="2"/><line x1="145" y1="10" x2="35" y2="130" stroke="#3b82f6" stroke-width="2"/><line x1="105" y1="10" x2="-5" y2="130" stroke="#3b82f6" stroke-width="2"/></svg>`
        },
        silk_drapery: {
            name: 'Linen Drapery',
            desc: 'Window Curtain Ocean Breeze',
            bgColor: '#0a0a0f',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M20 10 Q28 70, 20 130" stroke="rgba(244,244,245,0.7)" stroke-width="3" fill="none"/><path d="M45 10 Q53 70, 45 130" stroke="rgba(212,212,216,0.7)" stroke-width="3" fill="none"/><path d="M70 10 Q78 70, 70 130" stroke="rgba(244,244,245,0.7)" stroke-width="3" fill="none"/><path d="M95 10 Q103 70, 95 130" stroke="rgba(212,212,216,0.7)" stroke-width="3" fill="none"/><path d="M120 10 Q128 70, 120 130" stroke="rgba(244,244,245,0.7)" stroke-width="3" fill="none"/></svg>`
        },
        rose_gold_marble: {
            name: 'Rose Gold Marble',
            desc: 'Luxury Pearl & Metallic Veins',
            bgColor: '#14090e',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M10 30 Q70 10, 80 60 T140 50" fill="none" stroke="#f472b6" stroke-width="2.5"/><path d="M0 70 Q50 90, 90 70 T150 100" fill="none" stroke="#fb7185" stroke-width="2.5"/><path d="M15 110 Q60 130, 100 110 T140 130" fill="none" stroke="#fda4af" stroke-width="2"/><path d="M30 45 Q75 65, 115 45" fill="none" stroke="#fbcfe8" stroke-width="1.5"/></svg>`
        },
        sakura_river: {
            name: 'Sakura Hanaikada',
            desc: 'Floating Cherry Petal River',
            bgColor: '#11070e',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M10 50 Q70 20, 130 60" fill="none" stroke="rgba(244,114,182,0.4)" stroke-width="2"/><path d="M10 90 Q70 60, 130 100" fill="none" stroke="rgba(244,114,182,0.4)" stroke-width="2"/><path d="M45 40 Q55 30, 65 40 Q55 50, 45 40 Z" fill="#f472b6"/><path d="M85 75 Q95 65, 105 75 Q95 85, 85 75 Z" fill="#fbcfe8"/><path d="M30 85 Q40 75, 50 85 Q40 95, 30 85 Z" fill="#fda4af"/></svg>`
        },
        wisteria_breeze: {
            name: 'Wisteria Trellis',
            desc: 'Hanging Lilac Blossom Racemes',
            bgColor: '#0c0714',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M35 15 Q40 60, 35 125" stroke="#a855f7" stroke-width="2.5" fill="none"/><path d="M70 10 Q75 55, 70 120" stroke="#c084fc" stroke-width="2.5" fill="none"/><path d="M105 18 Q110 65, 105 130" stroke="#e9d5ff" stroke-width="2.5" fill="none"/></svg>`
        },
        crystal_prism_room: {
            name: 'Chandelier Rainbows',
            desc: 'Prismatic Sunlight on Velvet',
            bgColor: '#120810',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><polygon points="30,20 60,35 45,75 15,60" fill="rgba(244,114,182,0.35)" stroke="#f472b6" stroke-width="1.5"/><polygon points="80,40 120,55 105,95 65,80" fill="rgba(56,189,248,0.35)" stroke="#38bdf8" stroke-width="1.5"/><polygon points="40,85 75,100 60,135 25,120" fill="rgba(250,204,21,0.35)" stroke="#facc15" stroke-width="1.5"/></svg>`
        },
        opal_aurora: {
            name: 'Fire Opal Aurora',
            desc: 'Iridescent Mineral Matrix',
            bgColor: '#050b10',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M20 30 Q70 60, 120 20 L125 75 Q75 110, 15 80 Z" fill="rgba(45,212,191,0.3)" stroke="#2dd4bf" stroke-width="1.5"/><path d="M35 55 Q75 80, 115 50 L110 95 Q70 120, 30 95 Z" fill="rgba(251,146,60,0.3)" stroke="#fb923c" stroke-width="1.5"/></svg>`
        },
        glasswing_butterfly: {
            name: 'Glasswing Flutter',
            desc: 'Translucent Iridescent Wings',
            bgColor: '#0e0614',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M65 70 Q40 25, 20 45 Q20 75, 65 75 Z" fill="rgba(244,114,182,0.25)" stroke="#f472b6" stroke-width="1.5"/><path d="M75 70 Q100 25, 120 45 Q120 75, 75 75 Z" fill="rgba(192,132,252,0.25)" stroke="#c084fc" stroke-width="1.5"/><line x1="70" y1="40" x2="70" y2="90" stroke="#fbcfe8" stroke-width="2"/></svg>`
        },
        velvet_peony: {
            name: 'Velvet Peony',
            desc: 'Layered Blush Garden Petals',
            bgColor: '#16080d',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M25 45 Q70 15, 115 45 Q70 75, 25 45 Z" fill="rgba(244,63,94,0.3)" stroke="#f43f5e" stroke-width="1.8"/><path d="M20 75 Q70 45, 120 75 Q70 105, 20 75 Z" fill="rgba(251,113,133,0.3)" stroke="#fb7185" stroke-width="1.8"/><path d="M30 105 Q70 80, 110 105 Q70 130, 30 105 Z" fill="rgba(253,164,175,0.3)" stroke="#fda4af" stroke-width="1.8"/></svg>`
        },
        cotton_candy_sunset: {
            name: 'Pastel Twilight',
            desc: 'Dreamy Cotton Candy Clouds',
            bgColor: '#090714',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M15 40 Q40 25, 70 35 Q100 20, 125 40 Q135 60, 110 65 Q60 65, 15 55 Z" fill="rgba(244,114,182,0.35)" stroke="#f472b6" stroke-width="1.5"/><path d="M10 85 Q40 70, 75 80 Q105 65, 130 85 Q135 105, 105 110 Q60 110, 10 100 Z" fill="rgba(192,132,252,0.35)" stroke="#c084fc" stroke-width="1.5"/></svg>`
        },
        enchanted_jellyfish: {
            name: 'Moon Jellyfish',
            desc: 'Abyssal Neural Bioluminescence',
            bgColor: '#02040a',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M35 60 Q70 20, 105 60 Q95 70, 70 65 Q45 70, 35 60 Z" fill="rgba(34,211,238,0.28)" stroke="#22d3ee" stroke-width="1.6"/><path d="M50 65 Q45 95, 55 125" stroke="#a5f3fc" stroke-width="1.2" fill="none"/><path d="M70 65 Q75 95, 68 130" stroke="#c084fc" stroke-width="1.4" fill="none"/><path d="M90 65 Q95 95, 85 125" stroke="#a5f3fc" stroke-width="1.2" fill="none"/></svg>`
        },
        golden_hour_meadow: {
            name: 'Golden Meadow',
            desc: 'Rolling Wheat & Sunset Wind',
            bgColor: '#140a04',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M25 130 Q45 70, 60 30" stroke="#fbbf24" stroke-width="2" fill="none"/><circle cx="60" cy="30" r="4" fill="#fde68a"/><path d="M60 130 Q75 60, 95 25" stroke="#f59e0b" stroke-width="2" fill="none"/><circle cx="95" cy="25" r="4" fill="#fef08a"/><path d="M95 130 Q110 80, 120 45" stroke="#fbbf24" stroke-width="1.8" fill="none"/><circle cx="120" cy="45" r="3.5" fill="#fde68a"/></svg>`
        },
        rain_on_car_window: {
            name: 'Midnight Rain Glass',
            desc: 'City Bokeh & Streaming Droplets',
            bgColor: '#060810',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><circle cx="45" cy="45" r="22" fill="rgba(251,191,36,0.25)"/><circle cx="100" cy="55" r="28" fill="rgba(244,114,182,0.22)"/><circle cx="65" cy="95" r="18" fill="rgba(6,182,212,0.2)"/><path d="M40 20 L40 50" stroke="rgba(255,255,255,0.7)" stroke-width="1.5"/><circle cx="40" cy="52" r="3" fill="#ffffff"/><path d="M95 30 L95 75" stroke="rgba(255,255,255,0.7)" stroke-width="1.5"/><circle cx="95" cy="77" r="3.5" fill="#ffffff"/></svg>`
        },
        floating_lantern_festival: {
            name: 'Sky Lanterns',
            desc: 'Warm Glowing Ascent Over Mist',
            bgColor: '#050713',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><rect x="52" y="35" width="36" height="46" rx="4" fill="rgba(251,191,36,0.3)" stroke="#fbbf24" stroke-width="1.6"/><circle cx="70" cy="62" r="8" fill="#fef08a"/><rect x="20" y="70" width="24" height="32" rx="3" fill="rgba(249,115,22,0.25)" stroke="#f97316" stroke-width="1.4"/><circle cx="32" cy="88" r="5" fill="#fde68a"/><rect x="98" y="75" width="22" height="30" rx="3" fill="rgba(251,191,36,0.25)" stroke="#fbbf24" stroke-width="1.4"/><circle cx="109" cy="92" r="4.5" fill="#fef08a"/></svg>`
        },
        northern_lights_fjord: {
            name: 'Aurora Fjord',
            desc: 'Emerald Polar Ribbon Reflections',
            bgColor: '#02060e',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M0 45 Q35 15, 70 38 T140 25 L140 60 Q105 45, 70 65 T0 55 Z" fill="rgba(52,211,153,0.3)" stroke="#34d399" stroke-width="1.5"/><path d="M0 60 Q35 35, 70 55 T140 45 L140 75 Q105 60, 70 80 T0 70 Z" fill="rgba(168,85,247,0.25)" stroke="#a855f7" stroke-width="1.4"/><path d="M0 100 L30 85 L65 98 L100 82 L140 100 L140 140 L0 140 Z" fill="#010408"/></svg>`
        },
        sakura_tea_steam: {
            name: 'Tranquil Vapor',
            desc: 'Curling Tea & Incense Smoke Eddies',
            bgColor: '#08060d',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M50 130 C45 95, 80 80, 55 50 C40 30, 65 15, 75 10" stroke="rgba(253,164,175,0.7)" stroke-width="2" fill="none"/><path d="M75 130 C85 100, 60 85, 85 55 C100 35, 80 20, 70 10" stroke="rgba(216,180,254,0.7)" stroke-width="2" fill="none"/><path d="M62 130 C60 105, 72 90, 68 65 C65 45, 74 30, 72 15" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" fill="none"/></svg>`
        },
        amethyst_geode_growth: {
            name: 'Amethyst Geode',
            desc: 'Living Quartz Cavern & Crystal Strata',
            bgColor: '#08030c',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M30 110 L50 45 L65 30 L80 48 L60 110 Z" fill="rgba(147,51,234,0.35)" stroke="#c084fc" stroke-width="1.6"/><path d="M75 110 L90 60 L105 45 L115 65 L100 110 Z" fill="rgba(192,132,252,0.3)" stroke="#e9d5ff" stroke-width="1.6"/><line x1="65" y1="30" x2="60" y2="110" stroke="#f3e8ff" stroke-width="1.2"/></svg>`
        },
        feather_quill_whisper: {
            name: 'Gossamer Feathers',
            desc: 'Weightless Iridescent Quill Drift',
            bgColor: '#03050e',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M30 110 Q70 70, 110 30" stroke="#f1f5f9" stroke-width="1.8" fill="none"/><path d="M110 30 Q105 55, 75 75 Q45 95, 30 110 Q55 90, 85 60 Q105 40, 110 30 Z" fill="rgba(45,212,191,0.25)" stroke="#2dd4bf" stroke-width="1.4"/></svg>`
        },
        celestial_silk_nebula: {
            name: 'Celestial Silk Nebula',
            desc: 'Turbulent Curl-Noise Cosmic Tapestry',
            bgColor: '#04020c',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M10 130 C40 90, 30 50, 80 40 C110 35, 120 70, 130 10" stroke="rgba(244,114,182,0.7)" stroke-width="2" fill="none"/><path d="M20 140 C50 100, 40 60, 90 50 C120 45, 130 80, 140 20" stroke="rgba(56,189,248,0.65)" stroke-width="1.8" fill="none"/><path d="M0 110 C30 80, 60 70, 70 30 C80 10, 110 20, 130 30" stroke="rgba(251,191,36,0.6)" stroke-width="1.6" fill="none"/><circle cx="80" cy="40" r="3" fill="#ffffff"/><circle cx="45" cy="85" r="2" fill="#38bdf8"/></svg>`
        },
        living_dendrite_frost: {
            name: 'Dendrite Frost Arbor',
            desc: '60Â° Hexagonal Ice Fern Crystallization',
            bgColor: '#02060f',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><line x1="70" y1="130" x2="70" y2="10" stroke="#f8fafc" stroke-width="2"/><line x1="70" y1="100" x2="45" y2="75" stroke="#a5f3fc" stroke-width="1.6"/><line x1="70" y1="100" x2="95" y2="75" stroke="#a5f3fc" stroke-width="1.6"/><line x1="70" y1="70" x2="40" y2="40" stroke="#f8fafc" stroke-width="1.6"/><line x1="70" y1="70" x2="100" y2="40" stroke="#f8fafc" stroke-width="1.6"/><line x1="70" y1="40" x2="52" y2="22" stroke="#c4b5fd" stroke-width="1.4"/><line x1="70" y1="40" x2="88" y2="22" stroke="#c4b5fd" stroke-width="1.4"/><circle cx="70" cy="10" r="3" fill="#ffffff"/></svg>`
        },
        bioluminescent_coral_abyss: {
            name: 'Abyssal Coral Reef',
            desc: 'Living Deep Gorgonian Fan & Spores',
            bgColor: '#020b12',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M70 140 C68 100, 60 80, 40 50 C30 35, 20 25, 15 15" stroke="#e11d48" stroke-width="2.2" fill="none"/><path d="M60 80 C75 65, 95 55, 110 30 C118 20, 125 15, 130 10" stroke="#be123c" stroke-width="2" fill="none"/><path d="M40 50 C50 40, 65 35, 75 20" stroke="#fb7185" stroke-width="1.6" fill="none"/><circle cx="15" cy="15" r="3.5" fill="#34d399"/><circle cx="130" cy="10" r="3.5" fill="#34d399"/><circle cx="75" cy="20" r="3" fill="#f43f5e"/><circle cx="45" cy="70" r="2" fill="#34d399"/><circle cx="95" cy="75" r="2.5" fill="#f43f5e"/></svg>`
        },
        origami_kaleidoscope_shatter: {
            name: 'Hyper-Prism Origami',
            desc: '3D Faceted Crystal Kinetic Sculpture',
            bgColor: '#070512',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><polygon points="70,20 115,55 95,105 45,105 25,55" fill="none" stroke="#fbbf24" stroke-width="1.8"/><polygon points="70,20 70,75 115,55" fill="rgba(168,85,247,0.35)" stroke="#e9d5ff" stroke-width="1.2"/><polygon points="115,55 70,75 95,105" fill="rgba(56,189,248,0.35)" stroke="#bae6fd" stroke-width="1.2"/><polygon points="95,105 70,75 45,105" fill="rgba(251,191,36,0.3)" stroke="#fde68a" stroke-width="1.2"/><polygon points="45,105 70,75 25,55" fill="rgba(244,63,94,0.35)" stroke="#fecdd3" stroke-width="1.2"/><polygon points="25,55 70,75 70,20" fill="rgba(52,211,153,0.35)" stroke="#a7f3d0" stroke-width="1.2"/></svg>`
        },
        mystic_koi_shadows: {
            name: 'Mystic Koi Sanctuary',
            desc: 'Articulated Swimming Kinematics & Sun Caustics',
            bgColor: '#031412',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M45 125 C30 90, 50 65, 80 45 C95 35, 105 20, 108 10" stroke="rgba(20,184,166,0.3)" stroke-width="28" stroke-linecap="round" fill="none"/><path d="M45 125 C30 90, 50 65, 80 45 C95 35, 105 20, 108 10" stroke="#f8fafc" stroke-width="18" stroke-linecap="round" fill="none"/><path d="M60 78 C72 65, 82 55, 90 42" stroke="#dc2626" stroke-width="14" stroke-linecap="round" fill="none"/><circle cx="108" cy="10" r="6" fill="#f8fafc"/><circle cx="105" cy="7" r="1.8" fill="#000"/><circle cx="111" cy="7" r="1.8" fill="#00"/><path d="M35 120 C25 130, 20 140, 30 145 C40 140, 48 135, 45 125" fill="rgba(255,255,255,0.7)" stroke="#dc2626" stroke-width="1"/></svg>`
        },
        hyperborean_chronometer: {
            name: 'Astronomical Tourbillon',
            desc: 'Gothic Astrolabe & Harmonic Clockwork',
            bgColor: '#080604',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><circle cx="70" cy="70" r="58" fill="none" stroke="#d97706" stroke-width="2" stroke-dasharray="3 4"/><circle cx="70" cy="70" r="46" fill="none" stroke="#fbbf24" stroke-width="1.8"/><circle cx="70" cy="70" r="30" fill="none" stroke="#f59e0b" stroke-width="1.6" stroke-dasharray="6 4"/><line x1="70" y1="24" x2="70" y2="116" stroke="#fbbf24" stroke-width="1.4"/><line x1="24" y1="70" x2="116" y2="70" stroke="#fbbf24" stroke-width="1.4"/><circle cx="70" cy="70" r="14" fill="rgba(217,119,6,0.3)" stroke="#fef3c7" stroke-width="1.6"/><circle cx="70" cy="70" r="4.5" fill="#e11d48"/><circle cx="70" cy="70" r="1.8" fill="#ffffff"/></svg>`
        },
        enchanted_bonsai_spirit: {
            name: 'Ancient Bonsai Spirit',
            desc: 'Gnarled Pine Driftwood & Kodama Wisps',
            bgColor: '#040b08',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><path d="M40 135 C55 120, 50 95, 75 80 C90 70, 95 55, 85 35" stroke="#78350f" stroke-width="6" stroke-linecap="round" fill="none"/><path d="M85 35 C88 28, 95 20, 100 15" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round" fill="none"/><ellipse cx="75" cy="40" rx="22" ry="10" fill="rgba(5,150,105,0.8)" stroke="#34d399" stroke-width="1.4"/><ellipse cx="100" cy="55" rx="18" ry="8" fill="rgba(4,120,87,0.8)" stroke="#34d399" stroke-width="1.4"/><ellipse cx="50" cy="75" rx="16" ry="7" fill="rgba(6,78,59,0.85)" stroke="#10b981" stroke-width="1.4"/><circle cx="65" cy="50" r="3.5" fill="#fef08a"/><circle cx="110" cy="35" r="2.5" fill="#fef08a"/></svg>`
        },
        alchemical_liquid_quicksilver: {
            name: 'Iridescent Quicksilver',
            desc: 'Viscous Liquid Metal & Thin-Film Shifts',
            bgColor: '#090a10',
            bgSize: '140px 140px',
            svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><circle cx="60" cy="75" r="36" fill="rgba(226,232,240,0.35)" stroke="#f8fafc" stroke-width="2"/><ellipse cx="98" cy="52" rx="20" ry="18" fill="rgba(203,213,225,0.3)" stroke="#e2e8f0" stroke-width="1.8"/><path d="M78 60 Q86 62 90 55" stroke="#ffffff" stroke-width="3" fill="none"/><circle cx="50" cy="65" r="10" fill="rgba(255,255,255,0.5)"/><circle cx="108" cy="98" r="8" fill="rgba(168,85,247,0.4)" stroke="#c084fc" stroke-width="1.2"/><circle cx="32" cy="40" r="7" fill="rgba(45,212,191,0.4)" stroke="#2dd4bf" stroke-width="1.2"/></svg>`
        }
    },

    getPatternDataUrl(patternId) {
        const pat = this.PATTERNS[patternId] || this.PATTERNS.doodle;
        if (!pat || !pat.svg) return '';
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pat.svg)}`;
    },

    requestGyroPermission() {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission().then(state => {
                if (state === 'granted') {
                    this.initGyroscope();
                }
            }).catch(() => {});
        }
    },

    initGyroscope() {
        if (this._gyroListening) return;
        this._gyroListening = true;

        const handleOrientation = (e) => {
            if (!this.gyroEnabled || document.hidden) return;
            const gamma = e.gamma || 0; // Left-to-right tilt [-90, 90]
            const beta = e.beta || 0;   // Front-to-back tilt [-180, 180]
            
            // Continuous target values for butter-smooth per-frame LERP
            this._targetTiltX = Math.max(-14, Math.min(14, gamma * 0.5));
            this._targetTiltY = Math.max(-14, Math.min(14, (beta - 45) * 0.5));
        };

        if (window.DeviceOrientationEvent) {
            window.addEventListener('deviceorientation', handleOrientation, { passive: true });
        }

        // Desktop mouse hover tilt fallback
        const chatArea = document.getElementById('chat-area');
        if (chatArea) {
            chatArea.addEventListener('mousemove', (e) => {
                if (!this.gyroEnabled || document.hidden || window.innerWidth <= 768) return;
                const rect = chatArea.getBoundingClientRect();
                const relX = (e.clientX - rect.left) / rect.width - 0.5;
                const relY = (e.clientY - rect.top) / rect.height - 0.5;
                this._targetTiltX = relX * 16;
                this._targetTiltY = relY * 16;
            }, { passive: true });
        }
    },

    _stars: null,

    syncCanvasSize(canvas, isPattern, force = false) {
        if (!canvas) return;
        const now = performance.now();
        // Throttle layout measurements to eliminate frame drops & layout thrashing
        if (!force && canvas._lastSizeCheck && (now - canvas._lastSizeCheck < 500)) {
            return;
        }
        canvas._lastSizeCheck = now;

        if (isPattern) {
            const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
            const fallbackW = canvas.id === 'wallpaper-preview-canvas' ? 320 : 360;
            const fallbackH = canvas.id === 'wallpaper-preview-canvas' ? 120 : 640;
            const clientW = canvas.clientWidth || fallbackW;
            const clientH = canvas.clientHeight || fallbackH;
            const w = Math.round(clientW * dpr);
            const h = Math.round(clientH * dpr);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
                if (canvas.id === 'chat-wallpaper-canvas') this._chatCtx = null;
                else if (canvas.id === 'wallpaper-preview-canvas') this._previewCtx = null;
            }
        } else {
            const targetW = canvas.id === 'wallpaper-preview-canvas' ? 160 : 160;
            const targetH = canvas.id === 'wallpaper-preview-canvas' ? 100 : 280;
            if (canvas.width !== targetW || canvas.height !== targetH) {
                canvas.width = targetW;
                canvas.height = targetH;
                if (canvas.id === 'chat-wallpaper-canvas') this._chatCtx = null;
                else if (canvas.id === 'wallpaper-preview-canvas') this._previewCtx = null;
            }
        }
    },

    drawMesh(ctx, width, height, presetKey) {
        const preset = this.PRESETS[presetKey] || this.PRESETS.aurora;
        
        // Base dark backdrop
        ctx.fillStyle = preset.bg;
        ctx.fillRect(0, 0, width, height);

        // Blended luminous ambient orbs
        ctx.globalCompositeOperation = 'screen';
        const minDim = Math.min(width, height);

        for (let i = 0; i < preset.orbs.length; i++) {
            const orb = preset.orbs[i];
            const angle = this._simTime * orb.speed + orb.phase;
            const ox = (orb.cx + Math.cos(angle) * orb.rx + Math.sin(angle * 2) * (orb.rx * 0.25)) * width;
            const oy = (orb.cy + Math.sin(angle) * orb.ry + Math.cos(angle * 2) * (orb.ry * 0.25)) * height;
            const radius = orb.r * minDim * (1 + 0.12 * Math.sin(angle));

            const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, Math.max(10, radius));
            grad.addColorStop(0, orb.c0);
            grad.addColorStop(0.65, orb.c1);
            grad.addColorStop(1, 'rgba(0,0,0,0)');

            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(ox, oy, Math.max(10, radius), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
    },

    // 1. Living, Morphing Topographic Elevation Waves
    drawTopography(ctx, width, height, t) {
        ctx.fillStyle = '#09090b';
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = 1.6;

        const bands = 14;
        const step = height / (bands - 1);
        for (let i = 0; i < bands; i++) {
            const baseY = i * step;
            ctx.beginPath();
            const segs = 32;
            const dx = width / segs;
            for (let s = 0; s <= segs; s++) {
                const x = s * dx;
                const wave1 = Math.sin(x * 0.007 + t * 0.35 + i * 0.8) * 26;
                const wave2 = Math.cos(x * 0.014 - t * 0.25 + i * 1.2) * 14;
                const wave3 = Math.sin((x + baseY) * 0.005 + t * 0.2) * 12;
                const y = baseY + wave1 + wave2 + wave3;
                if (s === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        // Morphing elevation loops
        const loopCount = 3;
        for (let l = 0; l < loopCount; l++) {
            const lcx = (0.3 + 0.4 * l) * width + Math.sin(t * 0.2 + l * 2) * 35;
            const lcy = (0.35 + 0.3 * (l % 2)) * height + Math.cos(t * 0.25 + l * 2) * 35;
            const baseR = 30 + l * 18 + Math.sin(t * 0.4 + l) * 10;
            ctx.beginPath();
            const pts = 24;
            for (let p = 0; p <= pts; p++) {
                const a = (p / pts) * Math.PI * 2;
                const r = baseR + Math.sin(a * 3 + t * 0.5 + l) * 8 + Math.cos(a * 2 - t * 0.3) * 6;
                const px = lcx + Math.cos(a) * r;
                const py = lcy + Math.sin(a) * r;
                if (p === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.stroke();
        }
    },

    // 2. Dynamic Star Cluster with Drifting & Constellation Forming
    drawConstellations(ctx, width, height, t) {
        ctx.fillStyle = '#030712';
        ctx.fillRect(0, 0, width, height);

        if (!this._stars || this._stars.length === 0) {
            this._stars = [];
            const count = 38;
            for (let i = 0; i < count; i++) {
                this._stars.push({
                    bx: Math.random(),
                    by: Math.random(),
                    speedX: 0.12 + Math.random() * 0.15,
                    speedY: 0.10 + Math.random() * 0.15,
                    phase: Math.random() * Math.PI * 2,
                    rx: 18 + Math.random() * 25,
                    ry: 15 + Math.random() * 25,
                    baseR: 1.2 + Math.random() * 1.6
                });
            }
        }

        const positions = [];
        for (let i = 0; i < this._stars.length; i++) {
            const s = this._stars[i];
            const px = s.bx * width + Math.cos(t * s.speedX + s.phase) * s.rx;
            const py = s.by * height + Math.sin(t * s.speedY + s.phase) * s.ry;
            const pulse = (Math.sin(t * 1.5 + s.phase) + 1) * 0.5;
            const r = s.baseR * (0.8 + 0.5 * pulse);
            positions.push({ x: px, y: py, r, alpha: 0.4 + 0.5 * pulse });
        }

        // Draw connecting constellation lines
        const maxDist = Math.min(width, height) * 0.22;
        ctx.lineWidth = 1.0;
        for (let i = 0; i < positions.length; i++) {
            for (let j = i + 1; j < positions.length; j++) {
                const dx = positions[i].x - positions[j].x;
                const dy = positions[i].y - positions[j].y;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d < maxDist) {
                    const lineAlpha = (1 - d / maxDist) * 0.22;
                    ctx.strokeStyle = `rgba(147, 197, 253, ${lineAlpha.toFixed(3)})`;
                    ctx.beginPath();
                    ctx.moveTo(positions[i].x, positions[i].y);
                    ctx.lineTo(positions[j].x, positions[j].y);
                    ctx.stroke();
                }
            }
        }

        // Draw stars
        for (let i = 0; i < positions.length; i++) {
            const p = positions[i];
            ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha.toFixed(2)})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();

            if (p.r > 2.0) {
                ctx.fillStyle = `rgba(147, 197, 253, ${(p.alpha * 0.35).toFixed(2)})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r * 2.2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    },

    // 3. Cyber Hex Grid with Radial Energy Pulse Waves
    drawHexGrid(ctx, width, height, t) {
        ctx.fillStyle = '#050912';
        ctx.fillRect(0, 0, width, height);

        const r = 26;
        const h = r * Math.sqrt(3);
        const colW = r * 1.5;
        const rowH = h;
        const cols = Math.ceil(width / colW) + 2;
        const rows = Math.ceil(height / rowH) + 2;
        const cx = width * 0.5;
        const cy = height * 0.5;

        for (let c = -1; c < cols; c++) {
            for (let row = -1; row < rows; row++) {
                const hx = c * colW;
                const hy = row * rowH + (c % 2 !== 0 ? h * 0.5 : 0);

                const d = Math.sqrt((hx - cx) * (hx - cx) + (hy - cy) * (hy - cy));
                const wave = Math.sin(d * 0.02 - t * 2.2);
                const isPulse = wave > 0.65;
                const alpha = isPulse ? 0.28 + 0.25 * (wave - 0.65) / 0.35 : 0.09;

                ctx.strokeStyle = `rgba(34, 211, 238, ${alpha.toFixed(2)})`;
                ctx.lineWidth = isPulse ? 1.8 : 1.2;

                ctx.beginPath();
                for (let k = 0; k < 6; k++) {
                    const ang = (k / 6) * Math.PI * 2;
                    const vx = hx + Math.cos(ang) * (r - 2);
                    const vy = hy + Math.sin(ang) * (r - 2);
                    if (k === 0) ctx.moveTo(vx, vy);
                    else ctx.lineTo(vx, vy);
                }
                ctx.closePath();
                ctx.stroke();

                if (isPulse && wave > 0.85) {
                    ctx.fillStyle = `rgba(34, 211, 238, 0.7)`;
                    ctx.beginPath();
                    ctx.arc(hx, hy - (r - 2), 2.2, 0, Math.PI * 2);
                    ctx.arc(hx, hy + (r - 2), 2.2, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
    },

    // 4. Cyber Circuit Board with Traveling Electrical Data Packets
    drawCircuit(ctx, width, height, t) {
        ctx.fillStyle = '#020d09';
        ctx.fillRect(0, 0, width, height);

        const gridSize = 60;
        const cols = Math.ceil(width / gridSize) + 1;
        const rows = Math.ceil(height / gridSize) + 1;

        ctx.strokeStyle = 'rgba(16, 185, 129, 0.15)';
        ctx.lineWidth = 1.5;

        for (let i = 0; i < cols; i++) {
            const x = i * gridSize;
            for (let j = 0; j < rows; j++) {
                const y = j * gridSize;
                
                ctx.beginPath();
                ctx.moveTo(x, y);
                if ((i + j) % 2 === 0) {
                    ctx.lineTo(x + gridSize * 0.6, y);
                    ctx.lineTo(x + gridSize, y + gridSize * 0.4);
                } else {
                    ctx.lineTo(x, y + gridSize * 0.6);
                    ctx.lineTo(x + gridSize * 0.4, y + gridSize);
                }
                ctx.stroke();

                if ((i * 3 + j * 7) % 5 === 0) {
                    ctx.fillStyle = 'rgba(16, 185, 129, 0.35)';
                    ctx.beginPath();
                    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        // Active electronic data packets moving along traces
        const packetCount = 14;
        ctx.fillStyle = 'rgba(52, 211, 153, 0.9)';
        for (let p = 0; p < packetCount; p++) {
            const speed = 0.35 + (p % 3) * 0.12;
            const prog = (t * speed + p * 0.3) % 1.0;
            const trackCol = (p * 4) % cols;
            const trackRow = (p * 5) % rows;
            const sx = trackCol * gridSize;
            const sy = trackRow * gridSize;

            let curX = sx, curY = sy;
            if (prog < 0.5) {
                curX = sx + (prog / 0.5) * gridSize * 0.6;
            } else {
                const subP = (prog - 0.5) / 0.5;
                curX = sx + gridSize * 0.6 + subP * gridSize * 0.4;
                curY = sy + subP * gridSize * 0.4;
            }

            ctx.beginPath();
            ctx.arc(curX, curY, 3.2, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = 'rgba(52, 211, 153, 0.3)';
            ctx.beginPath();
            ctx.arc(curX, curY, 6.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'rgba(52, 211, 153, 0.9)';
        }
    },

    // 5. Undulating Japanese Zen Wave Arches
    drawZenWaves(ctx, width, height, t) {
        ctx.fillStyle = '#070a14';
        ctx.fillRect(0, 0, width, height);

        const rBase = 46;
        const dx = rBase * 1.5;
        const dy = rBase * 0.75;
        const cols = Math.ceil(width / dx) + 2;
        const rows = Math.ceil(height / dy) + 2;

        for (let row = -1; row < rows; row++) {
            const y = row * dy;
            const offsetX = (row % 2) * (dx * 0.5);
            const rowWave = Math.sin(t * 1.2 - row * 0.5);

            for (let col = -1; col < cols; col++) {
                const x = col * dx + offsetX;
                const ringCount = 4;
                for (let k = 1; k <= ringCount; k++) {
                    const undulation = Math.sin(t * 1.5 - row * 0.4 + k * 0.8) * 3.5;
                    const r = (k / ringCount) * rBase + undulation;
                    const alpha = 0.12 + 0.18 * ((rowWave + 1) * 0.5);

                    ctx.strokeStyle = `rgba(129, 140, 248, ${alpha.toFixed(2)})`;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(x, y, Math.max(4, r), Math.PI, 0, false);
                    ctx.stroke();
                }
            }
        }
    },

    // 6. Zero-Gravity WhatsApp / Telegram Floating Doodles
    drawDoodles(ctx, width, height, t) {
        ctx.fillStyle = '#0b141a';
        ctx.fillRect(0, 0, width, height);

        const cellSize = 110;
        const cols = Math.ceil(width / cellSize) + 2;
        const rows = Math.ceil(height / cellSize) + 2;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1.7;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const types = ['bubble', 'heart', 'plane', 'coffee', 'music', 'star', 'gamepad', 'camera'];

        for (let c = -1; c < cols; c++) {
            for (let r = -1; r < rows; r++) {
                const idx = Math.abs(c * 7 + r * 13) % types.length;
                const type = types[idx];
                const seed = c * 11 + r * 19;

                // Independent gentle float orbit
                const ox = Math.cos(t * 0.4 + seed) * 8;
                const oy = Math.sin(t * 0.35 + seed * 1.3) * 10;
                const rot = Math.sin(t * 0.25 + seed) * 0.08;

                const cx = c * cellSize + cellSize * 0.5 + ox;
                const cy = r * cellSize + cellSize * 0.5 + oy;

                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate(rot);

                if (type === 'bubble') {
                    ctx.strokeRect(-14, -10, 28, 18);
                    ctx.beginPath();
                    ctx.moveTo(-6, 8);
                    ctx.lineTo(-10, 13);
                    ctx.lineTo(-2, 8);
                    ctx.stroke();
                } else if (type === 'heart') {
                    ctx.beginPath();
                    ctx.moveTo(0, 8);
                    ctx.bezierCurveTo(-12, -2, -12, -12, 0, -6);
                    ctx.bezierCurveTo(12, -12, 12, -2, 0, 8);
                    ctx.stroke();
                } else if (type === 'plane') {
                    ctx.beginPath();
                    ctx.moveTo(-12, 10);
                    ctx.lineTo(12, -10);
                    ctx.lineTo(-4, 0);
                    ctx.closePath();
                    ctx.moveTo(-4, 0);
                    ctx.lineTo(-10, 3);
                    ctx.stroke();
                } else if (type === 'coffee') {
                    ctx.beginPath();
                    ctx.moveTo(-10, -6);
                    ctx.lineTo(-8, 8);
                    ctx.arcTo(0, 11, 8, 8, 4);
                    ctx.lineTo(10, -6);
                    ctx.closePath();
                    ctx.moveTo(10, -3);
                    ctx.arc(12, 0, 3.5, 0, Math.PI * 2);
                    ctx.stroke();
                } else if (type === 'music') {
                    ctx.beginPath();
                    ctx.arc(-6, 6, 3.5, 0, Math.PI * 2);
                    ctx.arc(6, 4, 3.5, 0, Math.PI * 2);
                    ctx.moveTo(-2.5, 6);
                    ctx.lineTo(-2.5, -8);
                    ctx.lineTo(9.5, -10);
                    ctx.lineTo(9.5, 4);
                    ctx.stroke();
                } else if (type === 'star') {
                    ctx.beginPath();
                    for (let p = 0; p < 5; p++) {
                        const a1 = (p / 5) * Math.PI * 2 - Math.PI * 0.5;
                        const a2 = a1 + Math.PI / 5;
                        const x1 = Math.cos(a1) * 10;
                        const y1 = Math.sin(a1) * 10;
                        const x2 = Math.cos(a2) * 4.5;
                        const y2 = Math.sin(a2) * 4.5;
                        if (p === 0) ctx.moveTo(x1, y1);
                        else ctx.lineTo(x1, y1);
                        ctx.lineTo(x2, y2);
                    }
                    ctx.closePath();
                    ctx.stroke();
                } else if (type === 'gamepad') {
                    ctx.strokeRect(-14, -7, 28, 14);
                    ctx.beginPath();
                    ctx.moveTo(-8, -4); ctx.lineTo(-8, 2);
                    ctx.moveTo(-11, -1); ctx.lineTo(-5, -1);
                    ctx.arc(8, -1, 1.5, 0, Math.PI * 2);
                    ctx.stroke();
                } else if (type === 'camera') {
                    ctx.strokeRect(-12, -7, 24, 15);
                    ctx.strokeRect(-5, -10, 10, 3);
                    ctx.beginPath();
                    ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
                    ctx.stroke();
                }

                ctx.restore();
            }
        }
    },

    // 7. Woven Carbon Fiber with Sweeping Holographic Specular Sheen
    drawCarbon(ctx, width, height, t) {
        ctx.fillStyle = '#080808';
        ctx.fillRect(0, 0, width, height);

        const blockSize = 20;
        const cols = Math.ceil(width / blockSize) + 1;
        const rows = Math.ceil(height / blockSize) + 1;

        const sweep = (t * 0.25) % 1.0;
        const sweepCenter = (width + height) * sweep;

        for (let c = 0; c < cols; c++) {
            const bx = c * blockSize;
            for (let r = 0; r < rows; r++) {
                const by = r * blockSize;
                const isAlt = (c + r) % 2 === 0;

                const posDiag = bx + by;
                const distSweep = Math.abs(posDiag - sweepCenter);
                const sheen = Math.max(0, 1 - distSweep / 140);

                const baseAlpha = isAlt ? 0.18 : 0.06;
                const finalAlpha = Math.min(0.7, baseAlpha + sheen * 0.35);

                ctx.fillStyle = isAlt ? `rgba(255, 255, 255, ${finalAlpha.toFixed(2)})` : `rgba(0, 0, 0, 0.4)`;
                ctx.fillRect(bx, by, blockSize, blockSize);

                ctx.strokeStyle = isAlt ? `rgba(255, 255, 255, ${(finalAlpha * 0.6).toFixed(2)})` : `rgba(255, 255, 255, 0.04)`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                if (isAlt) {
                    ctx.moveTo(bx, by); ctx.lineTo(bx + blockSize, by + blockSize);
                    ctx.moveTo(bx + blockSize * 0.5, by); ctx.lineTo(bx + blockSize, by + blockSize * 0.5);
                    ctx.moveTo(bx, by + blockSize * 0.5); ctx.lineTo(bx + blockSize * 0.5, by + blockSize);
                } else {
                    ctx.moveTo(bx + blockSize, by); ctx.lineTo(bx, by + blockSize);
                    ctx.moveTo(bx + blockSize * 0.5, by); ctx.lineTo(bx, by + blockSize * 0.5);
                    ctx.moveTo(bx, by + blockSize * 0.5); ctx.lineTo(bx + blockSize * 0.5, by + blockSize);
                }
                ctx.stroke();
            }
        }
    },

    // 8. Kinetic Bauhaus Arcs Rotating and Rearranging
    drawGeometric(ctx, width, height, t) {
        ctx.fillStyle = '#0d0b14';
        ctx.fillRect(0, 0, width, height);

        const size = 70;
        const cols = Math.ceil(width / size) + 2;
        const rows = Math.ceil(height / size) + 2;

        ctx.strokeStyle = 'rgba(244, 114, 182, 0.24)';
        ctx.lineWidth = 1.8;

        for (let c = -1; c < cols; c++) {
            for (let r = -1; r < rows; r++) {
                const gx = c * size;
                const gy = r * size;
                const dir = (c + r) % 2 === 0 ? 1 : -1;
                const rot = t * 0.25 * dir;

                ctx.save();
                ctx.translate(gx + size * 0.5, gy + size * 0.5);
                ctx.rotate(rot);

                ctx.beginPath();
                ctx.arc(-size * 0.35, 0, size * 0.35, 0, Math.PI, false);
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(size * 0.35, 0, size * 0.35, Math.PI, 0, false);
                ctx.stroke();

                const pulse = (Math.sin(t * 1.4 + c + r) + 1) * 0.5;
                ctx.fillStyle = `rgba(244, 114, 182, ${(0.2 + pulse * 0.35).toFixed(2)})`;
                ctx.beginPath();
                ctx.arc(0, 0, 2.5 + pulse * 2, 0, Math.PI * 2);
                ctx.fill();

                ctx.restore();
            }
        }
    },

    // 9. DNA Helix: 3D rotating double strand helix with continuous backbone ribbons & base pairs
    drawDNA(ctx, width, height, t) {
        ctx.fillStyle = '#040d1a';
        ctx.fillRect(0, 0, width, height);

        const helixCols = width > 500 ? 3 : (width > 280 ? 2 : 1);
        const colSpacing = width / (helixCols + 1);
        const amp = Math.min(width * 0.16, 42);
        const wavelength = 160;

        for (let c = 1; c <= helixCols; c++) {
            const hx = c * colSpacing;
            const rungs = Math.ceil((height + 60) / 18);
            const stepY = (height + 60) / rungs;

            // Step 1: Draw connecting base pair rungs & nucleotide nodes (Depth-Sorted)
            for (let i = 0; i <= rungs; i++) {
                const y = i * stepY - 30;
                const phase = (y / wavelength) * Math.PI * 2 - t * 1.8 + c * 1.5;
                const sinVal = Math.sin(phase);
                const cosVal = Math.cos(phase); // Z-depth: -1 (back) to +1 (front)

                const x1 = hx + sinVal * amp;
                const x2 = hx - sinVal * amp;
                const zNorm = (cosVal + 1) * 0.5; // 0 to 1

                // Base pair bond line
                const rungAlpha = 0.12 + zNorm * 0.45;
                const grad = ctx.createLinearGradient(x1, y, x2, y);
                grad.addColorStop(0, `rgba(56, 189, 248, ${rungAlpha.toFixed(2)})`);
                grad.addColorStop(0.5, `rgba(255, 255, 255, ${(rungAlpha * 0.9).toFixed(2)})`);
                grad.addColorStop(1, `rgba(192, 132, 252, ${rungAlpha.toFixed(2)})`);

                ctx.strokeStyle = grad;
                ctx.lineWidth = 1.2 + zNorm * 1.2;
                ctx.beginPath();
                ctx.moveTo(x1, y);
                ctx.lineTo(x2, y);
                ctx.stroke();

                // Nucleotide sphere 1 (Strand A: Cyan)
                const nodeR = 2.4 + zNorm * 2.2;
                ctx.fillStyle = `rgba(56, 189, 248, ${(0.3 + zNorm * 0.7).toFixed(2)})`;
                ctx.beginPath();
                ctx.arc(x1, y, nodeR, 0, Math.PI * 2);
                ctx.fill();

                // Nucleotide sphere 2 (Strand B: Violet)
                ctx.fillStyle = `rgba(192, 132, 252, ${(0.3 + zNorm * 0.7).toFixed(2)})`;
                ctx.beginPath();
                ctx.arc(x2, y, nodeR, 0, Math.PI * 2);
                ctx.fill();

                // Center hydrogen bond pip
                ctx.fillStyle = `rgba(255, 255, 255, ${(0.25 + zNorm * 0.75).toFixed(2)})`;
                ctx.beginPath();
                ctx.arc(hx, y, 1.2 + zNorm * 1.2, 0, Math.PI * 2);
                ctx.fill();
            }

            // Step 2: Draw continuous backbone ribbons (Strand A: Cyan & Strand B: Violet)
            ctx.lineWidth = 2.4;
            // Strand A
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
            ctx.beginPath();
            const segs = 60;
            const dy = (height + 60) / segs;
            for (let s = 0; s <= segs; s++) {
                const sy = s * dy - 30;
                const sphase = (sy / wavelength) * Math.PI * 2 - t * 1.8 + c * 1.5;
                const sx = hx + Math.sin(sphase) * amp;
                if (s === 0) ctx.moveTo(sx, sy);
                else ctx.lineTo(sx, sy);
            }
            ctx.stroke();

            // Strand B
            ctx.strokeStyle = 'rgba(192, 132, 252, 0.75)';
            ctx.beginPath();
            for (let s = 0; s <= segs; s++) {
                const sy = s * dy - 30;
                const sphase = (sy / wavelength) * Math.PI * 2 - t * 1.8 + c * 1.5;
                const sx = hx - Math.sin(sphase) * amp;
                if (s === 0) ctx.moveTo(sx, sy);
                else ctx.lineTo(sx, sy);
            }
            ctx.stroke();
        }
    },

    // 10. MoirÃ© Rings: Concentric wave interference patterns
    drawMoire(ctx, width, height, t) {
        ctx.fillStyle = '#0b0614';
        ctx.fillRect(0, 0, width, height);

        const cx1 = width * 0.45 + Math.cos(t * 0.4) * 35;
        const cy1 = height * 0.48 + Math.sin(t * 0.35) * 30;
        const cx2 = width * 0.55 + Math.cos(t * 0.35 + 2) * 35;
        const cy2 = height * 0.52 + Math.sin(t * 0.4 + 2) * 30;

        const maxR = Math.max(width, height) * 0.75;
        const ringStep = 10;

        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(192, 132, 252, 0.18)';

        for (let r = 10; r < maxR; r += ringStep) {
            ctx.beginPath();
            ctx.arc(cx1, cy1, r, 0, Math.PI * 2);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(cx2, cy2, r, 0, Math.PI * 2);
            ctx.stroke();
        }
    },

    // 11. Isometric Voxel Cubes: Tumbling 3D cubes with dynamic face lighting
    drawIsometric(ctx, width, height, t) {
        ctx.fillStyle = '#09090f';
        ctx.fillRect(0, 0, width, height);

        const s = 28;
        const h = s * Math.sqrt(3);
        const colW = s * 1.5;
        const rowH = h;
        const cols = Math.ceil(width / colW) + 2;
        const rows = Math.ceil(height / rowH) + 2;

        for (let c = -1; c < cols; c++) {
            for (let r = -1; r < rows; r++) {
                const ix = c * colW;
                const iy = r * rowH + (c % 2 !== 0 ? h * 0.5 : 0);
                const wave = Math.sin((c + r) * 0.35 - t * 1.5);
                const light = (wave + 1) * 0.5;

                // Top diamond face
                ctx.fillStyle = `rgba(250, 204, 21, ${(0.10 + light * 0.25).toFixed(2)})`;
                ctx.beginPath();
                ctx.moveTo(ix, iy - s * 0.5);
                ctx.lineTo(ix + s * 0.866, iy);
                ctx.lineTo(ix, iy + s * 0.5);
                ctx.lineTo(ix - s * 0.866, iy);
                ctx.closePath();
                ctx.fill();

                // Left face
                ctx.fillStyle = `rgba(234, 179, 8, ${(0.05 + light * 0.15).toFixed(2)})`;
                ctx.beginPath();
                ctx.moveTo(ix - s * 0.866, iy);
                ctx.lineTo(ix, iy + s * 0.5);
                ctx.lineTo(ix, iy + s * 1.5);
                ctx.lineTo(ix - s * 0.866, iy + s);
                ctx.closePath();
                ctx.fill();

                // Right face
                ctx.fillStyle = `rgba(161, 98, 7, ${(0.03 + light * 0.10).toFixed(2)})`;
                ctx.beginPath();
                ctx.moveTo(ix, iy + s * 0.5);
                ctx.lineTo(ix + s * 0.866, iy);
                ctx.lineTo(ix + s * 0.866, iy + s);
                ctx.lineTo(ix, iy + s * 1.5);
                ctx.closePath();
                ctx.fill();

                // Outline
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(ix, iy + s * 0.5);
                ctx.lineTo(ix, iy + s * 1.5);
                ctx.moveTo(ix, iy + s * 0.5);
                ctx.lineTo(ix - s * 0.866, iy);
                ctx.moveTo(ix, iy + s * 0.5);
                ctx.lineTo(ix + s * 0.866, iy);
                ctx.stroke();
            }
        }
    },

    // 12. Sacred Mandala: Kaleidoscopic flower-of-life petals breathing & rotating
    drawMandala(ctx, width, height, t) {
        ctx.fillStyle = '#120309';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const maxR = Math.min(width, height) * 0.44;

        ctx.strokeStyle = 'rgba(251, 113, 133, 0.25)';
        ctx.lineWidth = 1.4;

        const rings = [
            { count: 8, r: maxR * 0.35, rotSpeed: 0.15 },
            { count: 12, r: maxR * 0.65, rotSpeed: -0.12 },
            { count: 16, r: maxR * 0.95, rotSpeed: 0.10 }
        ];

        for (let ring = 0; ring < rings.length; ring++) {
            const conf = rings[ring];
            const rot = t * conf.rotSpeed;
            const pulse = (Math.sin(t * 1.2 + ring) + 1) * 0.5;
            const curR = conf.r * (0.92 + pulse * 0.12);

            for (let i = 0; i < conf.count; i++) {
                const angle = (i / conf.count) * Math.PI * 2 + rot;
                const px = cx + Math.cos(angle) * (curR * 0.5);
                const py = cy + Math.sin(angle) * (curR * 0.5);

                ctx.beginPath();
                ctx.arc(px, py, curR * 0.5, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        // Center jewel
        const centerPulse = (Math.sin(t * 2) + 1) * 0.5;
        ctx.fillStyle = `rgba(244, 63, 94, ${(0.3 + centerPulse * 0.4).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, 5 + centerPulse * 3, 0, Math.PI * 2);
        ctx.fill();
    },

    _ripplePool: null,

    // 13. Rain Ripples: Realistic liquid surface raindrops with expanding perspective wave rings
    drawRipples(ctx, width, height, t) {
        ctx.fillStyle = '#020b14';
        ctx.fillRect(0, 0, width, height);

        if (!this._ripplePool) {
            this._ripplePool = [];
            const dropCount = 14;
            for (let i = 0; i < dropCount; i++) {
                this._ripplePool.push({
                    x: Math.random() * width,
                    y: Math.random() * height,
                    birth: t - Math.random() * 3.0,
                    duration: 2.2 + Math.random() * 1.2,
                    maxR: 50 + Math.random() * 45,
                    rings: 3
                });
            }
        }

        for (let i = 0; i < this._ripplePool.length; i++) {
            const drop = this._ripplePool[i];
            const age = t - drop.birth;

            if (age > drop.duration || age < 0) {
                // Respawn at a new dynamic random position
                drop.x = Math.random() * width;
                drop.y = Math.random() * height;
                drop.birth = t;
                drop.duration = 2.2 + Math.random() * 1.2;
                drop.maxR = 50 + Math.random() * 45;
                continue;
            }

            const lifeProg = age / drop.duration;

            // 1. Splash droplet impact spark (first 0.28s)
            if (age < 0.28) {
                const splashProg = age / 0.28;
                const splashAlpha = (1 - splashProg) * 0.85;
                ctx.fillStyle = `rgba(186, 230, 253, ${splashAlpha.toFixed(2)})`;
                ctx.beginPath();
                ctx.arc(drop.x, drop.y, 2.5 * (1 - splashProg * 0.4), 0, Math.PI * 2);
                ctx.fill();

                // Faint splash halo
                ctx.strokeStyle = `rgba(56, 189, 248, ${(splashAlpha * 0.6).toFixed(2)})`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(drop.x, drop.y, 4 + splashProg * 8, 0, Math.PI * 2);
                ctx.stroke();
            }

            // 2. Concentric expanding perspective wave rings
            for (let r = 0; r < drop.rings; r++) {
                const ringOffset = r * 0.22;
                const rProg = lifeProg - ringOffset;
                if (rProg > 0 && rProg < 1) {
                    const currentR = drop.maxR * Math.pow(rProg, 0.65);
                    const ringAlpha = (1 - rProg) * (0.34 - r * 0.08);

                    ctx.strokeStyle = `rgba(34, 211, 238, ${ringAlpha.toFixed(2)})`;
                    ctx.lineWidth = Math.max(0.8, 1.8 * (1 - rProg));
                    ctx.beginPath();
                    // Perspective ellipse (ry = rx * 0.72) for realistic fluid surface angle
                    ctx.ellipse(drop.x, drop.y, Math.max(2, currentR), Math.max(1.5, currentR * 0.72), 0, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }
        }
    },

    // 14. Cyber Glitch: Digital scanlines and tech block bursts
    drawGlitch(ctx, width, height, t) {
        ctx.fillStyle = '#030f09';
        ctx.fillRect(0, 0, width, height);

        const rowH = 14;
        const rows = Math.ceil(height / rowH);

        for (let r = 0; r < rows; r++) {
            const y = r * rowH;
            const isGlitch = Math.sin(t * 5 + r * 11) > 0.82;
            const shift = isGlitch ? Math.sin(t * 8 + r * 3) * 22 : 0;
            const alpha = isGlitch ? 0.45 : 0.12;

            ctx.strokeStyle = `rgba(74, 222, 128, ${alpha.toFixed(2)})`;
            ctx.lineWidth = 1.2;

            // Barcode data segments
            const segW = 20;
            const cols = Math.ceil(width / segW);
            for (let c = 0; c < cols; c++) {
                const x = c * segW + shift;
                if ((c * 7 + r * 13) % 3 === 0) {
                    ctx.fillStyle = `rgba(52, 211, 153, ${(alpha * 0.9).toFixed(2)})`;
                    ctx.fillRect(x, y + 2, segW * 0.6, rowH - 4);
                } else if ((c * 5 + r * 9) % 4 === 0) {
                    ctx.beginPath();
                    ctx.moveTo(x, y + rowH * 0.5);
                    ctx.lineTo(x + segW * 0.8, y + rowH * 0.5);
                    ctx.stroke();
                }
            }
        }
    },

    // 15. Arabesque Stars: Islamic 8-pointed star tessellation with rotating facets
    drawArabesque(ctx, width, height, t) {
        ctx.fillStyle = '#120a02';
        ctx.fillRect(0, 0, width, height);

        const starSize = 56;
        const cols = Math.ceil(width / starSize) + 2;
        const rows = Math.ceil(height / starSize) + 2;

        ctx.strokeStyle = 'rgba(245, 158, 11, 0.24)';
        ctx.lineWidth = 1.4;

        for (let c = -1; c < cols; c++) {
            for (let r = -1; r < rows; r++) {
                const sx = c * starSize + starSize * 0.5;
                const sy = r * starSize + starSize * 0.5;
                const pulse = Math.sin(t * 1.5 + c + r) * 0.15;
                const rot = t * 0.2 * ((c + r) % 2 === 0 ? 1 : -1);

                ctx.save();
                ctx.translate(sx, sy);
                ctx.rotate(rot);

                // Two overlapping rotated squares = 8-pointed star
                const r0 = (starSize * 0.38) * (1 + pulse);
                ctx.strokeRect(-r0 * 0.5, -r0 * 0.5, r0, r0);
                ctx.rotate(Math.PI / 4);
                ctx.strokeRect(-r0 * 0.5, -r0 * 0.5, r0, r0);

                // Central node
                ctx.fillStyle = 'rgba(251, 191, 36, 0.35)';
                ctx.beginPath();
                ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
                ctx.fill();

                ctx.restore();
            }
        }
    },

    // 16. Radar Sonar: 360Â° tactical sweep with pulsating echo blips
    drawSonar(ctx, width, height, t) {
        ctx.fillStyle = '#020e06';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const maxR = Math.min(width, height) * 0.44;

        // Concentric range rings
        ctx.strokeStyle = 'rgba(34, 197, 94, 0.18)';
        ctx.lineWidth = 1.3;
        for (let r = 1; r <= 4; r++) {
            ctx.beginPath();
            ctx.arc(cx, cy, maxR * (r / 4), 0, Math.PI * 2);
            ctx.stroke();
        }

        // Cardinal axes crosshairs
        ctx.beginPath();
        ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy);
        ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR);
        ctx.stroke();

        // Rotating radar beam
        const sweepAngle = (t * 1.8) % (Math.PI * 2);
        const sweepX = cx + Math.cos(sweepAngle) * maxR;
        const sweepY = cy + Math.sin(sweepAngle) * maxR;

        // Sweep cone gradient
        const coneGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
        coneGrad.addColorStop(0, 'rgba(74, 222, 128, 0.25)');
        coneGrad.addColorStop(1, 'rgba(34, 197, 94, 0.05)');
        ctx.fillStyle = coneGrad;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, maxR, sweepAngle - 0.4, sweepAngle, false);
        ctx.closePath();
        ctx.fill();

        // Beam line
        ctx.strokeStyle = 'rgba(134, 239, 172, 0.8)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(sweepX, sweepY);
        ctx.stroke();

        // Blip targets
        const blips = [
            { angle: 0.8, r: 0.65 },
            { angle: 2.3, r: 0.45 },
            { angle: 4.1, r: 0.78 },
            { angle: 5.4, r: 0.35 }
        ];

        for (let b = 0; b < blips.length; b++) {
            const bl = blips[b];
            const bx = cx + Math.cos(bl.angle) * (maxR * bl.r);
            const by = cy + Math.sin(bl.angle) * (maxR * bl.r);
            let diff = sweepAngle - bl.angle;
            if (diff < 0) diff += Math.PI * 2;
            const blipAlpha = Math.max(0, 1 - diff / 2.2);

            if (blipAlpha > 0.02) {
                ctx.fillStyle = `rgba(134, 239, 172, ${(blipAlpha * 0.95).toFixed(2)})`;
                ctx.beginPath();
                ctx.arc(bx, by, 3, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    },

    // 17. Matrix Code Streams
    _matrixStreams: null,
    drawMatrix(ctx, width, height, t) {
        ctx.fillStyle = '#020d06';
        ctx.fillRect(0, 0, width, height);

        const colW = 20;
        const cols = Math.ceil(width / colW);
        if (!this._matrixStreams || this._matrixStreams.length !== cols) {
            this._matrixStreams = [];
            for (let c = 0; c < cols; c++) {
                this._matrixStreams.push({
                    speed: 40 + Math.random() * 50,
                    offset: Math.random() * 800,
                    trailLen: 12 + Math.floor(Math.random() * 10),
                    chars: '0123456789ABCDEFï½¦ï½±ï½³ï½´ï½µï½¶ï½·ï½¹ï½ºï½»ï½¼ï½½ï½¾ï½¿ï¾€ï¾‚ï¾ƒï¾…ï¾†ï¾‡ï¾ˆï¾Šï¾‹ï¾Žï¾ï¾ï¾‘ï¾’ï¾“ï¾”ï¾•ï¾—ï¾˜ï¾œ'
                });
            }
        }

        ctx.font = '12px monospace';
        ctx.textAlign = 'center';

        for (let c = 0; c < cols; c++) {
            const st = this._matrixStreams[c];
            const colX = c * colW + colW * 0.5;
            const headY = ((t * st.speed + st.offset) % (height + 300)) - 100;

            for (let k = 0; k < st.trailLen; k++) {
                const charY = headY - k * 16;
                if (charY < -20 || charY > height + 20) continue;

                const charIdx = Math.abs(Math.floor(c * 17 + k * 13 + t * 4)) % st.chars.length;
                const ch = st.chars[charIdx];

                if (k === 0) {
                    ctx.fillStyle = '#ffffff';
                    ctx.fillText(ch, colX, charY);
                } else if (k < 3) {
                    ctx.fillStyle = 'rgba(74, 222, 128, 0.9)';
                    ctx.fillText(ch, colX, charY);
                } else {
                    const alpha = Math.max(0.08, (1 - k / st.trailLen) * 0.6);
                    ctx.fillStyle = `rgba(34, 197, 94, ${alpha.toFixed(2)})`;
                    ctx.fillText(ch, colX, charY);
                }
            }
        }
    },

    // 18. Fluid Neon Plasma Flow
    drawPlasma(ctx, width, height, t) {
        ctx.fillStyle = '#090314';
        ctx.fillRect(0, 0, width, height);

        const bands = 10;
        const step = height / (bands + 1);

        for (let i = 0; i < bands; i++) {
            const baseY = (i + 1) * step;
            const color = i % 2 === 0 ? 'rgba(236, 72, 153, 0.35)' : 'rgba(6, 182, 212, 0.35)';

            ctx.strokeStyle = color;
            ctx.lineWidth = 2.0;
            ctx.beginPath();

            const segs = 36;
            const dx = width / segs;
            for (let s = 0; s <= segs; s++) {
                const x = s * dx;
                const wave1 = Math.sin(x * 0.008 + t * 1.1 + i * 0.6) * 32;
                const wave2 = Math.cos(x * 0.016 - t * 0.8 + i * 1.1) * 18;
                const wave3 = Math.sin((x + baseY) * 0.004 + t * 0.5) * 14;
                const y = baseY + wave1 + wave2 + wave3;
                if (s === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        // Ambient plasma glow center
        const cx = width * 0.5 + Math.sin(t * 0.7) * 40;
        const cy = height * 0.5 + Math.cos(t * 0.6) * 40;
        const grad = ctx.createRadialGradient(cx, cy, 10, cx, cy, Math.min(width, height) * 0.45);
        grad.addColorStop(0, 'rgba(139, 92, 246, 0.22)');
        grad.addColorStop(0.5, 'rgba(236, 72, 153, 0.12)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(width, height) * 0.45, 0, Math.PI * 2);
        ctx.fill();
    },

    // 19. Retro Synthwave Outrun Grid & Neon Sun
    drawSynthwave(ctx, width, height, t) {
        ctx.fillStyle = '#0d0218';
        ctx.fillRect(0, 0, width, height);

        const horizonY = height * 0.52;
        const sunR = Math.min(width, height) * 0.22;
        const sunCX = width * 0.5;
        const sunCY = horizonY - sunR * 0.3;

        // Glowing Synthwave Sun
        const sunGrad = ctx.createLinearGradient(sunCX, sunCY - sunR, sunCX, sunCY + sunR);
        sunGrad.addColorStop(0, '#fef08a');
        sunGrad.addColorStop(0.5, '#f43f5e');
        sunGrad.addColorStop(1, '#9333ea');
        ctx.fillStyle = sunGrad;
        ctx.beginPath();
        ctx.arc(sunCX, sunCY, sunR, Math.PI, 0, false);
        ctx.fill();

        // Horizontal sun grill slice bars
        ctx.fillStyle = '#0d0218';
        const slices = 6;
        for (let s = 1; s <= slices; s++) {
            const barY = sunCY - sunR + (sunR / slices) * s;
            const barH = 2.5 + s * 1.5;
            ctx.fillRect(sunCX - sunR - 10, barY, (sunR + 10) * 2, barH);
        }

        // Neon Horizon Line
        ctx.strokeStyle = 'rgba(236, 72, 153, 0.85)';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(0, horizonY);
        ctx.lineTo(width, horizonY);
        ctx.stroke();

        // Receding 3D Perspective Grid
        const gridLines = 14;
        const speed = (t * 0.4) % 1.0;
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
        ctx.lineWidth = 1.2;

        // Horizontal lines accelerating towards viewer
        for (let i = 0; i < gridLines; i++) {
            const prog = (i + speed) / gridLines;
            const y = horizonY + Math.pow(prog, 2.2) * (height - horizonY);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        // Perspective longitudinal vanishing rays
        const vCols = 16;
        for (let c = -vCols; c <= vCols; c++) {
            const vx = width * 0.5 + c * (width * 0.12);
            ctx.beginPath();
            ctx.moveTo(width * 0.5, horizonY);
            ctx.lineTo(vx, height);
            ctx.stroke();
        }
    },

    // 20. Quantum Orbitals & Electron Shells
    drawQuantum(ctx, width, height, t) {
        ctx.fillStyle = '#040914';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const maxR = Math.min(width, height) * 0.38;

        // Nucleus cluster
        const nPulse = (Math.sin(t * 2.5) + 1) * 0.5;
        ctx.fillStyle = `rgba(56, 189, 248, ${(0.4 + nPulse * 0.4).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, 6 + nPulse * 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
        ctx.fill();

        // 4 rotating quantum orbital ellipses
        const orbitals = [
            { angle: 0, speed: 1.2, color: 'rgba(56, 189, 248, 0.4)', nodeColor: '#38bdf8' },
            { angle: Math.PI / 4, speed: -1.0, color: 'rgba(129, 140, 248, 0.4)', nodeColor: '#818cf8' },
            { angle: Math.PI / 2, speed: 1.4, color: 'rgba(45, 212, 191, 0.4)', nodeColor: '#2dd4bf' },
            { angle: (Math.PI * 3) / 4, speed: -1.2, color: 'rgba(192, 132, 252, 0.4)', nodeColor: '#c084fc' }
        ];

        for (let o = 0; o < orbitals.length; o++) {
            const orb = orbitals[o];
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(orb.angle + t * 0.1);

            ctx.strokeStyle = orb.color;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.ellipse(0, 0, maxR, maxR * 0.32, 0, 0, Math.PI * 2);
            ctx.stroke();

            // Electron particle moving along ellipse
            const eAngle = t * orb.speed;
            const ex = Math.cos(eAngle) * maxR;
            const ey = Math.sin(eAngle) * (maxR * 0.32);

            ctx.fillStyle = orb.nodeColor;
            ctx.beginPath();
            ctx.arc(ex, ey, 3.2, 0, Math.PI * 2);
            ctx.fill();

            // Specular core
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(ex, ey, 1.4, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        }
    },

    // 21. Cosmic Stardust & Nebula Clouds
    _nebulaStars: null,
    drawNebula(ctx, width, height, t) {
        ctx.fillStyle = '#05020c';
        ctx.fillRect(0, 0, width, height);

        if (!this._nebulaStars) {
            this._nebulaStars = [];
            const count = 45;
            for (let i = 0; i < count; i++) {
                this._nebulaStars.push({
                    x: Math.random(),
                    y: Math.random(),
                    r: 0.8 + Math.random() * 1.8,
                    pulseSpeed: 1 + Math.random() * 2,
                    isFlare: Math.random() > 0.85
                });
            }
        }

        // Luminous breathing gas clouds
        const clouds = [
            { cx: 0.35, cy: 0.4, r: 0.45, color: 'rgba(168, 85, 247, 0.18)' },
            { cx: 0.65, cy: 0.6, r: 0.50, color: 'rgba(59, 130, 246, 0.16)' },
            { cx: 0.5, cy: 0.3, r: 0.38, color: 'rgba(236, 72, 153, 0.14)' }
        ];

        for (let c = 0; c < clouds.length; c++) {
            const cl = clouds[c];
            const px = (cl.cx + Math.sin(t * 0.3 + c) * 0.06) * width;
            const py = (cl.cy + Math.cos(t * 0.25 + c) * 0.06) * height;
            const rad = cl.r * Math.min(width, height) * (1 + 0.08 * Math.sin(t * 0.6 + c));

            const grad = ctx.createRadialGradient(px, py, 10, px, py, rad);
            grad.addColorStop(0, cl.color);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(px, py, rad, 0, Math.PI * 2);
            ctx.fill();
        }

        // Stars & Stellar Flares
        for (let i = 0; i < this._nebulaStars.length; i++) {
            const s = this._nebulaStars[i];
            const sx = s.x * width;
            const sy = s.y * height;
            const pulse = (Math.sin(t * s.pulseSpeed + i) + 1) * 0.5;
            const alpha = 0.3 + pulse * 0.7;

            ctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(2)})`;
            ctx.beginPath();
            ctx.arc(sx, sy, s.r * (0.8 + 0.4 * pulse), 0, Math.PI * 2);
            ctx.fill();

            if (s.isFlare && pulse > 0.6) {
                const flareLen = 6 + pulse * 8;
                ctx.strokeStyle = `rgba(224, 242, 254, ${(pulse * 0.6).toFixed(2)})`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(sx - flareLen, sy); ctx.lineTo(sx + flareLen, sy);
                ctx.moveTo(sx, sy - flareLen); ctx.lineTo(sx, sy + flareLen);
                ctx.stroke();
            }
        }
    },

    // 22. Bio Voronoi Cellular Crystals
    drawVoronoi(ctx, width, height, t) {
        ctx.fillStyle = '#020d0e';
        ctx.fillRect(0, 0, width, height);

        const cellSize = 80;
        const cols = Math.ceil(width / cellSize) + 1;
        const rows = Math.ceil(height / cellSize) + 1;

        ctx.strokeStyle = 'rgba(45, 212, 191, 0.22)';
        ctx.lineWidth = 1.4;

        // Cellular lattice with harmonic breathing vertices
        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
                const ox = Math.sin(t * 0.8 + c * 1.5 + r * 2.1) * 14;
                const oy = Math.cos(t * 0.7 + c * 2.3 + r * 1.2) * 14;
                const vx = c * cellSize + ox;
                const vy = r * cellSize + oy;

                // Center nucleus
                const pulse = (Math.sin(t * 1.5 + c + r) + 1) * 0.5;
                ctx.fillStyle = `rgba(45, 212, 191, ${(0.2 + pulse * 0.4).toFixed(2)})`;
                ctx.beginPath();
                ctx.arc(vx, vy, 2.8 + pulse * 1.5, 0, Math.PI * 2);
                ctx.fill();

                // Connecting edges to neighbors
                if (c < cols - 1) {
                    const nox = Math.sin(t * 0.8 + (c + 1) * 1.5 + r * 2.1) * 14;
                    const noy = Math.cos(t * 0.7 + (c + 1) * 2.3 + r * 1.2) * 14;
                    ctx.beginPath();
                    ctx.moveTo(vx, vy);
                    ctx.lineTo((c + 1) * cellSize + nox, r * cellSize + noy);
                    ctx.stroke();
                }
                if (r < rows - 1) {
                    const nox = Math.sin(t * 0.8 + c * 1.5 + (r + 1) * 2.1) * 14;
                    const noy = Math.cos(t * 0.7 + c * 2.3 + (r + 1) * 1.2) * 14;
                    ctx.beginPath();
                    ctx.moveTo(vx, vy);
                    ctx.lineTo(c * cellSize + nox, (r + 1) * cellSize + noy);
                    ctx.stroke();
                }
            }
        }
    },

    // 23. Prismatic Origami 3D Diamond Shards
    drawOrigami(ctx, width, height, t) {
        ctx.fillStyle = '#090712';
        ctx.fillRect(0, 0, width, height);

        const size = 64;
        const cols = Math.ceil(width / size) + 1;
        const rows = Math.ceil(height / size) + 1;
        const lightX = width * 0.5 + Math.cos(t * 0.8) * (width * 0.4);
        const lightY = height * 0.5 + Math.sin(t * 0.6) * (height * 0.4);

        for (let c = 0; c < cols; c++) {
            const bx = c * size;
            for (let r = 0; r < rows; r++) {
                const by = r * size;
                const midX = bx + size * 0.5;
                const midY = by + size * 0.5;

                // 4 triangular facets per cell meeting in center
                const facets = [
                    [bx, by, bx + size, by, midX, midY],
                    [bx + size, by, bx + size, by + size, midX, midY],
                    [bx + size, by + size, bx, by + size, midX, midY],
                    [bx, by + size, bx, by, midX, midY]
                ];

                for (let f = 0; f < 4; f++) {
                    const tri = facets[f];
                    const triCX = (tri[0] + tri[2] + tri[4]) / 3;
                    const triCY = (tri[1] + tri[3] + tri[5]) / 3;
                    const dist = Math.hypot(triCX - lightX, triCY - lightY);
                    const light = Math.max(0.04, 1 - dist / (width * 0.7));

                    ctx.fillStyle = `rgba(168, 85, 247, ${(0.05 + light * 0.28).toFixed(2)})`;
                    ctx.beginPath();
                    ctx.moveTo(tri[0], tri[1]);
                    ctx.lineTo(tri[2], tri[3]);
                    ctx.lineTo(tri[4], tri[5]);
                    ctx.closePath();
                    ctx.fill();

                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }
            }
        }
    },

    // 24. Fluid Harmonic Audio Soundwave
    drawSoundwave(ctx, width, height, t) {
        ctx.fillStyle = '#030c10';
        ctx.fillRect(0, 0, width, height);

        const barCount = Math.min(32, Math.floor(width / 16));
        const barW = Math.max(3, (width - (barCount - 1) * 8) / barCount);
        const midY = height * 0.5;

        for (let i = 0; i < barCount; i++) {
            const bx = i * (barW + 8) + 4;
            const freq = i * 0.35 + t * 2.2;
            const hFactor = (Math.sin(freq) * 0.5 + Math.cos(freq * 0.5) * 0.3 + 0.8) * 0.5;
            const barH = 20 + hFactor * (height * 0.32);

            const isGold = i % 3 === 0;
            const col = isGold ? 'rgba(245, 158, 11, 0.7)' : 'rgba(45, 212, 191, 0.75)';

            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.roundRect(bx, midY - barH * 0.5, barW, barH, barW * 0.5);
            ctx.fill();

            // Peak cap dot
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(bx + barW * 0.5, midY - barH * 0.5 - 4, 1.8, 0, Math.PI * 2);
            ctx.fill();
        }

        // Horizontal fluid sine wave overlay
        ctx.strokeStyle = 'rgba(20, 184, 166, 0.35)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        const segs = 40;
        const dx = width / segs;
        for (let s = 0; s <= segs; s++) {
            const x = s * dx;
            const y = midY + Math.sin(x * 0.015 + t * 2.5) * 28;
            if (s === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    },

    // 25. 4D Tesseract Hypercube Projection
    drawHypercube(ctx, width, height, t) {
        ctx.fillStyle = '#060714';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const baseSize = Math.min(width, height) * 0.36;

        // 4D rotation angle
        const rot = t * 0.8;
        const scaleInner = 0.45 + Math.sin(rot) * 0.15;
        const scaleOuter = 0.95 - Math.sin(rot) * 0.15;

        const verticesOuter = [
            [-1, -1], [1, -1], [1, 1], [-1, 1]
        ].map(([vx, vy]) => {
            const ang = Math.atan2(vy, vx) + rot * 0.3;
            const dist = Math.hypot(vx, vy) * baseSize * 0.5 * scaleOuter;
            return [cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist];
        });

        const verticesInner = [
            [-1, -1], [1, -1], [1, 1], [-1, 1]
        ].map(([vx, vy]) => {
            const ang = Math.atan2(vy, vx) - rot * 0.4;
            const dist = Math.hypot(vx, vy) * baseSize * 0.5 * scaleInner;
            return [cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist];
        });

        // Connecting 4D hypercube diagonal edges
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.4)';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 4; i++) {
            ctx.beginPath();
            ctx.moveTo(verticesOuter[i][0], verticesOuter[i][1]);
            ctx.lineTo(verticesInner[i][0], verticesInner[i][1]);
            ctx.stroke();
        }

        // Outer cube
        ctx.strokeStyle = 'rgba(129, 140, 248, 0.7)';
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
            if (i === 0) ctx.moveTo(verticesOuter[i][0], verticesOuter[i][1]);
            else ctx.lineTo(verticesOuter[i][0], verticesOuter[i][1]);
        }
        ctx.closePath();
        ctx.stroke();

        // Inner cube
        ctx.strokeStyle = 'rgba(165, 180, 252, 0.85)';
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
            if (i === 0) ctx.moveTo(verticesInner[i][0], verticesInner[i][1]);
            else ctx.lineTo(verticesInner[i][0], verticesInner[i][1]);
        }
        ctx.closePath();
        ctx.stroke();

        // Vertices nodes
        ctx.fillStyle = '#818cf8';
        for (let i = 0; i < 4; i++) {
            ctx.beginPath();
            ctx.arc(verticesOuter[i][0], verticesOuter[i][1], 3.5, 0, Math.PI * 2);
            ctx.arc(verticesInner[i][0], verticesInner[i][1], 3.0, 0, Math.PI * 2);
            ctx.fill();
        }
    },

    // 26. Sacred Fibonacci Golden Spiral
    drawFibonacci(ctx, width, height, t) {
        ctx.fillStyle = '#120902';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const phi = 1.61803398875;
        const count = 75;
        const rot = t * 0.25;

        for (let i = 1; i <= count; i++) {
            const angle = i * Math.PI * 2 * (1 - 1 / phi) + rot;
            const r = Math.sqrt(i) * (Math.min(width, height) * 0.045);
            const px = cx + Math.cos(angle) * r;
            const py = cy + Math.sin(angle) * r;
            const pulse = (Math.sin(t * 1.5 + i * 0.15) + 1) * 0.5;
            const nodeR = 2.0 + pulse * 2.0;

            const alpha = Math.min(0.85, 0.25 + (1 - i / count) * 0.6);
            ctx.fillStyle = i % 2 === 0 ? `rgba(245, 158, 11, ${alpha.toFixed(2)})` : `rgba(251, 191, 36, ${alpha.toFixed(2)})`;
            ctx.beginPath();
            ctx.arc(px, py, nodeR, 0, Math.PI * 2);
            ctx.fill();
        }

        // Center golden seed
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
        ctx.fill();
    },

    // 27. Neural Synapse Network
    _synapseNodes: null,
    drawSynapse(ctx, width, height, t) {
        ctx.fillStyle = '#030c14';
        ctx.fillRect(0, 0, width, height);

        if (!this._synapseNodes) {
            this._synapseNodes = [];
            const count = 28;
            for (let i = 0; i < count; i++) {
                this._synapseNodes.push({
                    x: Math.random(),
                    y: Math.random(),
                    pulse: Math.random() * Math.PI * 2
                });
            }
        }

        const maxDist = Math.min(width, height) * 0.26;
        const positions = this._synapseNodes.map(n => ({
            x: (n.x + Math.sin(t * 0.4 + n.pulse) * 0.03) * width,
            y: (n.y + Math.cos(t * 0.35 + n.pulse) * 0.03) * height
        }));

        // Draw axon connecting bridges
        ctx.lineWidth = 1.2;
        for (let i = 0; i < positions.length; i++) {
            for (let j = i + 1; j < positions.length; j++) {
                const dx = positions[i].x - positions[j].x;
                const dy = positions[i].y - positions[j].y;
                const dist = Math.hypot(dx, dy);

                if (dist < maxDist) {
                    const alpha = (1 - dist / maxDist) * 0.35;
                    ctx.strokeStyle = `rgba(56, 189, 248, ${alpha.toFixed(2)})`;
                    ctx.beginPath();
                    ctx.moveTo(positions[i].x, positions[i].y);
                    ctx.lineTo(positions[j].x, positions[j].y);
                    ctx.stroke();

                    // Action potential spark traveling along axon
                    const sparkProg = (t * 0.8 + (i * 3 + j * 7) * 0.2) % 1.0;
                    if (sparkProg < 0.3) {
                        const subProg = sparkProg / 0.3;
                        const sx = positions[i].x + (positions[j].x - positions[i].x) * subProg;
                        const sy = positions[i].y + (positions[j].y - positions[i].y) * subProg;
                        ctx.fillStyle = '#ffffff';
                        ctx.beginPath();
                        ctx.arc(sx, sy, 2.0, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            }
        }

        // Neuron nodes
        for (let i = 0; i < positions.length; i++) {
            const p = positions[i];
            const pulse = (Math.sin(t * 2 + i) + 1) * 0.5;
            ctx.fillStyle = `rgba(56, 189, 248, ${(0.4 + pulse * 0.5).toFixed(2)})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3.2 + pulse * 2, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(p.x, p.y, 1.4, 0, Math.PI * 2);
            ctx.fill();
        }
    },

    // 28. Refracting Laser Optics & Spectral Prism
    drawPrism(ctx, width, height, t) {
        ctx.fillStyle = '#0c0410';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.42;
        const cy = height * 0.5;
        const prismR = Math.min(width, height) * 0.22;

        // Central equilateral glass prism
        const pAngle = t * 0.15;
        const pVertices = [0, 1, 2].map(k => {
            const a = pAngle + (k / 3) * Math.PI * 2 - Math.PI * 0.5;
            return [cx + Math.cos(a) * prismR, cy + Math.sin(a) * prismR];
        });

        // Inbound White Laser Beam
        const beamAngle = t * 0.2;
        const inX = cx - Math.cos(beamAngle) * (width * 0.6);
        const inY = cy - Math.sin(beamAngle) * (height * 0.3);

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(inX, inY);
        ctx.lineTo(cx, cy);
        ctx.stroke();

        // Spectral Refracted Rays (Red to Violet)
        const spectrum = [
            'rgba(244, 63, 94, 0.75)',
            'rgba(245, 158, 11, 0.75)',
            'rgba(234, 179, 8, 0.75)',
            'rgba(34, 197, 94, 0.75)',
            'rgba(6, 182, 212, 0.75)',
            'rgba(168, 85, 247, 0.75)'
        ];

        for (let i = 0; i < spectrum.length; i++) {
            const spreadAngle = beamAngle + 0.15 + (i / spectrum.length) * 0.45;
            const outX = cx + Math.cos(spreadAngle) * (width * 0.7);
            const outY = cy + Math.sin(spreadAngle) * (height * 0.6);

            ctx.strokeStyle = spectrum[i];
            ctx.lineWidth = 2.0;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(outX, outY);
            ctx.stroke();
        }

        // Glass Prism Outline & Translucent Fill
        ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(pVertices[0][0], pVertices[0][1]);
        ctx.lineTo(pVertices[1][0], pVertices[1][1]);
        ctx.lineTo(pVertices[2][0], pVertices[2][1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    },

    // 29. Velvet Desert Dunes & Wind Contours
    drawDunes(ctx, width, height, t) {
        ctx.fillStyle = '#140a04';
        ctx.fillRect(0, 0, width, height);

        const duneLayers = 5;
        const step = height / (duneLayers + 1);

        for (let d = 0; d < duneLayers; d++) {
            const baseY = step * (d + 1.2);
            const speed = 0.15 + d * 0.08;

            ctx.beginPath();
            ctx.moveTo(-20, height + 20);

            const segs = 32;
            const dx = (width + 40) / segs;
            for (let s = 0; s <= segs; s++) {
                const x = s * dx - 20;
                const wave1 = Math.sin(x * 0.006 + t * speed + d * 1.8) * 35;
                const wave2 = Math.cos(x * 0.012 - t * speed * 0.7 + d) * 18;
                const y = baseY + wave1 + wave2;
                if (s === 0) ctx.lineTo(x, y);
                else ctx.lineTo(x, y);
            }

            ctx.lineTo(width + 20, height + 20);
            ctx.closePath();

            const alpha = 0.2 + (d / duneLayers) * 0.45;
            ctx.fillStyle = `rgba(217, 119, 6, ${alpha.toFixed(2)})`;
            ctx.fill();

            ctx.strokeStyle = `rgba(251, 191, 36, ${(alpha * 0.8).toFixed(2)})`;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
    },

    // 30. Tokyo Metro Cyberpunk Transit Grid
    drawMegacity(ctx, width, height, t) {
        ctx.fillStyle = '#050810';
        ctx.fillRect(0, 0, width, height);

        const lines = [
            { color: 'rgba(6, 182, 212, 0.45)', trainColor: '#22d3ee', path: [[0, 0.2], [0.35, 0.2], [0.55, 0.4], [1.0, 0.4]] },
            { color: 'rgba(236, 72, 153, 0.45)', trainColor: '#f472b6', path: [[0, 0.75], [0.4, 0.75], [0.65, 0.5], [1.0, 0.5]] },
            { color: 'rgba(245, 158, 11, 0.45)', trainColor: '#fbbf24', path: [[0.25, 0], [0.25, 0.45], [0.5, 0.7], [0.5, 1.0]] },
            { color: 'rgba(16, 185, 129, 0.45)', trainColor: '#34d399', path: [[0.75, 0], [0.75, 0.35], [0.55, 0.55], [0.85, 0.85], [0.85, 1.0]] }
        ];

        ctx.lineWidth = 2.0;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (let l = 0; l < lines.length; l++) {
            const line = lines[l];
            ctx.strokeStyle = line.color;
            ctx.beginPath();
            for (let p = 0; p < line.path.length; p++) {
                const px = line.path[p][0] * width;
                const py = line.path[p][1] * height;
                if (p === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.stroke();

            // Train pulse moving along the track
            const prog = (t * 0.35 + l * 0.25) % 1.0;
            const segIdx = Math.floor(prog * (line.path.length - 1));
            const subProg = (prog * (line.path.length - 1)) % 1.0;
            const p0 = line.path[segIdx];
            const p1 = line.path[segIdx + 1] || p0;
            const tx = (p0[0] + (p1[0] - p0[0]) * subProg) * width;
            const ty = (p0[1] + (p1[1] - p0[1]) * subProg) * height;

            ctx.fillStyle = line.trainColor;
            ctx.beginPath();
            ctx.arc(tx, ty, 3.8, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(tx, ty, 1.8, 0, Math.PI * 2);
            ctx.fill();
        }
    },

    // 31. Hyperspace Warp Wormhole
    drawVortex(ctx, width, height, t) {
        ctx.fillStyle = '#04020a';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const maxR = Math.hypot(cx, cy);
        const ringCount = 18;

        for (let i = 0; i < ringCount; i++) {
            const prog = ((t * 0.35 + i / ringCount) % 1.0);
            const r = Math.pow(prog, 2.2) * maxR;
            const rot = t * 0.8 + i * 0.3;
            const alpha = Math.min(0.7, (1 - prog) * 0.8);

            ctx.strokeStyle = i % 2 === 0 ? `rgba(168, 85, 247, ${alpha.toFixed(2)})` : `rgba(56, 189, 248, ${alpha.toFixed(2)})`;
            ctx.lineWidth = 1.2 + prog * 1.5;

            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(rot);
            ctx.beginPath();
            ctx.ellipse(0, 0, r, r * 0.75, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        // Center singularity
        ctx.fillStyle = '#000000';
        ctx.beginPath();
        ctx.arc(cx, cy, 14, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
        ctx.lineWidth = 1.8;
        ctx.stroke();
    },

    // 32. Polar Aurora Curtains
    drawAuroraRibbon(ctx, width, height, t) {
        ctx.fillStyle = '#020e0c';
        ctx.fillRect(0, 0, width, height);

        const curtains = [
            { baseY: height * 0.35, color0: 'rgba(16, 185, 129, 0.45)', color1: 'rgba(6, 182, 212, 0.15)', speed: 0.8 },
            { baseY: height * 0.50, color0: 'rgba(6, 182, 212, 0.40)', color1: 'rgba(168, 85, 247, 0.15)', speed: -0.6 },
            { baseY: height * 0.65, color0: 'rgba(168, 85, 247, 0.40)', color1: 'rgba(16, 185, 129, 0.15)', speed: 0.7 }
        ];

        for (let c = 0; c < curtains.length; c++) {
            const cur = curtains[c];
            const segs = 36;
            const dx = width / segs;

            for (let s = 0; s <= segs; s++) {
                const x = s * dx;
                const wave = Math.sin(x * 0.008 + t * cur.speed + c * 1.2) * 45;
                const yTop = cur.baseY + wave - 50;
                const yBottom = cur.baseY + wave + 50;

                const grad = ctx.createLinearGradient(x, yTop, x, yBottom);
                grad.addColorStop(0, 'rgba(0,0,0,0)');
                grad.addColorStop(0.5, cur.color0);
                grad.addColorStop(1, cur.color1);

                ctx.strokeStyle = grad;
                ctx.lineWidth = dx + 1;
                ctx.beginPath();
                ctx.moveTo(x, yTop);
                ctx.lineTo(x, yBottom);
                ctx.stroke();
            }
        }
    },

    // 33. Event Horizon Black Hole
    drawBlackHole(ctx, width, height, t) {
        ctx.fillStyle = '#020005';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const baseR = Math.min(width, height) * 0.22;

        // Relativistic vertical matter jets
        const jetGrad = ctx.createLinearGradient(cx, 0, cx, height);
        jetGrad.addColorStop(0, 'rgba(56, 189, 248, 0.4)');
        jetGrad.addColorStop(0.35, 'rgba(56, 189, 248, 0.1)');
        jetGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
        jetGrad.addColorStop(0.65, 'rgba(56, 189, 248, 0.1)');
        jetGrad.addColorStop(1, 'rgba(56, 189, 248, 0.4)');
        ctx.fillStyle = jetGrad;
        ctx.fillRect(cx - 3, 0, 6, height);

        // Gravitational lensing outer Einstein halo
        const haloGrad = ctx.createRadialGradient(cx, cy, baseR * 0.9, cx, cy, baseR * 2.2);
        haloGrad.addColorStop(0, 'rgba(251, 191, 36, 0.45)');
        haloGrad.addColorStop(0.4, 'rgba(245, 158, 11, 0.2)');
        haloGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = haloGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR * 2.2, 0, Math.PI * 2);
        ctx.fill();

        // Accretion disk spinning rings with Doppler beaming
        const ringCount = 16;
        for (let i = 0; i < ringCount; i++) {
            const rX = baseR * (1.1 + (i / ringCount) * 1.6);
            const rY = rX * 0.38;
            const tilt = -0.35;
            const rot = t * 1.2 + i * 0.2;

            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(tilt);

            const beamGrad = ctx.createLinearGradient(-rX, 0, rX, 0);
            beamGrad.addColorStop(0, 'rgba(254, 240, 138, 0.7)');
            beamGrad.addColorStop(0.3, 'rgba(251, 191, 36, 0.5)');
            beamGrad.addColorStop(0.7, 'rgba(245, 158, 11, 0.25)');
            beamGrad.addColorStop(1, 'rgba(220, 38, 38, 0.1)');

            ctx.strokeStyle = beamGrad;
            ctx.lineWidth = 1.4 + (i % 3) * 0.8;
            ctx.beginPath();
            ctx.ellipse(0, 0, rX, rY, 0, 0, Math.PI * 2);
            ctx.stroke();

            const knotAngle = rot + (i * Math.PI) / 8;
            const kx = Math.cos(knotAngle) * rX;
            const ky = Math.sin(knotAngle) * rY;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(kx, ky, 1.2, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        }

        // Central Pitch-Black Event Horizon
        ctx.fillStyle = '#000000';
        ctx.beginPath();
        ctx.arc(cx, cy, baseR * 0.82, 0, Math.PI * 2);
        ctx.fill();

        // Razor-thin photon sphere ring
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR * 0.84, 0, Math.PI * 2);
        ctx.stroke();
    },

    // 34. Royal Circuit (24K Gold Motherboard)
    drawRoyalCircuit(ctx, width, height, t) {
        ctx.fillStyle = '#090703';
        ctx.fillRect(0, 0, width, height);

        const grid = 48;
        const cols = Math.ceil(width / grid) + 1;
        const rows = Math.ceil(height / grid) + 1;

        ctx.lineWidth = 1.5;

        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
                const x = c * grid;
                const y = r * grid;
                const seed = (c * 19 + r * 37) % 7;

                ctx.strokeStyle = 'rgba(251, 191, 36, 0.22)';
                ctx.beginPath();
                if (seed === 0) {
                    ctx.moveTo(x, y);
                    ctx.lineTo(x + grid * 0.5, y);
                    ctx.lineTo(x + grid, y + grid * 0.5);
                } else if (seed === 1) {
                    ctx.moveTo(x, y);
                    ctx.lineTo(x, y + grid * 0.5);
                    ctx.lineTo(x + grid * 0.5, y + grid);
                } else if (seed === 2) {
                    ctx.moveTo(x + grid, y);
                    ctx.lineTo(x + grid * 0.5, y + grid * 0.5);
                    ctx.lineTo(x + grid * 0.5, y + grid);
                } else if (seed === 3) {
                    ctx.moveTo(x, y + grid * 0.5);
                    ctx.lineTo(x + grid, y + grid * 0.5);
                } else {
                    ctx.moveTo(x + grid * 0.5, y);
                    ctx.lineTo(x + grid * 0.5, y + grid);
                }
                ctx.stroke();

                if (seed < 4) {
                    ctx.fillStyle = '#090703';
                    ctx.beginPath();
                    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = 'rgba(251, 191, 36, 0.6)';
                    ctx.lineWidth = 1.2;
                    ctx.stroke();
                }

                const pulse = ((t * 1.5 + (c + r) * 0.2) % 1.0);
                if (seed === 0 || seed === 3) {
                    const px = x + pulse * grid;
                    const py = y;
                    ctx.fillStyle = 'rgba(254, 240, 138, 0.85)';
                    ctx.beginPath();
                    ctx.arc(px, py, 2.2, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
    },

    // 35. Liquid Mercury (Fluid Chrome Ripples)
    drawLiquidMercury(ctx, width, height, t) {
        ctx.fillStyle = '#050508';
        ctx.fillRect(0, 0, width, height);

        const waveCount = 5;
        for (let w = 0; w < waveCount; w++) {
            const baseY = (height / (waveCount + 1)) * (w + 1);
            const speed = (w % 2 === 0 ? 1 : -1) * (0.6 + w * 0.15);
            const amp = 22 + w * 6;

            ctx.beginPath();
            ctx.moveTo(0, baseY);

            for (let x = 0; x <= width; x += 12) {
                const y = baseY + Math.sin(x * 0.015 + t * speed + w) * amp + Math.cos(x * 0.007 - t * speed * 0.8) * (amp * 0.5);
                ctx.lineTo(x, y);
            }

            const alpha = 0.2 + (w / waveCount) * 0.35;
            ctx.strokeStyle = `rgba(228, 228, 231, ${alpha.toFixed(2)})`;
            ctx.lineWidth = 2 + w * 0.8;
            ctx.stroke();
        }

        const dropCount = 12;
        for (let i = 0; i < dropCount; i++) {
            const dx = (width * 0.15) + ((i * 123 + t * 25) % (width * 0.7));
            const dy = (height * 0.15) + ((i * 187 + Math.sin(t * 0.8 + i) * 60) % (height * 0.7));
            const r = 8 + (i % 4) * 4;

            const grad = ctx.createRadialGradient(dx - r * 0.35, dy - r * 0.35, r * 0.1, dx, dy, r);
            grad.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
            grad.addColorStop(0.4, 'rgba(203, 213, 225, 0.55)');
            grad.addColorStop(0.8, 'rgba(100, 116, 139, 0.35)');
            grad.addColorStop(1, 'rgba(15, 23, 42, 0.1)');

            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(dx, dy, r, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    },

    // 36. Emerald Lattice (Hexagonal Beryl Prisms)
    drawEmeraldLattice(ctx, width, height, t) {
        ctx.fillStyle = '#010c08';
        ctx.fillRect(0, 0, width, height);

        const hexR = 36;
        const hexH = hexR * Math.sqrt(3);
        const cols = Math.ceil(width / (hexR * 3)) + 1;
        const rows = Math.ceil(height / (hexH * 0.5)) + 1;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cx = c * (hexR * 3) + ((r % 2) * hexR * 1.5);
                const cy = r * (hexH * 0.5);
                const pulse = Math.sin(t * 1.5 + (c + r) * 0.5);
                const alpha = 0.18 + (pulse + 1) * 0.14;

                ctx.strokeStyle = `rgba(52, 211, 153, ${alpha.toFixed(2)})`;
                ctx.lineWidth = 1.3;
                ctx.beginPath();
                for (let a = 0; a < 6; a++) {
                    const angle = (a * Math.PI) / 3;
                    const hx = cx + Math.cos(angle) * (hexR * 0.88);
                    const hy = cy + Math.sin(angle) * (hexR * 0.88);
                    if (a === 0) ctx.moveTo(hx, hy);
                    else ctx.lineTo(hx, hy);
                }
                ctx.closePath();
                ctx.stroke();

                ctx.fillStyle = pulse > 0.4 ? '#34d399' : 'rgba(16, 185, 129, 0.6)';
                ctx.beginPath();
                ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    },

    // 37. Holo Terrestrial (3D Wireframe Cyber Earth)
    drawHoloGlobe(ctx, width, height, t) {
        ctx.fillStyle = '#020914';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const R = Math.min(width, height) * 0.35;
        const rot = t * 0.4;

        ctx.strokeStyle = 'rgba(6, 182, 212, 0.55)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.stroke();

        const latCount = 7;
        for (let i = 1; i < latCount; i++) {
            const latAngle = ((i / latCount) - 0.5) * Math.PI;
            const rLat = Math.cos(latAngle) * R;
            const yLat = cy + Math.sin(latAngle) * R;

            ctx.strokeStyle = 'rgba(6, 182, 212, 0.25)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.ellipse(cx, yLat, rLat, rLat * 0.28, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        const lonCount = 8;
        for (let j = 0; j < lonCount; j++) {
            const lonAngle = (j * Math.PI) / lonCount + rot;
            const rX = Math.cos(lonAngle) * R;
            const alpha = Math.abs(Math.sin(lonAngle)) * 0.35 + 0.15;

            ctx.strokeStyle = `rgba(56, 189, 248, ${alpha.toFixed(2)})`;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.abs(rX), R, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        const satAngle = -t * 0.7;
        const satR = R * 1.25;
        const sx = cx + Math.cos(satAngle) * satR;
        const sy = cy + Math.sin(satAngle) * (satR * 0.45);

        ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(cx, cy, satR, satR * 0.45, -0.2, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
        ctx.fill();
    },

    // 38. Neon Low-Poly (Crystalline Violet Peaks)
    drawNeonPoly(ctx, width, height, t) {
        ctx.fillStyle = '#080214';
        ctx.fillRect(0, 0, width, height);

        const stepX = 48;
        const stepY = 42;
        const cols = Math.ceil(width / stepX) + 2;
        const rows = Math.ceil(height / stepY) + 2;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const x0 = c * stepX + ((r % 2) * stepX * 0.5);
                const y0 = r * stepY;
                const wave = Math.sin(t * 1.2 + c * 0.4 + r * 0.6) * 12;

                const p1x = x0;
                const p1y = y0 + wave;
                const p2x = x0 + stepX;
                const p2y = y0 + Math.sin(t * 1.2 + (c + 1) * 0.4 + r * 0.6) * 12;
                const p3x = x0 + stepX * 0.5;
                const p3y = y0 + stepY + Math.sin(t * 1.2 + (c + 0.5) * 0.4 + (r + 1) * 0.6) * 12;

                const shade = 0.12 + Math.abs(Math.sin(t * 0.8 + c + r)) * 0.18;
                ctx.fillStyle = (c + r) % 2 === 0 ? `rgba(168, 85, 247, ${shade.toFixed(2)})` : `rgba(236, 72, 153, ${shade.toFixed(2)})`;
                ctx.strokeStyle = 'rgba(168, 85, 247, 0.4)';
                ctx.lineWidth = 1;

                ctx.beginPath();
                ctx.moveTo(p1x, p1y);
                ctx.lineTo(p2x, p2y);
                ctx.lineTo(p3x, p3y);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();

                ctx.fillStyle = '#f472b6';
                ctx.beginPath();
                ctx.arc(p1x, p1y, 1.8, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    },

    // 39. Sakura Drift (Twilight Cherry Petals)
    drawSakura(ctx, width, height, t) {
        ctx.fillStyle = '#08050e';
        ctx.fillRect(0, 0, width, height);

        const petalCount = 28;
        for (let i = 0; i < petalCount; i++) {
            const speedX = 18 + (i % 5) * 8;
            const speedY = 28 + (i % 6) * 10;
            const px = ((i * 67 + t * speedX) % (width + 60)) - 30;
            const py = ((i * 91 + t * speedY) % (height + 60)) - 30;
            const flutter = Math.sin(t * 2.5 + i * 1.3);
            const rot = t * 1.2 + i * 0.8;
            const rx = 8 + (i % 3) * 3;
            const ry = rx * (0.35 + Math.abs(flutter) * 0.35);

            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(rot);

            const grad = ctx.createLinearGradient(-rx, -ry, rx, ry);
            grad.addColorStop(0, 'rgba(253, 242, 248, 0.7)');
            grad.addColorStop(0.5, 'rgba(244, 114, 182, 0.55)');
            grad.addColorStop(1, 'rgba(251, 113, 133, 0.4)');

            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.lineWidth = 0.8;
            ctx.stroke();

            ctx.restore();
        }
    },

    // 40. L-System Fractal (Branching Tree of Light)
    drawFractalTree(ctx, width, height, t) {
        ctx.fillStyle = '#030c10';
        ctx.fillRect(0, 0, width, height);

        const startX = width * 0.5;
        const startY = height * 0.95;
        const trunkLen = Math.min(width, height) * 0.25;

        const drawBranch = (x, y, len, angle, depth) => {
            if (depth <= 0) {
                ctx.fillStyle = '#fbbf24';
                ctx.beginPath();
                ctx.arc(x, y, 2.5, 0, Math.PI * 2);
                ctx.fill();
                return;
            }

            const sway = Math.sin(t * 1.2 + depth * 0.8) * 0.05;
            const x2 = x + Math.cos(angle + sway) * len;
            const y2 = y + Math.sin(angle + sway) * len;

            const alpha = 0.25 + (depth / 6) * 0.5;
            ctx.strokeStyle = depth > 3 ? `rgba(45, 212, 191, ${alpha.toFixed(2)})` : `rgba(52, 211, 153, ${alpha.toFixed(2)})`;
            ctx.lineWidth = Math.max(1, depth * 0.8);

            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x2, y2);
            ctx.stroke();

            const nextLen = len * 0.72;
            const spread = 0.48 + Math.sin(t * 0.8) * 0.04;
            drawBranch(x2, y2, nextLen, angle - spread, depth - 1);
            drawBranch(x2, y2, nextLen, angle + spread, depth - 1);
        };

        drawBranch(startX, startY, trunkLen, -Math.PI * 0.5, 6);
    },

    // 41. Quantum Flux (Meissner Levitation Lines)
    drawQuantumFlux(ctx, width, height, t) {
        ctx.fillStyle = '#030718';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const diaR = 24;

        const lines = 14;
        for (let i = 0; i < lines; i++) {
            const spread = (i - lines * 0.5) * 18;
            const offset = Math.sin(t * 1.5 + i * 0.4) * 8;

            ctx.strokeStyle = i % 2 === 0 ? 'rgba(56, 189, 248, 0.4)' : 'rgba(37, 99, 235, 0.35)';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(20, cy + spread);
            ctx.bezierCurveTo(cx - 50, cy + spread * 2.2 + offset, cx + 50, cy + spread * 2.2 + offset, width - 20, cy + spread);
            ctx.stroke();

            const prog = ((t * 0.8 + i * 0.15) % 1.0);
            const px = 20 + prog * (width - 40);
            const py = (cy + spread) + Math.sin(prog * Math.PI) * (spread * 1.2 + offset);
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(px, py, 2, 0, Math.PI * 2);
            ctx.fill();
        }

        const levY = cy + Math.sin(t * 2) * 6;
        ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
        ctx.beginPath();
        ctx.moveTo(cx, levY - diaR);
        ctx.lineTo(cx + diaR, levY);
        ctx.lineTo(cx, levY + diaR);
        ctx.lineTo(cx - diaR, levY);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx, levY, 3.5, 0, Math.PI * 2);
        ctx.fill();
    },

    // 42. Astrolabe Chrono (Renaissance Celestial Gears)
    drawAstrolabe(ctx, width, height, t) {
        ctx.fillStyle = '#0d0802';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const maxR = Math.min(width, height) * 0.42;

        const rings = [
            { r: maxR, speed: 0.2, color: 'rgba(217, 119, 6, 0.45)', ticks: 48 },
            { r: maxR * 0.78, speed: -0.35, color: 'rgba(245, 158, 11, 0.45)', ticks: 36 },
            { r: maxR * 0.54, speed: 0.5, color: 'rgba(251, 191, 36, 0.45)', ticks: 24 },
            { r: maxR * 0.32, speed: -0.7, color: 'rgba(254, 240, 138, 0.5)', ticks: 12 }
        ];

        for (let i = 0; i < rings.length; i++) {
            const ring = rings[i];
            const rot = t * ring.speed;

            ctx.strokeStyle = ring.color;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
            ctx.stroke();

            for (let k = 0; k < ring.ticks; k++) {
                const angle = rot + (k * Math.PI * 2) / ring.ticks;
                const x1 = cx + Math.cos(angle) * (ring.r - 4);
                const y1 = cy + Math.sin(angle) * (ring.r - 4);
                const x2 = cx + Math.cos(angle) * (ring.r + 4);
                const y2 = cy + Math.sin(angle) * (ring.r + 4);

                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            }
        }

        const handAngle = t * 0.6;
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(handAngle) * (maxR * 0.88), cy + Math.sin(handAngle) * (maxR * 0.88));
        ctx.stroke();

        ctx.fillStyle = '#fef08a';
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fill();
    },

    // 43. Deep Abyss (Bioluminescent Jellyfish)
    drawDeepAbyss(ctx, width, height, t) {
        ctx.fillStyle = '#010512';
        ctx.fillRect(0, 0, width, height);

        const jfCount = 3;
        for (let j = 0; j < jfCount; j++) {
            const jx = (width * 0.25) + j * (width * 0.28) + Math.sin(t * 0.6 + j * 2) * 18;
            const jy = (height * 0.3) + j * (height * 0.18) + Math.cos(t * 0.5 + j) * 25;
            const pulse = (Math.sin(t * 1.8 + j * 1.2) + 1) * 0.5;
            const bellR = 24 + pulse * 6;

            ctx.fillStyle = 'rgba(34, 211, 238, 0.18)';
            ctx.beginPath();
            ctx.arc(jx, jy, bellR, Math.PI, 0, false);
            ctx.quadraticCurveTo(jx, jy + 10, jx - bellR, jy);
            ctx.fill();

            ctx.strokeStyle = 'rgba(34, 211, 238, 0.6)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            const tentCount = 6;
            for (let k = 0; k < tentCount; k++) {
                const tx = jx - bellR * 0.7 + (k / (tentCount - 1)) * (bellR * 1.4);
                ctx.strokeStyle = k % 2 === 0 ? 'rgba(192, 132, 252, 0.45)' : 'rgba(34, 211, 238, 0.45)';
                ctx.lineWidth = 1.2;

                ctx.beginPath();
                ctx.moveTo(tx, jy);
                let prevX = tx;
                let prevY = jy;
                for (let seg = 1; seg <= 6; seg++) {
                    const nextY = jy + seg * 12;
                    const nextX = tx + Math.sin(t * 2.5 + seg * 0.8 + k) * (6 + seg * 2);
                    ctx.quadraticCurveTo(prevX, prevY, nextX, nextY);
                    prevX = nextX;
                    prevY = nextY;
                }
                ctx.stroke();
            }
        }

        for (let p = 0; p < 16; p++) {
            const px = ((p * 79 + t * 8) % width);
            const py = ((p * 113 - t * 12) % height + height) % height;
            ctx.fillStyle = 'rgba(34, 211, 238, 0.6)';
            ctx.beginPath();
            ctx.arc(px, py, 1.2, 0, Math.PI * 2);
            ctx.fill();
        }
    },

    // 44. Stellar Whirlpool (Orbital Particle Convergence)
    drawParticleVortex(ctx, width, height, t) {
        ctx.fillStyle = '#060210';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const maxR = Math.hypot(cx, cy);
        const count = 45;

        for (let i = 0; i < count; i++) {
            const prog = ((t * 0.35 + (i / count)) % 1.0);
            const r = Math.pow(prog, 1.6) * maxR;
            const orbitalSpeed = (1.0 / (Math.max(r, 20) * 0.04)) * 3.5;
            const angle = t * orbitalSpeed + (i * 137.5 * Math.PI) / 180;

            const px = cx + Math.cos(angle) * r;
            const py = cy + Math.sin(angle) * (r * 0.72);
            const alpha = Math.min(0.85, (1 - prog) * 0.95);

            ctx.fillStyle = i % 3 === 0 ? `rgba(217, 70, 239, ${alpha.toFixed(2)})` : `rgba(6, 182, 212, ${alpha.toFixed(2)})`;
            ctx.beginPath();
            ctx.arc(px, py, 1.4 + prog * 1.8, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
        ctx.fill();
    },

    // 45. Rubik Quantum (4D Translucent Voxel Hypercube)
    drawQuantumCube(ctx, width, height, t) {
        ctx.fillStyle = '#080c14';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const S = Math.min(width, height) * 0.22;
        const rot = t * 0.7;

        const drawIsoCube = (x, y, size, rotOffset) => {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(rotOffset);

            const dx = size * 0.866;
            const dy = size * 0.5;

            ctx.fillStyle = 'rgba(0, 240, 255, 0.18)';
            ctx.strokeStyle = '#00f0ff';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(0, -size);
            ctx.lineTo(dx, -dy);
            ctx.lineTo(0, 0);
            ctx.lineTo(-dx, -dy);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = 'rgba(255, 0, 127, 0.18)';
            ctx.strokeStyle = '#ff007f';
            ctx.beginPath();
            ctx.moveTo(-dx, -dy);
            ctx.lineTo(0, 0);
            ctx.lineTo(0, size);
            ctx.lineTo(-dx, dy);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = 'rgba(57, 255, 20, 0.18)';
            ctx.strokeStyle = '#39ff14';
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(dx, -dy);
            ctx.lineTo(dx, dy);
            ctx.lineTo(0, size);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.restore();
        };

        drawIsoCube(cx, cy, S, rot);
        drawIsoCube(cx, cy, S * 0.5, -rot * 1.5);
    },

    // 46. Gatsby Deco (1920s Golden Sunburst Arches)
    drawArtDeco(ctx, width, height, t) {
        ctx.fillStyle = '#08080a';
        ctx.fillRect(0, 0, width, height);

        const fanCount = 3;
        const fanW = width / fanCount;

        for (let f = 0; f <= fanCount; f++) {
            const fx = f * fanW;
            const fy = height * 0.5;
            const maxR = fanW * 0.95;

            const archCount = 5;
            for (let a = 1; a <= archCount; a++) {
                const r = (a / archCount) * maxR;
                const wave = Math.sin(t * 1.5 + a * 0.5 + f) * 0.15;

                ctx.strokeStyle = a % 2 === 0 ? `rgba(250, 204, 21, ${0.35 + wave})` : `rgba(202, 138, 4, ${0.3 + wave})`;
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                ctx.arc(fx, fy, r, Math.PI, 0, false);
                ctx.stroke();
            }

            const rayCount = 12;
            for (let i = 0; i <= rayCount; i++) {
                const angle = Math.PI + (i * Math.PI) / rayCount;
                const x2 = fx + Math.cos(angle) * maxR;
                const y2 = fy + Math.sin(angle) * maxR;

                ctx.strokeStyle = 'rgba(250, 204, 21, 0.22)';
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.moveTo(fx, fy);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            }
        }
    },

    // 47. Chrono Halo (Spectral Aberration Rings)
    drawChronoHalo(ctx, width, height, t) {
        ctx.fillStyle = '#02040c';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const baseR = Math.min(width, height) * 0.32;

        const spectrum = [
            { col: 'rgba(239, 68, 68, 0.45)', off: 0.00 },
            { col: 'rgba(234, 179, 8, 0.45)', off: 0.04 },
            { col: 'rgba(16, 185, 129, 0.45)', off: 0.08 },
            { col: 'rgba(6, 182, 212, 0.55)', off: 0.12 },
            { col: 'rgba(139, 92, 246, 0.45)', off: 0.16 }
        ];

        for (let s = 0; s < spectrum.length; s++) {
            const spec = spectrum[s];
            const pulse = Math.sin(t * 1.5 + spec.off * 8) * 8;
            const r = baseR + spec.off * 40 + pulse;

            ctx.strokeStyle = spec.col;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.ellipse(cx, cy, r, r * 0.75, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        const flareGrad = ctx.createLinearGradient(0, cy, width, cy);
        flareGrad.addColorStop(0, 'rgba(0,0,0,0)');
        flareGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.75)');
        flareGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.strokeStyle = flareGrad;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, cy);
        ctx.lineTo(width, cy);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI * 2);
        ctx.fill();
    },

    // 48. Magnetic Corona (Incandescent Plasma Loops)
    drawSolarCorona(ctx, width, height, t) {
        ctx.fillStyle = '#0f0302';
        ctx.fillRect(0, 0, width, height);

        const loopCount = 6;
        for (let l = 0; l < loopCount; l++) {
            const startX = (width * 0.15) + l * (width * 0.14);
            const loopW = 50 + (l % 3) * 25;
            const endX = startX + loopW;
            const peakH = 65 + Math.sin(t * 1.5 + l * 1.1) * 30 + (l % 3) * 35;
            const peakY = height - peakH;

            const grad = ctx.createLinearGradient(startX, height, (startX + endX) * 0.5, peakY);
            grad.addColorStop(0, 'rgba(220, 38, 38, 0.5)');
            grad.addColorStop(0.5, 'rgba(249, 115, 22, 0.6)');
            grad.addColorStop(1, 'rgba(250, 204, 21, 0.8)');

            ctx.strokeStyle = grad;
            ctx.lineWidth = 2 + (l % 2) * 1.2;
            ctx.beginPath();
            ctx.moveTo(startX, height);
            ctx.quadraticCurveTo((startX + endX) * 0.5, peakY - 15, endX, height);
            ctx.stroke();

            const blobProg = ((t * 0.7 + l * 0.22) % 1.0);
            const bx = startX + blobProg * loopW;
            const by = height - Math.sin(blobProg * Math.PI) * peakH;

            ctx.fillStyle = '#fef08a';
            ctx.beginPath();
            ctx.arc(bx, by, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.fillStyle = '#180402';
        ctx.fillRect(0, height - 12, width, 12);
        ctx.strokeStyle = 'rgba(249, 115, 22, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, height - 12);
        ctx.lineTo(width, height - 12);
        ctx.stroke();
    },

    // 49. Zen Sand Garden (Meditative Concentric Stones & Raked Sand Lines)
    drawZenGarden(ctx, width, height, t) {
        ctx.fillStyle = '#070a0e';
        ctx.fillRect(0, 0, width, height);

        // 1. Raked sand wave grooves (horizontal fine lines with organic sinusoidal drift)
        const lineSpacing = 18;
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
        ctx.lineWidth = 1.2;
        const totalLines = Math.ceil(height / lineSpacing) + 1;
        for (let i = 0; i < totalLines; i++) {
            const baseY = i * lineSpacing;
            ctx.beginPath();
            ctx.moveTo(0, baseY);
            const segments = 24;
            const segW = width / segments;
            for (let s = 1; s <= segments; s++) {
                const px = s * segW;
                const waveY = baseY + Math.sin(px * 0.008 + t * 0.12 + i * 0.25) * 4;
                ctx.lineTo(px, waveY);
            }
            ctx.stroke();
        }

        // 2. Three Zen Rock Islands with expanding concentric stone ripples
        const rocks = [
            { x: width * 0.32, y: height * 0.40, r: 22, moss: '#10b981' },
            { x: width * 0.72, y: height * 0.30, r: 16, moss: '#059669' },
            { x: width * 0.52, y: height * 0.72, r: 28, moss: '#14b8a6' }
        ];

        for (let r = 0; r < rocks.length; r++) {
            const rock = rocks[r];
            const rippleCount = 6;
            for (let ring = 1; ring <= rippleCount; ring++) {
                const phase = ((t * 0.18 + ring * 0.3) % 1.0);
                const radius = rock.r + ring * 14 + phase * 8;
                const alpha = (1.0 - (radius - rock.r) / 95) * 0.28;
                if (alpha > 0) {
                    ctx.strokeStyle = `rgba(203, 213, 225, ${alpha.toFixed(3)})`;
                    ctx.lineWidth = 1.4;
                    ctx.beginPath();
                    ctx.arc(rock.x, rock.y, radius, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }

            // Rock shadow
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.beginPath();
            ctx.ellipse(rock.x + 4, rock.y + 6, rock.r + 2, rock.r * 0.8, 0.2, 0, Math.PI * 2);
            ctx.fill();

            // Smooth slate rock body with mossy gradient
            const rockGrad = ctx.createRadialGradient(rock.x - rock.r * 0.3, rock.y - rock.r * 0.3, 2, rock.x, rock.y, rock.r);
            rockGrad.addColorStop(0, '#475569');
            rockGrad.addColorStop(0.7, '#1e293b');
            rockGrad.addColorStop(1, '#0f172a');
            ctx.fillStyle = rockGrad;
            ctx.beginPath();
            ctx.arc(rock.x, rock.y, rock.r, 0, Math.PI * 2);
            ctx.fill();

            // Soft moss rim
            ctx.strokeStyle = rock.moss;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(rock.x, rock.y, rock.r, -0.4, Math.PI * 0.9);
            ctx.stroke();
        }
    },

    // 50. Bioluminescent Koi Pond (Serene Gliding Fish & Floating Caustics)
    drawKoiPond(ctx, width, height, t) {
        ctx.fillStyle = '#020b12';
        ctx.fillRect(0, 0, width, height);

        const waterG = ctx.createRadialGradient(width * 0.5, height * 0.5, 20, width * 0.5, height * 0.5, Math.max(width, height) * 0.7);
        waterG.addColorStop(0, 'rgba(6, 182, 212, 0.12)');
        waterG.addColorStop(1, 'rgba(2, 11, 18, 0)');
        ctx.fillStyle = waterG;
        ctx.fillRect(0, 0, width, height);

        const fishes = [
            { pathR: Math.min(width, height) * 0.32, speed: 0.22, phase: 0.0, color: '#38bdf8', accent: '#f43f5e' },
            { pathR: Math.min(width, height) * 0.25, speed: -0.18, phase: 2.4, color: '#fb923c', accent: '#facc15' },
            { pathR: Math.min(width, height) * 0.38, speed: 0.15, phase: 4.5, color: '#a78bfa', accent: '#38bdf8' }
        ];

        const cx = width * 0.5;
        const cy = height * 0.5;

        for (let f = 0; f < fishes.length; f++) {
            const fish = fishes[f];
            const angle = t * fish.speed + fish.phase;
            const headX = cx + Math.cos(angle) * fish.pathR;
            const headY = cy + Math.sin(angle * 1.2) * (fish.pathR * 0.8);
            const heading = angle + Math.PI * 0.5;

            const segCount = 8;
            const segLen = 5.5;
            const pts = [];
            for (let s = 0; s < segCount; s++) {
                const lag = s * 0.35;
                const lagAngle = (t * fish.speed + fish.phase) - lag * Math.sign(fish.speed) * 0.15;
                const wiggle = Math.sin(t * 2.8 - s * 0.55) * (s * 1.4);
                const perp = heading + Math.PI * 0.5;
                const bx = cx + Math.cos(lagAngle) * fish.pathR - Math.cos(heading) * (s * segLen) + Math.cos(perp) * wiggle;
                const by = cy + Math.sin(lagAngle * 1.2) * (fish.pathR * 0.8) - Math.sin(heading) * (s * segLen) + Math.sin(perp) * wiggle;
                pts.push({ x: bx, y: by, r: Math.max(1.5, 7.5 - s * 0.8) });
            }

            const aura = ctx.createRadialGradient(headX, headY, 2, headX, headY, 35);
            aura.addColorStop(0, fish.color);
            aura.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = aura;
            ctx.beginPath();
            ctx.arc(headX, headY, 35, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = fish.color;
            ctx.lineWidth = 1.2;
            for (let s = 0; s < pts.length; s++) {
                ctx.fillStyle = s < 3 ? fish.accent : fish.color;
                ctx.beginPath();
                ctx.arc(pts[s].x, pts[s].y, pts[s].r, 0, Math.PI * 2);
                ctx.fill();
            }

            if (pts[2]) {
                const finWing = Math.sin(t * 3.2) * 5;
                ctx.fillStyle = 'rgba(56, 189, 248, 0.35)';
                ctx.beginPath();
                ctx.ellipse(pts[2].x - Math.sin(heading) * 10, pts[2].y + Math.cos(heading) * 10, 8, 3, heading + 0.5 + finWing * 0.05, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.ellipse(pts[2].x + Math.sin(heading) * 10, pts[2].y - Math.cos(heading) * 10, 8, 3, heading - 0.5 - finWing * 0.05, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        const leaves = [
            { x: width * 0.22, y: height * 0.25, r: 24 },
            { x: width * 0.80, y: height * 0.70, r: 28 },
            { x: width * 0.85, y: height * 0.22, r: 18 }
        ];
        for (let l = 0; l < leaves.length; l++) {
            const lf = leaves[l];
            const driftX = Math.sin(t * 0.2 + l) * 5;
            const driftY = Math.cos(t * 0.25 + l) * 4;
            ctx.fillStyle = 'rgba(5, 150, 105, 0.25)';
            ctx.strokeStyle = 'rgba(52, 211, 153, 0.45)';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.arc(lf.x + driftX, lf.y + driftY, lf.r, 0.3, Math.PI * 1.85);
            ctx.lineTo(lf.x + driftX, lf.y + driftY);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }
    },

    // 51. Enchanted Fireflies (Twilight Meadow Organic Drift)
    drawFireflies(ctx, width, height, t) {
        ctx.fillStyle = '#040a08';
        ctx.fillRect(0, 0, width, height);

        const mist = ctx.createLinearGradient(0, 0, 0, height);
        mist.addColorStop(0, '#030806');
        mist.addColorStop(0.7, '#05140e');
        mist.addColorStop(1, '#091c14');
        ctx.fillStyle = mist;
        ctx.fillRect(0, 0, width, height);

        const count = 26;
        for (let i = 0; i < count; i++) {
            const seed = i * 137.5;
            const speedX = 0.18 + (i % 5) * 0.05;
            const speedY = 0.14 + (i % 4) * 0.06;

            const xNorm = 0.5 + Math.sin(t * speedX + seed) * 0.42 + Math.cos(t * 0.08 + i * 2) * 0.08;
            const yNorm = 0.5 + Math.cos(t * speedY + seed * 1.3) * 0.42 + Math.sin(t * 0.09 + i * 1.7) * 0.08;

            const px = xNorm * width;
            const py = yNorm * height;

            const pulse = (Math.sin(t * 1.5 + i * 1.6) + 1.0) * 0.5;
            if (pulse > 0.08) {
                const isMint = i % 2 === 0;
                const haloR = 12 + pulse * 22;

                const grad = ctx.createRadialGradient(px, py, 1, px, py, haloR);
                if (isMint) {
                    grad.addColorStop(0, `rgba(110, 231, 183, ${pulse.toFixed(2)})`);
                    grad.addColorStop(0.35, `rgba(52, 211, 153, ${(pulse * 0.4).toFixed(2)})`);
                    grad.addColorStop(1, 'rgba(16, 185, 129, 0)');
                } else {
                    grad.addColorStop(0, `rgba(254, 240, 138, ${pulse.toFixed(2)})`);
                    grad.addColorStop(0.35, `rgba(251, 191, 36, ${(pulse * 0.4).toFixed(2)})`);
                    grad.addColorStop(1, 'rgba(245, 158, 11, 0)');
                }

                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(px, py, haloR, 0, Math.PI * 2);
                ctx.fill();

                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(px, py, 1.4 + pulse * 1.2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    },

    // 52. Rain on Night Window (Calming Liquid Droplets & Streaks)
    drawRainWindow(ctx, width, height, t) {
        ctx.fillStyle = '#06080e';
        ctx.fillRect(0, 0, width, height);

        const bokeh = [
            { x: width * 0.25, y: height * 0.35, r: 42, col: 'rgba(245, 158, 11, 0.07)' },
            { x: width * 0.70, y: height * 0.25, r: 55, col: 'rgba(56, 189, 248, 0.08)' },
            { x: width * 0.45, y: height * 0.65, r: 60, col: 'rgba(244, 63, 94, 0.06)' },
            { x: width * 0.80, y: height * 0.75, r: 48, col: 'rgba(168, 85, 247, 0.06)' }
        ];
        for (let b = 0; b < bokeh.length; b++) {
            ctx.fillStyle = bokeh[b].col;
            ctx.beginPath();
            ctx.arc(bokeh[b].x, bokeh[b].y, bokeh[b].r, 0, Math.PI * 2);
            ctx.fill();
        }

        const streaks = 8;
        for (let s = 0; s < streaks; s++) {
            const laneX = ((s + 0.5) / streaks) * width + Math.sin(s * 17) * 15;
            const speed = 0.25 + (s % 4) * 0.12;
            const progress = ((t * speed + s * 0.33) % 1.0);
            const dropY = progress * (height + 60) - 30;

            const tailLen = 45 + (s % 3) * 20;
            const streakGrad = ctx.createLinearGradient(laneX, dropY - tailLen, laneX, dropY);
            streakGrad.addColorStop(0, 'rgba(148, 163, 184, 0)');
            streakGrad.addColorStop(0.7, 'rgba(203, 213, 225, 0.18)');
            streakGrad.addColorStop(1, 'rgba(241, 245, 249, 0.65)');

            ctx.strokeStyle = streakGrad;
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            ctx.moveTo(laneX, dropY - tailLen);
            ctx.lineTo(laneX + Math.sin(dropY * 0.03) * 1.5, dropY);
            ctx.stroke();

            ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.beginPath();
            ctx.ellipse(laneX, dropY, 2.5, 3.8, 0, 0, Math.PI * 2);
            ctx.fill();
        }

        const staticCount = 22;
        for (let d = 0; d < staticCount; d++) {
            const dx = ((d * 83.1) % width);
            const dy = ((d * 149.7) % height);
            const r = 1.8 + (d % 3) * 1.2;

            ctx.fillStyle = 'rgba(15, 23, 42, 0.6)';
            ctx.beginPath();
            ctx.arc(dx + 1, dy + 1, r, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = 'rgba(226, 232, 240, 0.45)';
            ctx.beginPath();
            ctx.arc(dx, dy, r, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(dx - r * 0.35, dy - r * 0.35, r * 0.3, 0, Math.PI * 2);
            ctx.fill();
        }
    },

    // 53. Sacred Mandala (Meditative Counter-Harmonic Gear Morph)
    drawMandalaBreathe(ctx, width, height, t) {
        ctx.fillStyle = '#080703';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const maxR = Math.min(width, height) * 0.42;

        const breathe = 1.0 + Math.sin(t * 0.4) * 0.06;

        const aura = ctx.createRadialGradient(cx, cy, 5, cx, cy, maxR * 1.2);
        aura.addColorStop(0, 'rgba(245, 158, 11, 0.22)');
        aura.addColorStop(0.6, 'rgba(217, 119, 6, 0.06)');
        aura.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.arc(cx, cy, maxR * 1.2, 0, Math.PI * 2);
        ctx.fill();

        const r1 = maxR * breathe;
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.35)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy, r1, 0, Math.PI * 2);
        ctx.stroke();

        const outerPoints = 24;
        const rot1 = t * 0.025;
        for (let p = 0; p < outerPoints; p++) {
            const a = rot1 + (p / outerPoints) * Math.PI * 2;
            const ox = cx + Math.cos(a) * r1;
            const oy = cy + Math.sin(a) * r1;
            ctx.fillStyle = p % 2 === 0 ? '#fbbf24' : '#38bdf8';
            ctx.beginPath();
            ctx.arc(ox, oy, 2.2, 0, Math.PI * 2);
            ctx.fill();
        }

        const r2 = maxR * 0.68 * breathe;
        const rot2 = -t * 0.045;
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
        ctx.lineWidth = 1.5;
        const petals = 12;
        for (let i = 0; i < petals; i++) {
            const a = rot2 + (i / petals) * Math.PI * 2;
            const tipX = cx + Math.cos(a) * r2;
            const tipY = cy + Math.sin(a) * r2;
            const ctrlAngle = a + Math.PI / petals;
            const ctrlX = cx + Math.cos(ctrlAngle) * (r2 * 0.45);
            const ctrlY = cy + Math.sin(ctrlAngle) * (r2 * 0.45);

            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
            ctx.stroke();
        }

        const r3 = maxR * 0.36 * breathe;
        const rot3 = t * 0.07;
        ctx.strokeStyle = 'rgba(254, 240, 138, 0.75)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
            const a = rot3 + (i / 8) * Math.PI * 2;
            const px = cx + Math.cos(a) * r3;
            const py = cy + Math.sin(a) * r3;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
        ctx.fill();
    },

    // 54. Liquid Silk Waves (Undulating Zero-G Satin Ribbons)
    drawSilkFlow(ctx, width, height, t) {
        ctx.fillStyle = '#06020c';
        ctx.fillRect(0, 0, width, height);

        const ribbons = [
            { baseY: height * 0.28, amp: 45, speed: 0.28, c0: 'rgba(168, 85, 247, 0.24)', c1: 'rgba(236, 72, 153, 0.08)', stroke: 'rgba(192, 132, 252, 0.6)' },
            { baseY: height * 0.48, amp: 55, speed: -0.22, c0: 'rgba(6, 182, 212, 0.22)', c1: 'rgba(56, 189, 248, 0.06)', stroke: 'rgba(103, 232, 249, 0.6)' },
            { baseY: height * 0.68, amp: 50, speed: 0.25, c0: 'rgba(244, 114, 182, 0.20)', c1: 'rgba(251, 146, 60, 0.06)', stroke: 'rgba(244, 114, 182, 0.6)' },
            { baseY: height * 0.82, amp: 40, speed: -0.30, c0: 'rgba(129, 140, 248, 0.22)', c1: 'rgba(168, 85, 247, 0.06)', stroke: 'rgba(165, 180, 252, 0.55)' }
        ];

        const segs = 32;
        const dx = width / segs;

        for (let r = 0; r < ribbons.length; r++) {
            const rib = ribbons[r];
            const topPts = [];
            const botPts = [];

            for (let i = 0; i <= segs; i++) {
                const x = i * dx;
                const wave = Math.sin(x * 0.005 + t * rib.speed + r * 1.8) * rib.amp
                           + Math.cos(x * 0.009 - t * (rib.speed * 0.7)) * (rib.amp * 0.4);
                topPts.push({ x, y: rib.baseY + wave - 24 });
                botPts.push({ x, y: rib.baseY + wave + 24 });
            }

            const grad = ctx.createLinearGradient(0, rib.baseY - 40, 0, rib.baseY + 40);
            grad.addColorStop(0, rib.c0);
            grad.addColorStop(1, rib.c1);
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(topPts[0].x, topPts[0].y);
            for (let i = 1; i <= segs; i++) ctx.lineTo(topPts[i].x, topPts[i].y);
            for (let i = segs; i >= 0; i--) ctx.lineTo(botPts[i].x, botPts[i].y);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = rib.stroke;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(topPts[0].x, topPts[0].y);
            for (let i = 1; i <= segs; i++) ctx.lineTo(topPts[i].x, topPts[i].y);
            ctx.stroke();
        }
    },

    // 55. Orrery Spheres (Harmonious Celestial Clockwork)
    drawCelestialClock(ctx, width, height, t) {
        ctx.fillStyle = '#02040b';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const baseR = Math.min(width, height) * 0.42;

        const sunG = ctx.createRadialGradient(cx, cy, 2, cx, cy, 24);
        sunG.addColorStop(0, '#ffffff');
        sunG.addColorStop(0.3, '#fef08a');
        sunG.addColorStop(0.7, '#f59e0b');
        sunG.addColorStop(1, 'rgba(217, 119, 6, 0)');
        ctx.fillStyle = sunG;
        ctx.beginPath();
        ctx.arc(cx, cy, 24, 0, Math.PI * 2);
        ctx.fill();

        const orbits = [
            { r: baseR * 0.28, speed: 0.45, color: '#38bdf8', size: 4.2 },
            { r: baseR * 0.48, speed: 0.28, color: '#34d399', size: 5.5 },
            { r: baseR * 0.68, speed: 0.18, color: '#f472b6', size: 6.8 },
            { r: baseR * 0.88, speed: 0.11, color: '#fbbf24', size: 8.2 },
            { r: baseR * 1.08, speed: 0.06, color: '#a78bfa', size: 5.0 }
        ];

        for (let i = 0; i < orbits.length; i++) {
            const orb = orbits[i];
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            ctx.arc(cx, cy, orb.r, 0, Math.PI * 2);
            ctx.stroke();

            const angle = t * orb.speed + i * 1.4;
            const px = cx + Math.cos(angle) * orb.r;
            const py = cy + Math.sin(angle) * orb.r;

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(px, py);
            ctx.stroke();

            ctx.fillStyle = orb.color;
            ctx.beginPath();
            ctx.arc(px, py, orb.size, 0, Math.PI * 2);
            ctx.fill();

            if (i === 2 || i === 3) {
                const moonAngle = t * 2.2 + i;
                const mx = px + Math.cos(moonAngle) * (orb.size * 2.2);
                const my = py + Math.sin(moonAngle) * (orb.size * 2.2);
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(mx, my, 1.8, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    },

    // 56. Magnetic Ferrofluid (Organic Liquid Chrome Spikes)
    drawFerrofluid(ctx, width, height, t) {
        ctx.fillStyle = '#050608';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const baseR = Math.min(width, height) * 0.22;

        const fluxCount = 16;
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
        ctx.lineWidth = 1;
        for (let i = 0; i < fluxCount; i++) {
            const a = (i / fluxCount) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(a) * (baseR * 2.5), cy + Math.sin(a) * (baseR * 2.5));
            ctx.stroke();
        }

        const numPoints = 64;
        ctx.beginPath();
        for (let i = 0; i <= numPoints; i++) {
            const a = (i / numPoints) * Math.PI * 2;
            const spike1 = Math.sin(a * 8 + t * 0.8) * (baseR * 0.35);
            const spike2 = Math.cos(a * 16 - t * 0.5) * (baseR * 0.18);
            const breathing = Math.sin(t * 0.3) * (baseR * 0.08);
            const r = baseR + spike1 + spike2 + breathing;
            const px = cx + Math.cos(a) * r;
            const py = cy + Math.sin(a) * r;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();

        const chromeG = ctx.createRadialGradient(cx - baseR * 0.3, cy - baseR * 0.3, 5, cx, cy, baseR * 1.5);
        chromeG.addColorStop(0, '#f8fafc');
        chromeG.addColorStop(0.3, '#94a3b8');
        chromeG.addColorStop(0.6, '#334155');
        chromeG.addColorStop(1, '#090d16');
        ctx.fillStyle = chromeG;
        ctx.fill();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 1.8;
        ctx.stroke();

        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fill();
    },

    // 57. Ocean Caustics (Sunlit Shallow Coral Reef Waves)
    drawOceanCaustics(ctx, width, height, t) {
        ctx.fillStyle = '#010d14';
        ctx.fillRect(0, 0, width, height);

        const oceanG = ctx.createLinearGradient(0, 0, width, height);
        oceanG.addColorStop(0, '#021824');
        oceanG.addColorStop(0.5, '#01121c');
        oceanG.addColorStop(1, '#00080e');
        ctx.fillStyle = oceanG;
        ctx.fillRect(0, 0, width, height);

        const cols = 12;
        const rows = 18;
        const cellW = width / cols;
        const cellH = height / rows;

        ctx.strokeStyle = 'rgba(6, 182, 212, 0.28)';
        ctx.lineWidth = 1.8;

        for (let r = 0; r < rows; r++) {
            ctx.beginPath();
            for (let c = 0; c <= cols; c++) {
                const u = c * cellW;
                const v = r * cellH;
                const warpX = Math.sin(u * 0.02 + t * 0.6 + v * 0.015) * 14;
                const warpY = Math.cos(v * 0.02 - t * 0.5 + u * 0.012) * 14;
                const px = u + warpX;
                const py = v + warpY;
                if (c === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }

        ctx.strokeStyle = 'rgba(165, 243, 252, 0.22)';
        ctx.lineWidth = 1.4;
        for (let c = 0; c < cols; c++) {
            ctx.beginPath();
            for (let r = 0; r <= rows; r++) {
                const u = c * cellW;
                const v = r * cellH;
                const warpX = Math.cos(u * 0.018 - t * 0.45) * 12;
                const warpY = Math.sin(v * 0.022 + t * 0.55) * 12;
                const px = u + warpX;
                const py = v + warpY;
                if (r === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }
    },

    // 58. Stardust Dunes (Wind-Swept Sahara Curves & Golden Sand Drift)
    drawSandDunes(ctx, width, height, t) {
        ctx.fillStyle = '#0b0602';
        ctx.fillRect(0, 0, width, height);

        const stars = 30;
        for (let s = 0; s < stars; s++) {
            const sx = (s * 137) % width;
            const sy = (s * 79) % (height * 0.35);
            const twinkle = (Math.sin(t * 1.5 + s) + 1.0) * 0.5;
            ctx.fillStyle = `rgba(254, 240, 138, ${(twinkle * 0.7).toFixed(2)})`;
            ctx.beginPath();
            ctx.arc(sx, sy, 1.2, 0, Math.PI * 2);
            ctx.fill();
        }

        const duneLayers = [
            { baseY: height * 0.35, amp: 35, speed: 0.05, c0: '#78350f', c1: '#451a03', crest: 'rgba(251, 191, 36, 0.4)' },
            { baseY: height * 0.52, amp: 45, speed: -0.04, c0: '#92400e', c1: '#451a03', crest: 'rgba(251, 191, 36, 0.6)' },
            { baseY: height * 0.70, amp: 50, speed: 0.06, c0: '#b45309', c1: '#78350f', crest: 'rgba(252, 211, 77, 0.7)' },
            { baseY: height * 0.88, amp: 40, speed: -0.05, c0: '#d97706', c1: '#92400e', crest: 'rgba(254, 240, 138, 0.85)' }
        ];

        for (let d = 0; d < duneLayers.length; d++) {
            const dl = duneLayers[d];
            ctx.fillStyle = dl.c0;
            ctx.beginPath();
            ctx.moveTo(0, height);
            ctx.lineTo(0, dl.baseY);

            const segs = 24;
            const dx = width / segs;
            for (let i = 0; i <= segs; i++) {
                const x = i * dx;
                const wave = Math.sin(x * 0.005 + t * dl.speed + d * 2.2) * dl.amp;
                ctx.lineTo(x, dl.baseY + wave);
            }
            ctx.lineTo(width, height);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = dl.crest;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            for (let i = 0; i <= segs; i++) {
                const x = i * dx;
                const wave = Math.sin(x * 0.005 + t * dl.speed + d * 2.2) * dl.amp;
                if (i === 0) ctx.moveTo(x, dl.baseY + wave);
                else ctx.lineTo(x, dl.baseY + wave);
            }
            ctx.stroke();
        }
    },

    // 59. Harmonic Pendulums (Physical Pendulum Wave Convergence)
    drawHarmonicPendulum(ctx, width, height, t) {
        ctx.fillStyle = '#030208';
        ctx.fillRect(0, 0, width, height);

        const beadCount = 18;
        const cx = width * 0.5;
        const amp = width * 0.38;
        const topMargin = height * 0.12;
        const bottomMargin = height * 0.88;
        const stepY = (bottomMargin - topMargin) / (beadCount - 1);

        const colors = [
            '#f43f5e', '#fb7185', '#fb923c', '#facc15', '#a3e635',
            '#4ade80', '#2dd4bf', '#22d3ee', '#38bdf8', '#60a5fa',
            '#818cf8', '#a78bfa', '#c084fc', '#e879f9', '#f472b6',
            '#fda4af', '#fef08a', '#a5f3fc'
        ];

        const pts = [];
        for (let i = 0; i < beadCount; i++) {
            const freq = 0.35 + i * 0.032;
            const x = cx + Math.sin(t * freq) * amp;
            const y = topMargin + i * stepY;
            pts.push({ x, y, color: colors[i % colors.length] });

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(cx, y);
            ctx.lineTo(x, y);
            ctx.stroke();
        }

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();

        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const glow = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, 14);
            glow.addColorStop(0, p.color);
            glow.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
            ctx.fill();
        }
    },

    // 60. Bioluminescent Surf (Vaadhoo Island Glowing Plankton Shore)
    drawBiolumWaves(ctx, width, height, t) {
        ctx.fillStyle = '#010810';
        ctx.fillRect(0, 0, width, height);

        const waveCount = 4;
        for (let w = 0; w < waveCount; w++) {
            const speed = 0.18 + w * 0.04;
            const cycle = ((t * speed + w * 0.28) % 1.0);
            const surfY = height * (0.85 - cycle * 0.5);

            const waterG = ctx.createLinearGradient(0, surfY - 20, 0, surfY + 40);
            waterG.addColorStop(0, 'rgba(6, 182, 212, 0.04)');
            waterG.addColorStop(0.7, 'rgba(6, 182, 212, 0.18)');
            waterG.addColorStop(1, 'rgba(0, 8, 16, 0.8)');

            ctx.fillStyle = waterG;
            ctx.beginPath();
            ctx.moveTo(0, height);
            ctx.lineTo(0, surfY);
            const segs = 28;
            const dx = width / segs;
            for (let i = 0; i <= segs; i++) {
                const x = i * dx;
                const waveShape = Math.sin(x * 0.01 + t * 0.8 + w * 1.5) * 14;
                ctx.lineTo(x, surfY + waveShape);
            }
            ctx.lineTo(width, height);
            ctx.closePath();
            ctx.fill();

            const surfAlpha = Math.sin(cycle * Math.PI);
            ctx.strokeStyle = `rgba(34, 211, 238, ${(surfAlpha * 0.85).toFixed(2)})`;
            ctx.lineWidth = 2.4;
            ctx.beginPath();
            for (let i = 0; i <= segs; i++) {
                const x = i * dx;
                const waveShape = Math.sin(x * 0.01 + t * 0.8 + w * 1.5) * 14;
                if (i === 0) ctx.moveTo(x, surfY + waveShape);
                else ctx.lineTo(x, surfY + waveShape);
            }
            ctx.stroke();

            if (surfAlpha > 0.2) {
                for (let p = 0; p < 8; p++) {
                    const px = (p * 47 + w * 89) % width;
                    const py = surfY + Math.sin(px * 0.01 + t * 0.8 + w * 1.5) * 14 + Math.sin(t * 2 + p) * 3;
                    ctx.fillStyle = '#a5f3fc';
                    ctx.beginPath();
                    ctx.arc(px, py, 1.8, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
    },

    // 61. Autumn Drift (Floating Ginkgo & Maple Leaves on Misty River)
    drawAutumnLeaves(ctx, width, height, t) {
        ctx.fillStyle = '#0c0603';
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = 'rgba(30, 15, 6, 0.4)';
        ctx.fillRect(0, height * 0.4, width, height * 0.6);

        const leafCount = 14;
        const leafColors = ['#f97316', '#eab308', '#ef4444', '#f59e0b', '#fb923c'];

        for (let i = 0; i < leafCount; i++) {
            const speedY = 0.08 + (i % 4) * 0.03;
            const progress = ((t * speedY + i * 0.18) % 1.0);
            const py = progress * (height + 40) - 20;
            const flutter = Math.sin(t * 1.8 + i * 2.2) * 28;
            const px = ((i * 73.5) % width) + flutter;
            const rot = t * 0.8 + i;
            const col = leafColors[i % leafColors.length];

            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(rot);

            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.moveTo(0, -9);
            ctx.quadraticCurveTo(6, -6, 8, -2);
            ctx.quadraticCurveTo(4, 2, 7, 7);
            ctx.quadraticCurveTo(2, 6, 0, 10);
            ctx.quadraticCurveTo(-2, 6, -7, 7);
            ctx.quadraticCurveTo(-4, 2, -8, -2);
            ctx.quadraticCurveTo(-6, -6, 0, -9);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = '#78350f';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, 10);
            ctx.lineTo(0, 14);
            ctx.stroke();

            ctx.restore();

            if (py > height * 0.45) {
                const ripRadius = 8 + (Math.sin(t * 2 + i) + 1.0) * 8;
                ctx.strokeStyle = 'rgba(251, 146, 60, 0.22)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.ellipse(px, py + 12, ripRadius, ripRadius * 0.35, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    },

    // 62. Cosmic Stargaze (Deep Space Volumetric Gas & Twinkling Pillars)
    drawNebulaCloud(ctx, width, height, t) {
        ctx.fillStyle = '#020108';
        ctx.fillRect(0, 0, width, height);

        const pillars = [
            { x: width * 0.32, y: height * 0.40, rx: width * 0.38, ry: height * 0.28, rot: 0.3, c0: 'rgba(217, 70, 239, 0.16)', c1: 'rgba(147, 51, 234, 0.04)' },
            { x: width * 0.68, y: height * 0.55, rx: width * 0.42, ry: height * 0.32, rot: -0.4, c0: 'rgba(6, 182, 212, 0.16)', c1: 'rgba(59, 130, 246, 0.04)' },
            { x: width * 0.50, y: height * 0.72, rx: width * 0.35, ry: height * 0.25, rot: 0.1, c0: 'rgba(244, 63, 94, 0.14)', c1: 'rgba(251, 146, 60, 0.03)' }
        ];

        for (let p = 0; p < pillars.length; p++) {
            const pil = pillars[p];
            const driftX = Math.sin(t * 0.15 + p) * 15;
            const driftY = Math.cos(t * 0.12 + p) * 12;

            const nebG = ctx.createRadialGradient(pil.x + driftX, pil.y + driftY, 10, pil.x + driftX, pil.y + driftY, pil.rx);
            nebG.addColorStop(0, pil.c0);
            nebG.addColorStop(0.6, pil.c1);
            nebG.addColorStop(1, 'rgba(0,0,0,0)');

            ctx.fillStyle = nebG;
            ctx.beginPath();
            ctx.ellipse(pil.x + driftX, pil.y + driftY, pil.rx, pil.ry, pil.rot, 0, Math.PI * 2);
            ctx.fill();
        }

        const starCount = 36;
        for (let s = 0; s < starCount; s++) {
            const sx = ((s * 179.3) % width);
            const sy = ((s * 283.1) % height);
            const twinkle = (Math.sin(t * 1.8 + s * 1.4) + 1.0) * 0.5;

            ctx.fillStyle = `rgba(255, 255, 255, ${(twinkle * 0.9).toFixed(2)})`;
            ctx.beginPath();
            ctx.arc(sx, sy, 1.2 + twinkle * 0.8, 0, Math.PI * 2);
            ctx.fill();

            if (s % 4 === 0 && twinkle > 0.4) {
                const spikeLen = 4 + twinkle * 5;
                ctx.strokeStyle = `rgba(255, 255, 255, ${(twinkle * 0.45).toFixed(2)})`;
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.moveTo(sx - spikeLen, sy);
                ctx.lineTo(sx + spikeLen, sy);
                ctx.moveTo(sx, sy - spikeLen);
                ctx.lineTo(sx, sy + spikeLen);
                ctx.stroke();
            }
        }
    },

    // 63. Kinetic Mobiles (Calder-Style Air Current Balance)
    drawKineticChimes(ctx, width, height, t) {
        ctx.fillStyle = '#07070a';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const topY = height * 0.12;

        ctx.strokeStyle = 'rgba(250, 204, 21, 0.7)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, topY);
        ctx.stroke();

        const angle1 = Math.sin(t * 0.35) * 0.22;
        const arm1 = width * 0.32;
        const p1L = { x: cx - Math.cos(angle1) * arm1, y: topY - Math.sin(angle1) * arm1 };
        const p1R = { x: cx + Math.cos(angle1) * arm1, y: topY + Math.sin(angle1) * arm1 };

        ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(p1L.x, p1L.y);
        ctx.lineTo(p1R.x, p1R.y);
        ctx.stroke();

        const drop1L = height * 0.22;
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.5)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p1L.x, p1L.y);
        ctx.lineTo(p1L.x, p1L.y + drop1L);
        ctx.stroke();

        ctx.fillStyle = '#f43f5e';
        ctx.beginPath();
        ctx.arc(p1L.x, p1L.y + drop1L, 16, 0, Math.PI * 2);
        ctx.fill();

        const drop1R = height * 0.16;
        const p2Pivot = { x: p1R.x, y: p1R.y + drop1R };
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.5)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p1R.x, p1R.y);
        ctx.lineTo(p2Pivot.x, p2Pivot.y);
        ctx.stroke();

        const angle2 = Math.sin(t * 0.48 + 1.2) * 0.28;
        const arm2 = width * 0.22;
        const p2L = { x: p2Pivot.x - Math.cos(angle2) * arm2, y: p2Pivot.y - Math.sin(angle2) * arm2 };
        const p2R = { x: p2Pivot.x + Math.cos(angle2) * arm2, y: p2Pivot.y + Math.sin(angle2) * arm2 };

        ctx.strokeStyle = 'rgba(250, 204, 21, 0.8)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(p2L.x, p2L.y);
        ctx.lineTo(p2R.x, p2R.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(p2L.x, p2L.y);
        ctx.lineTo(p2L.x, p2L.y + 45);
        ctx.stroke();
        ctx.fillStyle = '#06b6d4';
        ctx.beginPath();
        ctx.arc(p2L.x, p2L.y + 45, 12, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(p2R.x, p2R.y);
        ctx.lineTo(p2R.x, p2R.y + 65);
        ctx.stroke();
        ctx.fillStyle = '#facc15';
        ctx.beginPath();
        ctx.arc(p2R.x, p2R.y + 65, 20, 0, Math.PI * 2);
        ctx.fill();
    },

    // 64. Prism Caustics (Wandering Refractive Spectral Bands)
    drawPrismCaustics(ctx, width, height, t) {
        ctx.fillStyle = '#040406';
        ctx.fillRect(0, 0, width, height);

        const colors = [
            'rgba(239, 68, 68, 0.55)',
            'rgba(249, 115, 22, 0.55)',
            'rgba(234, 179, 8, 0.55)',
            'rgba(34, 197, 94, 0.55)',
            'rgba(6, 182, 212, 0.55)',
            'rgba(59, 130, 246, 0.55)',
            'rgba(168, 85, 247, 0.55)'
        ];

        const bandCount = colors.length;
        const segs = 32;
        const dx = width / segs;

        for (let b = 0; b < bandCount; b++) {
            const offsetPhase = b * 0.12;
            const baseY = height * 0.38 + b * 16 + Math.sin(t * 0.3) * 20;

            ctx.strokeStyle = colors[b];
            ctx.lineWidth = 3.5;
            ctx.beginPath();

            for (let i = 0; i <= segs; i++) {
                const x = i * dx;
                const wave = Math.sin(x * 0.005 + t * 0.4 + offsetPhase) * 55
                           + Math.cos(x * 0.009 - t * 0.25 + offsetPhase) * 28;
                const y = baseY + wave;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        const cx = width * 0.5;
        const cy = height * 0.45;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(t * 0.1);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let p = 0; p < 6; p++) {
            const a = (p / 6) * Math.PI * 2;
            const r = Math.min(width, height) * 0.35;
            const px = Math.cos(a) * r;
            const py = Math.sin(a) * r;
            if (p === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    },

    drawStainedGlass(ctx, width, height, t) {
        ctx.save();
        const cols = 6;
        const rows = 10;
        const cellW = width / cols;
        const cellH = height / rows;
        const beamX = width * (0.5 + Math.sin(t * 0.15) * 0.4);
        const beamY = height * (0.5 + Math.cos(t * 0.12) * 0.4);

        const palette = [
            '#dc2626', '#2563eb', '#d97706', '#059669', '#7c3aed', '#0891b2', '#db2777'
        ];

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const x0 = c * cellW;
                const y0 = r * cellH;
                const midX = x0 + cellW * 0.5;
                const midY = y0 + cellH * 0.5;
                const distToBeam = Math.hypot(midX - beamX, midY - beamY);
                const beamIntensity = Math.max(0, 1 - distToBeam / (width * 0.65));

                const colorBase = palette[(c * 3 + r * 2) % palette.length];
                ctx.fillStyle = colorBase;
                ctx.globalAlpha = 0.22 + beamIntensity * 0.45;

                ctx.beginPath();
                ctx.moveTo(midX, y0);
                ctx.lineTo(x0 + cellW, midY);
                ctx.lineTo(midX, y0 + cellH);
                ctx.lineTo(x0, midY);
                ctx.closePath();
                ctx.fill();

                if (beamIntensity > 0.3) {
                    const sheenGrad = ctx.createLinearGradient(x0, y0, x0 + cellW, y0 + cellH);
                    sheenGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
                    sheenGrad.addColorStop(0.5, `rgba(255, 245, 200, ${beamIntensity * 0.4})`);
                    sheenGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
                    ctx.fillStyle = sheenGrad;
                    ctx.fill();
                }

                ctx.globalAlpha = 0.85;
                ctx.strokeStyle = '#050508';
                ctx.lineWidth = 2.5;
                ctx.stroke();
            }
        }
        ctx.restore();
    },

    drawCircuitBoard(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#040907';
        ctx.fillRect(0, 0, width, height);

        const chips = [
            { x: width * 0.25, y: height * 0.3, w: 70, h: 50 },
            { x: width * 0.65, y: height * 0.65, w: 90, h: 60 }
        ];

        chips.forEach(chip => {
            ctx.fillStyle = '#0d1612';
            ctx.fillRect(chip.x - chip.w / 2, chip.y - chip.h / 2, chip.w, chip.h);
            ctx.strokeStyle = '#eab308';
            ctx.lineWidth = 1.8;
            ctx.strokeRect(chip.x - chip.w / 2, chip.y - chip.h / 2, chip.w, chip.h);

            ctx.fillStyle = '#ca8a04';
            const pinCount = 6;
            for (let i = 0; i < pinCount; i++) {
                const px = chip.x - chip.w / 2 + (chip.w / (pinCount - 1)) * i;
                ctx.fillRect(px - 2, chip.y - chip.h / 2 - 5, 4, 5);
                ctx.fillRect(px - 2, chip.y + chip.h / 2, 4, 5);
            }
        });

        const traces = [
            [[0, height * 0.15], [width * 0.3, height * 0.15], [width * 0.45, height * 0.3], [width * 0.8, height * 0.3]],
            [[width * 0.25, height * 0.35], [width * 0.25, height * 0.65], [width * 0.5, height * 0.65]],
            [[width * 0.7, height * 0.6], [width * 0.7, height * 0.4], [width * 0.9, height * 0.4], [width, height * 0.4]],
            [[0, height * 0.75], [width * 0.35, height * 0.75], [width * 0.5, height * 0.9], [width, height * 0.9]],
            [[width * 0.65, height * 0.72], [width * 0.65, height * 0.85], [width * 0.4, height * 0.85], [width * 0.4, height]]
        ];

        traces.forEach((pts, idx) => {
            const isGold = idx % 2 === 0;
            ctx.strokeStyle = isGold ? 'rgba(234, 179, 8, 0.4)' : 'rgba(6, 182, 212, 0.4)';
            ctx.lineWidth = 2.2;
            ctx.setLineDash([]);
            ctx.beginPath();
            pts.forEach((p, i) => {
                if (i === 0) ctx.moveTo(p[0], p[1]);
                else ctx.lineTo(p[0], p[1]);
            });
            ctx.stroke();

            ctx.strokeStyle = isGold ? '#fef08a' : '#a5f3fc';
            ctx.lineWidth = 3.5;
            ctx.setLineDash([12, 28]);
            ctx.lineDashOffset = -t * (70 + idx * 20);
            ctx.stroke();
            ctx.setLineDash([]);

            pts.forEach(p => {
                ctx.fillStyle = isGold ? '#eab308' : '#06b6d4';
                ctx.fillRect(p[0] - 3, p[1] - 3, 6, 6);
            });
        });
        ctx.restore();
    },

    drawTopographicCanyon(ctx, width, height, t) {
        ctx.save();
        const layers = 11;
        const spacing = height / (layers - 1);
        const canyonColors = [
            '#431407', '#78350f', '#9a3412', '#c2410c', '#ea580c',
            '#d97706', '#f59e0b', '#b45309', '#92400e', '#7c2d12', '#451a03'
        ];

        for (let i = 0; i < layers; i++) {
            const baseY = i * spacing;
            const color = canyonColors[i % canyonColors.length];

            ctx.beginPath();
            ctx.moveTo(0, height);
            ctx.lineTo(0, baseY);

            for (let x = 0; x <= width; x += 12) {
                const y = baseY +
                    Math.sin(x * 0.005 + t * 0.25 + i * 0.6) * 26 +
                    Math.cos(x * 0.012 - t * 0.18 + i * 0.9) * 16;
                ctx.lineTo(x, y);
            }
            ctx.lineTo(width, height);
            ctx.closePath();

            const grad = ctx.createLinearGradient(0, baseY - 30, 0, baseY + 60);
            grad.addColorStop(0, color);
            grad.addColorStop(1, '#180803');
            ctx.fillStyle = grad;
            ctx.globalAlpha = 0.88;
            ctx.fill();

            ctx.strokeStyle = 'rgba(255, 237, 213, 0.35)';
            ctx.lineWidth = 1.6;
            ctx.stroke();
        }
        ctx.restore();
    },

    drawSumiMountains(ctx, width, height, t) {
        ctx.save();
        const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
        bgGrad.addColorStop(0, '#06080e');
        bgGrad.addColorStop(1, '#111827');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, width, height);

        const ridges = 5;
        for (let i = 0; i < ridges; i++) {
            const depth = i / (ridges - 1);
            const baseY = height * (0.35 + depth * 0.45);
            const alpha = 0.25 + depth * 0.6;
            const inkColor = `rgba(15, 23, 42, ${alpha})`;

            ctx.beginPath();
            ctx.moveTo(0, height);
            ctx.lineTo(0, baseY);
            for (let x = 0; x <= width; x += 20) {
                const crag = Math.sin(x * 0.006 + i * 2.1) * 35 +
                             Math.cos(x * 0.015 + i * 1.5) * 20 +
                             Math.sin(x * 0.03 + i) * 10;
                ctx.lineTo(x, baseY + crag);
            }
            ctx.lineTo(width, height);
            ctx.closePath();
            ctx.fillStyle = inkColor;
            ctx.fill();

            const mistSpeed = (12 + i * 8);
            const mistX = ((t * mistSpeed) % (width * 1.6)) - width * 0.3;
            const mistGrad = ctx.createLinearGradient(mistX, 0, mistX + width * 0.8, 0);
            mistGrad.addColorStop(0, 'rgba(226, 232, 240, 0)');
            mistGrad.addColorStop(0.5, `rgba(203, 213, 225, ${0.12 + (1 - depth) * 0.18})`);
            mistGrad.addColorStop(1, 'rgba(226, 232, 240, 0)');
            ctx.fillStyle = mistGrad;
            ctx.fillRect(0, baseY - 20, width, 55);
        }
        ctx.restore();
    },

    drawShojiBamboo(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#17130e';
        ctx.fillRect(0, 0, width, height);

        const lanternGrad = ctx.createLinearGradient(0, height, 0, height * 0.4);
        lanternGrad.addColorStop(0, 'rgba(245, 158, 11, 0.18)');
        lanternGrad.addColorStop(1, 'rgba(245, 158, 11, 0)');
        ctx.fillStyle = lanternGrad;
        ctx.fillRect(0, 0, width, height);

        const stalkCount = 4;
        for (let s = 0; s < stalkCount; s++) {
            const baseX = width * (0.2 + s * 0.22);
            const sway = Math.sin(t * 0.5 + s * 1.3) * 16;
            ctx.strokeStyle = 'rgba(34, 197, 94, 0.28)';
            ctx.lineWidth = 7;
            ctx.lineCap = 'round';

            ctx.beginPath();
            ctx.moveTo(baseX, height);
            ctx.quadraticCurveTo(baseX + sway * 0.5, height * 0.5, baseX + sway, 0);
            ctx.stroke();

            const nodes = 6;
            for (let n = 1; n < nodes; n++) {
                const ny = height * (n / nodes);
                const nx = baseX + sway * (1 - n / nodes);

                ctx.strokeStyle = 'rgba(21, 128, 61, 0.5)';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(nx - 6, ny);
                ctx.lineTo(nx + 6, ny);
                ctx.stroke();

                const dir = (n + s) % 2 === 0 ? 1 : -1;
                const leafSway = Math.sin(t * 0.8 + n + s) * 8;
                ctx.fillStyle = 'rgba(34, 197, 94, 0.3)';
                ctx.beginPath();
                ctx.moveTo(nx, ny);
                ctx.quadraticCurveTo(nx + dir * 35, ny - 15 + leafSway, nx + dir * 65, ny - 5 + leafSway);
                ctx.quadraticCurveTo(nx + dir * 35, ny + 5 + leafSway, nx, ny);
                ctx.closePath();
                ctx.fill();
            }
        }

        const cols = 4;
        const rows = 7;
        ctx.strokeStyle = '#451a03';
        ctx.lineWidth = 4;
        for (let c = 0; c <= cols; c++) {
            const x = (width / cols) * c;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
        ctx.lineWidth = 3;
        for (let r = 0; r <= rows; r++) {
            const y = (height / rows) * r;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }
        ctx.restore();
    },

    drawSynthwaveGrid(ctx, width, height, t) {
        ctx.save();
        const vpX = width * 0.5;
        const vpY = height * 0.54;

        const skyGrad = ctx.createLinearGradient(0, 0, 0, vpY);
        skyGrad.addColorStop(0, '#05020c');
        skyGrad.addColorStop(1, '#2b0938');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, width, vpY);

        ctx.fillStyle = '#140326';
        ctx.beginPath();
        ctx.moveTo(0, vpY);
        for (let x = 0; x <= width; x += 25) {
            const mHeight = Math.abs(Math.sin(x * 0.015)) * 45 + Math.abs(Math.cos(x * 0.035)) * 25;
            ctx.lineTo(x, vpY - mHeight);
        }
        ctx.lineTo(width, vpY);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#ec4899';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.strokeStyle = 'rgba(236, 72, 153, 0.45)';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(0, vpY);
        ctx.lineTo(width, vpY);
        ctx.stroke();

        ctx.strokeStyle = '#fdf2f8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, vpY);
        ctx.lineTo(width, vpY);
        ctx.stroke();

        const groundGrad = ctx.createLinearGradient(0, vpY, 0, height);
        groundGrad.addColorStop(0, '#0a0314');
        groundGrad.addColorStop(1, '#020005');
        ctx.fillStyle = groundGrad;
        ctx.fillRect(0, vpY, width, height - vpY);

        const radials = 14;
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.45)';
        ctx.lineWidth = 1.5;
        for (let r = 0; r <= radials; r++) {
            const targetX = (width / radials) * r;
            ctx.beginPath();
            ctx.moveTo(vpX, vpY);
            ctx.lineTo(targetX * 2 - width * 0.5, height);
            ctx.stroke();
        }

        const barCount = 14;
        for (let b = 0; b < barCount; b++) {
            const phase = ((t * 35 + b * 22) % 300) / 300;
            const screenY = vpY + (height - vpY) * Math.pow(phase, 2.2);
            ctx.strokeStyle = `rgba(236, 72, 153, ${0.15 + phase * 0.7})`;
            ctx.lineWidth = 1 + phase * 2.5;
            ctx.beginPath();
            ctx.moveTo(0, screenY);
            ctx.lineTo(width, screenY);
            ctx.stroke();
        }
        ctx.restore();
    },

    drawBauhausCanvas(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#0f0f14';
        ctx.fillRect(0, 0, width, height);

        const xLines = [
            width * 0.28 + Math.sin(t * 0.25) * 20,
            width * 0.68 + Math.cos(t * 0.22) * 25
        ];
        const yLines = [
            height * 0.24 + Math.sin(t * 0.2) * 18,
            height * 0.62 + Math.cos(t * 0.18) * 22,
            height * 0.84 + Math.sin(t * 0.24) * 14
        ];

        ctx.fillStyle = '#dc2626';
        ctx.fillRect(xLines[1], 0, width - xLines[1], yLines[1]);

        ctx.fillStyle = '#1d4ed8';
        ctx.fillRect(0, yLines[1], xLines[0], yLines[2] - yLines[1]);

        ctx.fillStyle = '#eab308';
        ctx.fillRect(xLines[1], yLines[2], width - xLines[1], height - yLines[2]);

        ctx.fillStyle = '#f5f5f4';
        ctx.fillRect(xLines[0], yLines[0], xLines[1] - xLines[0], yLines[1] - yLines[0]);
        ctx.fillStyle = '#18181b';
        ctx.fillRect(0, 0, xLines[0], yLines[1]);

        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 7;
        xLines.forEach(x => {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        });
        yLines.forEach(y => {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        });
        ctx.restore();
    },

    drawAudioSpectrogram(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#030206';
        ctx.fillRect(0, 0, width, height);

        const cols = 32;
        const rows = 26;
        const colW = width / cols;
        const rowH = height / rows;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const timeRow = r + t * 4;
                const freq = Math.sin(c * 0.24 + timeRow * 0.16) * Math.cos(c * 0.08 - timeRow * 0.06);
                const normVal = Math.abs(freq);

                let color;
                if (normVal < 0.2) color = '#1e1b4b';
                else if (normVal < 0.4) color = '#6b21a8';
                else if (normVal < 0.6) color = '#db2777';
                else if (normVal < 0.8) color = '#ea580c';
                else color = '#facc15';

                ctx.fillStyle = color;
                ctx.globalAlpha = 0.3 + normVal * 0.7;
                ctx.fillRect(c * colW, r * rowH, colW - 1, rowH - 1);
            }
        }
        ctx.restore();
    },

    drawWeavingLoom(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#090d0b';
        ctx.fillRect(0, 0, width, height);

        const cols = 18;
        const rows = 28;
        const colW = width / cols;
        const rowH = height / rows;

        const warpColors = ['#166534', '#1e3a8a', '#991b1b', '#ca8a04'];
        const weftColors = ['#14532d', '#1e40af', '#b91c1c', '#eab308'];

        const shuttleWave = (col, row) => Math.sin((col + row) * 0.28 - t * 1.6) * 0.3;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const isWeftOver = (c + r) % 2 === 0;
                const wave = shuttleWave(c, r);

                if (isWeftOver) {
                    ctx.fillStyle = weftColors[r % weftColors.length];
                    ctx.globalAlpha = 0.75 + wave;
                    ctx.fillRect(c * colW, r * rowH, colW, rowH - 2);
                    ctx.fillStyle = 'rgba(0,0,0,0.5)';
                    ctx.fillRect(c * colW, r * rowH + rowH - 2, colW, 2);
                } else {
                    ctx.fillStyle = warpColors[c % warpColors.length];
                    ctx.globalAlpha = 0.75 + wave;
                    ctx.fillRect(c * colW, r * rowH, colW - 2, rowH);
                    ctx.fillStyle = 'rgba(0,0,0,0.5)';
                    ctx.fillRect(c * colW + colW - 2, r * rowH, 2, rowH);
                }
            }
        }
        ctx.restore();
    },

    drawVenetianBlinds(ctx, width, height, t) {
        ctx.save();
        const wallCycle = (Math.sin(t * 0.1) + 1) * 0.5;
        const wallGrad = ctx.createLinearGradient(0, 0, width, height);
        wallGrad.addColorStop(0, wallCycle > 0.5 ? '#241a12' : '#0d1019');
        wallGrad.addColorStop(1, wallCycle > 0.5 ? '#161009' : '#07090f');
        ctx.fillStyle = wallGrad;
        ctx.fillRect(0, 0, width, height);

        const lightBeam = ctx.createLinearGradient(0, 0, width, height * 0.8);
        lightBeam.addColorStop(0, 'rgba(254, 240, 138, 0.25)');
        lightBeam.addColorStop(0.6, 'rgba(251, 146, 60, 0.12)');
        lightBeam.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = lightBeam;
        ctx.fillRect(0, 0, width, height);

        const slats = 16;
        const spacing = height / slats;
        for (let s = 0; s < slats; s++) {
            const baseY = s * spacing;
            const tilt = Math.sin(t * 0.4 + s * 0.12) * 8;
            const slatH = spacing * 0.55 + Math.cos(t * 0.3) * 3;

            ctx.fillStyle = 'rgba(2, 2, 5, 0.78)';
            ctx.beginPath();
            ctx.moveTo(0, baseY + tilt);
            ctx.lineTo(width, baseY - tilt * 0.5);
            ctx.lineTo(width, baseY - tilt * 0.5 + slatH);
            ctx.lineTo(0, baseY + tilt + slatH);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        ctx.restore();
    },

    drawKineticFacade(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#0a0d10';
        ctx.fillRect(0, 0, width, height);

        const cols = 7;
        const rows = 11;
        const colW = width / cols;
        const rowH = height / rows;
        const panelW = colW * 0.85;
        const panelH = rowH * 0.82;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cx = c * colW + colW * 0.5;
                const cy = r * rowH + rowH * 0.5;

                const angle = Math.sin(t * 0.75 + c * 0.45 + r * 0.35) * 0.85;
                const projW = Math.max(4, panelW * Math.cos(angle));

                ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
                ctx.fillRect(cx - projW / 2 + 5, cy - panelH / 2 + 5, projW, panelH);

                const specGrad = ctx.createLinearGradient(cx - projW / 2, cy, cx + projW / 2, cy);
                if (angle > 0) {
                    specGrad.addColorStop(0, '#94a3b8');
                    specGrad.addColorStop(0.5, '#e2e8f0');
                    specGrad.addColorStop(1, '#475569');
                } else {
                    specGrad.addColorStop(0, '#334155');
                    specGrad.addColorStop(0.5, '#64748b');
                    specGrad.addColorStop(1, '#cbd5e1');
                }
                ctx.fillStyle = specGrad;
                ctx.fillRect(cx - projW / 2, cy - panelH / 2, projW, panelH);

                ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
                ctx.lineWidth = 1;
                ctx.strokeRect(cx - projW / 2, cy - panelH / 2, projW, panelH);
            }
        }
        ctx.restore();
    },

    drawBasaltWaterfall(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#060a0f';
        ctx.fillRect(0, 0, width, height);

        const cols = 9;
        const colW = width / cols;
        for (let c = 0; c < cols; c++) {
            const x = c * colW;
            const shade = (c % 3 === 0) ? '#0f172a' : ((c % 3 === 1) ? '#1e293b' : '#334155');
            ctx.fillStyle = shade;
            ctx.fillRect(x, 0, colW, height);
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, 0, colW, height);
        }

        const waterfalls = 10;
        for (let w = 0; w < waterfalls; w++) {
            const wx = (width / (waterfalls + 1)) * (w + 1);
            const waterPhase = (t * 220 + w * 85) % (height + 120) - 60;

            const waterGrad = ctx.createLinearGradient(wx, waterPhase, wx, waterPhase + 160);
            waterGrad.addColorStop(0, 'rgba(56, 189, 248, 0)');
            waterGrad.addColorStop(0.5, 'rgba(224, 242, 254, 0.85)');
            waterGrad.addColorStop(1, 'rgba(56, 189, 248, 0)');

            ctx.strokeStyle = waterGrad;
            ctx.lineWidth = 2.5 + (w % 3);
            ctx.beginPath();
            ctx.moveTo(wx, Math.max(0, waterPhase));
            ctx.lineTo(wx, Math.min(height, waterPhase + 160));
            ctx.stroke();
        }

        const mist = ctx.createLinearGradient(0, height, 0, height * 0.7);
        mist.addColorStop(0, 'rgba(224, 242, 254, 0.35)');
        mist.addColorStop(1, 'rgba(224, 242, 254, 0)');
        ctx.fillStyle = mist;
        ctx.fillRect(0, height * 0.7, width, height * 0.3);
        ctx.restore();
    },

    drawRetroTerminal(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#011207';
        ctx.fillRect(0, 0, width, height);

        const logs = [
            'CORE_INIT: 0x7FFF8020 [OK]',
            'MEMORY_MAP: 640KB BASE VRAM',
            'BUS_CLOCK: 800 MHz SYSBUS',
            'SECURE_KEY: 0xFA48-99BD-01',
            'BUFFER_STREAM: NOMINAL (99.8%)',
            'STATUS: COM_CHANNEL_ACTIVE',
            'DECRYPT_PASS: 0x90214C V3',
            'TELEMETRY: STABLE 60 FPS'
        ];

        ctx.font = '13px "Courier New", monospace';
        ctx.fillStyle = '#4ade80';

        const lineH = 26;
        const scrollOffset = (t * 18) % lineH;
        const totalVisible = Math.ceil(height / lineH) + 1;

        for (let i = 0; i < totalVisible; i++) {
            const lineIdx = (Math.floor((t * 18) / lineH) + i) % logs.length;
            const py = i * lineH - scrollOffset;
            ctx.fillText(logs[lineIdx], 20, py);
        }

        if (Math.floor(t * 2) % 2 === 0) {
            ctx.fillRect(20, (totalVisible - 2) * lineH - scrollOffset + 4, 9, 14);
        }

        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        for (let y = 0; y < height; y += 3) {
            ctx.fillRect(0, y, width, 1.2);
        }
        ctx.restore();
    },

    drawOrigamiFacets(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#0b0912';
        ctx.fillRect(0, 0, width, height);

        const cols = 8;
        const rows = 12;
        const colW = width / cols;
        const rowH = height / rows;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const x1 = c * colW;
                const y1 = r * rowH;
                const x2 = (c + 1) * colW;
                const y2 = (r + 1) * rowH;

                const z = Math.sin(c * 0.45 + t * 0.55) * 0.4 + Math.cos(r * 0.45 - t * 0.4) * 0.4;
                const lightNorm = Math.max(0.1, (z + 1) * 0.5);

                ctx.fillStyle = `rgba(99, 102, 241, ${0.2 + lightNorm * 0.6})`;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y1);
                ctx.lineTo(x1, y2);
                ctx.closePath();
                ctx.fill();
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = `rgba(52, 211, 153, ${0.2 + (1 - lightNorm) * 0.6})`;
                ctx.beginPath();
                ctx.moveTo(x2, y1);
                ctx.lineTo(x2, y2);
                ctx.lineTo(x1, y2);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }
        }
        ctx.restore();
    },

    drawVhsDrift(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#060609';
        ctx.fillRect(0, 0, width, height);

        const trackY = (t * 65) % (height + 140) - 70;

        ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
        ctx.fillRect(4, trackY - 20, width, 40);
        ctx.fillStyle = 'rgba(6, 182, 212, 0.25)';
        ctx.fillRect(-4, trackY - 16, width, 40);

        ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
        for (let i = 0; i < 6; i++) {
            const gy = trackY - 15 + i * 8;
            const gx = Math.sin(t * 15 + i) * 35;
            ctx.fillRect(gx, gy, width * 0.8, 2);
        }

        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        for (let y = 0; y < height; y += 3) {
            ctx.fillRect(0, y, width, 1.2);
        }

        const lumaGrad = ctx.createLinearGradient(0, trackY - 100, 0, trackY + 100);
        lumaGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
        lumaGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.12)');
        lumaGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = lumaGrad;
        ctx.fillRect(0, trackY - 100, width, 200);
        ctx.restore();
    },

    drawPenroseIsometric(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#0a0a0e';
        ctx.fillRect(0, 0, width, height);

        const tileW = 55;
        const tileH = tileW * 0.577;
        const cols = Math.ceil(width / tileW) + 2;
        const rows = Math.ceil(height / tileH) + 4;

        for (let r = -2; r < rows; r++) {
            for (let c = -1; c < cols; c++) {
                const cx = c * tileW + (r % 2 === 0 ? 0 : tileW * 0.5);
                const elev = Math.sin(c * 0.4 + r * 0.4 + t * 0.7) * 16;
                const cy = r * tileH + elev;

                ctx.fillStyle = '#f1f5f9';
                ctx.beginPath();
                ctx.moveTo(cx, cy - tileH * 0.5);
                ctx.lineTo(cx + tileW * 0.5, cy);
                ctx.lineTo(cx, cy + tileH * 0.5);
                ctx.lineTo(cx - tileW * 0.5, cy);
                ctx.closePath();
                ctx.fill();
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = '#64748b';
                ctx.beginPath();
                ctx.moveTo(cx - tileW * 0.5, cy);
                ctx.lineTo(cx, cy + tileH * 0.5);
                ctx.lineTo(cx, cy + tileH * 1.3);
                ctx.lineTo(cx - tileW * 0.5, cy + tileH * 0.8);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();

                ctx.fillStyle = '#1e293b';
                ctx.beginPath();
                ctx.moveTo(cx, cy + tileH * 0.5);
                ctx.lineTo(cx + tileW * 0.5, cy);
                ctx.lineTo(cx + tileW * 0.5, cy + tileH * 0.8);
                ctx.lineTo(cx, cy + tileH * 1.3);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }
        }
        ctx.restore();
    },

    drawFlutedGlass(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#06090d';
        ctx.fillRect(0, 0, width, height);

        const lights = [
            { y: height * (0.2 + Math.sin(t * 0.2) * 0.15), h: 70, col: 'rgba(56, 189, 248, 0.4)' },
            { y: height * (0.5 + Math.cos(t * 0.18) * 0.18), h: 85, col: 'rgba(251, 146, 60, 0.35)' },
            { y: height * (0.78 + Math.sin(t * 0.15) * 0.12), h: 65, col: 'rgba(168, 85, 247, 0.35)' }
        ];

        lights.forEach(l => {
            const grad = ctx.createLinearGradient(0, l.y - l.h * 0.5, 0, l.y + l.h * 0.5);
            grad.addColorStop(0, 'rgba(0,0,0,0)');
            grad.addColorStop(0.5, l.col);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, l.y - l.h * 0.5, width, l.h);
        });

        const ribs = 32;
        const ribW = width / ribs;
        for (let i = 0; i < ribs; i++) {
            const rx = i * ribW;

            const ribGrad = ctx.createLinearGradient(rx, 0, rx + ribW, 0);
            ribGrad.addColorStop(0, 'rgba(255, 255, 255, 0.32)');
            ribGrad.addColorStop(0.2, 'rgba(255, 255, 255, 0.08)');
            ribGrad.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
            ribGrad.addColorStop(0.8, 'rgba(0, 0, 0, 0.25)');
            ribGrad.addColorStop(1, 'rgba(0, 0, 0, 0.6)');

            ctx.fillStyle = ribGrad;
            ctx.fillRect(rx, 0, ribW, height);

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(rx, 0);
            ctx.lineTo(rx, height);
            ctx.stroke();
        }
        ctx.restore();
    },

    drawWoodMarquetry(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#120b07';
        ctx.fillRect(0, 0, width, height);

        const plankW = 38;
        const plankH = 110;
        const cols = Math.ceil(width / plankW) + 2;
        const rows = Math.ceil(height / (plankH * 0.5)) + 2;

        const woodColors = ['#3b2317', '#78350f', '#92400e', '#a16207', '#451a03'];
        const lightAngle = t * 0.25;

        for (let r = -1; r < rows; r++) {
            for (let c = -1; c < cols; c++) {
                const isLeft = (c + r) % 2 === 0;
                const px = c * plankW;
                const py = r * (plankH * 0.5);

                const baseCol = woodColors[(c * 3 + r * 2) % woodColors.length];
                const fiberAngle = isLeft ? Math.PI * 0.25 : -Math.PI * 0.25;
                const sheen = Math.cos(fiberAngle - lightAngle) * 0.28;

                ctx.fillStyle = baseCol;
                ctx.globalAlpha = Math.max(0.4, Math.min(1, 0.75 + sheen));

                ctx.beginPath();
                if (isLeft) {
                    ctx.moveTo(px, py);
                    ctx.lineTo(px + plankW, py + plankH * 0.5);
                    ctx.lineTo(px + plankW, py + plankH);
                    ctx.lineTo(px, py + plankH * 0.5);
                } else {
                    ctx.moveTo(px + plankW, py);
                    ctx.lineTo(px, py + plankH * 0.5);
                    ctx.lineTo(px, py + plankH);
                    ctx.lineTo(px + plankW, py + plankH * 0.5);
                }
                ctx.closePath();
                ctx.fill();

                ctx.strokeStyle = '#0a0604';
                ctx.lineWidth = 1.2;
                ctx.stroke();
            }
        }
        ctx.restore();
    },

    drawSeismicDrum(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#060a0f';
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = 'rgba(71, 85, 105, 0.15)';
        ctx.lineWidth = 1;
        for (let x = 0; x < width; x += 18) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
        for (let y = 0; y < height; y += 18) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        const channels = [
            { y: height * 0.2, color: '#ef4444', freq: 0.04, amp: 28, speed: 4.2 },
            { y: height * 0.42, color: '#10b981', freq: 0.025, amp: 34, speed: 3.5 },
            { y: height * 0.65, color: '#06b6d4', freq: 0.05, amp: 22, speed: 5.0 },
            { y: height * 0.85, color: '#f59e0b', freq: 0.03, amp: 30, speed: 3.8 }
        ];

        channels.forEach(ch => {
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, ch.y);
            ctx.lineTo(width, ch.y);
            ctx.stroke();

            ctx.strokeStyle = ch.color;
            ctx.lineWidth = 2.2;

            ctx.beginPath();
            for (let x = 0; x <= width; x += 4) {
                const tremor = Math.sin(x * ch.freq - t * ch.speed) *
                               Math.cos(x * ch.freq * 0.5 + t * ch.speed * 0.4) * ch.amp +
                               (Math.sin(x * 0.12 - t * 8) > 0.8 ? Math.sin(x * 0.2) * (ch.amp * 0.5) : 0);
                const py = ch.y + tremor;
                if (x === 0) ctx.moveTo(x, py);
                else ctx.lineTo(x, py);
            }
            ctx.stroke();
        });
        ctx.restore();
    },

    drawIsometricCity(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#05060a';
        ctx.fillRect(0, 0, width, height);

        const bCols = 5;
        const bRows = 6;
        const bSize = 48;

        for (let r = 0; r < bRows; r++) {
            for (let c = 0; c < bCols; c++) {
                const isoX = width * 0.5 + (c - r) * (bSize * 0.866);
                const isoY = height * 0.15 + (c + r) * (bSize * 0.5);
                const bH = 50 + ((c * 7 + r * 11) % 5) * 22;

                ctx.fillStyle = '#0e7490';
                ctx.beginPath();
                ctx.moveTo(isoX, isoY - bH);
                ctx.lineTo(isoX + bSize * 0.866, isoY - bH + bSize * 0.5);
                ctx.lineTo(isoX, isoY - bH + bSize);
                ctx.lineTo(isoX - bSize * 0.866, isoY - bH + bSize * 0.5);
                ctx.closePath();
                ctx.fill();
                ctx.strokeStyle = '#22d3ee';
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.fillStyle = '#082f49';
                ctx.beginPath();
                ctx.moveTo(isoX - bSize * 0.866, isoY - bH + bSize * 0.5);
                ctx.lineTo(isoX, isoY - bH + bSize);
                ctx.lineTo(isoX, isoY + bSize);
                ctx.lineTo(isoX - bSize * 0.866, isoY + bSize * 0.5);
                ctx.closePath();
                ctx.fill();

                ctx.fillStyle = 'rgba(56, 189, 248, 0.6)';
                for (let w = 1; w < 4; w++) {
                    const wy = isoY - bH + bSize * 0.5 + w * 18;
                    ctx.fillRect(isoX - bSize * 0.5, wy, 8, 4);
                }

                ctx.fillStyle = '#0c4a6e';
                ctx.beginPath();
                ctx.moveTo(isoX, isoY - bH + bSize);
                ctx.lineTo(isoX + bSize * 0.866, isoY - bH + bSize * 0.5);
                ctx.lineTo(isoX + bSize * 0.866, isoY + bSize * 0.5);
                ctx.lineTo(isoX, isoY + bSize);
                ctx.closePath();
                ctx.fill();
            }
        }

        ctx.strokeStyle = '#eab308';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, height * 0.85);
        ctx.lineTo(width, height * 0.25);
        ctx.stroke();

        const trainPhase = (t * 110) % (width * 1.2) - width * 0.1;
        const trainY = height * 0.85 - (trainPhase / width) * (height * 0.6);
        ctx.fillStyle = 'rgba(234, 179, 8, 0.35)';
        ctx.fillRect(trainPhase - 4, trainY - 7, 38, 14);
        ctx.fillStyle = '#fef08a';
        ctx.fillRect(trainPhase, trainY - 4, 30, 8);
        ctx.restore();
    },

    drawPapercraftLayers(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#06080b';
        ctx.fillRect(0, 0, width, height);

        const layers = [
            { col: '#0f172a', baseY: height * 0.18 },
            { col: '#1e293b', baseY: height * 0.32 },
            { col: '#334155', baseY: height * 0.46 },
            { col: '#475569', baseY: height * 0.60 },
            { col: '#64748b', baseY: height * 0.74 },
            { col: '#94a3b8', baseY: height * 0.88 }
        ];

        layers.forEach((l, idx) => {
            ctx.fillStyle = l.col;
            ctx.beginPath();
            ctx.moveTo(0, height);
            ctx.lineTo(0, l.baseY);

            for (let x = 0; x <= width; x += 16) {
                const py = l.baseY +
                    Math.sin(x * 0.006 + t * 0.35 + idx * 0.8) * 22 +
                    Math.cos(x * 0.014 - t * 0.25 + idx) * 12;
                ctx.lineTo(x, py);
            }
            ctx.lineTo(width, height);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.lineWidth = 1.4;
            ctx.stroke();
        });
        ctx.restore();
    },

    drawHexCipher(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#010c05';
        ctx.fillRect(0, 0, width, height);

        const hexChars = ['0A', 'F4', '8C', '1B', 'E9', '3D', '72', 'B0', '5E', 'D6', '9A', '23'];
        const cols = 16;
        const colW = width / cols;
        const rowH = 22;
        const rows = Math.ceil(height / rowH) + 2;

        ctx.font = '11px "Courier New", monospace';

        for (let c = 0; c < cols; c++) {
            const speed = 25 + (c % 5) * 15;
            const scroll = (t * speed) % (rows * rowH);

            for (let r = 0; r < rows; r++) {
                const py = (r * rowH + scroll) % (rows * rowH);
                const charIdx = (c * 7 + r * 13 + Math.floor(t * 2)) % hexChars.length;
                const isHead = r === 0;

                if (isHead) {
                    ctx.fillStyle = '#86efac';
                } else {
                    const depthAlpha = Math.max(0.15, 1 - (r / rows));
                    ctx.fillStyle = `rgba(34, 197, 94, ${depthAlpha})`;
                }
                ctx.fillText(hexChars[charIdx], c * colW + 4, py);
            }
        }

        ctx.strokeStyle = 'rgba(34, 197, 94, 0.15)';
        ctx.lineWidth = 1;
        for (let c = 0; c <= cols; c++) {
            ctx.beginPath();
            ctx.moveTo(c * colW, 0);
            ctx.lineTo(c * colW, height);
            ctx.stroke();
        }
        ctx.restore();
    },

    drawLaserGrating(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#050208';
        ctx.fillRect(0, 0, width, height);

        const spacing = 18;
        const count = Math.ceil((width + height) / spacing) + 4;

        ctx.strokeStyle = 'rgba(239, 68, 68, 0.45)';
        ctx.lineWidth = 1.8;
        const driftA = (t * 22) % spacing;

        for (let i = -count; i < count; i++) {
            const offset = i * spacing + driftA;
            ctx.beginPath();
            ctx.moveTo(offset, -50);
            ctx.lineTo(offset + height * 0.7, height + 50);
            ctx.stroke();
        }

        ctx.strokeStyle = 'rgba(59, 130, 246, 0.45)';
        ctx.lineWidth = 1.8;
        const driftB = (t * 18) % spacing;

        for (let i = -count; i < count; i++) {
            const offset = i * spacing - driftB;
            ctx.beginPath();
            ctx.moveTo(offset, height + 50);
            ctx.lineTo(offset + height * 0.7, -50);
            ctx.stroke();
        }
        ctx.restore();
    },

    drawSilkDrapery(ctx, width, height, t) {
        ctx.save();
        const bgGrad = ctx.createLinearGradient(0, 0, width, 0);
        bgGrad.addColorStop(0, '#06060c');
        bgGrad.addColorStop(1, '#0e111a');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, width, height);

        const folds = 14;
        const foldW = width / folds;

        for (let f = 0; f < folds; f++) {
            const baseX = f * foldW;

            const foldGrad = ctx.createLinearGradient(baseX, 0, baseX + foldW, 0);
            foldGrad.addColorStop(0, 'rgba(244, 244, 245, 0.12)');
            foldGrad.addColorStop(0.3, 'rgba(255, 255, 255, 0.35)');
            foldGrad.addColorStop(0.7, 'rgba(212, 212, 216, 0.22)');
            foldGrad.addColorStop(1, 'rgba(0, 0, 0, 0.55)');

            ctx.fillStyle = foldGrad;
            ctx.beginPath();
            ctx.moveTo(baseX, 0);

            for (let y = 0; y <= height; y += 20) {
                const sway = Math.sin(y * 0.005 + t * 0.65 + f * 0.45) * 16;
                ctx.lineTo(baseX + sway + foldW, y);
            }
            for (let y = height; y >= 0; y -= 20) {
                const sway = Math.sin(y * 0.005 + t * 0.65 + f * 0.45) * 16;
                ctx.lineTo(baseX + sway, y);
            }
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.lineWidth = 1.2;
            ctx.stroke();
        }
        ctx.restore();
    },

    drawRoseGoldMarble(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#14090e';
        ctx.fillRect(0, 0, width, height);

        const marblePalette = [
            '#f472b6', '#fb7185', '#fda4af', '#fbcfe8', '#fef08a', '#e0e7ff', '#f43f5e'
        ];

        const veins = 9;
        for (let v = 0; v < veins; v++) {
            const baseY = (height / (veins + 1)) * (v + 1);
            const color = marblePalette[v % marblePalette.length];

            ctx.beginPath();
            ctx.moveTo(0, baseY);

            for (let x = 0; x <= width; x += 12) {
                const py = baseY +
                    Math.sin(x * 0.005 + t * 0.35 + v * 0.7) * 45 +
                    Math.cos(x * 0.012 - t * 0.22 + v) * 22;
                ctx.lineTo(x, py);
            }

            ctx.strokeStyle = color;
            ctx.lineWidth = 4 + (v % 4) * 2;
            ctx.globalAlpha = 0.25;
            ctx.stroke();

            ctx.strokeStyle = '#fff1f2';
            ctx.lineWidth = 1.2;
            ctx.globalAlpha = 0.85;
            ctx.stroke();
        }
        ctx.restore();
    },

    drawSakuraRiver(ctx, width, height, t) {
        ctx.save();
        const streamGrad = ctx.createLinearGradient(0, 0, 0, height);
        streamGrad.addColorStop(0, '#0d0714');
        streamGrad.addColorStop(1, '#1a0c1a');
        ctx.fillStyle = streamGrad;
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = 'rgba(244, 114, 182, 0.15)';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 8; i++) {
            const cx = (width / 9) * (i + 1);
            ctx.beginPath();
            for (let y = 0; y <= height; y += 20) {
                const px = cx + Math.sin(y * 0.006 + t * 0.8 + i) * 25;
                if (y === 0) ctx.moveTo(px, y);
                else ctx.lineTo(px, y);
            }
            ctx.stroke();
        }

        const petalColors = ['#fbcfe8', '#fda4af', '#f472b6', '#ffffff', '#fecdd3'];
        const petalCount = 36;

        for (let p = 0; p < petalCount; p++) {
            const pSpeed = 35 + (p % 6) * 8;
            const py = ((p * 37 + t * pSpeed) % (height + 60)) - 30;
            const baseX = ((p * 73) % (width - 40)) + 20;
            const px = baseX + Math.sin(py * 0.008 + t * 0.5 + p) * 22;
            const rot = (p + t * 0.8) % (Math.PI * 2);
            const scale = 0.8 + (p % 4) * 0.2;

            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(rot);
            ctx.scale(scale, scale);

            ctx.fillStyle = petalColors[p % petalColors.length];
            ctx.globalAlpha = 0.75;

            ctx.beginPath();
            ctx.moveTo(0, -8);
            ctx.quadraticCurveTo(8, -14, 12, -4);
            ctx.quadraticCurveTo(12, 10, 0, 16);
            ctx.quadraticCurveTo(-12, 10, -12, -4);
            ctx.quadraticCurveTo(-8, -14, 0, -8);
            ctx.closePath();
            ctx.fill();

            ctx.restore();
        }
        ctx.restore();
    },

    drawWisteriaBreeze(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#090510';
        ctx.fillRect(0, 0, width, height);

        const clusters = 11;
        const clusterW = width / clusters;
        const wisteriaColors = ['#c084fc', '#a855f7', '#e9d5ff', '#d8b4fe', '#9333ea'];

        for (let c = 0; c < clusters; c++) {
            const bx = c * clusterW + clusterW * 0.5;
            const length = height * (0.45 + ((c * 3) % 5) * 0.1);
            const sway = Math.sin(t * 0.75 + c * 0.65) * 18;

            ctx.strokeStyle = 'rgba(147, 51, 234, 0.4)';
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(bx, 0);
            ctx.quadraticCurveTo(bx + sway * 0.5, length * 0.5, bx + sway, length);
            ctx.stroke();

            const tiers = 16;
            for (let tr = 1; tr < tiers; tr++) {
                const frac = tr / tiers;
                const ty = length * frac;
                const tx = bx + sway * Math.pow(frac, 1.2);
                const tierW = (1 - frac * 0.6) * 16;

                ctx.fillStyle = wisteriaColors[(c + tr) % wisteriaColors.length];
                ctx.globalAlpha = 0.75 - frac * 0.2;

                ctx.beginPath();
                ctx.moveTo(tx, ty);
                ctx.quadraticCurveTo(tx - tierW, ty - 4, tx - tierW * 0.7, ty + 8);
                ctx.quadraticCurveTo(tx - 2, ty + 6, tx, ty);
                ctx.closePath();
                ctx.fill();

                ctx.beginPath();
                ctx.moveTo(tx, ty);
                ctx.quadraticCurveTo(tx + tierW, ty - 4, tx + tierW * 0.7, ty + 8);
                ctx.quadraticCurveTo(tx + 2, ty + 6, tx, ty);
                ctx.closePath();
                ctx.fill();
            }
        }
        ctx.restore();
    },

    drawCrystalPrisms(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#12080f';
        ctx.fillRect(0, 0, width, height);

        const spectralBands = [
            'rgba(244, 114, 182, 0.45)',
            'rgba(251, 146, 60, 0.45)',
            'rgba(250, 204, 21, 0.45)',
            'rgba(52, 211, 153, 0.45)',
            'rgba(56, 189, 248, 0.45)',
            'rgba(192, 132, 252, 0.45)'
        ];

        const prisms = 7;
        for (let p = 0; p < prisms; p++) {
            const cx = width * (0.2 + (p % 4) * 0.22) + Math.sin(t * 0.4 + p * 1.5) * 45;
            const cy = height * (0.2 + Math.floor(p / 4) * 0.45) + Math.cos(t * 0.35 + p) * 35;
            const rot = t * 0.15 + p * 0.8;

            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(rot);

            const fanR = 60 + (p % 3) * 25;
            for (let b = 0; b < spectralBands.length; b++) {
                const angle0 = (b / spectralBands.length) * Math.PI * 0.6 - Math.PI * 0.3;
                const angle1 = ((b + 1) / spectralBands.length) * Math.PI * 0.6 - Math.PI * 0.3;

                ctx.fillStyle = spectralBands[b];
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.lineTo(Math.cos(angle0) * fanR, Math.sin(angle0) * fanR);
                ctx.lineTo(Math.cos(angle1) * fanR, Math.sin(angle1) * fanR);
                ctx.closePath();
                ctx.fill();
            }

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(0, -18);
            ctx.lineTo(14, 0);
            ctx.lineTo(0, 18);
            ctx.lineTo(-14, 0);
            ctx.closePath();
            ctx.stroke();

            ctx.restore();
        }
        ctx.restore();
    },

    drawOpalAurora(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#04080d';
        ctx.fillRect(0, 0, width, height);

        const opalColors = [
            '#2dd4bf', '#fb923c', '#f472b6', '#38bdf8', '#c084fc', '#4ade80'
        ];

        const layers = 8;
        for (let i = 0; i < layers; i++) {
            const baseY = (height / (layers + 1)) * (i + 1);
            const col = opalColors[i % opalColors.length];

            ctx.beginPath();
            ctx.moveTo(0, baseY);

            for (let x = 0; x <= width; x += 15) {
                const y = baseY +
                    Math.sin(x * 0.008 + t * 0.45 + i * 0.9) * 38 +
                    Math.cos(x * 0.016 - t * 0.3 + i) * 20;
                ctx.lineTo(x, y);
            }

            const fireGrad = ctx.createLinearGradient(0, baseY - 25, 0, baseY + 25);
            fireGrad.addColorStop(0, 'rgba(0,0,0,0)');
            fireGrad.addColorStop(0.5, col);
            fireGrad.addColorStop(1, 'rgba(0,0,0,0)');

            ctx.strokeStyle = fireGrad;
            ctx.lineWidth = 8;
            ctx.globalAlpha = 0.55 + Math.sin(t * 0.6 + i) * 0.2;
            ctx.stroke();
        }
        ctx.restore();
    },

    drawGlasswingButterfly(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#08040d';
        ctx.fillRect(0, 0, width, height);

        const butterflies = 6;
        for (let b = 0; b < butterflies; b++) {
            const phase = t * 0.4 + b * 1.6;
            const bx = width * 0.5 + Math.sin(phase * 0.6) * (width * 0.42);
            const by = height * 0.5 + Math.cos(phase * 0.8) * (height * 0.38);
            const flap = Math.sin(t * 7 + b * 2) * 0.75;
            const heading = Math.cos(phase * 0.6) * 0.6;

            ctx.save();
            ctx.translate(bx, by);
            ctx.rotate(heading);

            ctx.save();
            ctx.scale(Math.cos(flap), 1);
            ctx.fillStyle = 'rgba(244, 114, 182, 0.25)';
            ctx.strokeStyle = 'rgba(251, 207, 232, 0.8)';
            ctx.lineWidth = 1.4;

            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.quadraticCurveTo(-25, -28, -42, -14);
            ctx.quadraticCurveTo(-38, 12, 0, 16);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.scale(Math.cos(flap), 1);
            ctx.fillStyle = 'rgba(192, 132, 252, 0.25)';
            ctx.strokeStyle = 'rgba(233, 213, 255, 0.8)';
            ctx.lineWidth = 1.4;

            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.quadraticCurveTo(25, -28, 42, -14);
            ctx.quadraticCurveTo(38, 12, 0, 16);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();

            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.moveTo(0, -10);
            ctx.lineTo(1.5, 12);
            ctx.lineTo(-1.5, 12);
            ctx.closePath();
            ctx.fill();

            ctx.restore();
        }
        ctx.restore();
    },

    drawVelvetPeony(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#12050b';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const petalLayers = 9;

        const peonyShades = [
            '#4c0519', '#881337', '#be123c', '#e11d48', '#fb7185',
            '#fda4af', '#fbcfe8', '#fce7f3', '#fff1f2'
        ];

        for (let l = 0; l < petalLayers; l++) {
            const rad = Math.min(width, height) * (0.12 + (l / petalLayers) * 0.42);
            const petals = 6 + l;
            const bloomBreath = Math.sin(t * 0.35 + l * 0.5) * 14;

            for (let p = 0; p < petals; p++) {
                const angle = (p / petals) * Math.PI * 2 + t * 0.05 * (l % 2 === 0 ? 1 : -1) + l * 0.3;
                const px = cx + Math.cos(angle) * (rad + bloomBreath);
                const py = cy + Math.sin(angle) * (rad + bloomBreath);
                const pW = rad * 0.55;

                ctx.save();
                ctx.translate(px, py);
                ctx.rotate(angle + Math.PI * 0.5);

                const grad = ctx.createRadialGradient(0, 0, 5, 0, 0, pW);
                grad.addColorStop(0, peonyShades[l % peonyShades.length]);
                grad.addColorStop(1, 'rgba(76, 5, 25, 0.4)');

                ctx.fillStyle = grad;
                ctx.globalAlpha = 0.72;

                ctx.beginPath();
                ctx.moveTo(-pW * 0.5, 0);
                ctx.quadraticCurveTo(-pW * 0.7, -pW * 0.8, 0, -pW);
                ctx.quadraticCurveTo(pW * 0.7, -pW * 0.8, pW * 0.5, 0);
                ctx.closePath();
                ctx.fill();

                ctx.restore();
            }
        }
        ctx.restore();
    },

    drawPastelClouds(ctx, width, height, t) {
        ctx.save();
        const skyGrad = ctx.createLinearGradient(0, 0, 0, height);
        skyGrad.addColorStop(0, '#100c1e');
        skyGrad.addColorStop(0.5, '#2e122b');
        skyGrad.addColorStop(1, '#4a1525');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, width, height);

        const cloudBanks = 5;
        const cloudColors = [
            'rgba(244, 114, 182, 0.32)',
            'rgba(192, 132, 252, 0.32)',
            'rgba(251, 146, 60, 0.32)',
            'rgba(254, 240, 138, 0.28)',
            'rgba(253, 164, 175, 0.35)'
        ];

        for (let b = 0; b < cloudBanks; b++) {
            const baseY = height * (0.35 + b * 0.13);
            const speed = (12 + b * 9);
            const driftX = (t * speed) % (width * 1.5) - width * 0.25;

            ctx.fillStyle = cloudColors[b];

            ctx.beginPath();
            ctx.moveTo(0, height);
            ctx.lineTo(0, baseY);

            for (let x = 0; x <= width; x += 25) {
                const puff = Math.sin((x + driftX) * 0.015 + b) * 26 +
                             Math.cos((x + driftX) * 0.035 + b * 2) * 14;
                ctx.lineTo(x, baseY + puff);
            }

            ctx.lineTo(width, height);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = 'rgba(254, 243, 199, 0.45)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        ctx.restore();
    },

    // 97. Abyssal Moon Jellyfish (Neural Bioluminescence & Undulating Bell)
    drawEnchantedJellyfish(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#01030a';
        ctx.fillRect(0, 0, width, height);

        // Deep ocean ambient marine snow / bioluminescent specks
        const speckCount = 28;
        ctx.fillStyle = 'rgba(34, 211, 238, 0.5)';
        for (let s = 0; s < speckCount; s++) {
            const sx = ((s * 47 + t * 6) % (width + 20)) - 10;
            const sy = ((s * 83 + Math.sin(t * 0.4 + s) * 15) % (height + 20)) - 10;
            const sr = 0.8 + (s % 3) * 0.7;
            ctx.beginPath();
            ctx.arc(sx, sy, sr, 0, Math.PI * 2);
            ctx.fill();
        }

        // Two moon jellies at different depths
        const jellies = [
            { cx: width * 0.52, cy: height * 0.46, scale: Math.min(width, height) * 0.0028, phase: 0 },
            { cx: width * 0.22, cy: height * 0.75, scale: Math.min(width, height) * 0.0016, phase: 1.8 }
        ];

        jellies.forEach(j => {
            const localT = t + j.phase;
            const pulseCycle = (localT * 0.8) % (Math.PI * 2);
            const contract = Math.pow(Math.max(0, Math.sin(pulseCycle)), 2.5);
            const bobY = Math.sin(localT * 0.8) * 18 - contract * 28;
            const bobX = Math.cos(localT * 0.4) * 14;

            const jx = j.cx + bobX;
            const jy = j.cy + bobY;
            const s = j.scale;

            ctx.save();
            ctx.translate(jx, jy);

            // Trailing long tentacles swaying behind
            const tentacleCount = 14;
            for (let k = 0; k < tentacleCount; k++) {
                const spread = (k / (tentacleCount - 1) - 0.5) * (48 * s * (1 - contract * 0.3));
                ctx.beginPath();
                ctx.moveTo(spread, 10 * s);

                const tLen = 140 * s;
                const steps = 18;
                for (let step = 1; step <= steps; step++) {
                    const prog = step / steps;
                    const ty = 10 * s + prog * tLen;
                    const sway = Math.sin(prog * 3.5 - localT * 2.2 + k * 0.4) * (18 * s * prog);
                    ctx.lineTo(spread + sway, ty);
                }

                ctx.strokeStyle = k % 2 === 0 ? 'rgba(34, 211, 238, 0.4)' : 'rgba(192, 132, 252, 0.35)';
                ctx.lineWidth = Math.max(0.8, 1.4 * s);
                ctx.stroke();

                // Neural action potential pulse travelling down tentacle
                const pulseProg = (localT * 0.6 + k * 0.12) % 1.0;
                const pY = 10 * s + pulseProg * tLen;
                const pSway = Math.sin(pulseProg * 3.5 - localT * 2.2 + k * 0.4) * (18 * s * pulseProg);
                ctx.fillStyle = '#f0fdf4';
                ctx.beginPath();
                ctx.arc(spread + pSway, pY, 2.2 * s, 0, Math.PI * 2);
                ctx.fill();
            }

            // Undulating oral arms (frilly central ribbons)
            for (let a = -1; a <= 1; a += 2) {
                ctx.beginPath();
                ctx.moveTo(a * 8 * s, 5 * s);
                for (let seg = 1; seg <= 12; seg++) {
                    const prog = seg / 12;
                    const ay = 5 * s + prog * 95 * s;
                    const ax = a * 8 * s + Math.sin(prog * 4 - localT * 2 + a) * 14 * s * prog;
                    ctx.lineTo(ax, ay);
                }
                ctx.strokeStyle = 'rgba(244, 114, 182, 0.45)';
                ctx.lineWidth = 3.5 * s;
                ctx.stroke();
            }

            // Translucent dome bell
            const bellW = (46 - contract * 14) * s;
            const bellH = (38 + contract * 12) * s;

            const bellGrad = ctx.createRadialGradient(0, -bellH * 0.3, 2, 0, 0, bellW * 1.2);
            bellGrad.addColorStop(0, 'rgba(165, 243, 252, 0.65)');
            bellGrad.addColorStop(0.5, 'rgba(34, 211, 238, 0.35)');
            bellGrad.addColorStop(0.85, 'rgba(168, 85, 247, 0.25)');
            bellGrad.addColorStop(1, 'rgba(34, 211, 238, 0.7)');

            ctx.fillStyle = bellGrad;
            ctx.beginPath();
            ctx.moveTo(-bellW, 0);
            ctx.bezierCurveTo(-bellW, -bellH * 1.2, bellW, -bellH * 1.2, bellW, 0);
            // Scalloped bottom rim
            ctx.quadraticCurveTo(bellW * 0.5, 6 * s, 0, 2 * s);
            ctx.quadraticCurveTo(-bellW * 0.5, 6 * s, -bellW, 0);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = 'rgba(224, 242, 254, 0.85)';
            ctx.lineWidth = 1.6 * s;
            ctx.stroke();

            // Internal four-leaf clover gonad organ
            for (let c = 0; c < 4; c++) {
                const cAngle = (c / 4) * Math.PI * 2 + localT * 0.1;
                const ox = Math.cos(cAngle) * 9 * s;
                const oy = -bellH * 0.35 + Math.sin(cAngle) * 7 * s;
                ctx.fillStyle = 'rgba(244, 114, 182, 0.5)';
                ctx.beginPath();
                ctx.arc(ox, oy, 5 * s, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.restore();
        });
        ctx.restore();
    },

    // 98. Golden Hour Meadow (Rolling Wind Waves & Wheat Silhouettes)
    drawGoldenHourMeadow(ctx, width, height, t) {
        ctx.save();
        // Warm sunset sky gradient
        const sky = ctx.createLinearGradient(0, 0, 0, height);
        sky.addColorStop(0, '#160802');
        sky.addColorStop(0.45, '#3b1405');
        sky.addColorStop(0.75, '#5a2208');
        sky.addColorStop(1, '#1a0902');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, width, height);

        // Warm setting sun orb on horizon
        const sunX = width * 0.68;
        const sunY = height * 0.58;
        const sunGrad = ctx.createRadialGradient(sunX, sunY, 5, sunX, sunY, Math.min(width, height) * 0.45);
        sunGrad.addColorStop(0, 'rgba(254, 240, 138, 0.65)');
        sunGrad.addColorStop(0.3, 'rgba(251, 146, 60, 0.35)');
        sunGrad.addColorStop(0.7, 'rgba(234, 88, 12, 0.12)');
        sunGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = sunGrad;
        ctx.fillRect(0, 0, width, height);

        // Three depth layers of swaying wheat & grasses
        const layers = [
            { count: 28, baseY: height * 0.82, color: '#78350f', strokeW: 1.6, amp: 26, headR: 3 },
            { count: 32, baseY: height * 0.92, color: '#b45309', strokeW: 2.0, amp: 32, headR: 4 },
            { count: 36, baseY: height * 1.02, color: '#f59e0b', strokeW: 2.4, amp: 38, headR: 4.5 }
        ];

        layers.forEach((lay, lIdx) => {
            const stepX = width / (lay.count - 1);
            for (let i = 0; i < lay.count; i++) {
                const rootX = i * stepX + ((i * 19) % 15) - 7;
                const rootY = lay.baseY;
                const stalkH = height * (0.35 + ((i * 7 + lIdx * 11) % 5) * 0.05);

                // Compound rolling wind wave
                const windPhase = rootX * 0.006 - t * (1.6 + lIdx * 0.3);
                const windBend = Math.sin(windPhase) * lay.amp + Math.cos(windPhase * 0.6) * (lay.amp * 0.4);

                const tipX = rootX + windBend;
                const tipY = rootY - stalkH;

                ctx.strokeStyle = lay.color;
                ctx.lineWidth = lay.strokeW;
                ctx.beginPath();
                ctx.moveTo(rootX, rootY);
                ctx.quadraticCurveTo(rootX + windBend * 0.35, rootY - stalkH * 0.5, tipX, tipY);
                ctx.stroke();

                // Wheat seeded head / grain spikelets
                ctx.fillStyle = lIdx === 2 ? '#fef08a' : lay.color;
                ctx.beginPath();
                ctx.ellipse(tipX, tipY, lay.headR, lay.headR * 2.2, windBend * 0.03, 0, Math.PI * 2);
                ctx.fill();

                // Delicate wheat awns (whisker bristles)
                for (let w = -2; w <= 2; w++) {
                    const awnY = tipY + w * 4;
                    const awnX = tipX + (w % 2 === 0 ? 5 : -5);
                    ctx.strokeStyle = 'rgba(254, 240, 138, 0.4)';
                    ctx.lineWidth = 0.8;
                    ctx.beginPath();
                    ctx.moveTo(tipX, awnY);
                    ctx.lineTo(awnX + windBend * 0.15, awnY - 8);
                    ctx.stroke();
                }
            }
        });

        // Drifting dandelion seeds & glowing evening pollen
        const seedCount = 24;
        ctx.fillStyle = 'rgba(254, 240, 138, 0.75)';
        for (let s = 0; s < seedCount; s++) {
            const seedSpeed = 38 + (s % 5) * 12;
            const sx = ((s * 53 + t * seedSpeed) % (width + 60)) - 30;
            const sy = height * 0.25 + ((s * 71) % (height * 0.6)) + Math.sin(t * 1.2 + s) * 14;
            ctx.beginPath();
            ctx.arc(sx, sy, 1.8, 0, Math.PI * 2);
            ctx.fill();

            // Parachute tuft lines
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx - 6, sy - 8);
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + 6, sy - 8);
            ctx.stroke();
        }
        ctx.restore();
    },

    // 99. Midnight Rain on Glass & Distant City Bokeh
    drawRainOnWindow(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#05070f';
        ctx.fillRect(0, 0, width, height);

        // Distant out-of-focus city streetlight bokeh discs
        const bokehOrbs = [
            { x: 0.18, y: 0.28, r: 42, col: 'rgba(251, 191, 36, 0.32)' },
            { x: 0.78, y: 0.35, r: 52, col: 'rgba(244, 114, 182, 0.28)' },
            { x: 0.45, y: 0.55, r: 36, col: 'rgba(6, 182, 212, 0.26)' },
            { x: 0.88, y: 0.65, r: 48, col: 'rgba(250, 204, 21, 0.30)' },
            { x: 0.28, y: 0.72, r: 38, col: 'rgba(239, 68, 68, 0.25)' },
            { x: 0.62, y: 0.82, r: 44, col: 'rgba(168, 85, 247, 0.24)' },
            { x: 0.35, y: 0.15, r: 30, col: 'rgba(255, 255, 255, 0.22)' }
        ];

        bokehOrbs.forEach(b => {
            const bx = b.x * width + Math.sin(t * 0.3 + b.r) * 12;
            const by = b.y * height + Math.cos(t * 0.25 + b.r) * 10;
            const grad = ctx.createRadialGradient(bx, by, 2, bx, by, b.r);
            grad.addColorStop(0, b.col);
            grad.addColorStop(0.7, b.col.replace(/[\d\.]+\)$/, '0.12)'));
            grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(bx, by, b.r, 0, Math.PI * 2);
            ctx.fill();
        });

        // Vertical water droplet slide trails (surface-tension tracks)
        const trails = 6;
        for (let tr = 0; tr < trails; tr++) {
            const tx = width * (0.15 + (tr / (trails - 1)) * 0.7) + ((tr * 37) % 25) - 12;
            const slideSpeed = 45 + (tr % 3) * 20;
            const headY = (t * slideSpeed + tr * 90) % (height + 120) - 40;

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(tx, 0);
            ctx.lineTo(tx, headY);
            ctx.stroke();

            // Sliding lead droplet with refractive highlight
            if (headY > 0 && headY < height) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
                ctx.beginPath();
                ctx.ellipse(tx, headY, 2.5, 4.5, 0, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Static clinging condensation raindrops with specular glints
        const dropCount = 42;
        for (let d = 0; d < dropCount; d++) {
            const dx = ((d * 89) % (width - 30)) + 15;
            const dy = ((d * 137) % (height - 30)) + 15;
            const dr = 2 + (d % 4) * 1.5;

            // Droplet dark shadow on bottom right
            ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
            ctx.beginPath();
            ctx.arc(dx + 0.8, dy + 0.8, dr, 0, Math.PI * 2);
            ctx.fill();

            // Droplet translucent liquid body
            ctx.fillStyle = 'rgba(224, 242, 254, 0.22)';
            ctx.beginPath();
            ctx.arc(dx, dy, dr, 0, Math.PI * 2);
            ctx.fill();

            // Specular white glint on top left
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.beginPath();
            ctx.arc(dx - dr * 0.35, dy - dr * 0.35, dr * 0.35, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    },

    // 100. Floating Sky Lanterns Over Midnight Mist (Yi Peng Festival)
    drawSkyLanterns(ctx, width, height, t) {
        ctx.save();
        // Night sky and misty water backdrop
        const sky = ctx.createLinearGradient(0, 0, 0, height);
        sky.addColorStop(0, '#040612');
        sky.addColorStop(0.65, '#0d1326');
        sky.addColorStop(1, '#020409');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, width, height);

        // Water reflection plane line at 85% height
        const waterY = height * 0.85;

        // 22 lanterns ascending at multiple depth tiers
        const lanterns = 22;
        for (let l = 0; l < lanterns; l++) {
            const speed = 12 + (l % 5) * 6;
            const depthFrac = 0.35 + (l / lanterns) * 0.65; // Scale & brightness
            const lx = ((l * 67 + Math.sin(t * 0.6 + l) * 18) % (width + 60)) - 30;
            const ly = ((height + 80) - ((t * speed + l * 45) % (height + 120))) - 20;

            const lW = 18 * depthFrac;
            const lH = 26 * depthFrac;
            const sway = Math.sin(t * 1.4 + l) * (2.5 * depthFrac);

            ctx.save();
            ctx.translate(lx, ly);
            ctx.rotate(sway * 0.03);

            // Ambient warmth glow around lantern
            const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, lW * 2.2);
            glow.addColorStop(0, `rgba(251, 191, 36, ${(0.45 * depthFrac).toFixed(2)})`);
            glow.addColorStop(0.6, `rgba(249, 115, 22, ${(0.18 * depthFrac).toFixed(2)})`);
            glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(0, 0, lW * 2.2, 0, Math.PI * 2);
            ctx.fill();

            // Translucent rice-paper cylinder body
            const paperGrad = ctx.createLinearGradient(0, -lH * 0.5, 0, lH * 0.5);
            paperGrad.addColorStop(0, `rgba(254, 240, 138, ${(0.7 * depthFrac).toFixed(2)})`);
            paperGrad.addColorStop(0.65, `rgba(251, 146, 60, ${(0.85 * depthFrac).toFixed(2)})`);
            paperGrad.addColorStop(1, `rgba(234, 88, 12, ${(0.95 * depthFrac).toFixed(2)})`);

            ctx.fillStyle = paperGrad;
            ctx.beginPath();
            ctx.roundRect(-lW * 0.5, -lH * 0.5, lW, lH, 3 * depthFrac);
            ctx.fill();

            ctx.strokeStyle = `rgba(254, 240, 138, ${(0.6 * depthFrac).toFixed(2)})`;
            ctx.lineWidth = Math.max(0.6, 1.2 * depthFrac);
            ctx.stroke();

            // Inner candle flame core
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.ellipse(0, lH * 0.25, 2.5 * depthFrac, 4 * depthFrac, 0, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();

            // Water reflection below horizon
            if (ly < waterY) {
                const reflY = waterY + (waterY - ly) * 0.45;
                if (reflY < height) {
                    const reflRipple = Math.sin(t * 3 + l + reflY * 0.05) * 6;
                    ctx.fillStyle = `rgba(251, 146, 60, ${(0.12 * depthFrac).toFixed(2)})`;
                    ctx.beginPath();
                    ctx.ellipse(lx + reflRipple, reflY, lW * 0.9, 3 * depthFrac, 0, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
        ctx.restore();
    },

    // 101. Polar Aurora Fjord (Emerald Ribbon Curtains & Mirror Waters)
    drawAuroraFjord(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#01040a';
        ctx.fillRect(0, 0, width, height);

        const waterLine = height * 0.72;

        // 4 Auroral Ribbon Curtains with vertical light striations
        const ribbons = [
            { col: '#10b981', baseY: height * 0.22, amp: 38, speed: 0.35, freq: 0.005 },
            { col: '#34d399', baseY: height * 0.32, amp: 48, speed: -0.28, freq: 0.007 },
            { col: '#a855f7', baseY: height * 0.42, amp: 42, speed: 0.42, freq: 0.006 },
            { col: '#22d3ee', baseY: height * 0.16, amp: 32, speed: -0.20, freq: 0.004 }
        ];

        ribbons.forEach(rib => {
            const stepX = 14;
            const steps = Math.ceil(width / stepX) + 1;

            for (let i = 0; i < steps; i++) {
                const x = i * stepX;
                const wave = Math.sin(x * rib.freq + t * rib.speed) * rib.amp +
                             Math.cos(x * rib.freq * 1.8 - t * rib.speed * 0.7) * (rib.amp * 0.45);
                const curtainTop = rib.baseY + wave - 60;
                const curtainBottom = rib.baseY + wave + 40;

                const grad = ctx.createLinearGradient(x, curtainTop, x, curtainBottom);
                grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
                grad.addColorStop(0.35, rib.col);
                grad.addColorStop(0.8, rib.col.replace(/#/, 'rgba(').concat('0.25)'));
                grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

                ctx.strokeStyle = grad;
                ctx.lineWidth = stepX * 1.3;
                ctx.globalAlpha = 0.45;
                ctx.beginPath();
                ctx.moveTo(x, curtainTop);
                ctx.lineTo(x, curtainBottom);
                ctx.stroke();
            }
        });

        // Mountain ridge silhouette across the middle
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = '#02050c';
        ctx.beginPath();
        ctx.moveTo(0, waterLine);
        const mPts = 18;
        for (let p = 0; p <= mPts; p++) {
            const mx = (width / mPts) * p;
            const peak = Math.sin(p * 1.3) * 45 + Math.cos(p * 2.7) * 22;
            ctx.lineTo(mx, waterLine - 35 - Math.abs(peak));
        }
        ctx.lineTo(width, waterLine);
        ctx.closePath();
        ctx.fill();

        // Calm dark fjord mirror water with horizontal light reflection
        const fjordGrad = ctx.createLinearGradient(0, waterLine, 0, height);
        fjordGrad.addColorStop(0, '#030a14');
        fjordGrad.addColorStop(1, '#010308');
        ctx.fillStyle = fjordGrad;
        ctx.fillRect(0, waterLine, width, height - waterLine);

        // Water reflection shimmering bands
        for (let r = 0; r < 8; r++) {
            const ry = waterLine + ((r + 1) / 9) * (height - waterLine);
            const rWave = Math.sin(t * 1.8 + r * 0.8) * 16;
            ctx.fillStyle = r % 2 === 0 ? 'rgba(52, 211, 153, 0.15)' : 'rgba(168, 85, 247, 0.12)';
            ctx.beginPath();
            ctx.ellipse(width * 0.5 + rWave, ry, width * 0.4, 2.5, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    },

    // 102. Tranquil Vapor & Incense Ribbons (KÅdÅ Sanctuary)
    drawTeaSteam(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#07050d';
        ctx.fillRect(0, 0, width, height);

        // Warm ambient glowing incense vessel at bottom center
        const cx = width * 0.5;
        const cy = height * 0.94;
        const emberGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, 28);
        emberGrad.addColorStop(0, '#fb7185');
        emberGrad.addColorStop(0.4, 'rgba(244, 63, 94, 0.45)');
        emberGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = emberGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, 28, 0, Math.PI * 2);
        ctx.fill();

        // 6 Curling fluid vapor & incense smoke strands
        const strands = 6;
        for (let s = 0; s < strands; s++) {
            const sPhase = s * 1.2;
            const riseSpeed = 32 + (s % 3) * 10;
            const rootX = cx + (s - (strands - 1) * 0.5) * 7;

            ctx.beginPath();
            ctx.moveTo(rootX, cy);

            const steps = 36;
            for (let step = 1; step <= steps; step++) {
                const prog = step / steps;
                const py = cy - prog * (height * 0.88);
                const curl1 = Math.sin(prog * 5 - t * (riseSpeed * 0.05) + sPhase) * (prog * 42);
                const curl2 = Math.cos(prog * 8 + t * 0.4 + sPhase) * (prog * 22);
                const px = rootX + curl1 + curl2;
                ctx.lineTo(px, py);
            }

            const smokeGrad = ctx.createLinearGradient(0, cy, 0, cy - height * 0.88);
            smokeGrad.addColorStop(0, 'rgba(253, 164, 175, 0.65)');
            smokeGrad.addColorStop(0.35, 'rgba(216, 180, 254, 0.45)');
            smokeGrad.addColorStop(0.75, 'rgba(192, 132, 252, 0.25)');
            smokeGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

            ctx.strokeStyle = smokeGrad;
            ctx.lineWidth = 2.4 + s * 0.5;
            ctx.lineCap = 'round';
            ctx.stroke();
        }
        ctx.restore();
    },

    // 103. Living Amethyst Crystal Geode & Mineral Strata
    drawAmethystGeode(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#060209';
        ctx.fillRect(0, 0, width, height);

        // Concentric outer mineral agate bands
        const bands = [
            { r: Math.min(width, height) * 0.48, col: '#1e1124' },
            { r: Math.min(width, height) * 0.43, col: '#2e1038' },
            { r: Math.min(width, height) * 0.38, col: '#4a1259' },
            { r: Math.min(width, height) * 0.33, col: '#6b21a8' }
        ];

        const cx = width * 0.5;
        const cy = height * 0.5;

        bands.forEach(b => {
            ctx.strokeStyle = b.col;
            ctx.lineWidth = 14;
            ctx.beginPath();
            ctx.arc(cx, cy, b.r, 0, Math.PI * 2);
            ctx.stroke();
        });

        // 16 Faceted raw amethyst crystal points growing inward
        const crystalCount = 16;
        const lightAngle = t * 0.4;

        for (let i = 0; i < crystalCount; i++) {
            const angle = (i / crystalCount) * Math.PI * 2 + 0.1;
            const baseDist = Math.min(width, height) * 0.33;
            const cLen = 45 + ((i * 13) % 4) * 18;
            const cW = 16;

            const bx = cx + Math.cos(angle) * baseDist;
            const by = cy + Math.sin(angle) * baseDist;
            const tipX = cx + Math.cos(angle) * (baseDist - cLen);
            const tipY = cy + Math.sin(angle) * (baseDist - cLen);

            const normX = -Math.sin(angle) * (cW * 0.5);
            const normY = Math.cos(angle) * (cW * 0.5);

            // Shifting specular light calculation
            const facetDot = Math.cos(angle - lightAngle);
            const lightFrac = Math.max(0.15, (facetDot + 1) * 0.5);

            ctx.save();

            // Left crystal facet
            ctx.fillStyle = `rgba(147, 51, 234, ${(0.4 + lightFrac * 0.45).toFixed(2)})`;
            ctx.beginPath();
            ctx.moveTo(bx - normX, by - normY);
            ctx.lineTo(tipX - normX * 0.4, tipY - normY * 0.4);
            ctx.lineTo(tipX, tipY);
            ctx.lineTo(bx, by);
            ctx.closePath();
            ctx.fill();

            // Right crystal facet (brighter specular gleam)
            ctx.fillStyle = `rgba(192, 132, 252, ${(0.3 + lightFrac * 0.6).toFixed(2)})`;
            ctx.beginPath();
            ctx.moveTo(bx + normX, by + normY);
            ctx.lineTo(tipX + normX * 0.4, tipY + normY * 0.4);
            ctx.lineTo(tipX, tipY);
            ctx.lineTo(bx, by);
            ctx.closePath();
            ctx.fill();

            // Sharp crystal edges
            ctx.strokeStyle = lightFrac > 0.7 ? '#fdf4ff' : 'rgba(233, 213, 255, 0.6)';
            ctx.lineWidth = 1.2;
            ctx.stroke();

            ctx.restore();
        }
        ctx.restore();
    },

    // 104. Gossamer Feathers (Weightless Iridescent Down Drift)
    drawDriftingFeathers(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#02050f';
        ctx.fillRect(0, 0, width, height);

        // 8 Weightless downy feathers twirling in 3D perspective
        const feathers = 8;
        for (let f = 0; f < feathers; f++) {
            const fSpeed = 22 + (f % 4) * 8;
            const fPhase = f * 1.5;
            const fy = ((t * fSpeed + f * 95) % (height + 140)) - 70;
            const fx = width * 0.5 + Math.sin(t * 0.6 + fPhase) * (width * 0.42);

            const fLen = 55 + (f % 3) * 18;
            const fW = fLen * 0.38;
            const tilt = Math.sin(t * 1.2 + fPhase) * 0.6;
            const flip3D = Math.cos(t * 0.8 + fPhase);

            ctx.save();
            ctx.translate(fx, fy);
            ctx.rotate(tilt);
            ctx.scale(flip3D, 1);

            // Central rachis (quill shaft)
            ctx.strokeStyle = '#f8fafc';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(0, -fLen * 0.5);
            ctx.quadraticCurveTo(fW * 0.15, 0, 0, fLen * 0.5);
            ctx.stroke();

            // Lateral barbs fanning out on both sides with iridescent teal & lavender sheen
            const barbs = 22;
            for (let b = 1; b < barbs; b++) {
                const prog = b / barbs;
                const by = -fLen * 0.5 + prog * fLen;
                const bSpan = Math.sin(prog * Math.PI) * fW;

                ctx.strokeStyle = f % 2 === 0 ? 'rgba(45, 212, 191, 0.45)' : 'rgba(192, 132, 252, 0.42)';
                ctx.lineWidth = 1.1;

                // Left barb
                ctx.beginPath();
                ctx.moveTo(0, by);
                ctx.lineTo(-bSpan, by + 5);
                ctx.stroke();

                // Right barb
                ctx.beginPath();
                ctx.moveTo(0, by);
                ctx.lineTo(bSpan, by + 5);
                ctx.stroke();
            }

            ctx.restore();
        }
        ctx.restore();
    },

    // 105. Celestial Silk Nebula (Turbulent Curl-Noise Cosmic Tapestry)
    drawCelestialSilkNebula(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#030209';
        ctx.fillRect(0, 0, width, height);

        // Volumetric deep nebula glows (zero shadowBlur, pure smooth radial gradients)
        const g1X = width * 0.35 + Math.sin(t * 0.15) * 45;
        const g1Y = height * 0.38 + Math.cos(t * 0.12) * 55;
        const rad1 = Math.max(width, height) * 0.45;
        const grad1 = ctx.createRadialGradient(g1X, g1Y, 0, g1X, g1Y, rad1);
        grad1.addColorStop(0, 'rgba(147, 51, 234, 0.18)');
        grad1.addColorStop(0.55, 'rgba(79, 70, 229, 0.08)');
        grad1.addColorStop(1, 'transparent');
        ctx.fillStyle = grad1;
        ctx.fillRect(0, 0, width, height);

        const g2X = width * 0.68 + Math.cos(t * 0.17) * 40;
        const g2Y = height * 0.64 + Math.sin(t * 0.14) * 45;
        const rad2 = Math.max(width, height) * 0.42;
        const grad2 = ctx.createRadialGradient(g2X, g2Y, 0, g2X, g2Y, rad2);
        grad2.addColorStop(0, 'rgba(14, 165, 233, 0.16)');
        grad2.addColorStop(0.5, 'rgba(236, 72, 153, 0.07)');
        grad2.addColorStop(1, 'transparent');
        ctx.fillStyle = grad2;
        ctx.fillRect(0, 0, width, height);

        // 16 Continuous flowing silk streamlines driven by 2D analytical curl noise
        const k1 = 0.0038, k2 = 0.0072, k3 = 0.0019;
        const t1 = t * 0.236, t2 = t * 0.382, t3 = t * 0.146;

        const ribbons = 16;
        const ptsPerRibbon = 22;
        const step = 14;

        const colors = [
            'rgba(244, 114, 182, 0.52)',
            'rgba(56, 189, 248, 0.50)',
            'rgba(192, 132, 252, 0.48)',
            'rgba(251, 191, 36, 0.45)',
            'rgba(52, 211, 153, 0.46)'
        ];

        for (let r = 0; r < ribbons; r++) {
            const seed = r * 1.6180339887;
            let px = (r * (width / ribbons) + Math.sin(seed + t * 0.11) * 35 + width) % width;
            let py = ((r * 137.5) % height + Math.cos(seed * 2 + t * 0.09) * 45 + height) % height;

            ctx.strokeStyle = colors[r % colors.length];
            ctx.lineWidth = 1.2 + (r % 3) * 0.5;

            ctx.beginPath();
            ctx.moveTo(px, py);

            for (let i = 0; i < ptsPerRibbon; i++) {
                const dPsiDy = -k1 * Math.sin(px * k1 + t1) * Math.sin(py * k1 + t2)
                             + 0.5 * k2 * Math.cos(px * k2 - t3 + py * k2)
                             - 0.25 * k3 * Math.sin((px + py) * k3 + t * 0.618);

                const dPsiDx = k1 * Math.cos(px * k1 + t1) * Math.cos(py * k1 + t2)
                             + 0.5 * k2 * Math.cos(px * k2 - t3 + py * k2)
                             - 0.25 * k3 * Math.sin((px + py) * k3 + t * 0.618);

                const u = dPsiDy * 800;
                const v = -dPsiDx * 800;
                const spd = Math.sqrt(u * u + v * v) + 0.0001;

                px += (u / spd) * step;
                py += (v / spd) * step;

                ctx.lineTo(px, py);

                if (i % 6 === 0) {
                    ctx.save();
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(px - 1, py - 1, 2, 2);
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
                    ctx.lineWidth = 0.8;
                    ctx.beginPath();
                    ctx.moveTo(px - 5, py); ctx.lineTo(px + 5, py);
                    ctx.moveTo(px, py - 5); ctx.lineTo(px, py + 5);
                    ctx.stroke();
                    ctx.restore();
                }
            }
            ctx.stroke();
        }
        ctx.restore();
    },

    // 106. Dendrite Frost Arbor (Microscopic Hexagonal Ice Crystallization)
    drawDendriteFrost(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#02050e';
        ctx.fillRect(0, 0, width, height);

        const coldGrad = ctx.createRadialGradient(width * 0.5, height * 0.5, 20, width * 0.5, height * 0.5, Math.max(width, height) * 0.7);
        coldGrad.addColorStop(0, '#040b1a');
        coldGrad.addColorStop(0.7, '#020611');
        coldGrad.addColorStop(1, '#010309');
        ctx.fillStyle = coldGrad;
        ctx.fillRect(0, 0, width, height);

        const nuclei = [
            { x: width * 0.5, y: height * 0.42, rMax: Math.min(width, height) * 0.38, seed: 0 },
            { x: width * 0.18, y: height * 0.18, rMax: Math.min(width, height) * 0.24, seed: 1.4 },
            { x: width * 0.82, y: height * 0.22, rMax: Math.min(width, height) * 0.26, seed: 2.8 },
            { x: width * 0.22, y: height * 0.78, rMax: Math.min(width, height) * 0.27, seed: 4.2 },
            { x: width * 0.78, y: height * 0.76, rMax: Math.min(width, height) * 0.29, seed: 5.6 }
        ];

        const HEX = Math.PI / 3;

        nuclei.forEach((nuc, idx) => {
            const rot = t * 0.04 + nuc.seed;
            const growthFront = 0.72 + 0.28 * Math.sin(t * 0.31 + nuc.seed * 1.7) * Math.cos(t * 0.19 + idx);
            const armLen = nuc.rMax * growthFront;

            ctx.save();
            ctx.translate(nuc.x, nuc.y);

            for (let a = 0; a < 6; a++) {
                const angle = rot + a * HEX;
                const cosA = Math.cos(angle);
                const sinA = Math.sin(angle);

                ctx.strokeStyle = idx === 0 ? '#f8fafc' : 'rgba(241, 245, 249, 0.9)';
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.lineTo(cosA * armLen, sinA * armLen);
                ctx.stroke();

                const steps = 9;
                for (let s = 1; s <= steps; s++) {
                    const frac = s / steps;
                    const d = frac * armLen;
                    const bx = cosA * d;
                    const by = sinA * d;

                    const subLen = (1 - frac) * (armLen * 0.36) * (0.8 + 0.2 * Math.sin(t * 0.7 + a + s));
                    const angLeft = angle - HEX;
                    const angRight = angle + HEX;

                    ctx.strokeStyle = s % 2 === 0 ? 'rgba(165, 243, 252, 0.7)' : 'rgba(196, 181, 253, 0.65)';
                    ctx.lineWidth = 1.1;

                    ctx.beginPath();
                    ctx.moveTo(bx, by);
                    const lx = bx + Math.cos(angLeft) * subLen;
                    const ly = by + Math.sin(angLeft) * subLen;
                    ctx.lineTo(lx, ly);
                    ctx.stroke();

                    if (s < 6 && subLen > 14) {
                        const tLen = subLen * 0.42;
                        ctx.beginPath();
                        ctx.moveTo(bx + (lx - bx) * 0.5, by + (ly - by) * 0.5);
                        ctx.lineTo(bx + (lx - bx) * 0.5 + Math.cos(angLeft + HEX) * tLen, by + (ly - by) * 0.5 + Math.sin(angLeft + HEX) * tLen);
                        ctx.stroke();
                    }

                    ctx.beginPath();
                    ctx.moveTo(bx, by);
                    const rx = bx + Math.cos(angRight) * subLen;
                    const ry = by + Math.sin(angRight) * subLen;
                    ctx.lineTo(rx, ry);
                    ctx.stroke();

                    if (s < 6 && subLen > 14) {
                        const tLen = subLen * 0.42;
                        ctx.beginPath();
                        ctx.moveTo(bx + (rx - bx) * 0.5, by + (ry - by) * 0.5);
                        ctx.lineTo(bx + (rx - bx) * 0.5 + Math.cos(angRight - HEX) * tLen, by + (ry - by) * 0.5 + Math.sin(angRight - HEX) * tLen);
                        ctx.stroke();
                    }
                }

                ctx.fillStyle = '#ffffff';
                ctx.fillRect(cosA * armLen - 1.5, sinA * armLen - 1.5, 3, 3);
            }

            ctx.fillStyle = 'rgba(224, 242, 254, 0.45)';
            ctx.beginPath();
            for (let c = 0; c < 6; c++) {
                const ca = rot + c * HEX;
                const cr = 6;
                const cx = Math.cos(ca) * cr;
                const cy = Math.sin(ca) * cr;
                if (c === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
            }
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.restore();
        });

        const dustCount = 18;
        for (let d = 0; d < dustCount; d++) {
            const dx = (d * 87.3 + Math.sin(t * 0.2 + d) * 25 + width) % width;
            const dy = (d * 143.7 + Math.cos(t * 0.15 + d * 2) * 30 + height) % height;
            const glint = Math.sin(t * 1.5 + d * 3.7);
            if (glint > 0.3) {
                ctx.fillStyle = `rgba(240, 249, 255, ${(glint * 0.8).toFixed(2)})`;
                ctx.fillRect(dx - 1, dy - 1, 2, 2);
            }
        }
        ctx.restore();
    },

    // 107. Abyssal Coral Reef (Living Deep Gorgonian Fan & Spores)
    drawBioluminescentCoral(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#010811';
        ctx.fillRect(0, 0, width, height);

        const oceanGrad = ctx.createLinearGradient(0, 0, 0, height);
        oceanGrad.addColorStop(0, '#02182b');
        oceanGrad.addColorStop(0.5, '#010f1c');
        oceanGrad.addColorStop(1, '#00050a');
        ctx.fillStyle = oceanGrad;
        ctx.fillRect(0, 0, width, height);

        const swell = (Math.sin(t * 0.636) * 0.6 + Math.sin(t * 0.383) * 0.3 + Math.sin(t * 0.229) * 0.1);

        const fans = [
            { rootX: width * 0.15, rootY: height, height: height * 0.65, angle: -Math.PI * 0.48, color: '#be123c', accent: '#34d399' },
            { rootX: width * 0.85, rootY: height, height: height * 0.68, angle: -Math.PI * 0.52, color: '#4338ca', accent: '#f43f5e' },
            { rootX: width * 0.48, rootY: height, height: height * 0.75, angle: -Math.PI * 0.50, color: '#047857', accent: '#a78bfa' },
            { rootX: width * 0.02, rootY: height * 0.7, height: height * 0.45, angle: -Math.PI * 0.25, color: '#9f1239', accent: '#38bdf8' }
        ];

        const drawBranch = (x, y, len, ang, depth, fanColor, polypColor) => {
            if (depth <= 0 || len < 6) return;

            const segSwell = swell * (0.04 + (6 - depth) * 0.02);
            const currentAng = ang + segSwell;

            const x2 = x + Math.cos(currentAng) * len;
            const y2 = y + Math.sin(currentAng) * len;

            ctx.strokeStyle = fanColor;
            ctx.lineWidth = Math.max(depth * 0.9, 0.8);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x2, y2);
            ctx.stroke();

            if (depth <= 3) {
                const polypPulse = 0.5 + 0.5 * Math.sin(t * 1.8 + depth * 1.2 + x2 * 0.05);
                ctx.fillStyle = polypColor;
                ctx.beginPath();
                ctx.arc(x2, y2, 1.8 * polypPulse + 0.8, 0, 6.283);
                ctx.fill();

                if (depth <= 2 && polypPulse > 0.4) {
                    ctx.strokeStyle = polypColor;
                    ctx.lineWidth = 0.6;
                    const tLen = 2.5;
                    ctx.beginPath();
                    ctx.moveTo(x2 - tLen, y2); ctx.lineTo(x2 + tLen, y2);
                    ctx.moveTo(x2, y2 - tLen); ctx.lineTo(x2, y2 + tLen);
                    ctx.stroke();
                }
            }

            const childLen = len * 0.74;
            drawBranch(x2, y2, childLen, currentAng - 0.38, depth - 1, fanColor, polypColor);
            drawBranch(x2, y2, childLen, currentAng + 0.38, depth - 1, fanColor, polypColor);
            if (depth === 5) {
                drawBranch(x2, y2, childLen * 0.85, currentAng + 0.05, depth - 2, fanColor, polypColor);
            }
        };

        fans.forEach(fan => {
            drawBranch(fan.rootX, fan.rootY, fan.height * 0.32, fan.angle, 5, fan.color, fan.accent);
        });

        const ruffledPoints = 20;
        ctx.fillStyle = 'rgba(244, 63, 94, 0.16)';
        ctx.beginPath();
        ctx.moveTo(0, height);
        for (let r = 0; r <= ruffledPoints; r++) {
            const rx = (r / ruffledPoints) * width;
            const ry = height - 25 - Math.sin(r * 1.2 + t * 1.2) * 15 - Math.cos(r * 0.6 - t * 0.8) * 8;
            ctx.lineTo(rx, ry);
        }
        ctx.lineTo(width, height);
        ctx.closePath();
        ctx.fill();

        const spores = 22;
        for (let s = 0; s < spores; s++) {
            const spd = 12 + (s % 5) * 6;
            const sy = ((height + 60) - ((t * spd + s * 45) % (height + 120)));
            const sx = (width * 0.5 + Math.sin(t * 0.5 + s * 1.7) * (width * 0.44) + Math.cos(t * 0.9 + s) * 20);

            const sporeColor = s % 3 === 0 ? 'rgba(52, 211, 153, ' : (s % 3 === 1 ? 'rgba(244, 63, 94, ' : 'rgba(56, 189, 248, ');
            const pulse = 0.5 + 0.5 * Math.sin(t * 2.2 + s * 2.5);

            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(sx, sy, 1.2, 0, 6.283);
            ctx.fill();

            ctx.fillStyle = `${sporeColor}${(0.45 * pulse).toFixed(2)})`;
            ctx.beginPath();
            ctx.arc(sx, sy, 3.5 * pulse + 1.5, 0, 6.283);
            ctx.fill();
        }
        ctx.restore();
    },

    // 108. Hyper-Prism Origami (3D Faceted Crystal Kinetic Sculpture)
    drawOrigamiKaleidoscope(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#060410';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const scale = Math.min(width, height) * 0.38;

        const rx = t * 0.28284;
        const ry = t * 0.34641;
        const rz = t * 0.22361;

        const cosX = Math.cos(rx), sinX = Math.sin(rx);
        const cosY = Math.cos(ry), sinY = Math.sin(ry);
        const cosZ = Math.cos(rz), sinZ = Math.sin(rz);

        const fold = 0.85 + 0.35 * Math.sin(t * 0.45) * Math.cos(t * 0.28);

        const phi = (1 + Math.sqrt(5)) * 0.5;
        const rawVerts = [
            [-1,  phi, 0], [ 1,  phi, 0], [-1, -phi, 0], [ 1, -phi, 0],
            [ 0, -1,  phi], [ 0,  1,  phi], [ 0, -1, -phi], [ 0,  1, -phi],
            [ phi, 0, -1], [ phi, 0,  1], [-phi, 0, -1], [-phi, 0,  1]
        ];

        const faces = [
            [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
            [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
            [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
            [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
        ];

        const projVerts = rawVerts.map(v => {
            let x = v[0] * fold;
            let y = v[1] * fold;
            let z = v[2] * fold;

            const x1 = x * cosY + z * sinY;
            const z1 = -x * sinY + z * cosY;
            const y2 = y * cosX - z1 * sinX;
            const z2 = y * sinX + z1 * cosX;
            const x3 = x1 * cosZ - y2 * sinZ;
            const y3 = x1 * sinZ + y2 * cosZ;

            const dist = 3.6;
            const pScale = scale / (z2 + dist);
            return {
                x2d: cx + x3 * pScale,
                y2d: cy + y3 * pScale,
                x3d: x3, y3d: y3, z3d: z2
            };
        });

        const lx = 0.577, ly = -0.577, lz = 0.577;

        const facetHues = [
            { r: 168, g: 85,  b: 247 },
            { r: 56,  g: 189, b: 248 },
            { r: 244, g: 63,  b: 94  },
            { r: 251, g: 191, b: 36  },
            { r: 52,  g: 211, b: 153 }
        ];

        const sortedFaces = faces.map((f, idx) => {
            const v0 = projVerts[f[0]];
            const v1 = projVerts[f[1]];
            const v2 = projVerts[f[2]];
            const zAvg = (v0.z3d + v1.z3d + v2.z3d) / 3;

            const ax = v1.x3d - v0.x3d, ay = v1.y3d - v0.y3d, az = v1.z3d - v0.z3d;
            const bx = v2.x3d - v0.x3d, by = v2.y3d - v0.y3d, bz = v2.z3d - v0.z3d;
            let nx = ay * bz - az * by;
            let ny = az * bx - ax * bz;
            let nz = ax * by - ay * bx;
            const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= nLen; ny /= nLen; nz /= nLen;

            const dotLight = Math.max(nx * lx + ny * ly + nz * lz, -0.2);
            return { f, zAvg, dotLight, idx };
        }).sort((a, b) => b.zAvg - a.zAvg);

        sortedFaces.forEach(sf => {
            const v0 = projVerts[sf.f[0]];
            const v1 = projVerts[sf.f[1]];
            const v2 = projVerts[sf.f[2]];

            const hue = facetHues[sf.idx % facetHues.length];
            const diffuse = Math.max(0, sf.dotLight);
            const alpha = 0.25 + diffuse * 0.55;

            ctx.fillStyle = `rgba(${hue.r}, ${hue.g}, ${hue.b}, ${alpha.toFixed(2)})`;
            ctx.beginPath();
            ctx.moveTo(v0.x2d, v0.y2d);
            ctx.lineTo(v1.x2d, v1.y2d);
            ctx.lineTo(v2.x2d, v2.y2d);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = diffuse > 0.6 ? '#fef08a' : 'rgba(251, 191, 36, 0.75)';
            ctx.lineWidth = 1.1;
            ctx.stroke();

            if (diffuse > 0.75) {
                ctx.fillStyle = `rgba(255, 255, 255, ${(diffuse * 0.7).toFixed(2)})`;
                ctx.beginPath();
                ctx.arc((v0.x2d + v1.x2d + v2.x2d) / 3, (v0.y2d + v1.y2d + v2.y2d) / 3, 2.5, 0, 6.283);
                ctx.fill();
            }
        });

        projVerts.forEach(pv => {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(pv.x2d - 1.5, pv.y2d - 1.5, 3, 3);
        });

        ctx.restore();
    },

    // 109. Mystic Koi Sanctuary (Articulated Swimming Kinematics & Sun Caustics)
    drawMysticKoi(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#021312';
        ctx.fillRect(0, 0, width, height);

        const pebbleCount = 28;
        for (let p = 0; p < pebbleCount; p++) {
            const px = ((p * 79.7) % width);
            const py = ((p * 123.3) % height);
            const pr = 10 + (p % 5) * 5;
            ctx.fillStyle = p % 2 === 0 ? 'rgba(6, 78, 59, 0.25)' : 'rgba(4, 47, 46, 0.35)';
            ctx.beginPath();
            ctx.ellipse(px, py, pr * 1.3, pr * 0.9, (p * 0.4), 0, 6.283);
            ctx.fill();
        }

        ctx.strokeStyle = 'rgba(204, 251, 241, 0.12)';
        ctx.lineWidth = 1.3;
        const cCols = 6, cRows = 8;
        const colW = width / cCols, rowH = height / cRows;
        for (let r = 0; r < cRows; r++) {
            ctx.beginPath();
            for (let c = 0; c <= cCols; c++) {
                const cx = c * colW + Math.sin(t * 0.8 + r * 1.1 + c * 0.7) * 14;
                const cy = r * rowH + Math.cos(t * 0.7 + c * 0.9 + r * 0.8) * 12;
                if (c === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
            }
            ctx.stroke();
        }

        const koiList = [
            { type: 'kohaku', speed: 0.22, orbitX: width * 0.45, orbitY: height * 0.42, radX: width * 0.35, radY: height * 0.32, phase: 0, bodyLen: 125 },
            { type: 'yamabuki', speed: 0.18, orbitX: width * 0.55, orbitY: height * 0.58, radX: width * 0.32, radY: height * 0.36, phase: 3.14, bodyLen: 115 }
        ];

        koiList.forEach(koi => {
            const kTime = t * koi.speed + koi.phase;
            const numVerts = 12;
            const spine = [];

            const hx = koi.orbitX + Math.sin(kTime) * koi.radX + Math.cos(kTime * 0.5) * (koi.radX * 0.3);
            const hy = koi.orbitY + Math.cos(kTime * 0.8) * koi.radY + Math.sin(kTime * 0.4) * (koi.radY * 0.25);

            const nextK = kTime + 0.05;
            const nhx = koi.orbitX + Math.sin(nextK) * koi.radX + Math.cos(nextK * 0.5) * (koi.radX * 0.3);
            const nhy = koi.orbitY + Math.cos(nextK * 0.8) * koi.radY + Math.sin(nextK * 0.4) * (koi.radY * 0.25);
            let heading = Math.atan2(nhy - hy, nhx - hx);

            const segDist = koi.bodyLen / (numVerts - 1);
            for (let v = 0; v < numVerts; v++) {
                const prog = v / (numVerts - 1);
                const wave = Math.sin(t * 2.8 - v * 0.48 + koi.phase) * (prog * prog * 18);
                const segAng = heading + Math.PI;
                const normAng = heading + Math.PI * 0.5;

                const vx = hx + Math.cos(segAng) * (v * segDist) + Math.cos(normAng) * wave;
                const vy = hy + Math.sin(segAng) * (v * segDist) + Math.sin(normAng) * wave;

                let halfW = 0;
                if (v === 0) halfW = 7;
                else if (v <= 4) halfW = 7 + (v / 4) * 11;
                else halfW = 18 * (1 - ((v - 4) / 7) * 0.78);

                spine.push({ x: vx, y: vy, w: halfW, normAng });
            }

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(spine[0].x, spine[0].y);
            for (let v = 0; v < numVerts; v++) {
                const lx = spine[v].x + Math.cos(spine[v].normAng) * spine[v].w;
                const ly = spine[v].y + Math.sin(spine[v].normAng) * spine[v].w;
                ctx.lineTo(lx, ly);
            }
            const tailV = spine[numVerts - 1];
            ctx.lineTo(tailV.x, tailV.y);
            for (let v = numVerts - 1; v >= 0; v--) {
                const rx = spine[v].x - Math.cos(spine[v].normAng) * spine[v].w;
                const ry = spine[v].y - Math.sin(spine[v].normAng) * spine[v].w;
                ctx.lineTo(rx, ry);
            }
            ctx.closePath();

            if (koi.type === 'kohaku') {
                ctx.fillStyle = '#f8fafc';
            } else {
                ctx.fillStyle = '#f59e0b';
            }
            ctx.fill();

            if (koi.type === 'kohaku') {
                ctx.fillStyle = '#dc2626';
                ctx.beginPath();
                ctx.ellipse(spine[1].x, spine[1].y, 14, 11, heading, 0, 6.283);
                ctx.fill();

                ctx.beginPath();
                ctx.ellipse(spine[5].x, spine[5].y, 16, 10, heading, 0, 6.283);
                ctx.fill();

                ctx.beginPath();
                ctx.ellipse(spine[8].x, spine[8].y, 9, 6, heading, 0, 6.283);
                ctx.fill();

                ctx.fillStyle = '#0f172a';
                ctx.beginPath();
                ctx.arc(spine[3].x + Math.cos(spine[3].normAng) * 6, spine[3].y + Math.sin(spine[3].normAng) * 6, 3.5, 0, 6.283);
                ctx.fill();
            } else {
                ctx.strokeStyle = '#fef08a';
                ctx.lineWidth = 1;
                for (let v = 2; v <= 7; v++) {
                    ctx.beginPath();
                    ctx.arc(spine[v].x, spine[v].y, spine[v].w * 0.7, heading - 1, heading + 1);
                    ctx.stroke();
                }
            }

            const finV = spine[2];
            const finFlutter = Math.sin(t * 3.5 + koi.phase) * 0.25;

            const leftFinAng = finV.normAng + 0.6 + finFlutter;
            const finLen = 38;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
            ctx.beginPath();
            ctx.moveTo(finV.x + Math.cos(finV.normAng) * finV.w, finV.y + Math.sin(finV.normAng) * finV.w);
            ctx.quadraticCurveTo(
                finV.x + Math.cos(leftFinAng) * (finLen * 0.7),
                finV.y + Math.sin(leftFinAng) * (finLen * 0.7),
                finV.x + Math.cos(leftFinAng + 0.3) * finLen,
                finV.y + Math.sin(leftFinAng + 0.3) * finLen
            );
            ctx.lineTo(finV.x + Math.cos(leftFinAng - 0.2) * (finLen * 0.75), finV.y + Math.sin(leftFinAng - 0.2) * (finLen * 0.75));
            ctx.closePath();
            ctx.fill();

            const rightFinAng = finV.normAng + Math.PI - 0.6 - finFlutter;
            ctx.beginPath();
            ctx.moveTo(finV.x - Math.cos(finV.normAng) * finV.w, finV.y - Math.sin(finV.normAng) * finV.w);
            ctx.quadraticCurveTo(
                finV.x + Math.cos(rightFinAng) * (finLen * 0.7),
                finV.y + Math.sin(rightFinAng) * (finLen * 0.7),
                finV.x + Math.cos(rightFinAng - 0.3) * finLen,
                finV.y + Math.sin(rightFinAng - 0.3) * finLen
            );
            ctx.lineTo(finV.x + Math.cos(rightFinAng + 0.2) * (finLen * 0.75), finV.y + Math.sin(rightFinAng + 0.2) * (finLen * 0.75));
            ctx.closePath();
            ctx.fill();

            const tailAng = spine[numVerts - 1].normAng + Math.PI * 0.5;
            const tLen = 48;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.beginPath();
            ctx.moveTo(tailV.x, tailV.y);
            ctx.quadraticCurveTo(
                tailV.x + Math.cos(tailAng - 0.5) * (tLen * 0.8),
                tailV.y + Math.sin(tailAng - 0.5) * (tLen * 0.8),
                tailV.x + Math.cos(tailAng - 0.3) * tLen,
                tailV.y + Math.sin(tailAng - 0.3) * tLen
            );
            ctx.lineTo(tailV.x + Math.cos(tailAng) * (tLen * 0.65), tailV.y + Math.sin(tailAng) * (tLen * 0.65));
            ctx.lineTo(tailV.x + Math.cos(tailAng + 0.3) * tLen, tailV.y + Math.sin(tailAng + 0.3) * tLen);
            ctx.quadraticCurveTo(
                tailV.x + Math.cos(tailAng + 0.5) * (tLen * 0.8),
                tailV.y + Math.sin(tailAng + 0.5) * (tLen * 0.8),
                tailV.x, tailV.y
            );
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = '#0f172a';
            const eyeDist = 6;
            ctx.beginPath();
            ctx.arc(spine[0].x + Math.cos(spine[0].normAng) * eyeDist, spine[0].y + Math.sin(spine[0].normAng) * eyeDist, 2, 0, 6.283);
            ctx.arc(spine[0].x - Math.cos(spine[0].normAng) * eyeDist, spine[0].y - Math.sin(spine[0].normAng) * eyeDist, 2, 0, 6.283);
            ctx.fill();

            ctx.restore();

            const rippleR = ((t * 25 + koi.phase * 40) % 70);
            const rippleAlpha = Math.max(0, 1 - (rippleR / 70)) * 0.35;
            ctx.strokeStyle = `rgba(204, 251, 241, ${rippleAlpha.toFixed(2)})`;
            ctx.lineWidth = 1.1;
            ctx.beginPath();
            ctx.arc(hx, hy, rippleR, 0, 6.283);
            ctx.stroke();
        });

        ctx.restore();
    },

    // 110. Astronomical Tourbillon (Gothic Astrolabe & Harmonic Clockwork)
    drawHyperboreanChronometer(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#080604';
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.5;
        const maxR = Math.min(width, height) * 0.44;

        const velvet = ctx.createRadialGradient(cx, cy, 10, cx, cy, maxR * 1.25);
        velvet.addColorStop(0, '#150f0a');
        velvet.addColorStop(0.7, '#080604');
        velvet.addColorStop(1, '#020101');
        ctx.fillStyle = velvet;
        ctx.fillRect(0, 0, width, height);

        const drawGear = (rBase, numTeeth, toothH, angle, strokeCol, fillCol, lineWidth = 1.2) => {
            const step = (Math.PI * 2) / numTeeth;
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(angle);

            ctx.beginPath();
            for (let i = 0; i < numTeeth; i++) {
                const a0 = i * step;
                const a1 = a0 + step * 0.25;
                const a2 = a0 + step * 0.5;
                const a3 = a0 + step * 0.75;
                const a4 = a0 + step;

                const rInner = rBase - toothH * 0.5;
                const rOuter = rBase + toothH * 0.5;

                if (i === 0) ctx.moveTo(Math.cos(a0) * rInner, Math.sin(a0) * rInner);
                ctx.lineTo(Math.cos(a1) * rOuter, Math.sin(a1) * rOuter);
                ctx.lineTo(Math.cos(a2) * rOuter, Math.sin(a2) * rOuter);
                ctx.lineTo(Math.cos(a3) * rInner, Math.sin(a3) * rInner);
                ctx.lineTo(Math.cos(a4) * rInner, Math.sin(a4) * rInner);
            }
            ctx.closePath();
            if (fillCol) { ctx.fillStyle = fillCol; ctx.fill(); }
            ctx.strokeStyle = strokeCol;
            ctx.lineWidth = lineWidth;
            ctx.stroke();
            ctx.restore();
        };

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(t * 0.015);

        ctx.strokeStyle = '#d97706';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(0, 0, maxR, 0, 6.283);
        ctx.arc(0, 0, maxR - 14, 0, 6.283);
        ctx.stroke();

        for (let i = 0; i < 72; i++) {
            const ang = (i / 72) * Math.PI * 2;
            const isMajor = i % 6 === 0;
            const len = isMajor ? 12 : 6;
            ctx.strokeStyle = isMajor ? '#fbbf24' : 'rgba(251, 191, 36, 0.45)';
            ctx.lineWidth = isMajor ? 1.4 : 0.8;
            ctx.beginPath();
            ctx.moveTo(Math.cos(ang) * (maxR - 1), Math.sin(ang) * (maxR - 1));
            ctx.lineTo(Math.cos(ang) * (maxR - len), Math.sin(ang) * (maxR - len));
            ctx.stroke();
        }
        ctx.restore();

        const gear1Speed = t * 0.08;
        drawGear(maxR - 22, 64, 7, gear1Speed, '#f59e0b', 'rgba(180, 83, 9, 0.08)', 1.3);

        const gear2Speed = -gear1Speed * (64 / 48);
        drawGear(maxR * 0.65, 48, 6, gear2Speed, '#fbbf24', 'rgba(251, 191, 36, 0.06)', 1.2);

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(t * 0.05);

        ctx.strokeStyle = 'rgba(254, 243, 199, 0.7)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(maxR * 0.22, 0, maxR * 0.38, maxR * 0.28, 0, 0, 6.283);
        ctx.stroke();

        const sunAng = t * 0.12;
        const sx = maxR * 0.22 + Math.cos(sunAng) * (maxR * 0.38);
        const sy = Math.sin(sunAng) * (maxR * 0.28);
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, 6.283);
        ctx.fill();
        ctx.restore();

        const tourbillonSpeed = t * 0.6;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(tourbillonSpeed);

        const cageR = maxR * 0.38;
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
            const ang = (i / 3) * Math.PI * 2;
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(ang) * cageR, Math.sin(ang) * cageR);
        }
        ctx.stroke();

        const balanceOsc = Math.sin(t * 20) * 0.6;
        ctx.save();
        ctx.rotate(balanceOsc);

        const balR = cageR * 0.78;
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(0, 0, balR, 0, 6.283);
        ctx.stroke();

        for (let s = 0; s < 12; s++) {
            const sang = (s / 12) * Math.PI * 2;
            ctx.fillStyle = '#fef08a';
            ctx.fillRect(Math.cos(sang) * balR - 1.2, Math.sin(sang) * balR - 1.2, 2.4, 2.4);
        }

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.85)';
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        for (let th = 0; th < Math.PI * 8; th += 0.2) {
            const sr = (th / (Math.PI * 8)) * (balR * 0.58);
            const px = Math.cos(th) * sr;
            const py = Math.sin(th) * sr;
            if (th === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = '#e11d48';
        ctx.beginPath();
        ctx.arc(0, 0, 5.5, 0, 6.283);
        ctx.fill();
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(1.5, -1.5, 1.3, 0, 6.283);
        ctx.fill();

        ctx.restore();
        ctx.restore();
    },

    // 111. Ancient Bonsai Spirit (Gnarled Pine Driftwood & Kodama Wisps)
    drawEnchantedBonsai(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#030a07';
        ctx.fillRect(0, 0, width, height);

        const mistGrad = ctx.createLinearGradient(0, 0, 0, height);
        mistGrad.addColorStop(0, '#04140e');
        mistGrad.addColorStop(0.5, '#071e16');
        mistGrad.addColorStop(1, '#020906');
        ctx.fillStyle = mistGrad;
        ctx.fillRect(0, 0, width, height);

        const mistWaves = 3;
        for (let m = 0; m < mistWaves; m++) {
            const mSpd = 0.15 + m * 0.08;
            const mY = height * (0.35 + m * 0.25);
            ctx.fillStyle = `rgba(209, 250, 229, ${(0.04 + m * 0.02).toFixed(2)})`;
            ctx.beginPath();
            ctx.moveTo(0, height);
            ctx.lineTo(0, mY);
            for (let x = 0; x <= width; x += 20) {
                const my = mY + Math.sin(x * 0.008 + t * mSpd + m * 2) * 18 + Math.cos(x * 0.015 - t * 0.1) * 10;
                ctx.lineTo(x, my);
            }
            ctx.lineTo(width, height);
            ctx.closePath();
            ctx.fill();
        }

        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.moveTo(0, height);
        ctx.lineTo(0, height * 0.75);
        ctx.lineTo(width * 0.25, height * 0.78);
        ctx.lineTo(width * 0.42, height * 0.88);
        ctx.lineTo(width * 0.48, height);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(71, 85, 105, 0.6)';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        const rootX = width * 0.32;
        const rootY = height * 0.84;

        ctx.save();
        ctx.strokeStyle = '#3d2516';
        ctx.lineWidth = 22;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(rootX, rootY);
        ctx.bezierCurveTo(
            rootX + 35, rootY - 60,
            rootX - 45, rootY - 140,
            rootX + 20, rootY - 220
        );
        ctx.stroke();

        ctx.strokeStyle = '#1e110a';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(rootX + 4, rootY);
        ctx.bezierCurveTo(
            rootX + 39, rootY - 60,
            rootX - 41, rootY - 140,
            rootX + 24, rootY - 220
        );
        ctx.stroke();

        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(rootX + 20, rootY - 220);
        ctx.lineTo(rootX + 35, rootY - 265);
        ctx.lineTo(rootX + 42, rootY - 285);
        ctx.stroke();

        const branches = [
            { x: rootX + 10, y: rootY - 80, ex: rootX - 75, ey: rootY - 105, w: 10 },
            { x: rootX + 5,  y: rootY - 130, ex: rootX + 90, ey: rootY - 150, w: 9 },
            { x: rootX - 15, y: rootY - 170, ex: rootX - 60, ey: rootY - 210, w: 7 },
            { x: rootX + 15, y: rootY - 210, ex: rootX + 80, ey: rootY - 235, w: 6 }
        ];

        branches.forEach(b => {
            ctx.strokeStyle = '#3d2516';
            ctx.lineWidth = b.w;
            ctx.beginPath();
            ctx.moveTo(b.x, b.y);
            ctx.quadraticCurveTo((b.x + b.ex) * 0.5, b.y + 15, b.ex, b.ey);
            ctx.stroke();

            for (let m = 0; m < 3; m++) {
                const mx = b.x + (b.ex - b.x) * (0.3 + m * 0.25);
                const my = b.y + (b.ey - b.y) * (0.3 + m * 0.25);
                ctx.strokeStyle = 'rgba(110, 231, 183, 0.35)';
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.moveTo(mx, my);
                ctx.quadraticCurveTo(mx + Math.sin(t * 0.8 + m) * 4, my + 14, mx, my + 24);
                ctx.stroke();
            }
        });
        ctx.restore();

        const cloudPads = [
            { x: rootX - 85,  y: rootY - 110, rx: 38, ry: 15, seed: 0 },
            { x: rootX + 100, y: rootY - 155, rx: 44, ry: 16, seed: 1.2 },
            { x: rootX - 65,  y: rootY - 215, rx: 35, ry: 14, seed: 2.4 },
            { x: rootX + 85,  y: rootY - 240, rx: 36, ry: 14, seed: 3.6 },
            { x: rootX + 15,  y: rootY - 235, rx: 42, ry: 17, seed: 4.8 },
            { x: rootX - 25,  y: rootY - 155, rx: 30, ry: 12, seed: 6.0 },
            { x: rootX + 45,  y: rootY - 275, rx: 28, ry: 11, seed: 7.2 }
        ];

        cloudPads.forEach(pad => {
            const windSway = Math.sin(t * 0.9 + pad.seed) * 3;
            const px = pad.x + windSway;
            const py = pad.y;

            ctx.fillStyle = '#064e3b';
            ctx.beginPath();
            ctx.ellipse(px, py, pad.rx, pad.ry, 0, 0, 6.283);
            ctx.fill();

            ctx.fillStyle = '#059669';
            ctx.beginPath();
            ctx.ellipse(px, py - 3, pad.rx * 0.85, pad.ry * 0.85, 0, 0, 6.283);
            ctx.fill();

            const numNeedles = 18;
            for (let n = 0; n < numNeedles; n++) {
                const nang = Math.PI + (n / numNeedles) * Math.PI;
                const nLen = pad.rx * 0.95;
                ctx.strokeStyle = '#34d399';
                ctx.lineWidth = 1.1;
                ctx.beginPath();
                ctx.moveTo(px, py - 2);
                ctx.lineTo(px + Math.cos(nang) * nLen, (py - 2) + Math.sin(nang) * (pad.ry * 0.9));
                ctx.stroke();
            }
        });

        const kodamas = 8;
        for (let k = 0; k < kodamas; k++) {
            const kSpd = 0.35 + (k % 3) * 0.12;
            const kTime = t * kSpd + k * 2.1;
            const kx = rootX + Math.sin(kTime * 0.7) * (width * 0.32) + Math.cos(kTime * 1.3) * 25;
            const ky = (rootY - 40) - ((kTime * 18 + k * 35) % (height * 0.65));

            ctx.save();
            ctx.fillStyle = 'rgba(254, 243, 199, 0.45)';
            ctx.beginPath();
            ctx.arc(kx, ky, 5, 0, 6.283);
            ctx.fill();

            ctx.fillStyle = '#fef3c7';
            ctx.beginPath();
            ctx.arc(kx, ky, 3.2, 0, 6.283);
            ctx.fill();

            ctx.fillStyle = '#1e293b';
            ctx.fillRect(kx - 1.2, ky - 0.5, 0.9, 1.2);
            ctx.fillRect(kx + 0.4, ky - 0.5, 0.9, 1.2);

            ctx.fillStyle = 'rgba(254, 243, 199, 0.6)';
            ctx.fillRect(kx - 0.5 + Math.sin(t * 2 + k) * 3, ky + 6, 1.2, 1.2);
            ctx.restore();
        }
        ctx.restore();
    },

    // 112. Iridescent Quicksilver (Viscous Liquid Metal & Thin-Film Shifts)
    drawLiquidQuicksilver(ctx, width, height, t) {
        ctx.save();
        ctx.fillStyle = '#07080d';
        ctx.fillRect(0, 0, width, height);

        const titanium = ctx.createLinearGradient(0, 0, width, height);
        titanium.addColorStop(0, '#0a0d14');
        titanium.addColorStop(0.5, '#05070a');
        titanium.addColorStop(1, '#0e1118');
        ctx.fillStyle = titanium;
        ctx.fillRect(0, 0, width, height);

        const drops = [
            { rx0: width * 0.48, ry0: height * 0.45, r: 48, spd: 0.35, fX: 1.1, fY: 0.9, phase: 0 },
            { rx0: width * 0.32, ry0: height * 0.32, r: 28, spd: 0.42, fX: 1.3, fY: 1.1, phase: 1.2 },
            { rx0: width * 0.68, ry0: height * 0.38, r: 32, spd: 0.38, fX: 0.9, fY: 1.4, phase: 2.5 },
            { rx0: width * 0.55, ry0: height * 0.68, r: 36, spd: 0.31, fX: 1.2, fY: 0.8, phase: 3.8 },
            { rx0: width * 0.25, ry0: height * 0.65, r: 24, spd: 0.48, fX: 1.5, fY: 1.3, phase: 5.1 },
            { rx0: width * 0.78, ry0: height * 0.72, r: 22, spd: 0.52, fX: 1.1, fY: 1.6, phase: 6.4 },
            { rx0: width * 0.15, ry0: height * 0.22, r: 16, spd: 0.58, fX: 1.7, fY: 1.2, phase: 0.8 },
            { rx0: width * 0.85, ry0: height * 0.25, r: 18, spd: 0.62, fX: 1.4, fY: 1.8, phase: 2.1 },
            { rx0: width * 0.42, ry0: height * 0.18, r: 14, spd: 0.68, fX: 1.9, fY: 1.5, phase: 3.4 },
            { rx0: width * 0.60, ry0: height * 0.85, r: 15, spd: 0.71, fX: 1.3, fY: 1.7, phase: 4.7 },
            { rx0: width * 0.35, ry0: height * 0.82, r: 12, spd: 0.75, fX: 1.6, fY: 1.4, phase: 5.9 },
            { rx0: width * 0.88, ry0: height * 0.52, r: 13, spd: 0.79, fX: 1.8, fY: 1.3, phase: 1.6 }
        ];

        const pos = drops.map(d => {
            const dx = d.rx0 + Math.sin(t * d.spd * d.fX + d.phase) * (width * 0.18);
            const dy = d.ry0 + Math.cos(t * d.spd * d.fY + d.phase) * (height * 0.18);
            return { x: dx, y: dy, r: d.r };
        });

        ctx.fillStyle = '#cbd5e1';
        for (let i = 0; i < pos.length; i++) {
            for (let j = i + 1; j < pos.length; j++) {
                const p1 = pos[i];
                const p2 = pos[j];
                const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                const maxBridgeDist = (p1.r + p2.r) * 1.35;

                if (dist < maxBridgeDist && dist > 1) {
                    const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
                    const norm = ang + Math.PI * 0.5;
                    const neckW = (1 - (dist / maxBridgeDist)) * Math.min(p1.r, p2.r) * 0.75;

                    ctx.beginPath();
                    ctx.moveTo(p1.x + Math.cos(norm) * p1.r, p1.y + Math.sin(norm) * p1.r);
                    ctx.quadraticCurveTo(
                        (p1.x + p2.x) * 0.5 + Math.cos(norm) * neckW,
                        (p1.y + p2.y) * 0.5 + Math.sin(norm) * neckW,
                        p2.x + Math.cos(norm) * p2.r, p2.y + Math.sin(norm) * p2.r
                    );
                    ctx.lineTo(p2.x - Math.cos(norm) * p2.r, p2.y - Math.sin(norm) * p2.r);
                    ctx.quadraticCurveTo(
                        (p1.x + p2.x) * 0.5 - Math.cos(norm) * neckW,
                        (p1.y + p2.y) * 0.5 - Math.sin(norm) * neckW,
                        p1.x - Math.cos(norm) * p1.r, p1.y - Math.sin(norm) * p1.r
                    );
                    ctx.closePath();
                    ctx.fill();
                }
            }
        }

        pos.forEach((p, idx) => {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.beginPath();
            ctx.ellipse(p.x, p.y + p.r * 0.25, p.r * 1.05, p.r * 0.75, 0, 0, 6.283);
            ctx.fill();

            const chrome = ctx.createLinearGradient(p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r);
            chrome.addColorStop(0, '#f8fafc');
            chrome.addColorStop(0.35, '#94a3b8');
            chrome.addColorStop(0.55, '#334155');
            chrome.addColorStop(0.7, '#cbd5e1');
            chrome.addColorStop(1, '#64748b');
            ctx.fillStyle = chrome;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, 6.283);
            ctx.fill();

            const colorPhase = t * 1.2 + idx * 0.8;
            const iridColors = [
                '#2dd4bf',
                '#a855f7',
                '#f43f5e',
                '#fbbf24'
            ];
            const ringCol = iridColors[Math.floor((colorPhase % 4 + 4) % 4)];
            ctx.strokeStyle = ringCol;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r - 0.8, 0, 6.283);
            ctx.stroke();

            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(p.r * 0.12, 1.8);
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r * 0.72, -Math.PI * 0.8, -Math.PI * 0.2);
            ctx.stroke();

            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(p.x - p.r * 0.45, p.y - p.r * 0.45, Math.max(p.r * 0.08, 1.2), 0, 6.283);
            ctx.fill();
        });

        ctx.restore();
    },

    drawPattern(ctx, width, height, patternKey) {
        const key = patternKey || this.selectedPattern || 'doodle';
        const t = this._simTime;
        switch (key) {
            case 'topography': this.drawTopography(ctx, width, height, t); break;
            case 'constellations': this.drawConstellations(ctx, width, height, t); break;
            case 'hexgrid': this.drawHexGrid(ctx, width, height, t); break;
            case 'circuit': this.drawCircuit(ctx, width, height, t); break;
            case 'seigaiha': this.drawZenWaves(ctx, width, height, t); break;
            case 'carbon': this.drawCarbon(ctx, width, height, t); break;
            case 'geometric': this.drawGeometric(ctx, width, height, t); break;
            case 'dna': this.drawDNA(ctx, width, height, t); break;
            case 'moire': this.drawMoire(ctx, width, height, t); break;
            case 'isometric': this.drawIsometric(ctx, width, height, t); break;
            case 'mandala': this.drawMandala(ctx, width, height, t); break;
            case 'ripples': this.drawRipples(ctx, width, height, t); break;
            case 'glitch': this.drawGlitch(ctx, width, height, t); break;
            case 'tessellation': this.drawArabesque(ctx, width, height, t); break;
            case 'sonar': this.drawSonar(ctx, width, height, t); break;
            case 'matrix': this.drawMatrix(ctx, width, height, t); break;
            case 'plasma': this.drawPlasma(ctx, width, height, t); break;
            case 'synthwave': this.drawSynthwave(ctx, width, height, t); break;
            case 'quantum': this.drawQuantum(ctx, width, height, t); break;
            case 'nebula': this.drawNebula(ctx, width, height, t); break;
            case 'voronoi': this.drawVoronoi(ctx, width, height, t); break;
            case 'origami': this.drawOrigami(ctx, width, height, t); break;
            case 'soundwave': this.drawSoundwave(ctx, width, height, t); break;
            case 'hypercube': this.drawHypercube(ctx, width, height, t); break;
            case 'fibonacci': this.drawFibonacci(ctx, width, height, t); break;
            case 'synapse': this.drawSynapse(ctx, width, height, t); break;
            case 'prism': this.drawPrism(ctx, width, height, t); break;
            case 'dunes': this.drawDunes(ctx, width, height, t); break;
            case 'megacity': this.drawMegacity(ctx, width, height, t); break;
            case 'vortex': this.drawVortex(ctx, width, height, t); break;
            case 'aurora_ribbon': this.drawAuroraRibbon(ctx, width, height, t); break;
            case 'blackhole': this.drawBlackHole(ctx, width, height, t); break;
            case 'circuit_gold': this.drawRoyalCircuit(ctx, width, height, t); break;
            case 'liquid_mercury': this.drawLiquidMercury(ctx, width, height, t); break;
            case 'crystal_lattice': this.drawEmeraldLattice(ctx, width, height, t); break;
            case 'hologram_globe': this.drawHoloGlobe(ctx, width, height, t); break;
            case 'neon_poly': this.drawNeonPoly(ctx, width, height, t); break;
            case 'sakura': this.drawSakura(ctx, width, height, t); break;
            case 'fractal_tree': this.drawFractalTree(ctx, width, height, t); break;
            case 'superconductor': this.drawQuantumFlux(ctx, width, height, t); break;
            case 'astrolabe': this.drawAstrolabe(ctx, width, height, t); break;
            case 'deep_abyss': this.drawDeepAbyss(ctx, width, height, t); break;
            case 'particle_vortex': this.drawParticleVortex(ctx, width, height, t); break;
            case 'quantum_cube': this.drawQuantumCube(ctx, width, height, t); break;
            case 'art_deco': this.drawArtDeco(ctx, width, height, t); break;
            case 'chrono_halo': this.drawChronoHalo(ctx, width, height, t); break;
            case 'solar_corona': this.drawSolarCorona(ctx, width, height, t); break;
            case 'zen_garden': this.drawZenGarden(ctx, width, height, t); break;
            case 'koi_pond': this.drawKoiPond(ctx, width, height, t); break;
            case 'fireflies': this.drawFireflies(ctx, width, height, t); break;
            case 'rain_window': this.drawRainWindow(ctx, width, height, t); break;
            case 'mandala_breathe': this.drawMandalaBreathe(ctx, width, height, t); break;
            case 'silk_flow': this.drawSilkFlow(ctx, width, height, t); break;
            case 'celestial_clock': this.drawCelestialClock(ctx, width, height, t); break;
            case 'ferrofluid': this.drawFerrofluid(ctx, width, height, t); break;
            case 'ocean_caustics': this.drawOceanCaustics(ctx, width, height, t); break;
            case 'sand_dune_drift': this.drawSandDunes(ctx, width, height, t); break;
            case 'harmonic_pendulum': this.drawHarmonicPendulum(ctx, width, height, t); break;
            case 'biolum_waves': this.drawBiolumWaves(ctx, width, height, t); break;
            case 'autumn_amber': this.drawAutumnLeaves(ctx, width, height, t); break;
            case 'nebula_cloud': this.drawNebulaCloud(ctx, width, height, t); break;
            case 'kinetic_chime': this.drawKineticChimes(ctx, width, height, t); break;
            case 'prism_caustic': this.drawPrismCaustics(ctx, width, height, t); break;
            case 'stained_glass': this.drawStainedGlass(ctx, width, height, t); break;
            case 'circuit_board': this.drawCircuitBoard(ctx, width, height, t); break;
            case 'topographic_canyon': this.drawTopographicCanyon(ctx, width, height, t); break;
            case 'sumi_mountains': this.drawSumiMountains(ctx, width, height, t); break;
            case 'shoji_bamboo': this.drawShojiBamboo(ctx, width, height, t); break;
            case 'synthwave_grid': this.drawSynthwaveGrid(ctx, width, height, t); break;
            case 'bauhaus_canvas': this.drawBauhausCanvas(ctx, width, height, t); break;
            case 'audio_spectrogram': this.drawAudioSpectrogram(ctx, width, height, t); break;
            case 'weaving_loom': this.drawWeavingLoom(ctx, width, height, t); break;
            case 'venetian_blinds': this.drawVenetianBlinds(ctx, width, height, t); break;
            case 'kinetic_facade': this.drawKineticFacade(ctx, width, height, t); break;
            case 'basalt_waterfall': this.drawBasaltWaterfall(ctx, width, height, t); break;
            case 'retro_terminal': this.drawRetroTerminal(ctx, width, height, t); break;
            case 'origami_facets': this.drawOrigamiFacets(ctx, width, height, t); break;
            case 'vhs_drift': this.drawVhsDrift(ctx, width, height, t); break;
            case 'penrose_isometric': this.drawPenroseIsometric(ctx, width, height, t); break;
            case 'fluted_glass': this.drawFlutedGlass(ctx, width, height, t); break;
            case 'wood_marquetry': this.drawWoodMarquetry(ctx, width, height, t); break;
            case 'seismic_drum': this.drawSeismicDrum(ctx, width, height, t); break;
            case 'isometric_city': this.drawIsometricCity(ctx, width, height, t); break;
            case 'papercraft_layers': this.drawPapercraftLayers(ctx, width, height, t); break;
            case 'hex_cipher': this.drawHexCipher(ctx, width, height, t); break;
            case 'laser_grating': this.drawLaserGrating(ctx, width, height, t); break;
            case 'silk_drapery': this.drawSilkDrapery(ctx, width, height, t); break;
            case 'rose_gold_marble': this.drawRoseGoldMarble(ctx, width, height, t); break;
            case 'sakura_river': this.drawSakuraRiver(ctx, width, height, t); break;
            case 'wisteria_breeze': this.drawWisteriaBreeze(ctx, width, height, t); break;
            case 'crystal_prism_room': this.drawCrystalPrisms(ctx, width, height, t); break;
            case 'opal_aurora': this.drawOpalAurora(ctx, width, height, t); break;
            case 'glasswing_butterfly': this.drawGlasswingButterfly(ctx, width, height, t); break;
            case 'velvet_peony': this.drawVelvetPeony(ctx, width, height, t); break;
            case 'cotton_candy_sunset': this.drawPastelClouds(ctx, width, height, t); break;
            case 'enchanted_jellyfish': this.drawEnchantedJellyfish(ctx, width, height, t); break;
            case 'golden_hour_meadow': this.drawGoldenHourMeadow(ctx, width, height, t); break;
            case 'rain_on_car_window': this.drawRainOnWindow(ctx, width, height, t); break;
            case 'floating_lantern_festival': this.drawSkyLanterns(ctx, width, height, t); break;
            case 'northern_lights_fjord': this.drawAuroraFjord(ctx, width, height, t); break;
            case 'sakura_tea_steam': this.drawTeaSteam(ctx, width, height, t); break;
            case 'amethyst_geode_growth': this.drawAmethystGeode(ctx, width, height, t); break;
            case 'feather_quill_whisper': this.drawDriftingFeathers(ctx, width, height, t); break;
            case 'celestial_silk_nebula': this.drawCelestialSilkNebula(ctx, width, height, t); break;
            case 'living_dendrite_frost': this.drawDendriteFrost(ctx, width, height, t); break;
            case 'bioluminescent_coral_abyss': this.drawBioluminescentCoral(ctx, width, height, t); break;
            case 'origami_kaleidoscope_shatter': this.drawOrigamiKaleidoscope(ctx, width, height, t); break;
            case 'mystic_koi_shadows': this.drawMysticKoi(ctx, width, height, t); break;
            case 'hyperborean_chronometer': this.drawHyperboreanChronometer(ctx, width, height, t); break;
            case 'enchanted_bonsai_spirit': this.drawEnchantedBonsai(ctx, width, height, t); break;
            case 'alchemical_liquid_quicksilver': this.drawLiquidQuicksilver(ctx, width, height, t); break;
            case 'doodle':
            default:
                this.drawDoodles(ctx, width, height, t);
                break;
        }
    },

    startLoop(forceRestart = false) {
        if (this._rafId) {
            if (!forceRestart) return;
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }

        let lastNow = performance.now();

        const renderFrame = (now) => {
            this._rafId = requestAnimationFrame(renderFrame);

            // Auto-pause if tab/window is hidden
            if (document.hidden) {
                lastNow = now;
                return;
            }

            // Smooth simulation delta with strict 50ms clamp (eliminates ALL snaps on lag or app resume)
            const dt = Math.min((now - lastNow) * 0.001, 0.05);
            lastNow = now;
            this._simTime += dt;

            // Butter-smooth per-frame Gyroscope LERP
            if (this.gyroEnabled) {
                this._currentTiltX += (this._targetTiltX - this._currentTiltX) * 0.08;
                this._currentTiltY += (this._targetTiltY - this._currentTiltY) * 0.08;
                const layer = document.getElementById('chat-wallpaper-layer');
                if (layer) {
                    layer.style.transform = `translate3d(${this._currentTiltX.toFixed(2)}px, ${this._currentTiltY.toFixed(2)}px, 0) scale(1.08)`;
                }
            }

            // Check if modal is open
            const modal = document.getElementById('wallpaper-modal');
            const previewCanvas = document.getElementById('wallpaper-preview-canvas');
            const isModalOpen = modal && !modal.classList.contains('hidden');

            // Render main chat wallpaper canvas (dynamic or pattern)
            // PERFORMANCE FIX: Skip drawing background chat canvas when modal is open to save GPU & frame budget!
            const chatLayer = document.getElementById('chat-wallpaper-layer');
            const chatCanvas = document.getElementById('chat-wallpaper-canvas');
            const isChatDynamic = chatLayer && chatLayer.classList.contains('has-dynamic');
            const isChatPattern = chatLayer && chatLayer.classList.contains('has-pattern');

            if (!isModalOpen && chatLayer && chatCanvas && (isChatDynamic || isChatPattern)) {
                this.syncCanvasSize(chatCanvas, isChatPattern);
                if (!this._chatCtx) this._chatCtx = chatCanvas.getContext('2d', { alpha: false });
                if (this._chatCtx) {
                    if (isChatDynamic) {
                        this.drawMesh(this._chatCtx, chatCanvas.width, chatCanvas.height, this.selectedPreset);
                    } else if (isChatPattern) {
                        this.drawPattern(this._chatCtx, chatCanvas.width, chatCanvas.height, this.selectedPattern);
                    }
                }
            }

            // Render modal preview canvas (ONLY if wallpaper modal is open)
            if (isModalOpen && previewCanvas) {
                if (this.currentMode === 'dynamic') {
                    this.syncCanvasSize(previewCanvas, false);
                    if (!this._previewCtx) this._previewCtx = previewCanvas.getContext('2d', { alpha: false });
                    if (this._previewCtx) {
                        this.drawMesh(this._previewCtx, previewCanvas.width, previewCanvas.height, this.selectedPreset);
                    }
                } else if (this.currentMode === 'patterns') {
                    this.syncCanvasSize(previewCanvas, true);
                    if (!this._previewCtx) this._previewCtx = previewCanvas.getContext('2d', { alpha: false });
                    if (this._previewCtx) {
                        this.drawPattern(this._previewCtx, previewCanvas.width, previewCanvas.height, this.selectedPattern);
                    }
                }
            }

            // Auto-pause loop if neither chat animation nor modal is active
            if (!isChatDynamic && !isChatPattern && !isModalOpen) {
                this.stopLoop();
            }
        };

        this._rafId = requestAnimationFrame(renderFrame);
    },

    stopLoop() {
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    },

    resume() {
        const chatLayer = document.getElementById('chat-wallpaper-layer');
        const modal = document.getElementById('wallpaper-modal');
        const modalOpen = modal && !modal.classList.contains('hidden');
        let isChatDynamic = chatLayer && chatLayer.classList.contains('has-dynamic');
        let isChatPattern = chatLayer && chatLayer.classList.contains('has-pattern');

        // Fail-safe: If user is inside an active chat but classes were dropped during suspend/restore
        if (!isChatDynamic && !isChatPattern && state?.activeChatId) {
            const savedWp = localStorage.getItem(`wp_${state.activeChatId}`);
            if (savedWp) {
                try {
                    const parsed = JSON.parse(savedWp);
                    if (parsed && parsed.image) {
                        this.applyToDOM(parsed.image, parsed.opacity);
                        return;
                    }
                } catch (e) {}
            }
        }

        if (isChatDynamic || isChatPattern || modalOpen) {
            const chatCanvas = document.getElementById('chat-wallpaper-canvas');
            if (chatCanvas) {
                this.syncCanvasSize(chatCanvas, isChatPattern);
            }
            if (modalOpen) {
                const previewCanvas = document.getElementById('wallpaper-preview-canvas');
                if (previewCanvas) {
                    this.syncCanvasSize(previewCanvas, this.currentMode === 'patterns');
                }
            }
            if (this.gyroEnabled && !this._gyroListening) {
                this.initGyroscope();
            }
            this.startLoop(true);
        }
    },

    applyToDOM(imageData, opacity) {
        const layer = document.getElementById('chat-wallpaper-layer');
        if (!layer) return;

        const canvas = document.getElementById('chat-wallpaper-canvas');
        const imgEl = document.getElementById('chat-wallpaper-image');
        const dimmer = document.getElementById('chat-wallpaper-dimmer');
        const dimVal = typeof opacity === 'number' ? opacity : 0.4;

        if (dimmer) dimmer.style.opacity = dimVal;

        if (!imageData) {
            // Cleared
            layer.classList.remove('has-dynamic', 'has-pattern', 'has-image');
            if (imgEl) imgEl.style.backgroundImage = '';
            this.stopLoop();
            if (canvas) {
                const ctx = canvas.getContext('2d');
                if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            this._chatCtx = null;
            this._previewCtx = null;
            return;
        }

        // Parse format: dynamic preset vs vector pattern vs custom image
        if (typeof imageData === 'string' && imageData.startsWith('dynamic:')) {
            const parts = imageData.split(':');
            const preset = parts[1] || 'aurora';
            const gyro = parts[2] !== 'no-gyro';

            layer.classList.remove('has-image', 'has-pattern');
            layer.classList.add('has-dynamic');
            if (imgEl) {
                imgEl.style.backgroundImage = '';
                imgEl.style.backgroundColor = '';
            }
            this.gyroEnabled = gyro;
            this.selectedPreset = preset;
            this.currentMode = 'dynamic';

            this.startLoop();
        } else if (typeof imageData === 'string' && imageData.startsWith('pattern:')) {
            const parts = imageData.split(':');
            const patternId = parts[1] || 'doodle';
            const gyro = parts[2] !== 'no-gyro';

            layer.classList.remove('has-dynamic', 'has-image');
            layer.classList.add('has-pattern');
            if (imgEl) {
                imgEl.style.backgroundImage = '';
                imgEl.style.backgroundColor = '';
            }
            this.gyroEnabled = gyro;
            this.selectedPattern = patternId;
            this.currentMode = 'patterns';

            this.startLoop();
        } else {
            // Custom Image
            let imgSrc = imageData;
            let gyro = true;
            if (typeof imageData === 'string' && imageData.includes('|gyro=')) {
                const parts = imageData.split('|gyro=');
                imgSrc = parts[0];
                gyro = parts[1] === 'true';
            }
            layer.classList.remove('has-dynamic', 'has-pattern');
            layer.classList.add('has-image');
            if (imgEl) {
                imgEl.style.backgroundImage = `url(${imgSrc})`;
                imgEl.style.backgroundRepeat = 'no-repeat';
                imgEl.style.backgroundSize = 'cover';
                imgEl.style.backgroundColor = '';
            }
            this.gyroEnabled = gyro;
            this.customImageData = imgSrc;
            this.currentMode = 'custom';
            this.stopLoop();
        }

        if (this.gyroEnabled) {
            this.initGyroscope();
        }
    }
};

let pendingWallpaper = null;

function setWallpaper(imageData, opacity) {
    WallpaperEngine.applyToDOM(imageData, opacity);
}

function syncWallpaperModalToCurrentState() {
    const currentWp = (state.activeChatId && localStorage.getItem(`wp_${state.activeChatId}`))
        ? JSON.parse(localStorage.getItem(`wp_${state.activeChatId}`) || '{}')
        : null;

    const preview = document.getElementById('wallpaper-preview');
    const previewCanvas = document.getElementById('wallpaper-preview-canvas');
    const previewImage = document.getElementById('wallpaper-preview-image');
    const previewDimmer = document.getElementById('wallpaper-preview-dimmer');
    const gyroToggle = document.getElementById('wallpaper-gyro-toggle');
    const opacitySlider = document.getElementById('wallpaper-opacity');
    const opacityValue = document.getElementById('opacity-value');

    const dimVal = (currentWp && typeof currentWp.opacity === 'number') ? currentWp.opacity : 0.4;
    const dimPercent = Math.round(dimVal * 100);
    if (opacitySlider) opacitySlider.value = dimPercent;
    if (opacityValue) opacityValue.textContent = `${dimPercent}%`;
    if (previewDimmer) previewDimmer.style.opacity = dimVal;

    if (currentWp && currentWp.image && currentWp.image.startsWith('dynamic:')) {
        const parts = currentWp.image.split(':');
        const preset = parts[1] || 'aurora';
        const gyro = parts[2] !== 'no-gyro';
        switchWallpaperTab('dynamic');
        selectWallpaperPreset(preset);
        if (gyroToggle) gyroToggle.checked = gyro;
        pendingWallpaper = currentWp.image;
    } else if (currentWp && currentWp.image && currentWp.image.startsWith('pattern:')) {
        const parts = currentWp.image.split(':');
        const patternId = parts[1] || 'doodle';
        const gyro = parts[2] !== 'no-gyro';
        switchWallpaperTab('patterns');
        selectWallpaperPattern(patternId);
        if (gyroToggle) gyroToggle.checked = gyro;
        pendingWallpaper = currentWp.image;
    } else if (currentWp && currentWp.image) {
        switchWallpaperTab('custom');
        let imgSrc = currentWp.image;
        let gyro = true;
        if (imgSrc.includes('|gyro=')) {
            const parts = imgSrc.split('|gyro=');
            imgSrc = parts[0];
            gyro = parts[1] === 'true';
        }
        if (gyroToggle) gyroToggle.checked = gyro;
        if (preview) {
            preview.classList.remove('has-dynamic', 'has-pattern');
            preview.classList.add('has-image');
        }
        if (previewImage) {
            previewImage.style.backgroundImage = `url(${imgSrc})`;
            previewImage.style.backgroundRepeat = 'no-repeat';
            previewImage.style.backgroundSize = 'cover';
            previewImage.style.backgroundColor = '';
        }
        pendingWallpaper = currentWp.image;
    } else {
        // Default to Aurora dynamic preset
        switchWallpaperTab('dynamic');
        selectWallpaperPreset('aurora');
        if (gyroToggle) gyroToggle.checked = true;
        updatePendingDynamicWallpaper();
    }
}

function openWallpaperModal() {
    const modal = document.getElementById('wallpaper-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    syncWallpaperModalToCurrentState();
    WallpaperEngine.startLoop();
    window.BackNavManager?.push('wallpaper-modal', () => {
        closeWallpaperModal(true);
    });
}

function closeWallpaperModal(fromPop = false) {
    if (typeof window._markModalClosed === 'function') window._markModalClosed();
    const modal = document.getElementById('wallpaper-modal');
    if (modal) modal.classList.add('hidden');
    if (!fromPop && window.BackNavManager?.has('wallpaper-modal')) {
        window.BackNavManager.pop('wallpaper-modal');
    }
    const layer = document.getElementById('chat-wallpaper-layer');
    const isDynamic = layer && layer.classList.contains('has-dynamic');
    const isPattern = layer && layer.classList.contains('has-pattern');
    if (!isDynamic && !isPattern) {
        WallpaperEngine.stopLoop();
    }
}

function switchWallpaperTab(tab) {
    WallpaperEngine.currentMode = tab;
    document.querySelectorAll('.wp-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    const panelDynamic = document.getElementById('wp-panel-dynamic');
    const panelPatterns = document.getElementById('wp-panel-patterns');
    const panelCustom = document.getElementById('wp-panel-custom');
    if (panelDynamic) panelDynamic.classList.toggle('active', tab === 'dynamic');
    if (panelPatterns) panelPatterns.classList.toggle('active', tab === 'patterns');
    if (panelCustom) panelCustom.classList.toggle('active', tab === 'custom');

    const preview = document.getElementById('wallpaper-preview');
    const previewImage = document.getElementById('wallpaper-preview-image');
    if (tab === 'dynamic') {
        if (preview) {
            preview.classList.remove('has-image', 'has-pattern');
            preview.classList.add('has-dynamic');
        }
        if (previewImage) {
            previewImage.style.backgroundImage = '';
            previewImage.style.backgroundColor = '';
        }
        WallpaperEngine._previewCtx = null;
        WallpaperEngine.startLoop();
        updatePendingDynamicWallpaper();
    } else if (tab === 'patterns') {
        if (preview) {
            preview.classList.remove('has-image', 'has-dynamic');
            preview.classList.add('has-pattern');
        }
        if (previewImage) {
            previewImage.style.backgroundImage = '';
            previewImage.style.backgroundColor = '';
        }
        WallpaperEngine._previewCtx = null;
        WallpaperEngine.startLoop();
        selectWallpaperPattern(WallpaperEngine.selectedPattern || 'doodle');
    } else {
        if (preview) {
            preview.classList.remove('has-dynamic', 'has-pattern');
            if (WallpaperEngine.customImageData) {
                preview.classList.add('has-image');
            } else {
                preview.classList.remove('has-image');
            }
        }
        WallpaperEngine.stopLoop();
        updatePendingCustomWallpaper();
    }
}

function selectWallpaperPreset(preset) {
    WallpaperEngine.currentMode = 'dynamic';
    WallpaperEngine.selectedPreset = preset;
    document.querySelectorAll('#wp-panel-dynamic .wp-preset-card').forEach(card => {
        card.classList.toggle('active', card.dataset.preset === preset);
    });

    const preview = document.getElementById('wallpaper-preview');
    const previewImage = document.getElementById('wallpaper-preview-image');
    if (preview) {
        preview.classList.remove('has-pattern', 'has-image');
        preview.classList.add('has-dynamic');
    }
    if (previewImage) {
        previewImage.style.backgroundImage = '';
        previewImage.style.backgroundColor = '';
    }
    WallpaperEngine._previewCtx = null;
    WallpaperEngine.startLoop();
    updatePendingDynamicWallpaper();
}

function selectWallpaperPattern(patternId) {
    WallpaperEngine.currentMode = 'patterns';
    WallpaperEngine.selectedPattern = patternId;

    // Fast targeted active toggle instead of iterating all 104 cards
    const prevActive = document.querySelector('#wp-panel-patterns .wp-preset-card.active');
    if (prevActive && prevActive.dataset.pattern !== patternId) {
        prevActive.classList.remove('active');
    }
    const newActive = document.querySelector(`#wp-panel-patterns .wp-preset-card[data-pattern="${patternId}"]`);
    if (newActive) {
        newActive.classList.add('active');
    }

    const preview = document.getElementById('wallpaper-preview');
    const previewImage = document.getElementById('wallpaper-preview-image');
    if (preview) {
        preview.classList.remove('has-dynamic', 'has-image');
        preview.classList.add('has-pattern');
    }
    if (previewImage) {
        previewImage.style.backgroundImage = '';
        previewImage.style.backgroundColor = '';
    }
    WallpaperEngine._previewCtx = null;
    WallpaperEngine.startLoop();
    updatePendingPatternWallpaper();
}

function updatePendingDynamicWallpaper() {
    const gyroToggle = document.getElementById('wallpaper-gyro-toggle');
    const gyro = gyroToggle ? gyroToggle.checked : true;
    pendingWallpaper = `dynamic:${WallpaperEngine.selectedPreset}:${gyro ? 'gyro' : 'no-gyro'}`;
}

function updatePendingPatternWallpaper() {
    const gyroToggle = document.getElementById('wallpaper-gyro-toggle');
    const gyro = gyroToggle ? gyroToggle.checked : true;
    pendingWallpaper = `pattern:${WallpaperEngine.selectedPattern || 'doodle'}:${gyro ? 'gyro' : 'no-gyro'}`;
}

function updatePendingCustomWallpaper() {
    if (!WallpaperEngine.customImageData) return;
    const gyroToggle = document.getElementById('wallpaper-gyro-toggle');
    const gyro = gyroToggle ? gyroToggle.checked : true;
    pendingWallpaper = `${WallpaperEngine.customImageData}|gyro=${gyro}`;
}

async function handleWallpaperFile(file) {
    if (!file || !file.type.startsWith('image/')) return;

    const compressed = await compressWallpaper(file);
    WallpaperEngine.customImageData = compressed;

    const preview = document.getElementById('wallpaper-preview');
    const previewImage = document.getElementById('wallpaper-preview-image');
    if (preview) {
        preview.classList.remove('has-dynamic');
        preview.classList.add('has-image');
    }
    if (previewImage) {
        previewImage.style.backgroundImage = `url(${compressed})`;
        previewImage.style.backgroundRepeat = 'no-repeat';
        previewImage.style.backgroundSize = 'cover';
        previewImage.style.backgroundColor = '';
    }
    const statusLabel = document.getElementById('wallpaper-file-status');
    if (statusLabel) {
        statusLabel.textContent = file.name ? `Selected: ${file.name.slice(0, 20)}` : 'Photo Selected';
    }
    updatePendingCustomWallpaper();
}

function updateOpacityDisplay() {
    const slider = document.getElementById('wallpaper-opacity');
    if (!slider) return;
    const val = parseInt(slider.value, 10);
    const opacity = val / 100;
    const label = document.getElementById('opacity-value');
    if (label) label.textContent = `${val}%`;

    const previewDimmer = document.getElementById('wallpaper-preview-dimmer');
    if (previewDimmer) previewDimmer.style.opacity = opacity;
}

async function compressWallpaper(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const maxDim = 1200;
                let { width, height } = img;
                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round(height * maxDim / width);
                        width = maxDim;
                    } else {
                        width = Math.round(width * maxDim / height);
                        height = maxDim;
                    }
                }
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.7));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function applyWallpaper() {
    if (!state.activeChatId) return;

    if (WallpaperEngine.currentMode === 'dynamic') {
        updatePendingDynamicWallpaper();
    } else if (WallpaperEngine.currentMode === 'patterns') {
        updatePendingPatternWallpaper();
    } else {
        updatePendingCustomWallpaper();
    }

    if (!pendingWallpaper) return;

    // iOS permission request if applicable
    if (typeof WallpaperEngine.requestGyroPermission === 'function') {
        WallpaperEngine.requestGyroPermission();
    }

    const applyBtn = document.getElementById('wallpaper-apply');
    const origText = applyBtn ? applyBtn.textContent : '';
    if (applyBtn) {
        applyBtn.textContent = 'Applying...';
        applyBtn.disabled = true;
    }

    const opacity = parseInt(document.getElementById('wallpaper-opacity')?.value || '40', 10) / 100;

    try {
        await apiFetch(`/api/chat/${state.activeChatId}/wallpaper`, {
            method: 'POST',
            body: JSON.stringify({ image: pendingWallpaper, opacity })
        });

        // Cache locally for instant loading
        const wpCacheKey = `wp_${state.activeChatId}`;
        localStorage.setItem(wpCacheKey, JSON.stringify({ image: pendingWallpaper, opacity }));

        // Apply locally
        setWallpaper(pendingWallpaper, opacity);

        if (applyBtn) applyBtn.textContent = 'Applied!';
        setTimeout(() => {
            if (applyBtn) {
                applyBtn.textContent = origText || 'Apply Wallpaper';
                applyBtn.disabled = false;
            }
            closeWallpaperModal();
        }, 300);
    } catch (e) {
        console.error('Failed to set wallpaper:', e);
        if (applyBtn) {
            applyBtn.textContent = origText || 'Apply Wallpaper';
            applyBtn.disabled = false;
        }
    }
}

async function clearWallpaper() {
    if (!state.activeChatId) return;

    try {
        await apiFetch(`/api/chat/${state.activeChatId}/wallpaper`, {
            method: 'POST',
            body: JSON.stringify({ image: null, opacity: 0 })
        });

        const wpCacheKey = `wp_${state.activeChatId}`;
        localStorage.removeItem(wpCacheKey);

        setWallpaper(null, 0);
        closeWallpaperModal();
    } catch (e) {
        console.error('Failed to clear wallpaper:', e);
    }
}

// Wallpaper Event Listeners Setup
function initWallpaperEventListeners() {
    document.getElementById('wallpaper-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openWallpaperModal();
    });
    document.getElementById('wallpaper-close')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof window._markModalClosed === 'function') window._markModalClosed();
        closeWallpaperModal(false);
    });
    document.getElementById('wallpaper-input')?.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) handleWallpaperFile(e.target.files[0]);
    });
    document.getElementById('wallpaper-opacity')?.addEventListener('input', updateOpacityDisplay);
    document.getElementById('wallpaper-apply')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        applyWallpaper();
    });
    document.getElementById('wallpaper-clear')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearWallpaper();
    });

    // Tab buttons
    document.querySelectorAll('.wp-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            switchWallpaperTab(btn.dataset.tab);
        });
    });

    // Preset & Pattern cards
    document.querySelectorAll('.wp-preset-card').forEach(card => {
        card.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (card.dataset.preset) {
                selectWallpaperPreset(card.dataset.preset);
            } else if (card.dataset.pattern) {
                selectWallpaperPattern(card.dataset.pattern);
            }
        });
    });

    // Render thumbnail pattern previews
    document.querySelectorAll('.preset-thumb.pattern-thumb').forEach(thumb => {
        const card = thumb.closest('.wp-preset-card');
        const patKey = card?.dataset.pattern;
        if (patKey && WallpaperEngine.PATTERNS[patKey]) {
            const pat = WallpaperEngine.PATTERNS[patKey];
            thumb.style.backgroundImage = `url("${WallpaperEngine.getPatternDataUrl(patKey)}")`;
            thumb.style.backgroundColor = pat.bgColor;
            thumb.style.backgroundRepeat = 'repeat';
            thumb.style.backgroundSize = pat.bgSize;
        }
    });

    // Gyroscope toggle
    document.getElementById('wallpaper-gyro-toggle')?.addEventListener('change', (e) => {
        if (e.target.checked && typeof WallpaperEngine.requestGyroPermission === 'function') {
            WallpaperEngine.requestGyroPermission();
        }
        if (WallpaperEngine.currentMode === 'dynamic') {
            updatePendingDynamicWallpaper();
        } else if (WallpaperEngine.currentMode === 'patterns') {
            updatePendingPatternWallpaper();
        } else {
            updatePendingCustomWallpaper();
        }
    });

    // Delegated click listener to catch #menu-wallpaper injected by calls.js
    document.addEventListener('click', (e) => {
        if (e.target.closest('#menu-wallpaper')) {
            openWallpaperModal();
        }
    });

    // Visibility & Lifecycle auto-sleep and resume
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            WallpaperEngine.stopLoop();
        } else {
            WallpaperEngine.resume();
        }
    });

    // Mutation observer so any time #wallpaper-modal is un-hidden, it auto-syncs
    const wpModalEl = document.getElementById('wallpaper-modal');
    if (wpModalEl) {
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.attributeName === 'class' && !wpModalEl.classList.contains('hidden')) {
                    syncWallpaperModalToCurrentState();
                }
            }
        });
        observer.observe(wpModalEl, { attributes: true, attributeFilter: ['class'] });
    }
}
initWallpaperEventListeners();

// Global exports
window.openWallpaperModal = openWallpaperModal;
window.closeWallpaperModal = closeWallpaperModal;
window.WallpaperEngine = WallpaperEngine;


// =========================================
// Swipe to Reply Feature
// =========================================
let replyingTo = null; // { from, text, id, mediaSrc, mediaType }

function extractReplyDetails(msgEl) {
    const from = msgEl.dataset.from || 'Unknown';
    const msgId = msgEl.dataset.id || msgEl.dataset.clientId;
    let text = msgEl.querySelector('.msg-text')?.textContent?.trim() || '';
    let imgSrc = msgEl.querySelector('.message-gif')?.src || msgEl.querySelector('.message-image')?.src || msgEl.querySelector('.lp-image')?.src || null;
    let mediaType = null;

    if (msgEl.querySelector('.voice-note, audio, .msg-audio') || msgEl.dataset.mediaType === 'audio') {
        mediaType = 'audio';
        text = text || 'Voice message';
    } else if (msgEl.querySelector('video, .msg-video') || msgEl.dataset.mediaType === 'video') {
        mediaType = 'video';
        text = text || 'Video';
    } else if (imgSrc) {
        mediaType = 'image';
        text = text || 'Photo';
    } else if (msgEl.querySelector('.media-download-card, .file-card')) {
        text = text || msgEl.querySelector('.media-card-title')?.textContent?.trim() || 'Attachment';
    }

    return { from, text, msgId, imgSrc, mediaType };
}

function setReplyTo(from, text, msgId, mediaSrc = null, mediaType = null) {
    // Store mediaSrc and mediaType so sendMessage can pick it up
    replyingTo = { from, text, id: msgId, mediaSrc, mediaType };
    const preview = document.getElementById('reply-preview');
    if (!preview) return;
    preview.querySelector('.reply-name').textContent = from;
    preview.querySelector('.reply-text').textContent = text;

    // Handle media thumbnail for Images, GIFs, Videos, and Audio
    const mediaEl = preview.querySelector('.reply-media');
    if (mediaEl) {
        if (mediaSrc && (mediaType === 'image' || mediaType === 'gif' || (!mediaType && (mediaSrc.startsWith('http') || mediaSrc.startsWith('data:') || mediaSrc.startsWith('blob:'))))) {
            mediaEl.innerHTML = `<img src="${mediaSrc}" alt="Reply media" style="width: 100%; height: 100%; object-fit: cover;">`;
            mediaEl.classList.remove('hidden');
        } else if (mediaType === 'video') {
            mediaEl.innerHTML = `<div style="width:100%;height:100%;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;color:#3b82f6;"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg></div>`;
            mediaEl.classList.remove('hidden');
        } else if (mediaType === 'audio') {
            mediaEl.innerHTML = `<div style="width:100%;height:100%;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;color:#10b981;"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg></div>`;
            mediaEl.classList.remove('hidden');
        } else {
            mediaEl.innerHTML = '';
            mediaEl.classList.add('hidden');
        }
    }

    preview.classList.remove('hidden');
    // Never auto-focus input here â€” keyboard should only open when user taps the message input box
}

function clearReply() {
    replyingTo = null;
    const preview = document.getElementById('reply-preview');
    if (preview) preview.classList.add('hidden');
}

document.getElementById('reply-close')?.addEventListener('click', clearReply);

// Touch swipe handler for messages
let swipeStartX = 0;
let swipeStartY = 0;
let swipeCurrentX = 0;
let swipeDirection = null; // 'horizontal', 'vertical', or null
let swipingMessage = null;
let longPressTimer = null;
let mouseDownTimer = null;
let _lastTouchEndTime = 0;

window._isUserTouching = false;

function cancelAllReactionTimers() {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
    if (mouseDownTimer) {
        clearTimeout(mouseDownTimer);
        mouseDownTimer = null;
    }
}

// Momentum Scroll Glide & Velocity Tracking Engine
let _lastScrollTop = 0;
let _lastScrollTime = 0;
let _messagesScrollVelocity = 0; // px / ms
let _lastScrollEventTs = 0;
let _glideRafId = null;
let _glideVelocity = 0;
let _lastGlideTs = 0;
let _lastLowerBarTapTs = 0;
let _lastScrollBtnTapTs = 0;

function isMessagesFlingActive() {
    return (Date.now() - _lastScrollEventTs < 90) && Math.abs(_messagesScrollVelocity) > 0.08;
}

function startScrollGlide(initialVelocity) {
    cancelScrollGlide();
    const container = document.getElementById('messages-container');
    if (!container) return;

    // Cap velocity to avoid excessive speeds (max +/- 3.5 px/ms)
    _glideVelocity = Math.max(-3.5, Math.min(3.5, initialVelocity));
    if (Math.abs(_glideVelocity) < 0.08) return;

    _lastGlideTs = performance.now();

    function step(now) {
        const dt = Math.min(32, now - _lastGlideTs);
        _lastGlideTs = now;

        if (Math.abs(_glideVelocity) < 0.03) {
            _glideRafId = null;
            return;
        }

        const mc = document.getElementById('messages-container');
        if (!mc) {
            _glideRafId = null;
            return;
        }

        const prevTop = mc.scrollTop;
        mc.scrollTop = prevTop + (_glideVelocity * dt);

        // Stop glide if hit top or bottom boundary
        if (mc.scrollTop === prevTop && Math.abs(_glideVelocity * dt) > 0.5) {
            _glideRafId = null;
            return;
        }

        // Kinetic friction decay: 0.95 per 16ms
        const friction = Math.pow(0.95, dt / 16);
        _glideVelocity *= friction;

        _glideRafId = requestAnimationFrame(step);
    }

    _glideRafId = requestAnimationFrame(step);
}

function cancelScrollGlide() {
    if (_glideRafId) {
        cancelAnimationFrame(_glideRafId);
        _glideRafId = null;
    }
    _glideVelocity = 0;
}

// Touch-aware Fast-Tap Helper for Lower Bar & Floating Controls
function attachFastTap(element, actionCallback, continueGlide = false) {
    if (!element || element._fastTapAttached) return;
    element._fastTapAttached = true;

    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let isCancelled = false;

    element.addEventListener('touchstart', (e) => {
        if (!e.touches || e.touches.length > 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startTime = performance.now();
        isCancelled = false;
    }, { passive: true });

    element.addEventListener('touchmove', (e) => {
        if (isCancelled || !e.touches || !e.touches[0]) return;
        const dx = Math.abs(e.touches[0].clientX - startX);
        const dy = Math.abs(e.touches[0].clientY - startY);
        if (dx > 12 || dy > 12) {
            isCancelled = true;
        }
    }, { passive: true });

    element.addEventListener('touchend', (e) => {
        if (isCancelled) return;
        const elapsed = performance.now() - startTime;
        if (elapsed < 350) {
            _lastLowerBarTapTs = Date.now();
            const wasFlinging = isMessagesFlingActive();
            actionCallback(e);
            if (continueGlide && wasFlinging) {
                startScrollGlide(_messagesScrollVelocity);
            }
        }
    }, { passive: true });

    element.addEventListener('touchcancel', () => {
        isCancelled = true;
    }, { passive: true });
}

function initLowerBarTouchHandlers() {
    // 1. Scroll-to-bottom floating button
    const scrollBtn = document.getElementById('scroll-bottom-btn');
    if (scrollBtn) {
        attachFastTap(scrollBtn, () => {
            scrollToBottomAndReset();
        }, false);
    }

    // 2. Message input field & wrapper pill
    const msgInput = document.getElementById('message-input');
    const inputWrapper = document.querySelector('.input-wrapper-ig');
    const handleInputFastTap = () => {
        if (msgInput && document.activeElement !== msgInput) {
            msgInput.focus();
        }
    };
    if (msgInput) attachFastTap(msgInput, handleInputFastTap, true);
    if (inputWrapper) attachFastTap(inputWrapper, handleInputFastTap, true);

    // 3. Image attachment button
    const imgBtn = document.getElementById('img-btn');
    if (imgBtn) {
        attachFastTap(imgBtn, () => {
            showImagePicker();
        }, true);
    }

    // 4. GIF picker button
    const gifBtn = document.getElementById('gif-btn');
    if (gifBtn) {
        attachFastTap(gifBtn, () => {
            openGifPicker();
        }, true);
    }

    // 5. Send button
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) {
        attachFastTap(sendBtn, () => {
            sendMessage();
        }, false);
    }
}

function initMessageTouchHandlers() {
    const container = document.getElementById('messages-container');
    if (!container || container._touchHandlersAttached) return;
    container._touchHandlersAttached = true;

    _lastScrollTop = container.scrollTop;
    _lastScrollTime = performance.now();

    container.addEventListener('touchstart', (e) => {
        cancelScrollGlide();
        window._isUserTouching = true;
        handleTouchStart(e);
    }, { passive: true });
    container.addEventListener('wheel', () => {
        cancelScrollGlide();
    }, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', (e) => {
        window._isUserTouching = false;
        _lastTouchEndTime = Date.now();
        handleTouchEnd(e);
    }, { passive: true });
    container.addEventListener('touchcancel', () => {
        window._isUserTouching = false;
        _lastTouchEndTime = Date.now();
        cancelAllReactionTimers();
        if (swipingMessage) {
            swipingMessage.classList.remove('swiping', 'swiping-left', 'swiping-right');
            swipingMessage.style.transform = '';
            swipingMessage = null;
        }
    }, { passive: true });

    // Cancel reaction timers & track scroll velocity for momentum glide
    let _scrollDynamicBlurTimer = null;
    container.addEventListener('scroll', () => {
        window._lastUserScrollTs = Date.now();
        if (longPressTimer || mouseDownTimer) cancelAllReactionTimers();

        const now = performance.now();
        const currentScrollTop = container.scrollTop;
        const dt = now - _lastScrollTime;
        if (dt > 4 && dt < 120) {
            const dy = currentScrollTop - _lastScrollTop;
            const v = dy / dt;
            _messagesScrollVelocity = _messagesScrollVelocity * 0.3 + v * 0.7;
        }
        _lastScrollTime = now;
        _lastScrollTop = currentScrollTop;
        _lastScrollEventTs = Date.now();

        // Dynamic Scroll Blur workaround: ONLY for Firefox to prevent GeckoView GPU readback lag during scroll
        if (navigator.userAgent.includes('Firefox')) {
            if (!document.body.classList.contains('is-scrolling-chat')) {
                document.body.classList.add('is-scrolling-chat');
            }
            if (_scrollDynamicBlurTimer) clearTimeout(_scrollDynamicBlurTimer);
            _scrollDynamicBlurTimer = setTimeout(() => {
                document.body.classList.remove('is-scrolling-chat');
                _scrollDynamicBlurTimer = null;
            }, 90);
        }
    }, { passive: true });

    // Mouse events for desktop (fine pointers only)
    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseup', handleMouseUp);
}

function getMessageElement(target) {
    return target.closest('.message');
}

let _lastSwipeEndTime = 0;

function handleTouchStart(e) {
    if (e.target.closest('.message-swipe-actions') || e.target.closest('.swipe-act-btn') || e.target.closest('.voice-progress-container')) {
        return;
    }

    if (e.touches && e.touches[0]) {
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
        swipeCurrentX = swipeStartX;
        swipeDirection = null;
    }

    const msgEl = getMessageElement(e.target);
    if (!msgEl) return;

    // Automatically snap back any previously opened message action chips so only 1 message has actions open at a time
    document.querySelectorAll('.message.actions-open').forEach(openEl => {
        if (openEl !== msgEl) {
            openEl.classList.remove('actions-open', 'swiping', 'swiping-left', 'swiping-right');
            openEl.classList.add('snapback');
            openEl.style.transform = '';
            setTimeout(() => openEl.classList.remove('snapback'), 160);
        }
    });

    swipingMessage = msgEl;

    // Capture touch coords for reaction picker placement
    const touchX = e.touches && e.touches[0] ? e.touches[0].clientX : 0;
    const touchY = e.touches && e.touches[0] ? e.touches[0].clientY : 0;

    // Clear any previous timer before starting a new one
    cancelAllReactionTimers();

    // Intentional stationary long-press (600ms) for reactions
    longPressTimer = setTimeout(() => {
        // Only trigger if user is still touching the same stationary message
        if (window._isUserTouching && swipingMessage === msgEl && swipeDirection === null) {
            showReactionPicker(msgEl, touchX, touchY);
        }
        swipingMessage = null;
        longPressTimer = null;
    }, 600);
}

function handleTouchMove(e) {
    if (swipeDirection === 'vertical') return;

    if (e.touches && e.touches[0]) {
        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;
        const deltaX = currentX - swipeStartX;
        const deltaY = currentY - swipeStartY;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);

        // Cancel reaction timer immediately on ANY movement > 3px
        if (absX > 3 || absY > 3) {
            cancelAllReactionTimers();
        }

        if (!swipeDirection) {
            if (absX > 8 || absY > 8) {
                if (absX > absY) {
                    swipeDirection = 'horizontal';
                } else {
                    swipeDirection = 'vertical';
                }
            }
        }
    }

    if (!swipingMessage) return;

    if (swipeDirection === 'vertical') {
        return;
    }

    if (swipeDirection === 'horizontal') {
        if (e.cancelable) e.preventDefault();
        swipeCurrentX = e.touches[0].clientX;
        const deltaX = swipeCurrentX - swipeStartX;

        if (deltaX > 0) {
            // LTR: Swipe Right (Reply)
            const visualDeltaX = Math.min(deltaX, 85);
            if (visualDeltaX > 8) {
                swipingMessage.classList.add('swiping', 'swiping-right');
                swipingMessage.classList.remove('swiping-left');
                swipingMessage.style.transform = `translateX(${visualDeltaX}px)`;
            } else {
                swipingMessage.style.transform = '';
            }
        } else {
            // RTL: Swipe Left (Edit+Delete for sent text, Single Delete for media/received)
            const hasTwoActions = swipingMessage.querySelector('.message-swipe-actions:not(.single-action)');
            const maxSwipe = hasTwoActions ? -105 : -65;
            const visualDeltaX = Math.max(deltaX, maxSwipe);
            if (visualDeltaX < -8) {
                swipingMessage.classList.add('swiping', 'swiping-left');
                swipingMessage.classList.remove('swiping-right');
                swipingMessage.style.transform = `translateX(${visualDeltaX}px)`;
            } else {
                swipingMessage.style.transform = '';
            }
        }
    }
}

function handleTouchEnd(e) {
    cancelAllReactionTimers();
    _lastTouchEndTime = Date.now();

    if (!swipingMessage) return;

    const deltaX = swipeCurrentX - swipeStartX;
    const msgEl = swipingMessage;
    const hasTwoActions = msgEl.querySelector('.message-swipe-actions:not(.single-action)');

    // Trigger reply if swiped right enough (LTR)
    if (swipeDirection === 'horizontal' && deltaX > 55) {
        const { from, text, msgId, imgSrc, mediaType } = extractReplyDetails(msgEl);
        requestAnimationFrame(() => {
            setReplyTo(from, text, msgId, imgSrc, mediaType);
        });
    }

    // Reveal action chips if swiped left enough (RTL)
    const threshold = hasTwoActions ? -55 : -35;
    if (swipeDirection === 'horizontal' && deltaX < threshold) {
        requestAnimationFrame(() => {
            msgEl.classList.remove('swiping', 'swiping-left', 'swiping-right');
            msgEl.classList.add('actions-open');
            msgEl.style.transform = hasTwoActions ? 'translateX(-96px)' : 'translateX(-52px)';
        });
    } else if (msgEl.style.transform || msgEl.classList.contains('swiping') || msgEl.classList.contains('actions-open')) {
        // Reset with requestAnimationFrame for smooth non-blocking snapback (only if actually swiped horizontally)
        requestAnimationFrame(() => {
            msgEl.classList.remove('swiping', 'swiping-left', 'swiping-right', 'actions-open');
            msgEl.classList.add('snapback');
            msgEl.style.transform = '';
            setTimeout(() => msgEl.classList.remove('snapback'), 160);
        });
    }

    if (swipeDirection === 'horizontal' && Math.abs(deltaX) > 10) {
        _lastSwipeEndTime = Date.now();
    }

    swipingMessage = null;
    swipeStartX = 0;
    swipeStartY = 0;
    swipeCurrentX = 0;
    swipeDirection = null;
}

// Mouse handlers for desktop (fine pointers only â€” never touch)
function handleMouseDown(e) {
    if (e.target.closest('.message-swipe-actions') || e.target.closest('.swipe-act-btn') || e.target.closest('.voice-progress-container')) {
        return;
    }

    // Completely ignore touch devices or synthetic mouse events after a touch!
    if (window._isUserTouching || (Date.now() - _lastTouchEndTime < 800)) {
        return;
    }
    if (window.matchMedia && !window.matchMedia('(pointer: fine)').matches) {
        return;
    }

    const msgEl = getMessageElement(e.target);
    if (!msgEl || e.button !== 0) return;

    cancelAllReactionTimers();
    mouseDownTimer = setTimeout(() => {
        showReactionPicker(msgEl, e.clientX, e.clientY);
        mouseDownTimer = null;
    }, 600);
}

function handleMouseMove(e) {
    if (mouseDownTimer) {
        clearTimeout(mouseDownTimer);
        mouseDownTimer = null;
    }
}

function handleMouseUp(e) {
    if (mouseDownTimer) {
        clearTimeout(mouseDownTimer);
        mouseDownTimer = null;
    }
}

// =========================================
// Message Reactions Feature
// =========================================
let reactionTarget = null; // Element to add reaction to
const messageReactions = {}; // { msgId: { emoji: count } }

function showReactionPicker(msgEl, x, y) {
    const picker = document.getElementById('reaction-picker');
    reactionTarget = msgEl;

    // Get message position for better picker placement
    const msgRect = msgEl.getBoundingClientRect();
    const pickerWidth = 320; // Approximate picker width
    const pickerHeight = 56;

    // Position above the message, centered horizontally
    let left = msgRect.left + (msgRect.width / 2) - (pickerWidth / 2);
    let top = msgRect.top - pickerHeight - 10;

    // Keep on screen
    left = Math.max(10, Math.min(left, window.innerWidth - pickerWidth - 10));
    top = Math.max(10, top);

    // If would go above viewport, show below message
    if (top < 10) {
        top = msgRect.bottom + 10;
    }

    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
    picker.classList.remove('hidden');
    BackNavManager.push('reaction-bubble', () => {
        hideReactionPicker(true, true);
    });
}

function hideReactionPicker(clearTarget = true, fromPop = false) {
    if (!fromPop && BackNavManager.has('reaction-bubble')) {
        BackNavManager.pop('reaction-bubble');
    }
    document.getElementById('reaction-picker')?.classList.add('hidden');
    if (clearTarget) reactionTarget = null;
}

function addReaction(emoji) {
    if (!reactionTarget || !state.activeChatId) return;
    const targetChatId = state.activeChatId;

    const msgId = reactionTarget.dataset.id || reactionTarget.dataset.clientId;
    if (!msgId) return;

    // Optimistic UI update - show reaction immediately
    const currentReactions = {};
    const existingBadges = reactionTarget.querySelectorAll('.reaction-badge');
    existingBadges.forEach(badge => {
        const e = badge.dataset.emoji;
        currentReactions[e] = [state.user];
    });

    // Toggle reaction
    if (currentReactions[emoji]) {
        delete currentReactions[emoji];
    } else {
        currentReactions[emoji] = [state.user];
    }

    updateReactionDisplay(reactionTarget, msgId, currentReactions);
    hideReactionPicker();

    // Call API to sync reaction
    apiFetch(`/api/chat/${targetChatId}/react`, {
        method: 'POST',
        body: JSON.stringify({ msgId, emoji })
    }).catch(e => console.error('Reaction failed:', e));
}

function updateReactionDisplay(msgEl, msgId, reactions) {
    if (!reactions || Object.keys(reactions).length === 0) {
        const existing = msgEl.querySelector('.message-reactions');
        if (existing) existing.remove();
        return;
    }

    // Find or create reactions container
    let reactionsEl = msgEl.querySelector('.message-reactions');
    if (!reactionsEl) {
        reactionsEl = document.createElement('div');
        reactionsEl.className = 'message-reactions';
        msgEl.appendChild(reactionsEl);
    }

    reactionsEl.innerHTML = Object.entries(reactions)
        .map(([emoji, users]) => `
            <span class="reaction-badge" data-emoji="${emoji}">
                <span class="reaction-emoji">${emoji}</span>
                ${Array.isArray(users) && users.length > 1 ? `<span class="reaction-count">${users.length}</span>` : ''}
            </span>
        `).join('');
}

// Reaction picker click handlers
document.querySelectorAll('.reaction-btn:not(.reaction-more)').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        addReaction(btn.dataset.emoji);
    });
});

// Full emoji picker
const FULL_EMOJI_LIST = [
    "ðŸ˜€", "ðŸ˜ƒ", "ðŸ˜„", "ðŸ˜", "ðŸ˜†", "ðŸ˜…", "ðŸ¤£", "ðŸ˜‚", "ðŸ™‚", "ðŸ˜Š", "ðŸ˜‡", "ðŸ¥°", "ðŸ˜", "ðŸ¤©", "ðŸ˜˜", "ðŸ˜—",
    "ðŸ˜š", "ðŸ˜™", "ðŸ˜‹", "ðŸ˜›", "ðŸ˜œ", "ðŸ¤ª", "ðŸ˜", "ðŸ¤‘", "ðŸ¤—", "ðŸ¤­", "ðŸ¤«", "ðŸ¤”", "ðŸ¤", "ðŸ¤¨", "ðŸ˜", "ðŸ˜‘",
    "ðŸ˜¶", "ðŸ˜", "ðŸ˜’", "ðŸ™„", "ðŸ˜¬", "ðŸ¤¥", "ðŸ˜Œ", "ðŸ˜”", "ðŸ˜ª", "ðŸ¤¤", "ðŸ˜´", "ðŸ˜·", "ðŸ¤’", "ðŸ¤•", "ðŸ¤¢", "ðŸ¤®",
    "ðŸ¤§", "ðŸ¥µ", "ðŸ¥¶", "ðŸ¥´", "ðŸ˜µ", "ðŸ¤¯", "ðŸ¤ ", "ðŸ¥³", "ðŸ˜Ž", "ðŸ¤“", "ðŸ§", "ðŸ˜•", "ðŸ˜Ÿ", "ðŸ™", "ðŸ˜®", "ðŸ˜¯",
    "ðŸ˜²", "ðŸ˜³", "ðŸ¥º", "ðŸ˜¦", "ðŸ˜§", "ðŸ˜¨", "ðŸ˜°", "ðŸ˜¥", "ðŸ˜¢", "ðŸ˜­", "ðŸ˜±", "ðŸ˜–", "ðŸ˜£", "ðŸ˜ž", "ðŸ˜“", "ðŸ˜©",
    "ðŸ˜«", "ðŸ¥±", "ðŸ˜¤", "ðŸ˜¡", "ðŸ˜ ", "ðŸ¤¬", "ðŸ˜ˆ", "ðŸ‘¿", "ðŸ’€", "â˜ ï¸", "ðŸ’©", "ðŸ¤¡", "ðŸ‘¹", "ðŸ‘º", "ðŸ‘»", "ðŸ‘½",
    "ðŸ‘¾", "ðŸ¤–", "ðŸ˜º", "ðŸ˜¸", "ðŸ˜¹", "ðŸ˜»", "ðŸ˜¼", "ðŸ˜½", "ðŸ™€", "ðŸ˜¿", "ðŸ˜¾", "ðŸ™ˆ", "ðŸ™‰", "ðŸ™Š", "ðŸ’‹", "ðŸ’Œ",
    "ðŸ’˜", "ðŸ’", "ðŸ’–", "ðŸ’—", "ðŸ’“", "ðŸ’ž", "ðŸ’•", "ðŸ’Ÿ", "â£ï¸", "ðŸ’”", "â¤ï¸", "ðŸ§¡", "ðŸ’›", "ðŸ’š", "ðŸ’™", "ðŸ’œ",
    "ðŸ¤Ž", "ðŸ–¤", "ðŸ¤", "ðŸ’¯", "ðŸ’¢", "ðŸ’¥", "ðŸ’«", "ðŸ’¦", "ðŸ’¨", "ðŸ•³ï¸", "ðŸ’£", "ðŸ’¬", "ðŸ‘ï¸â€ðŸ—¨ï¸", "ðŸ—¨ï¸", "ðŸ—¯ï¸", "ðŸ’­",
    "ðŸ‘", "ðŸ‘Ž", "ðŸ‘Š", "âœŠ", "ðŸ¤›", "ðŸ¤œ", "âœŒï¸", "ðŸ¤ž", "ðŸ¤Ÿ", "ðŸ¤˜", "ðŸ¤™", "ðŸ‘ˆ", "ðŸ‘‰", "ðŸ‘†", "ðŸ‘‡", "â˜ï¸",
    "âœ‹", "ðŸ¤š", "ðŸ–ï¸", "ðŸ––", "ðŸ‘‹", "ðŸ¤™", "âœï¸", "ðŸ‘", "ðŸ’ª", "ðŸ¦¾", "ðŸ¦¿", "ðŸ¦µ", "ðŸ¦¶", "ðŸ‘‚", "ðŸ¦»", "ðŸ‘ƒ",
    "ðŸ”¥", "â­", "ðŸŒŸ", "âœ¨", "âš¡", "ðŸŽ‰", "ðŸŽŠ", "ðŸŽ", "ðŸ†", "ðŸ¥‡", "ðŸ¥ˆ", "ðŸ¥‰", "âš½", "ðŸ€", "ðŸˆ", "âš¾"
];

function openFullEmojiPicker() {
    hideReactionPicker(false); // Preserve target
    const modal = document.getElementById('emoji-picker-modal');
    const grid = document.getElementById('emoji-grid');

    grid.innerHTML = FULL_EMOJI_LIST.map(e =>
        `<button class="emoji-btn" data-emoji="${e}">${e}</button>`
    ).join('');

    modal.classList.remove('hidden');
    BackNavManager.push('emoji-picker', () => {
        closeFullEmojiPicker(true);
    });
}

function closeFullEmojiPicker(fromPop = false) {
    if (!fromPop && BackNavManager.has('emoji-picker')) {
        BackNavManager.pop('emoji-picker');
    }
    document.getElementById('emoji-picker-modal')?.classList.add('hidden');
}

// Emoji picker events
document.getElementById('reaction-more-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openFullEmojiPicker();
});

document.getElementById('emoji-picker-close')?.addEventListener('click', closeFullEmojiPicker);

document.getElementById('emoji-grid')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-btn');
    if (btn) {
        addReaction(btn.dataset.emoji);
        closeFullEmojiPicker();
    }
});

// =========================================
// Text Effects Feature (Disabled for Convoo)
// =========================================
let selectedEffect = 'none';

function openEffectsModal() {}
function closeEffectsModal() {}
function updateEffectPreview() {}
async function sendWithEffect() {}

// =========================================
// Magic Words Feature (Disabled for Convoo)
// =========================================
const MAGIC_WORDS = {};
const MAGIC_WORD_HINT = /(?!)/;

// Copy code block helper
window.copyCodeBlock = function(btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    if (!wrapper) return;
    const codeEl = wrapper.querySelector('.code-content-pre code');
    if (!codeEl) return;
    navigator.clipboard.writeText(codeEl.textContent).then(() => {
        btn.classList.add('copied');
        const textSpan = btn.querySelector('span');
        if (textSpan) textSpan.textContent = 'Copied!';
        setTimeout(() => {
            btn.classList.remove('copied');
            if (textSpan) textSpan.textContent = 'Copy';
        }, 1500);
    }).catch(() => {});
};

// Syntax highlighting helper for code blocks
function highlightSyntax(rawCode, lang) {
    let esc = escapeHtml(rawCode);

    // Comments: // ... or # ... or /* ... */
    esc = esc.replace(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g, '<span class="syn-com">$1</span>');

    // Strings: "..." or '...' or `...`
    esc = esc.replace(/(&quot;[\s\S]*?&quot;|&#39;[\s\S]*?&#39;|`[\s\S]*?`)/g, '<span class="syn-str">$1</span>');

    // Numbers
    esc = esc.replace(/\b(\d+(\.\d+)?|\b0x[0-9a-fA-F]+)\b/g, '<span class="syn-num">$1</span>');

    // Booleans and null/undefined
    esc = esc.replace(/\b(true|false|null|undefined)\b/g, '<span class="syn-bool">$1</span>');

    // Language keywords
    const keywords = /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|import|export|from|class|extends|super|new|this|typeof|instanceof|void|delete|try|catch|finally|throw|async|await|yield|def|lambda|print|elif|None|True|False|self|package|public|private|protected|static|final|interface|enum|implements|abstract)\b/g;
    esc = esc.replace(keywords, '<span class="syn-kwd">$1</span>');

    // Functions
    esc = esc.replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*\()/g, '<span class="syn-fn">$1</span>');

    return esc;
}

// Helper to highlight markdown and code blocks within clean text (No magic words)
function formatMessageText(text) {
    if (!text) return '';
    if (typeof text === 'string' && text.startsWith('__chunked__:')) {
        const count = parseInt(text.split(':')[1]) || 0;
        return renderPlaceholderCard('', 'MEDIA', Math.floor(count * 500000 * 0.75));
    }

    // 1. Extract triple-backtick Code Blocks
    const codeBlocks = [];
    let processed = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
        const token = `__CODE_BLOCK_${codeBlocks.length}__`;
        const cleanLang = (lang || 'code').toLowerCase().trim();
        const highlighted = highlightSyntax(code.replace(/^\n+|\n+$/g, ''), cleanLang);
        const blockHtml = `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang-tag">${escapeHtml(cleanLang)}</span><button type="button" class="code-copy-btn" onclick="copyCodeBlock(this)"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button></div><pre class="code-content-pre"><code>${highlighted}</code></pre></div>`;
        codeBlocks.push(blockHtml);
        return token;
    });

    // 2. Extract single-backtick Inline Code
    const inlineCodes = [];
    processed = processed.replace(/`([^`\n]+)`/g, (match, code) => {
        const token = `__INLINE_CODE_${inlineCodes.length}__`;
        inlineCodes.push(`<code class="inline-code">${escapeHtml(code)}</code>`);
        return token;
    });

    // 3. Escape HTML on the remaining text
    let html = escapeHtml(processed);

    // 4. Markdown formatting: *bold*, _italic_, ~strike~
    html = html.replace(/(^|[^\w*])\*([^*\n\r]+?)\*([^\w*]|$)/g, '$1<strong>$2</strong>$3');
    html = html.replace(/(^|[^\w_])_([^_\n\r]+?)_([^\w_]|$)/g, '$1<em>$2</em>$3');
    html = html.replace(/(^|[^\w~])~([^~\n\r]+?)~([^\w~]|$)/g, '$1<del>$2</del>$3');

    // 5. Clean Linkification (Standard text, no magic word highlighting)
    html = linkifyText(html);

    // 6. Restore Inline Code tokens
    for (let i = 0; i < inlineCodes.length; i++) {
        html = html.replace(`__INLINE_CODE_${i}__`, inlineCodes[i]);
    }

    // 7. Restore Code Block tokens
    for (let i = 0; i < codeBlocks.length; i++) {
        html = html.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]);
    }

    return html;
}

function detectMagicWord(text) {
    return null;
}

function playMagicAnimation(type) {
    // Disabled for Convoo
}

// Close reaction picker when clicking outside
document.addEventListener('click', (e) => {
    const picker = document.getElementById('reaction-picker');
    if (picker && !picker.classList.contains('hidden')) {
        if (!picker.contains(e.target) && !e.target.closest('.message') && !e.target.closest('.hover-btn')) {
            hideReactionPicker();
        }
    }

    // Close open swipe actions on outside click (ignore if tapping swipe action buttons)
    document.querySelectorAll('.message.actions-open').forEach(el => {
        if (!el.contains(e.target) && !e.target.closest('.message-swipe-actions')) {
            el.classList.remove('actions-open');
            el.classList.add('snapback');
            el.style.transform = '';
            setTimeout(() => el.classList.remove('snapback'), 160);
        }
    });

    // Desktop hover menu buttons & swipe action buttons
    if (e.target.classList.contains('hover-reply')) {
        const msgEl = e.target.closest('.message');
        if (msgEl) {
            const { from, text, msgId, imgSrc, mediaType } = extractReplyDetails(msgEl);
            setReplyTo(from, text, msgId, imgSrc, mediaType);
        }
    }

    const editBtn = e.target.closest('.hover-edit') || e.target.closest('.edit-act');
    if (editBtn) {
        e.preventDefault();
        e.stopPropagation();
        const msgEl = editBtn.closest('.message');
        if (msgEl) {
            const msgId = msgEl.dataset.id || '';
            const clientId = msgEl.dataset.clientId || '';
            const text = msgEl.querySelector('.msg-text')?.textContent || '';
            startEditingMessage({ id: msgId, clientId: clientId }, text);
        }
    }

    const deleteBtn = e.target.closest('.hover-delete') || e.target.closest('.delete-act');
    if (deleteBtn) {
        e.preventDefault();
        e.stopPropagation();
        const msgEl = deleteBtn.closest('.message');
        if (msgEl) {
            deleteMessageForEveryone(msgEl);
        }
    }

    if (e.target.classList.contains('hover-react')) {
        e.stopPropagation();
        const msgEl = e.target.closest('.message');
        if (msgEl) {
            const rect = e.target.getBoundingClientRect();
            showReactionPicker(msgEl, rect.left, rect.top);
        }
    }
});

// =========================================
// Two-Way Gestures: Message Editing & Deleting
// =========================================

function startEditingMessage(editRef, text) {
    document.querySelectorAll('.message.actions-open').forEach(el => {
        el.classList.remove('actions-open');
        el.classList.add('snapback');
        el.style.transform = '';
        setTimeout(() => el.classList.remove('snapback'), 160);
    });

    state.editingMessageRef = typeof editRef === 'object' ? editRef : { id: editRef, clientId: null };
    state.editingMessageId = (state.editingMessageRef.id || state.editingMessageRef.clientId || editRef);
    if (typeof cancelReply === 'function') cancelReply();

    const banner = document.getElementById('editing-preview');
    const previewText = document.getElementById('editing-text-preview');
    const inp = document.getElementById('message-input');

    if (banner && previewText && inp) {
        previewText.textContent = text || '';
        banner.classList.remove('hidden');
        inp.value = text || '';
        inp.focus();
        inp.closest('.input-wrapper')?.classList.add('has-text');

        if (typeof updateActionAndGifState === 'function') {
            updateActionAndGifState(true);
        } else {
            document.getElementById('img-btn')?.classList.add('hidden');
            document.getElementById('search-effects-btn')?.classList.remove('hidden');
            document.getElementById('right-media-icons')?.classList.add('hidden');
            document.getElementById('send-btn')?.classList.remove('hidden');
        }
    }
}

function cancelEditing() {
    state.editingMessageId = null;
    state.editingMessageRef = null;
    const banner = document.getElementById('editing-preview');
    if (banner) banner.classList.add('hidden');
    const inp = document.getElementById('message-input');
    if (inp) {
        inp.value = '';
        inp.closest('.input-wrapper')?.classList.remove('has-text');
        if (typeof updateActionAndGifState === 'function') {
            updateActionAndGifState(false, true);
        } else {
            document.getElementById('img-btn')?.classList.remove('hidden');
            document.getElementById('search-effects-btn')?.classList.add('hidden');
            document.getElementById('right-media-icons')?.classList.remove('hidden');
            document.getElementById('send-btn')?.classList.add('hidden');
        }
    }
}

async function submitMessageEdit(editRef, newText) {
    let id = null;
    let clientId = null;
    if (typeof editRef === 'object' && editRef !== null) {
        id = editRef.id || null;
        clientId = editRef.clientId || null;
    } else if (typeof editRef === 'string') {
        id = editRef;
    }
    if (!id && !clientId) return;
    if (!newText || !state.activeChatId) return;
    const targetChatId = state.activeChatId;

    // Optimistically update locally and persist to IDB immediately
    handleMessageEditedLive({ id, clientId, msgId: id || clientId, newText, editedAt: Date.now() });

    try {
        await apiFetch(`/api/chat/${targetChatId}/message/edit`, {
            method: 'POST',
            body: JSON.stringify({ msgId: id || clientId, clientId: clientId || id, newText })
        });
    } catch (e) {
        console.error('Failed to submit message edit:', e);
    }
}

async function deleteMessageForEveryone(targetElOrId, maybeClientId) {
    let id = null;
    let clientId = null;
    if (targetElOrId instanceof Element) {
        id = targetElOrId.dataset.id || null;
        clientId = targetElOrId.dataset.clientId || null;
    } else if (typeof targetElOrId === 'string') {
        id = targetElOrId;
        clientId = maybeClientId || null;
    }
    if (!id && !clientId) return;
    if (!state.activeChatId) return;
    const targetChatId = state.activeChatId;

    // Instant deletion without blocking browser confirm dialog
    document.querySelectorAll('.message.actions-open').forEach(el => {
        el.classList.remove('actions-open');
        el.classList.add('snapback');
        el.style.transform = '';
        setTimeout(() => el.classList.remove('snapback'), 160);
    });

    // Optimistically delete locally and persist to IDB immediately
    handleMessageDeletedLive({ id, clientId, msgId: id || clientId });

    try {
        await apiFetch(`/api/chat/${targetChatId}/message/delete`, {
            method: 'POST',
            body: JSON.stringify({ msgId: id || clientId, clientId: clientId || id })
        });
    } catch (e) {
        console.error('Failed to delete message for everyone:', e);
    }
}

function handleMessageEditedLive(data) {
    const id = typeof data === 'object' ? data.id : data;
    const clientId = typeof data === 'object' ? data.clientId : null;
    const msgId = typeof data === 'object' ? data.msgId : id;
    const newText = typeof data === 'object' ? data.newText : arguments[1];
    const editedAt = typeof data === 'object' ? data.editedAt : arguments[2];

    const selectors = [
        id ? `[data-id="${id}"]` : null,
        clientId ? `[data-client-id="${clientId}"]` : null,
        msgId ? `[data-id="${msgId}"]` : null,
        msgId ? `[data-client-id="${msgId}"]` : null
    ].filter(Boolean).join(', ');

    if (selectors) {
        const msgEls = document.querySelectorAll(selectors);
        msgEls.forEach(msgEl => {
            const textEl = msgEl.querySelector('.msg-text');
            if (textEl) textEl.textContent = newText;
            let footerEl = msgEl.querySelector('.msg-footer');
            if (footerEl && !footerEl.querySelector('.msg-edited-badge')) {
                const badge = document.createElement('span');
                badge.className = 'msg-edited-badge';
                badge.textContent = 'Edited';
                footerEl.insertBefore(badge, footerEl.firstChild);
            }
        });
    }

    if (state.activeChatId) {
        const msgs = ChatCache._activeMsgs.get(state.activeChatId);
        if (msgs) {
            const target = msgs.find(x => 
                (id && (x.id === id || x.clientId === id)) || 
                (clientId && (x.id === clientId || x.clientId === clientId)) ||
                (msgId && (x.id === msgId || x.clientId === msgId))
            );
            if (target) {
                target.text = newText;
                target.edited = true;
                target.editedAt = editedAt || Date.now();
                idb.put('messages', `msgs_${state.activeChatId}`, msgs).catch(() => {});
            }
        }
    }
}

function handleMessageDeletedLive(data) {
    const id = typeof data === 'object' ? data.id : data;
    const clientId = typeof data === 'object' ? data.clientId : null;
    const msgId = typeof data === 'object' ? data.msgId : id;

    const selectors = [
        id ? `[data-id="${id}"]` : null,
        clientId ? `[data-client-id="${clientId}"]` : null,
        msgId ? `[data-id="${msgId}"]` : null,
        msgId ? `[data-client-id="${msgId}"]` : null
    ].filter(Boolean).join(', ');

    if (selectors) {
        const msgEls = document.querySelectorAll(selectors);
        msgEls.forEach(msgEl => {
            msgEl.style.transition = 'opacity 0.2s ease, transform 0.2s ease, max-height 0.25s ease, margin 0.25s ease, padding 0.25s ease';
            msgEl.style.opacity = '0';
            msgEl.style.transform = 'scale(0.85)';
            msgEl.style.maxHeight = '0px';
            msgEl.style.overflow = 'hidden';
            msgEl.style.marginTop = '0px';
            msgEl.style.marginBottom = '0px';
            msgEl.style.paddingTop = '0px';
            msgEl.style.paddingBottom = '0px';
            setTimeout(() => msgEl.remove(), 260);
        });
    }

    if (state.activeChatId) {
        ChatCache.deleteMessage(state.activeChatId, id || msgId, clientId);
    }
}

// Initialize touch handlers and editing controls after DOM
document.addEventListener('DOMContentLoaded', () => {
    initMessageTouchHandlers();
    initLowerBarTouchHandlers();
    const cancelEditBtn = document.getElementById('cancel-editing-btn');
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', cancelEditing);
});
if (document.readyState !== 'loading') {
    initMessageTouchHandlers();
    initLowerBarTouchHandlers();
    const cancelEditBtn = document.getElementById('cancel-editing-btn');
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', cancelEditing);
}

// =========================================
// Profile Picture Feature
// =========================================
let pendingProfilePic = null;

const UPDATE_APK_URL = 'https://chattingsite.pages.dev/updates/fast2.apk';

async function openProfilePicModal() {
    document.getElementById('profile-pic-modal').classList.remove('hidden');
    BackNavManager.push('profile-modal', () => {
        closeProfilePicModal(true);
    });

    const updateBtn = document.getElementById('profile-update-btn');
    const progressContainer = document.getElementById('profile-update-progress-container');
    const descEl = document.getElementById('profile-update-desc');
    const titleEl = document.getElementById('profile-update-title');

    if (updateBtn) updateBtn.classList.remove('hidden');
    if (progressContainer) progressContainer.classList.add('hidden');

    if (IS_CAPACITOR) {
        if (titleEl) titleEl.textContent = "App Update";
        if (descEl) descEl.textContent = "Checking version...";
        if (updateBtn) updateBtn.textContent = "Update App";

        try {
            const { AppUpdate } = window.Capacitor.Plugins;
            if (AppUpdate) {
                const info = await AppUpdate.getAppInfo();
                if (descEl) descEl.textContent = `Current version: v${info.versionName} (Build ${info.versionCode})`;
            } else {
                if (descEl) descEl.textContent = "AppUpdate plugin not loaded.";
            }
        } catch (e) {
            if (descEl) descEl.textContent = "Failed to load app version info.";
        }
    } else {
        if (titleEl) titleEl.textContent = "Download Android App";
        if (descEl) descEl.textContent = "Download the FastChat Android APK directly to your device.";
        if (updateBtn) updateBtn.textContent = "Download APK";
    }

    // Load current profile pic if exists
    const cached = localStorage.getItem(`profile_pic_${state.user}`);
    const preview = document.getElementById('profile-pic-preview');
    if (cached) {
        preview.style.backgroundImage = `url(${cached})`;
        preview.classList.add('has-image');
        pendingProfilePic = cached;
    }
}

function closeProfilePicModal(fromPop = false) {
    if (!fromPop && BackNavManager.has('profile-modal')) {
        BackNavManager.pop('profile-modal');
    }
    document.getElementById('profile-pic-modal').classList.add('hidden');
    pendingProfilePic = null;
    const preview = document.getElementById('profile-pic-preview');
    preview.style.backgroundImage = '';
    preview.classList.remove('has-image');
}

async function handleAppUpdateAction() {
    const updateBtn = document.getElementById('profile-update-btn');
    const progressContainer = document.getElementById('profile-update-progress-container');
    const progressBarFill = document.getElementById('profile-update-progress-fill');
    const progressText = document.getElementById('profile-update-progress-text');
    const descEl = document.getElementById('profile-update-desc');

    if (!IS_CAPACITOR) {
        const downloadUrl = UPDATE_APK_URL;
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = downloadUrl.split('/').pop();
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
    }

    const { AppUpdate } = window.Capacitor.Plugins;
    if (!AppUpdate) {
        alert("AppUpdate plugin not registered.");
        return;
    }

    try {
        const permission = await AppUpdate.canRequestPackageInstalls();
        if (!permission.value) {
            descEl.textContent = "Please allow 'Install unknown apps' permission to update.";
            await AppUpdate.openInstallSettings();
            return;
        }

        updateBtn.classList.add('hidden');
        progressContainer.classList.remove('hidden');
        progressBarFill.style.width = '0%';
        progressText.textContent = 'Downloading: 0%';

        const progressListener = await AppUpdate.addListener('updateProgress', (info) => {
            if (info.status === 'downloading') {
                const pct = info.progress || 0;
                progressBarFill.style.width = `${pct}%`;
                progressText.textContent = `Downloading: ${pct}%`;
            } else if (info.status === 'downloaded') {
                progressText.textContent = 'Launching Installer...';
                setTimeout(() => {
                    progressContainer.classList.add('hidden');
                    updateBtn.classList.remove('hidden');
                }, 3000);
                progressListener.remove();
            } else if (info.status === 'failed') {
                descEl.textContent = `Failed: ${info.error || 'Unknown error'}`;
                progressContainer.classList.add('hidden');
                updateBtn.classList.remove('hidden');
                progressListener.remove();
            }
        });

        await AppUpdate.downloadAndInstallApk({ url: `${UPDATE_APK_URL}?t=${Date.now()}` });

    } catch (e) {
        console.error('Update flow failed:', e);
        alert('Failed to launch update: ' + e.message);
    }
}

function compressProfilePic(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const size = 200; // 1:1 ratio, 200x200
                canvas.width = size;
                canvas.height = size;

                // Center crop
                const ctx = canvas.getContext('2d');
                const minDim = Math.min(img.width, img.height);
                const sx = (img.width - minDim) / 2;
                const sy = (img.height - minDim) / 2;
                ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);

                resolve(canvas.toDataURL('image/jpeg', 0.8));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function handleProfilePicFile(file) {
    if (!file || !file.type.startsWith('image/')) return;

    pendingProfilePic = await compressProfilePic(file);
    const preview = document.getElementById('profile-pic-preview');
    preview.style.backgroundImage = `url(${pendingProfilePic})`;
    preview.classList.add('has-image');
}

async function saveProfilePic() {
    if (!pendingProfilePic || !state.user) return;

    try {
        await apiFetch('/api/profile/picture', {
            method: 'POST',
            body: JSON.stringify({ image: pendingProfilePic })
        });

        // Cache locally
        localStorage.setItem(`profile_pic_${state.user}`, pendingProfilePic);

        // Update avatar display
        applyProfilePic(pendingProfilePic);
        closeProfilePicModal();
    } catch (e) {
        console.error('Failed to save profile picture:', e);
    }
}

async function removeProfilePic() {
    try {
        await apiFetch('/api/profile/picture', {
            method: 'DELETE'
        });

        // Clear cache
        localStorage.removeItem(`profile_pic_${state.user}`);

        // Reset avatar
        const myAvatar = document.getElementById('my-avatar');
        myAvatar.style.backgroundImage = '';
        myAvatar.classList.remove('has-pic');
        myAvatar.textContent = state.user[0].toUpperCase();

        closeProfilePicModal();
    } catch (e) {
        console.error('Failed to remove profile picture:', e);
    }
}

function applyProfilePic(imageData) {
    const myAvatar = document.getElementById('my-avatar');
    myAvatar.style.backgroundImage = `url(${imageData})`;
    myAvatar.classList.add('has-pic');
    myAvatar.textContent = ''; // Clear initial letter
}

async function loadMyProfilePic() {
    // Try cache first
    const cached = localStorage.getItem(`profile_pic_${state.user}`);
    if (cached) {
        applyProfilePic(cached);
    }

    // Fetch from server in background
    try {
        const res = await apiFetch('/api/profile/picture');
        if (res && res.image) {
            localStorage.setItem(`profile_pic_${state.user}`, res.image);
            applyProfilePic(res.image);
        }
    } catch (e) { }
}

// Load peer's profile picture for chat header
async function loadPeerProfilePic(peer) {
    const cacheKey = `profile_pic_${peer}`;
    const cacheTimeKey = `profile_pic_ts_${peer}`;
    const cached = localStorage.getItem(cacheKey);
    const cachedTs = parseInt(localStorage.getItem(cacheTimeKey) || '0');
    const chatAvatar = document.getElementById('chat-avatar');

    if (cached) {
        chatAvatar.style.backgroundImage = `url(${cached})`;
        chatAvatar.classList.add('has-pic');
        chatAvatar.textContent = '';
        // Skip server fetch if cached within last hour
        if (Date.now() - cachedTs < 3600000) return;
    }

    // Fetch from server in background
    try {
        const res = await apiFetch(`/api/users/${peer}/picture`);
        if (res && res.image) {
            localStorage.setItem(cacheKey, res.image);
            localStorage.setItem(cacheTimeKey, String(Date.now()));
            chatAvatar.style.backgroundImage = `url(${res.image})`;
            chatAvatar.classList.add('has-pic');
            chatAvatar.textContent = '';
        } else {
            chatAvatar.style.backgroundImage = '';
            chatAvatar.classList.remove('has-pic');
            chatAvatar.textContent = peer[0].toUpperCase();
        }
    } catch (e) { }
}

// Profile Picture Event Listeners
document.getElementById('my-avatar')?.addEventListener('click', openProfilePicModal);
document.getElementById('profile-pic-close')?.addEventListener('click', closeProfilePicModal);
document.getElementById('profile-pic-input')?.addEventListener('change', (e) => {
    if (e.target.files[0]) handleProfilePicFile(e.target.files[0]);
});
document.getElementById('profile-pic-apply')?.addEventListener('click', saveProfilePic);
document.getElementById('profile-pic-remove')?.addEventListener('click', removeProfilePic);
document.getElementById('profile-update-btn')?.addEventListener('click', handleAppUpdateAction);

// =========================================
// Keyboard Events (0ms Native Viewport Sync)
// =========================================
async function initKeyboardEvents() {
    // Lock window scroll on input focus and visualViewport scroll
    const msgInp = document.getElementById('message-input');
    if (msgInp) {
        msgInp.addEventListener('focus', () => {
            window.scrollTo(0, 0);
            if (document.body) document.body.scrollTop = 0;
            if (document.documentElement) document.documentElement.scrollTop = 0;
        }, { passive: true });
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener('scroll', () => {
            // NEVER fight touch scrolling when user is scrolling messages!
            if (window._isUserTouching) return;
            // Only lock window scroll when the software keyboard is open or an input is focused
            if (!document.body.classList.contains('keyboard-open') && document.activeElement !== msgInp) return;
            if (window.visualViewport.pageTop > 0 || window.scrollY > 0) {
                window.scrollTo(0, 0);
            }
        }, { passive: true });
    }

    setTimeout(() => {
        let maxViewportHeight = Math.max(window.innerHeight, window.visualViewport ? window.visualViewport.height : window.innerHeight);
        let _kbRaf = 0;

        const checkForKeyboard = () => {
            const currentHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
            if (currentHeight > maxViewportHeight) {
                maxViewportHeight = currentHeight;
            }

            if (currentHeight < maxViewportHeight * 0.82) {
                document.body.classList.add('keyboard-open');
                cancelAnimationFrame(_kbRaf);
            } else if (document.body.classList.contains('keyboard-open') || (msgInp && document.activeElement === msgInp)) {
                document.body.classList.remove('keyboard-open');
                if (msgInp && document.activeElement === msgInp) {
                    msgInp.blur();
                }
            }
        };

        window.addEventListener('resize', checkForKeyboard, { passive: true });

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', checkForKeyboard, { passive: true });
        }
    }, 200);

    if (window.Capacitor?.Plugins?.Keyboard) {
        const { Keyboard } = window.Capacitor.Plugins;
        Keyboard.addListener('keyboardWillShow', () => document.body.classList.add('keyboard-open'));
        Keyboard.addListener('keyboardWillHide', () => {
            document.body.classList.remove('keyboard-open');
            const inp = document.getElementById('message-input');
            if (inp && document.activeElement === inp) {
                inp.blur();
            }
        });
        Keyboard.addListener('keyboardDidHide', () => {
            document.body.classList.remove('keyboard-open');
            const inp = document.getElementById('message-input');
            if (inp && document.activeElement === inp) {
                inp.blur();
            }
        });
    }
}

// =========================================
// Push Notifications (Android only)
// =========================================
async function initPushNotifications() {
    if (!IS_CAPACITOR || !window.Capacitor?.Plugins?.PushNotifications) {
        return;
    }

    // Immediately sync locally cached token to server if available
    const cachedToken = localStorage.getItem('fcm_token');
    if (cachedToken && state.user) {
        apiFetch('/api/profile/fcm_token', {
            method: 'POST',
            body: JSON.stringify({ token: cachedToken })
        }).catch(() => {});
    }

    const { PushNotifications } = window.Capacitor.Plugins;

    try {
        if (!state._pushListenersInitialized) {
            state._pushListenersInitialized = true;

            // Listen for registration success BEFORE calling register()
            PushNotifications.addListener('registration', async (token) => {
                console.log('[Push] FCM Token received:', token.value);
                state.fcmToken = token.value;
                localStorage.setItem('fcm_token', token.value);
                try {
                    await apiFetch('/api/profile/fcm_token', {
                        method: 'POST',
                        body: JSON.stringify({ token: token.value })
                    });
                    console.log('[Push] FCM token sent to server successfully');
                } catch (e) {
                    console.error('[Push] Failed to send FCM token:', e);
                }
            });

            // Listen for registration errors
            PushNotifications.addListener('registrationError', (error) => {
                console.error('[Push] FCM registration error:', error);
            });

            // Handle notification received while app is open
            PushNotifications.addListener('pushNotificationReceived', (notification) => {
                console.log('[Push] Push received in foreground:', notification);
                const data = notification?.data;
                if (data?.peer && data.peer !== state.activePeer) {
                    refreshChatList();
                }
            });

            // Handle notification tap - open the correct chat
            PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
                console.log('[Push] Notification tapped:', action);
                const data = action.notification?.data;
                if (data?.peer) {
                    setTimeout(() => {
                        openChat(data.peer);
                    }, 300);
                }
            });
        }

        // Request permission
        const permResult = await PushNotifications.requestPermissions();
        if (permResult.receive !== 'granted') {
            console.log('[Push] Permission denied');
            return;
        }

        // Register with FCM
        await PushNotifications.register();
        console.log('[Push] PushNotifications.register() called successfully');
    } catch (e) {
        console.error('[Push] Push notification init error:', e);
    }
}

// Initialize push notifications & keyboard on DOM load
document.addEventListener('DOMContentLoaded', () => {
    initKeyboardEvents();
    if (state.user) initPushNotifications();
});
if (document.readyState !== 'loading') {
    if (state.user) initPushNotifications();
}

// =========================================
// Scroll-to-Bottom Badge & Reply Navigation
// =========================================

// Scroll badge helpers
function scrollToBottomAndReset() {
    if (Date.now() - _lastScrollBtnTapTs < 300) return;
    _lastScrollBtnTapTs = Date.now();
    cancelScrollGlide();
    scrollToBottom(true);
    const badge = document.getElementById('scroll-badge');
    if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
    const btn = document.getElementById('scroll-bottom-btn');
    if (btn) btn.classList.add('hidden');
}

function incrementUnreadScrollBadge() {
    const badge = document.getElementById('scroll-badge');
    const btn = document.getElementById('scroll-bottom-btn');
    if (!badge || !btn) return;
    const count = parseInt(badge.textContent || '0') + 1;
    badge.textContent = count;
    badge.classList.remove('hidden');
    btn.classList.remove('hidden');
}

// Show/hide scroll-to-bottom button based on scroll position (VSYNC RAF throttled)
let _scrollBottomBtnRaf = 0;
document.getElementById('messages-container')?.addEventListener('scroll', () => {
    window._lastUserScrollTs = Date.now();
    if (_scrollBottomBtnRaf) return;
    _scrollBottomBtnRaf = requestAnimationFrame(() => {
        _scrollBottomBtnRaf = 0;
        const mc = document.getElementById('messages-container');
        const btn = document.getElementById('scroll-bottom-btn');
        const badge = document.getElementById('scroll-badge');
        if (!mc || !btn) return;
        const distFromBottom = mc.scrollHeight - mc.scrollTop - mc.clientHeight;
        if (distFromBottom > 300) {
            btn.classList.remove('hidden');
        } else {
            btn.classList.add('hidden');
            if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
        }
    });
}, { passive: true });

// Reply navigation: seek original message
async function seekQuote(quote) {
    const targetId = quote.dataset.targetId?.trim();
    const quoteName = quote.querySelector('.quote-name')?.textContent?.trim();
    const quoteText = quote.querySelector('.quote-text')?.textContent?.trim();
    const hasMedia = quote.querySelector('.quote-media') !== null;
    if (!targetId && !quoteText && !hasMedia) return;

    const container = document.getElementById('messages-container');
    let found = null;

    // 1. Direct O(1) exact element lookup by target message ID in currently rendered DOM
    if (targetId) {
        found = document.querySelector(`[data-id="${targetId}"], [data-client-id="${targetId}"]`);
    }

    // 2. Fallback: check if target message is in local cache but outside current loadedMessageLimit slice
    if (!found && state.activeChatId) {
        try {
            const allLocal = await ChatCache.getMessages(state.activeChatId);
            let targetIdx = -1;
            if (targetId) {
                targetIdx = allLocal.findIndex(m => m && (m.id === targetId || m.clientId === targetId));
            }
            if (targetIdx === -1 && (quoteText || hasMedia)) {
                for (let i = allLocal.length - 1; i >= 0; i--) {
                    const m = allLocal[i];
                    if (!m) continue;
                    if (quoteName && m.from !== quoteName) continue;
                    if (hasMedia && m.mediaType) {
                        targetIdx = i;
                        break;
                    }
                    if (quoteText && m.text && m.text.includes(quoteText.slice(0, 40))) {
                        targetIdx = i;
                        break;
                    }
                }
            }

            if (targetIdx > -1) {
                const neededFromEnd = allLocal.length - targetIdx;
                if (neededFromEnd > state.loadedMessageLimit) {
                    state.loadedMessageLimit = Math.max(state.loadedMessageLimit + 200, neededFromEnd + 20);
                    renderMessages(allLocal.slice(-state.loadedMessageLimit));
                }
                const actualTargetId = allLocal[targetIdx].id || allLocal[targetIdx].clientId || targetId;
                found = document.querySelector(`[data-id="${actualTargetId}"], [data-client-id="${actualTargetId}"]`);
            }
        } catch (err) {
            console.warn('[QuoteSeek] Error expanding local message cache:', err);
        }
    }

    // 3. Intelligent fallback matching for legacy messages in rendered list
    if (!found) {
        const currentMsg = quote.closest('.message');
        const allMsgs = [...document.querySelectorAll('#messages-list .message')];
        const currentIndex = allMsgs.indexOf(currentMsg);
        const searchList = currentIndex > -1 ? allMsgs.slice(0, currentIndex).reverse() : allMsgs.reverse();

        for (const msg of searchList) {
            const msgFrom = msg.dataset.from;
            // Match by media
            if (hasMedia) {
                const msgImg = msg.querySelector('.message-image, .message-gif, .msg-video, .voice-note');
                if (msgImg && (!quoteName || msgFrom === quoteName)) {
                    found = msg;
                    break;
                }
            } 
            // Match by text
            else {
                const msgText = msg.querySelector('.msg-text')?.textContent?.trim();
                if (msgText && quoteText && msgText.includes(quoteText.slice(0, 50)) && (!quoteName || msgFrom === quoteName)) {
                    found = msg;
                    break;
                }
            }
        }
    }

    if (found && container) {
        // Calculate container-relative scroll offset to center the message without jerking/scrolling the outer body
        const containerRect = container.getBoundingClientRect();
        const msgRect = found.getBoundingClientRect();
        const targetScrollTop = container.scrollTop + (msgRect.top - containerRect.top) - (containerRect.height / 2) + (msgRect.height / 2);
        
        container.scrollTo({
            top: targetScrollTop,
            behavior: 'smooth'
        });
        
        found.classList.add('highlight-flash');
        setTimeout(() => found.classList.remove('highlight-flash'), 1500);
    }
}

let _quoteTouchHandled = false;

// Reply navigation: click on quoted message to scroll to original
document.getElementById('messages-list')?.addEventListener('click', (e) => {
    const quote = e.target.closest('.message-quote');
    if (!quote) return;
    
    // Skip if touchend handled this tap or if user was scrolling/swiping
    if (_quoteTouchHandled || swipeDirection !== null) {
        _quoteTouchHandled = false;
        return;
    }

    e.preventDefault();
    e.stopPropagation();
    
    // Clear any reaction long press timers if active
    cancelAllReactionTimers();
    seekQuote(quote);
});

// Touch reply navigation: prevent touch scroll/drag over quote from jumping to reply
document.getElementById('messages-list')?.addEventListener('touchend', (e) => {
    const quote = e.target.closest('.message-quote');
    if (!quote) return;

    // Check if user moved finger (scrolled or swiped) during touch
    let moved = false;
    if (swipeDirection !== null) {
        moved = true;
    } else if (e.changedTouches && e.changedTouches[0]) {
        const touch = e.changedTouches[0];
        const startX = (typeof swipeStartX === 'number' && !isNaN(swipeStartX)) ? swipeStartX : touch.clientX;
        const startY = (typeof swipeStartY === 'number' && !isNaN(swipeStartY)) ? swipeStartY : touch.clientY;
        const dist = Math.hypot(touch.clientX - startX, touch.clientY - startY);
        if (dist > 10) moved = true;
    }

    // If user was scrolling/swiping over the quote, DO NOT jump to replied message
    if (moved) return;

    e.preventDefault();
    e.stopPropagation();
    _quoteTouchHandled = true;
    setTimeout(() => { _quoteTouchHandled = false; }, 400);

    // Clear any reaction long press timers immediately to prevent emoji reaction menu
    cancelAllReactionTimers();
    seekQuote(quote);
}, { passive: false });

checkSession();








// =========================================
// Login Screen Dynamic Security Typewriter
// =========================================
(function initSecurityTypewriter() {
    const phrases = [
        "Zero Phone Numbers. 100% Anonymous.",
        "AES-256-GCM Military-Grade E2EE.",
        "Not even our servers can read your chats.",
        "120 FPS Fluid Speed with Encrypted Live Peek.",
        "Salted PBKDF2-SHA512 Password Protection."
    ];

    let phraseIdx = 0;
    let charIdx = 0;
    let isDeleting = false;
    let typeDelay = 45;

    function typeLoop() {
        const textEl = document.getElementById('typewriter-text');
        if (!textEl) {
            setTimeout(typeLoop, 200);
            return;
        }

        const currentPhrase = phrases[phraseIdx];

        if (isDeleting) {
            textEl.textContent = currentPhrase.substring(0, charIdx - 1);
            charIdx--;
            typeDelay = 25;
        } else {
            textEl.textContent = currentPhrase.substring(0, charIdx + 1);
            charIdx++;
            typeDelay = 50;
        }

        if (!isDeleting && charIdx === currentPhrase.length) {
            typeDelay = 2200;
            isDeleting = true;
        } else if (isDeleting && charIdx === 0) {
            isDeleting = false;
            phraseIdx = (phraseIdx + 1) % phrases.length;
            typeDelay = 400;
        }

        setTimeout(typeLoop, typeDelay);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', typeLoop);
    } else {
        typeLoop();
    }
})();

// ==========================================================================
// CONVOO: DIRECT, GROUPS, AND RANDOM CHAT MODULES
// Clean, modern, 100% SVG-powered, zero fluff
// ==========================================================================

state.activeView = 'direct';

function switchView(view) {
    state.activeView = view;
    document.querySelectorAll('.convoo-nav-tab').forEach(btn => {
        const isSelected = btn.dataset.view === view;
        btn.classList.toggle('active', isSelected);
        btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });

    const noChatSelected = document.getElementById('no-chat-selected');
    const activeChat = document.getElementById('active-chat-container');

    if (view === 'random') {
        renderChatList();
        RandomChatManager.openRandomChat();
    } else {
        state.isRandom = false;
        state.isPulse = false;
        if (window.RandomChatManager) {
            window.RandomChatManager.onChatClosed();
        }
        document.getElementById('random-action-bar')?.classList.add('hidden');
        document.getElementById('random-center-menu')?.classList.add('hidden');
        document.getElementById('active-chat-container')?.classList.remove('has-random-bar');
        if (!state.activeChatId || state.activeChatId.startsWith('rnd_')) {
            activeChat?.classList.add('hidden');
            noChatSelected?.classList.remove('hidden');
            state.activeChatId = null;
        }
        renderChatList();
    }
}

function initConvooNavigation() {
    const tabs = document.querySelectorAll('.convoo-nav-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const view = tab.dataset.view;
            if (view) switchView(view);
        });
    });
}

const GroupManager = {
    activeGroupId: null,

    init() {
        const tabDirect = document.getElementById('tab-modal-direct');
        const tabGroup = document.getElementById('tab-modal-group');
        const panelDirect = document.getElementById('panel-modal-direct');
        const panelGroup = document.getElementById('panel-modal-group');

        if (tabDirect && tabGroup) {
            tabDirect.onclick = () => {
                tabDirect.classList.add('active');
                tabGroup.classList.remove('active');
                panelDirect?.classList.remove('hidden');
                panelGroup?.classList.add('hidden');
            };
            tabGroup.onclick = () => {
                tabGroup.classList.add('active');
                tabDirect.classList.remove('active');
                panelGroup?.classList.remove('hidden');
                panelDirect?.classList.add('hidden');
            };
        }

        const groupClose = document.getElementById('group-modal-close');
        if (groupClose) groupClose.onclick = () => closeUserModal(false);

        const createConfirm = document.getElementById('create-group-confirm');
        if (createConfirm) createConfirm.onclick = () => this.handleCreateGroup();

        const drawerClose = document.getElementById('btn-space-drawer-close');
        const drawerBackdrop = document.getElementById('space-drawer-backdrop');
        if (drawerClose) drawerClose.onclick = () => this.closeDrawer();
        if (drawerBackdrop) drawerBackdrop.onclick = () => this.closeDrawer();

        const copyLinkBtn = document.getElementById('btn-space-copy-link');
        if (copyLinkBtn) copyLinkBtn.onclick = () => this.copyInviteLink();

        const addMemBtn = document.getElementById('btn-space-add-member');
        if (addMemBtn) addMemBtn.onclick = () => this.openAddMemberModal();

        const leaveBtn = document.getElementById('btn-space-leave');
        if (leaveBtn) leaveBtn.onclick = () => this.leaveGroup();

        const addMemCancel = document.getElementById('add-space-member-cancel');
        const addMemConfirm = document.getElementById('add-space-member-confirm');
        if (addMemCancel) addMemCancel.onclick = () => this.closeAddMemberModal();
        if (addMemConfirm) addMemConfirm.onclick = () => this.handleAddMember();

        const chatInfo = document.querySelector('.chat-info');
        const chatAvatar = document.getElementById('chat-avatar');
        const openGroupDetails = (e) => {
            if (state.activeChatId && state.activeChatId.startsWith('grp_')) {
                if (e) { e.preventDefault(); e.stopPropagation(); }
                this.openDrawer(state.activeChatId);
            }
        };
        if (chatInfo) chatInfo.addEventListener('click', openGroupDetails);
        if (chatAvatar) chatAvatar.addEventListener('click', openGroupDetails);

        // Handle URL hash invite link on init & hashchange
        window.addEventListener('hashchange', () => this.handleHashLink());
        setTimeout(() => this.handleHashLink(), 100);
    },

    async handleHashLink() {
        const hash = window.location.hash || '';
        const match = hash.match(/#(?:group|space)=([a-zA-Z0-9_-]+)/);
        if (!match || !match[1]) return;
        const groupId = match[1];
        if (!state.user) return; // Will run after login
        let cached = ChatCache.chats ? ChatCache.chats.find(c => c.other === groupId) : null;
        if (!cached) {
            try {
                const info = await apiFetch(`/api/groups/${groupId}/info`);
                if (info && !info.error) {
                    const isMember = (info.members && typeof info.members === 'object' && info.members[state.user]) ||
                                     (Array.isArray(info.memberList) && info.memberList.some(m => m.username === state.user));
                    if (!isMember) {
                        await apiFetch(`/api/groups/${groupId}/members/add`, {
                            method: 'POST',
                            body: JSON.stringify({ members: [state.user] })
                        });
                    }
                    const totalCount = info.memberCount || (Array.isArray(info.memberList) ? info.memberList.length : 1);
                    cached = {
                        other: groupId,
                        name: info.name || 'Group',
                        topic: info.topic || '',
                        isGroup: true,
                        isSpace: true,
                        memberCount: totalCount,
                        unread: 0,
                        lastMessage: 'Joined via invite link',
                        lastTs: Date.now()
                    };
                    ChatCache.chats.unshift(cached);
                    await ChatCache.saveChats(ChatCache.chats);
                }
            } catch(e) {
                console.warn('[GroupManager] Invite link error:', e);
            }
        }
        switchView('groups');
        openChat(groupId, Date.now());
    },

    async handleCreateGroup() {
        const nameInput = document.getElementById('group-name-input');
        const topicInput = document.getElementById('group-topic-input');
        const membersInput = document.getElementById('group-members-input');
        const err = document.getElementById('group-modal-error');

        const name = nameInput?.value.trim();
        const topic = topicInput?.value.trim() || '';
        const rawMembers = membersInput?.value.trim() || '';

        if (!name) {
            if (err) {
                err.textContent = 'Group name is required';
                err.classList.remove('hidden');
            }
            return;
        }

        const initialMembers = rawMembers ? rawMembers.split(',').map(m => m.trim()).filter(Boolean) : [];
        const memberCount = 1 + initialMembers.length;

        try {
            if (err) err.classList.add('hidden');
            const res = await apiFetch('/api/groups/create', {
                method: 'POST',
                body: JSON.stringify({ name, topic, initialMembers })
            });

            if (res.error) {
                if (err) {
                    err.textContent = res.error;
                    err.classList.remove('hidden');
                }
                return;
            }

            const groupId = res.groupId || res.spaceId;
            const groupItem = {
                other: groupId,
                name: res.name || name,
                topic: res.topic || topic,
                isGroup: true,
                isSpace: true,
                memberCount: memberCount,
                unread: 0,
                lastMessage: 'Group created',
                lastTs: Date.now()
            };

            ChatCache.chats.unshift(groupItem);
            await ChatCache.saveChats(ChatCache.chats);

            closeUserModal(false);
            if (nameInput) nameInput.value = '';
            if (topicInput) topicInput.value = '';
            if (membersInput) membersInput.value = '';

            switchView('groups');
            openChat(groupId, Date.now());
        } catch (e) {
            if (err) {
                err.textContent = e.message || 'Failed to create group';
                err.classList.remove('hidden');
            }
        }
    },

    async openDrawer(groupId) {
        this.activeGroupId = groupId;
        const drawer = document.getElementById('space-drawer');
        if (!drawer) return;

        drawer.classList.remove('hidden');
        BackNavManager.push('space-drawer', () => this.closeDrawer(true));

        const nameEl = document.getElementById('space-drawer-name');
        const topicEl = document.getElementById('space-drawer-topic');
        const countEl = document.getElementById('space-member-count');
        const roleEl = document.getElementById('space-role-badge');
        const listEl = document.getElementById('space-members-list');

        const cached = ChatCache.chats.find(c => c.other === groupId);
        if (nameEl && cached) nameEl.textContent = cached.name || 'Group';
        if (topicEl && cached) topicEl.textContent = cached.topic || '';

        try {
            const info = await apiFetch(`/api/groups/${groupId}/info`);
            if (info && !info.error) {
                if (nameEl) nameEl.textContent = info.name || 'Group';
                if (topicEl) topicEl.textContent = info.topic || 'No description';

                let memberArray = [];
                if (Array.isArray(info.memberList)) {
                    memberArray = info.memberList;
                } else if (Array.isArray(info.members)) {
                    memberArray = info.members;
                } else if (info.members && typeof info.members === 'object') {
                    memberArray = Object.entries(info.members).map(([username, data]) => ({
                        username,
                        role: data?.role || 'member',
                        joinedAt: data?.joinedAt
                    }));
                }

                const totalCount = info.memberCount || memberArray.length || 0;
                if (countEl) countEl.textContent = totalCount;

                if (cached) {
                    cached.memberCount = totalCount;
                    if (info.name) cached.name = info.name;
                    if (info.topic) cached.topic = info.topic;
                    ChatCache.saveChats(ChatCache.chats).catch(() => {});
                }

                const myMember = memberArray.find(m => m.username === state.user);
                const myRole = myMember?.role || (info.members && typeof info.members === 'object' ? info.members[state.user]?.role : 'member') || 'member';
                if (roleEl) roleEl.textContent = myRole.toUpperCase();

                const isLeader = myRole === 'founder' || myRole === 'moderator';

                if (listEl) {
                    listEl.innerHTML = '';
                    memberArray.forEach(m => {
                        const row = document.createElement('div');
                        row.className = 'space-member-row';
                        const isSelf = m.username === state.user;
                        const canRemove = isLeader && !isSelf && m.role !== 'founder';

                        row.innerHTML = `
                            <div class="space-member-left">
                                <span class="space-member-name">${escapeHtml(m.username)}${isSelf ? ' (You)' : ''}</span>
                                <span class="space-member-role-tag role-${m.role}">${m.role}</span>
                            </div>
                            ${canRemove ? `
                                <button type="button" class="btn-remove-member" data-user="${escapeHtml(m.username)}" title="Remove member">
                                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                </button>
                            ` : ''}
                        `;

                        if (canRemove) {
                            const rmBtn = row.querySelector('.btn-remove-member');
                            rmBtn.onclick = () => this.removeMember(m.username);
                        }

                        listEl.appendChild(row);
                    });
                }
            }
        } catch (e) {
            console.warn('[GroupManager] info fetch failed:', e);
        }
    },

    closeDrawer(fromPop = false) {
        const drawer = document.getElementById('space-drawer');
        if (drawer) drawer.classList.add('hidden');
        if (!fromPop && BackNavManager.has('space-drawer')) {
            BackNavManager.pop('space-drawer');
        }
    },

    async copyInviteLink() {
        if (!this.activeGroupId) return;
        const link = `${window.location.origin}/#group=${this.activeGroupId}`;
        try {
            await navigator.clipboard.writeText(link);
            const btn = document.getElementById('btn-space-copy-link');
            if (btn) {
                const orig = btn.innerHTML;
                btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg><span>Copied!</span>`;
                setTimeout(() => { btn.innerHTML = orig; }, 2000);
            }
        } catch (e) {
            prompt('Copy Group Link:', link);
        }
    },

    openAddMemberModal() {
        const modal = document.getElementById('add-space-member-modal');
        const inp = document.getElementById('add-space-member-input');
        const err = document.getElementById('add-space-member-error');
        if (inp) inp.value = '';
        if (err) err.classList.add('hidden');
        if (modal) modal.classList.remove('hidden');
    },

    closeAddMemberModal() {
        const modal = document.getElementById('add-space-member-modal');
        if (modal) modal.classList.add('hidden');
    },

    async handleAddMember() {
        const inp = document.getElementById('add-space-member-input');
        const err = document.getElementById('add-space-member-error');
        const username = inp?.value.trim();

        if (!username) {
            if (err) { err.textContent = 'Enter a username'; err.classList.remove('hidden'); }
            return;
        }

        try {
            const check = await apiFetch(`/api/users/${username}/check`);
            if (!check.exists) {
                if (err) { err.textContent = 'User does not exist'; err.classList.remove('hidden'); }
                return;
            }

            const res = await apiFetch(`/api/groups/${this.activeGroupId}/members/add`, {
                method: 'POST',
                body: JSON.stringify({ username })
            });

            if (res.error) {
                if (err) { err.textContent = res.error; err.classList.remove('hidden'); }
                return;
            }

            this.closeAddMemberModal();
            this.openDrawer(this.activeGroupId);
        } catch (e) {
            if (err) { err.textContent = e.message || 'Failed to add member'; err.classList.remove('hidden'); }
        }
    },

    async removeMember(username) {
        if (!confirm(`Remove ${username} from this group?`)) return;
        try {
            await apiFetch(`/api/groups/${this.activeGroupId}/members/remove`, {
                method: 'POST',
                body: JSON.stringify({ username })
            });
            this.openDrawer(this.activeGroupId);
        } catch (e) {
            alert('Failed to remove member: ' + e.message);
        }
    },

    async leaveGroup() {
        if (!confirm('Leave this group? You will no longer receive its messages.')) return;
        try {
            await apiFetch(`/api/groups/${this.activeGroupId}/leave`, {
                method: 'POST',
                body: JSON.stringify({})
            });
            ChatCache.chats = ChatCache.chats.filter(c => c.other !== this.activeGroupId);
            await ChatCache.saveChats(ChatCache.chats);
            this.closeDrawer();
            closeActiveChat();
            renderChatList();
        } catch (e) {
            alert('Failed to leave group: ' + e.message);
        }
    }
};

const RandomChatManager = {
    ws: null,
    activeTopic: 'all',
    activeRoomId: null,
    isConnected: false,
    isSearching: false,
    friendState: 'none', // 'none' | 'sent' | 'received' | 'accepted'
    friendFromUser: null,
    searchTimerInterval: null,
    searchStartTime: 0,

    init() {
        const keywordsContainer = document.getElementById('random-keywords-list');
        if (keywordsContainer) {
            keywordsContainer.addEventListener('click', (e) => {
                const chip = e.target.closest('.random-keyword-chip');
                if (!chip) return;
                keywordsContainer.querySelectorAll('.random-keyword-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                this.activeTopic = chip.dataset.topic || 'all';
                if (this.isSearching) {
                    this.startSearch();
                }
            });
        }

        const endBtn = document.getElementById('btn-random-end');
        const skipBtn = document.getElementById('btn-random-skip');
        const addBtn = document.getElementById('btn-random-add');
        const searchNowBtn = document.getElementById('btn-random-search-now');

        if (endBtn) {
            endBtn.onclick = (e) => {
                if (e) { e.preventDefault(); e.stopPropagation(); }
                this.endChat();
            };
        }
        if (skipBtn) {
            skipBtn.onclick = (e) => {
                if (e) { e.preventDefault(); e.stopPropagation(); }
                this.skipPeer();
            };
        }
        if (addBtn) {
            addBtn.onclick = (e) => {
                if (e) { e.preventDefault(); e.stopPropagation(); }
                this.sendFriendRequest();
            };
        }
        if (searchNowBtn) {
            searchNowBtn.onclick = (e) => {
                if (e) { e.preventDefault(); e.stopPropagation(); }
                if (this.isSearching) return; // Guard against rapid duplicate clicks
                this.startSearch();
            };
        }
    },

    startSearchTimer() {
        this.stopSearchTimer();
        this.searchStartTime = Date.now();
        const timerEl = document.getElementById('random-search-timer');
        const timerBadge = document.getElementById('random-timer-badge');
        if (timerBadge) timerBadge.classList.remove('hidden');
        if (timerEl) timerEl.textContent = '00:00';

        this.searchTimerInterval = setInterval(() => {
            const elapsedSec = Math.floor((Date.now() - this.searchStartTime) / 1000);
            const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
            const ss = String(elapsedSec % 60).padStart(2, '0');
            if (timerEl) timerEl.textContent = `${mm}:${ss}`;
        }, 1000);
    },

    stopSearchTimer() {
        if (this._pingInterval) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
        if (this.searchTimerInterval) {
            clearInterval(this.searchTimerInterval);
            this.searchTimerInterval = null;
        }
    },

    openRandomChat() {
        state.activeView = 'random';
        state.isRandom = true;
        state.isGroup = false;
        state.activePeer = 'Random';

        document.querySelectorAll('.convoo-nav-tab').forEach(btn => {
            const isSelected = btn.dataset.view === 'random';
            btn.classList.toggle('active', isSelected);
            btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        });

        document.body.classList.add('show-chat');
        if (window.innerWidth <= 768 || document.body.classList.contains('show-chat')) {
            BackNavManager.push('chat', () => {
                closeActiveChat(true);
            });
        }

        document.getElementById('no-chat-selected')?.classList.add('hidden');
        document.getElementById('active-chat-container')?.classList.remove('hidden');

        // Navigation board (End, Skip, Add Friend) MUST ONLY be visible when connected
        const actionBar = document.getElementById('random-action-bar');
        const centerMenu = document.getElementById('random-center-menu');
        const chatTitle = document.getElementById('chat-title');
        const connStatus = document.getElementById('connection-status');
        const chatAvatar = document.getElementById('chat-avatar');

        if (chatAvatar) {
            chatAvatar.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/></svg>`;
            chatAvatar.style.backgroundImage = '';
            chatAvatar.classList.remove('has-pic');
        }

        if (this.isConnected && this.activeRoomId) {
            if (actionBar) actionBar.classList.remove('hidden');
            document.getElementById('active-chat-container')?.classList.add('has-random-bar');
            if (centerMenu) centerMenu.classList.add('hidden');
            if (chatTitle) chatTitle.textContent = 'Anonymous';
            if (connStatus) connStatus.textContent = 'Online';
        } else {
            if (actionBar) actionBar.classList.add('hidden');
            document.getElementById('active-chat-container')?.classList.remove('has-random-bar');
            if (centerMenu) centerMenu.classList.remove('hidden');
            if (chatTitle) chatTitle.textContent = '-';
            if (connStatus) connStatus.textContent = 'Looking for someone...';
            
            // Clear any lingering direct messages from the DOM
            state.messages = [];
            const msgsList = document.getElementById('messages-list');
            if (msgsList) msgsList.innerHTML = '';
            
            this.startSearch();
        }
    },

    startSearch() {
        this.stopSearchTimer();
        this.isConnected = false;
        this.isSearching = true;
        this.friendState = 'none';
        this.friendFromUser = null;
        this.activeRoomId = null;
        state.activeChatId = null;
        state.activePeer = null;
        state.isRandom = true;
        this.updateAddFriendButton('none');

        // Close existing chat room socket if active
        if (state.ws) {
            try { state.ws.close(); } catch(e) {}
            state.ws = null;
        }

        // Action bar, history banners, and clearance class MUST BE HIDDEN while searching
        document.getElementById('random-action-bar')?.classList.add('hidden');
        document.getElementById('active-chat-container')?.classList.remove('has-random-bar');
        document.getElementById('load-history-banner')?.remove();

        // Start live elapsed timer
        this.startSearchTimer();

        const chatTitle = document.getElementById('chat-title');
        const connStatus = document.getElementById('connection-status');
        const centerMenu = document.getElementById('random-center-menu');
        const centerTitle = document.getElementById('random-center-title');
        const searchBtnLabel = document.getElementById('random-search-btn-label');
        const spinner = document.getElementById('random-search-spinner');

        // Username is "-" while searching
        if (chatTitle) chatTitle.textContent = '-';
        if (connStatus) connStatus.textContent = 'Looking for someone...';
        if (centerMenu) centerMenu.classList.remove('hidden');
        if (centerTitle) centerTitle.textContent = 'Finding someone to chat with...';
        if (searchBtnLabel) searchBtnLabel.textContent = 'Looking for someone...';
        if (spinner) spinner.classList.remove('hidden');

        state.messages = [];
        const msgsList = document.getElementById('messages-list');
        if (msgsList) msgsList.innerHTML = '';

        const token = localStorage.getItem('fc_token') || localStorage.getItem('token') || '';
        const myUserId = state.user || ('anon_' + Math.random().toString(36).slice(2, 8));
        const wsBase = API_BASE.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
        const wsUrl = `${wsBase}/api/pulse/ws?token=${encodeURIComponent(token)}&topic=${encodeURIComponent(this.activeTopic)}&userId=${encodeURIComponent(myUserId)}`;

        if (this.ws) {
            try { this.ws.close(); } catch(e) {}
            this.ws = null;
        }

        if (this._pingInterval) clearInterval(this._pingInterval);

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('[Random] Connected to matchmaker');
            // Keepalive ping every 20s to prevent Cloudflare Worker DO socket timeout
            if (this._pingInterval) clearInterval(this._pingInterval);
            this._pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch(e) {}
                }
            }, 20000);
        };

        this.ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                this.handleMatchmakerMessage(msg);
            } catch(err) {
                console.warn('[Random] Matchmaker parse error:', err);
            }
        };

        this.ws.onerror = (err) => {
            console.warn('[Random] WebSocket error:', err);
            if (connStatus) connStatus.textContent = 'Connection error. Retrying...';
        };

        this.ws.onclose = () => {
            console.log('[Random] Socket closed');
            if (this._pingInterval) clearInterval(this._pingInterval);
            if (this.isSearching && !this.isConnected) {
                setTimeout(() => {
                    if (this.isSearching && !this.isConnected) {
                        this.startSearch();
                    }
                }, 2000);
            }
        };
    },

    handleMatchmakerMessage(msg) {
        switch (msg.type) {
            case 'searching':
                const connStatus = document.getElementById('connection-status');
                if (connStatus) connStatus.textContent = 'Looking for someone...';
                break;

            case 'matched':
                this.stopSearchTimer();
                this.activeRoomId = msg.roomId;
                this.isConnected = true;
                this.isSearching = false;
                this.friendState = 'none';
                this.friendFromUser = null;

                state.activeChatId = msg.roomId;
                state.activePeer = 'Anonymous';
                state.isRandom = true;

                // Converts to "Anonymous" on top bar when connected
                const chatTitle = document.getElementById('chat-title');
                if (chatTitle) chatTitle.textContent = 'Anonymous';

                const statusEl = document.getElementById('connection-status');
                if (statusEl) statusEl.textContent = 'Online';

                // Middle finding menu disappears, End/Skip/Add Friend action bar appears!
                document.getElementById('random-center-menu')?.classList.add('hidden');
                document.getElementById('random-action-bar')?.classList.remove('hidden');
                document.getElementById('active-chat-container')?.classList.add('has-random-bar');

                state.messages = [];
                const msgsList = document.getElementById('messages-list');
                if (msgsList) msgsList.innerHTML = '';

                this.updateAddFriendButton('none');

                // Connect active chat room WebSocket
                connectWS(msg.roomId);
                break;

            case 'peer_disconnected':
                this.handlePeerDisconnected();
                break;
        }
    },

    handlePeerDisconnected() {
        if (!this.isConnected && !this.isSearching) return;
        this.stopSearchTimer();
        state._connectedChatId = null;
        this.isConnected = false;
        this.isSearching = false;

        const cs = document.getElementById('connection-status');
        if (cs) {
            cs.textContent = 'Stranger disconnected';
            cs.classList.remove('online');
        }
        const ct = document.getElementById('chat-title');
        if (ct) ct.textContent = 'Stranger (Left)';

        this.appendChatNotice('Stranger has left the chat. Click Skip to find a new person.');
        this.updateAddFriendButton('none');
        const addBtn = document.getElementById('btn-random-add');
        if (addBtn) addBtn.disabled = true;

        if (state.ws) {
            try { state.ws.close(); } catch(e) {}
            state.ws = null;
        }
    },

    skipPeer() {
        this.stopSearchTimer();
        state._connectedChatId = null;
        // 1. Notify peer that we're skipping
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            try {
                state.ws.send(JSON.stringify({ type: 'peer_disconnected' }));
            } catch(e) {}
        }
        // 2. Disconnect room socket
        if (state.ws) {
            try { state.ws.close(); } catch(e) {}
            state.ws = null;
        }

        // 3. Clear messages
        state.messages = [];
        const msgsList = document.getElementById('messages-list');
        if (msgsList) msgsList.innerHTML = '';

        // 4. Update UI
        this.isConnected = false;
        this.friendState = 'none';
        this.friendFromUser = null;
        this.updateAddFriendButton('none');
        document.getElementById('random-action-bar')?.classList.add('hidden');
        document.getElementById('active-chat-container')?.classList.remove('has-random-bar');

        // 5. Send skip to matchmaker and start search
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ type: 'skip', topic: this.activeTopic }));
            } catch(e) {}
        }
        this.startSearch();
    },

    endChat() {
        this.stopSearchTimer();
        state._connectedChatId = null;
        // 1. Notify peer that we're ending
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            try {
                state.ws.send(JSON.stringify({ type: 'peer_disconnected' }));
            } catch(e) {}
        }
        // 2. Disconnect room socket
        if (state.ws) {
            try { state.ws.close(); } catch(e) {}
            state.ws = null;
        }
        // 3. Close matchmaker socket
        if (this.ws) {
            try {
                this.ws.send(JSON.stringify({ type: 'disconnect' }));
                this.ws.close();
            } catch(e) {}
            this.ws = null;
        }

        this.isConnected = false;
        this.isSearching = false;
        this.activeRoomId = null;
        state.activeChatId = null;

        state.messages = [];
        const msgsList = document.getElementById('messages-list');
        if (msgsList) msgsList.innerHTML = '';

        // Action bar is hidden
        document.getElementById('random-action-bar')?.classList.add('hidden');
        document.getElementById('active-chat-container')?.classList.remove('has-random-bar');

        // Center menu displays chat ended
        const centerMenu = document.getElementById('random-center-menu');
        const centerTitle = document.getElementById('random-center-title');
        const searchBtnLabel = document.getElementById('random-search-btn-label');
        const spinner = document.getElementById('random-search-spinner');
        const timerBadge = document.getElementById('random-timer-badge');

        const chatTitle = document.getElementById('chat-title');
        const connStatus = document.getElementById('connection-status');

        if (chatTitle) chatTitle.textContent = '-';
        if (connStatus) {
            connStatus.textContent = 'Chat ended';
            connStatus.classList.remove('online');
        }
        if (centerMenu) centerMenu.classList.remove('hidden');
        if (centerTitle) centerTitle.textContent = 'Chat ended';
        if (searchBtnLabel) searchBtnLabel.textContent = 'Find New Chat';
        if (spinner) spinner.classList.add('hidden');
        if (timerBadge) timerBadge.classList.add('hidden');

        this.updateAddFriendButton('none');
    },

    onChatClosed(cleanDb = true) {
        this.stopSearchTimer();
        state._connectedChatId = null;
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            if (this.friendState !== 'accepted') {
                try { state.ws.send(JSON.stringify({ type: 'peer_disconnected' })); } catch(e) {}
            }
        }
        if (state.ws) {
            try { state.ws.close(); } catch(e) {}
            state.ws = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch(e) {}
            this.ws = null;
        }
        const lastRoom = this.activeRoomId;
        this.isConnected = false;
        this.isSearching = false;
        this.activeRoomId = null;
        document.getElementById('random-action-bar')?.classList.add('hidden');
        document.getElementById('random-center-menu')?.classList.add('hidden');
        document.getElementById('active-chat-container')?.classList.remove('has-random-bar');

        if (cleanDb && lastRoom && lastRoom.startsWith('rnd_')) {
            try {
                ChatCache.clearMessages(lastRoom);
            } catch(e) {}
        }
    },

    // Friend Request Architecture (Sent as in-chat text, not popup)
    sendFriendRequest() {
        if (!this.isConnected || !this.activeRoomId) return;
        if (this.friendState === 'sent' || this.friendState === 'accepted') return;

        if (this.friendState === 'received' && this.friendFromUser) {
            this.acceptFriendRequest(this.friendFromUser);
            return;
        }

        const myUser = state.user || 'Anonymous';
        const msgText = `Friend request from ${myUser}`;

        // Send as a real in-chat text message
        if (typeof window.sendDirectCustomMessage === 'function') {
            window.sendDirectCustomMessage(msgText, {
                friendRequest: {
                    from: myUser,
                    status: 'pending'
                }
            });
        }

        // Also broadcast via WS event for instant action bar update
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            try {
                state.ws.send(JSON.stringify({
                    type: 'friend_request',
                    fromUser: myUser
                }));
            } catch(e) {}
        }

        this.friendState = 'sent';
        this.updateAddFriendButton('sent');
    },

    onFriendRequestReceived(fromUser) {
        if (!fromUser || fromUser === state.user) return;

        this.friendState = 'received';
        this.friendFromUser = fromUser;
        this.updateAddFriendButton('received');

        // Check if already in DOM
        const existingBubble = document.getElementById(`inline-freq-${fromUser}`) ||
                               document.querySelector('.inline-friend-req-box');
        if (existingBubble) return;

        // If not already rendered via sendDirectCustomMessage, render as an in-chat text message bubble
        const msgId = `freq-${Date.now()}`;
        const fakeMsg = {
            id: msgId,
            clientId: msgId,
            from: fromUser,
            text: `Friend request from ${fromUser}`,
            ts: Date.now(),
            friendRequest: {
                from: fromUser,
                status: 'pending'
            }
        };
        renderMessages([fakeMsg], true);
        scrollToBottom(true);
    },

    async acceptFriendRequest(targetUser, boxEl) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'friend_accept',
                fromUser: state.user,
                targetUser: targetUser
            }));
        }

        this.friendState = 'accepted';
        this.updateAddFriendButton('accepted');

        const iconCheck = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:6px;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
        if (boxEl) {
            boxEl.innerHTML = `<div class="inline-friend-req-text" style="color: #22c55e; font-weight: 500;">${iconCheck}You and <strong>${escapeHtml(targetUser)}</strong> are now friends! Opening Direct chat...</div>`;
        }

        // Send confirmation as a text message in the chat
        if (typeof window.sendDirectCustomMessage === 'function') {
            window.sendDirectCustomMessage(`Friend request accepted! You and ${targetUser} are now friends.`, {
                friendRequest: {
                    from: state.user,
                    target: targetUser,
                    status: 'accepted'
                }
            });
        }

        try {
            await apiFetch('/api/random/add_friend', {
                method: 'POST',
                body: JSON.stringify({ userA: targetUser, userB: state.user })
            });

            await ChatCache.addChat(targetUser, false);
            refreshChatList();
        } catch(e) {
            console.warn('[Random] Add friend save error:', e);
        }

        // Close Random room and open Direct chat with friend
        setTimeout(() => {
            if (window.RandomChatManager) {
                window.RandomChatManager.onChatClosed();
            }
            switchView('direct');
            openChat(targetUser);
        }, 1400);
    },

    declineFriendRequest(targetUser, boxEl) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({
                type: 'friend_decline',
                fromUser: state.user,
                targetUser: targetUser
            }));
        }

        this.friendState = 'none';
        this.updateAddFriendButton('none');

        const iconClose = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:6px;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
        if (boxEl) {
            boxEl.innerHTML = `<div class="inline-friend-req-text" style="opacity: 0.7;">${iconClose}Friend request declined</div>`;
        }
    },

    async onFriendConfirmed(userA, userB) {
        this.friendState = 'accepted';
        this.updateAddFriendButton('accepted');

        const otherUser = (userA === state.user) ? userB : userA;
        const iconCheck = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:6px;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;

        // Update inline friend request bubble if present
        const inlineBox = document.querySelector('.inline-friend-req-box');
        if (inlineBox) {
            inlineBox.innerHTML = `<div class="inline-friend-req-text" style="color: #22c55e; font-weight: 500;">${iconCheck}You and <strong>${escapeHtml(otherUser)}</strong> are now friends! Opening Direct chat...</div>`;
        }

        try {
            await ChatCache.addChat(otherUser, false);
            refreshChatList();
        } catch(e) {
            console.warn('[Random] friend confirm cache error:', e);
        }

        // Automatically switch to Direct tab and open 1:1 chat with the new friend
        setTimeout(() => {
            if (window.RandomChatManager) {
                window.RandomChatManager.onChatClosed();
            }
            switchView('direct');
            openChat(otherUser);
        }, 1400);
    },

    onFriendDeclined(fromUser) {
        this.friendState = 'none';
        this.updateAddFriendButton('none');
        const iconClose = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:6px;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
        const inlineBox = document.querySelector('.inline-friend-req-box');
        if (inlineBox) {
            inlineBox.innerHTML = `<div class="inline-friend-req-text" style="opacity: 0.7;">${iconClose}Friend request was declined.</div>`;
        }
    },

    updateAddFriendButton(status) {
        const btn = document.getElementById('btn-random-add');
        const label = document.getElementById('btn-random-add-label');
        if (!btn || !label) return;

        if (status === 'none') {
            label.textContent = 'Add Friend';
            btn.disabled = !this.isConnected;
            btn.classList.remove('active', 'pending');
        } else if (status === 'sent') {
            label.textContent = 'Request Sent';
            btn.disabled = true;
            btn.classList.add('pending');
            btn.classList.remove('active');
        } else if (status === 'received') {
            label.textContent = 'Accept Friend';
            btn.disabled = false;
            btn.classList.add('active');
            btn.classList.remove('pending');
        } else if (status === 'accepted') {
            label.textContent = 'Friends';
            btn.disabled = true;
            btn.classList.remove('pending');
            btn.classList.add('active');
        }
    },

    appendChatNotice(text) {
        const msgsList = document.getElementById('messages-list');
        if (!msgsList) return;
        const div = document.createElement('div');
        div.className = 'random-chat-notice';
        div.textContent = text;
        msgsList.appendChild(div);
        scrollToBottom(true);
    }
};

// Auto-initialize modules when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initConvooNavigation();
        GroupManager.init();
        RandomChatManager.init();
    });
} else {
    initConvooNavigation();
    GroupManager.init();
    RandomChatManager.init();
}

// Global exports for integrations
window.openChat = openChat;
window.refreshChatList = refreshChatList;
window.ChatCache = ChatCache;
window.GroupManager = GroupManager;
window.RandomChatManager = RandomChatManager;
window.switchView = switchView;

// Notify peer immediately if the tab or window is explicitly closed
window.addEventListener('beforeunload', () => {
    if (state.isRandom && state.ws && state.ws.readyState === WebSocket.OPEN) {
        try {
            state.ws.send(JSON.stringify({ type: 'peer_disconnected' }));
        } catch(e) {}
    }
    if (window.RandomChatManager && window.RandomChatManager.ws && window.RandomChatManager.ws.readyState === WebSocket.OPEN) {
        try {
            window.RandomChatManager.ws.send(JSON.stringify({ type: 'disconnect' }));
        } catch(e) {}
    }
});

