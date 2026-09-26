/* ==========================================================================
   watchparty.js — FastChat 120 FPS Floating Synchronized Watch Party Engine
   ========================================================================== */

(function(window) {
    'use strict';

    // Strict YouTube URL Regex
    const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;

    let ytApiLoaded = false;
    let ytApiReadyCallbacks = [];
    let ytApiLoadingTimeout = null;

    function loadYouTubeApi() {
        return new Promise((resolve) => {
            if (window.YT && window.YT.Player) {
                ytApiLoaded = true;
                return resolve(window.YT);
            }
            ytApiReadyCallbacks.push(resolve);

            const drainCallbacks = (api) => {
                ytApiLoaded = true;
                if (ytApiLoadingTimeout) {
                    clearInterval(ytApiLoadingTimeout);
                    ytApiLoadingTimeout = null;
                }
                while (ytApiReadyCallbacks.length > 0) {
                    const cb = ytApiReadyCallbacks.shift();
                    try { cb(api || window.YT); } catch(e) {}
                }
            };

            const existingScript = document.getElementById('yt-iframe-api-script');
            if (!existingScript) {
                const tag = document.createElement('script');
                tag.id = 'yt-iframe-api-script';
                tag.src = 'https://www.youtube.com/iframe_api';
                tag.async = true;
                tag.onerror = () => {
                    console.warn('[WatchParty] Failed to load YouTube iframe API script. Retrying...');
                    setTimeout(() => {
                        if (!window.YT || !window.YT.Player) {
                            tag.remove();
                            loadYouTubeApi().then(resolve);
                        }
                    }, 1500);
                };
                const firstScript = document.getElementsByTagName('script')[0];
                if (firstScript && firstScript.parentNode) {
                    firstScript.parentNode.insertBefore(tag, firstScript);
                } else {
                    document.head.appendChild(tag);
                }

                window.onYouTubeIframeAPIReady = () => {
                    drainCallbacks(window.YT);
                };
            }

            // Fallback watchdog timer for slow/poor networks (15s):
            // Poll for window.YT in case onYouTubeIframeAPIReady was missed or delayed
            if (!ytApiLoadingTimeout) {
                let attempts = 0;
                ytApiLoadingTimeout = setInterval(() => {
                    attempts++;
                    if (window.YT && window.YT.Player) {
                        drainCallbacks(window.YT);
                    } else if (attempts > 30) { // 15 seconds
                        console.warn('[WatchParty] YouTube API load timed out. Resolving with fallback.');
                        drainCallbacks(window.YT || null);
                    }
                }, 500);
            }
        });
    }

    function formatTime(sec) {
        sec = Math.max(0, Math.floor(sec || 0));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    class WatchPartyManager {
        constructor() {
            this.mode = 'youtube'; // 'youtube' | 'local'
            this.localVideo = null;
            this.localVideoUrl = null;
            this.localFile = null;

            this.active = false;
            this.videoId = null;
            this.url = null;
            this.title = 'Watch Party';
            this.player = null;
            this.isHost = false;
            this.isMinimized = false;
            this.isFullscreen = false;
            this.lastSyncState = 'paused';
            this.isAutoplayBlocked = false; // Tracks if mobile browser blocked unmuted play without gesture
            
            // Robust Anti-Jitter & Anti-Ping-Pong Timestamps
            this.isRemoteSyncing = false;
            this.isScrubbing = false;
            this.isBuffering = false;
            this._pausedForFriendBuffering = false;
            this._bufferingSafetyTimer = null;
            this.lastSyncSeekTs = 0;
            this._suppressBroadcastUntil = 0;
            this._lastReportedTime = 0;
            this._lastDetectedState = -1;
            
            this.heartbeatInterval = null;
            this.pollStateInterval = null;
            this.httpFallbackInterval = null;
            
            // 120 FPS GPU Coordinates & Size
            this.posX = 16;
            this.posY = 70;
            this.width = Math.min(340, Math.floor(window.innerWidth * 0.9));
            this.isDragging = false;
            this.isResizing = false;
            this.dragStartX = 0;
            this.dragStartY = 0;
            this.windowStartX = 0;
            this.windowStartY = 0;
            this.initialWidth = 340;
            this.initialPinchDist = 0;
            this._dragRaf = null;

            this.dom = {
                container: null,
                card: null,
                header: null,
                titleText: null,
                statusBadge: null,
                resyncBtn: null,
                videoBox: null,
                dragShield: null,
                bubble: null,
                resizeHandle: null,
                minimizeBtn: null,
                fullscreenBtn: null,
                closeBtn: null,
                // Dedicated Controls Bar
                playPauseBtn: null,
                playIconSlot: null,
                rewindBtn: null,
                forwardBtn: null,
                seekSlider: null,
                timeText: null
            };
        }

        getCurrentTime() {
            if (this.mode === 'local') {
                return this.localVideo ? this.localVideo.currentTime : 0;
            }
            return (this.player && typeof this.player.getCurrentTime === 'function') ? this.player.getCurrentTime() : 0;
        }

        getDuration() {
            if (this.mode === 'local') {
                const d = this.localVideo ? this.localVideo.duration : 0;
                if (d && isFinite(d) && d > 0) return d;
                if (this.cinemaDuration && isFinite(this.cinemaDuration) && this.cinemaDuration > 0) return this.cinemaDuration;
                return 0;
            }
            return (this.player && typeof this.player.getDuration === 'function') ? this.player.getDuration() : 0;
        }

        getPlayerState() {
            if (this.mode === 'local') {
                if (!this.localVideo) return -1;
                if (this.localVideo.paused) return 2; // paused (Checked first so paused video doesn't show as buffering)
                if (this.localVideo.seeking || this.localVideo.readyState < 2) return 3; // buffering (readyState < 2 means lack of renderable data)
                return 1; // playing
            }
            return (this.player && typeof this.player.getPlayerState === 'function') ? this.player.getPlayerState() : 0;
        }

        closePlayerInstance() {
            if (this.localVideo) {
                try {
                    this.localVideo.pause();
                    this.localVideo.removeAttribute('src');
                    this.localVideo.load();
                } catch(e) {}
                try { this.localVideo.remove(); } catch(e) {}
                this.localVideo = null;
            }
            if (this.localVideoUrl) {
                try { URL.revokeObjectURL(this.localVideoUrl); } catch(e) {}
                this.localVideoUrl = null;
            }
            this.localFile = null;
            this._pendingSeekTarget = null;
            if (this._seekDebounceTimer) {
                clearTimeout(this._seekDebounceTimer);
                this._seekDebounceTimer = null;
            }

            if (this.player && typeof this.player.destroy === 'function') {
                try { this.player.destroy(); } catch(e) {}
                this.player = null;
            }
        }

        extractYouTubeId(str) {
            if (!str || typeof str !== 'string') return null;
            if (str.includes('instagram.com') || str.includes('instagr.am')) return null;
            const match = str.match(YOUTUBE_REGEX);
            return match ? match[1] : null;
        }

        startWithVideoId(videoId) {
            if (!videoId) return;
            const cleanId = this.extractYouTubeId(videoId) || videoId;
            return this.startParty(cleanId, `https://youtu.be/${cleanId}`, true, 0);
        }

        init() {
            if (this.dom.container) return;
            
            let container = document.getElementById('floating-watch-party');
            if (!container) {
                container = document.createElement('div');
                container.id = 'floating-watch-party';
                container.className = 'fwp-container hidden';
                container.innerHTML = `
                    <div class="fwp-card" id="fwp-card">
                        <!-- Top Header Bar -->
                        <div class="fwp-header" id="fwp-header" title="Drag to move">
                            <div class="fwp-info" id="fwp-info" title="Tap to view full movie name">
                                <div class="fwp-icon-wrapper">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg>
                                </div>
                                <span class="fwp-title" id="fwp-title">Watch Party</span>
                                <button type="button" class="fwp-title-reveal-btn" id="fwp-title-reveal" title="Show full movie name">
                                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                </button>
                                <div class="fwp-badge" id="fwp-badge">
                                    <span class="fwp-badge-dot"></span>
                                    <span class="fwp-badge-text">Synced</span>
                                </div>
                            </div>
                            <div class="fwp-actions">
                                <button type="button" class="fwp-btn" id="fwp-resync" title="Instant Re-sync">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
                                </button>
                                <button type="button" class="fwp-btn" id="fwp-minimize" title="Minimize">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                </button>
                                <button type="button" class="fwp-btn" id="fwp-fullscreen" title="Fullscreen">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
                                </button>
                                <button type="button" class="fwp-btn fwp-close" id="fwp-close" title="Close">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                </button>
                            </div>
                        </div>

                        <!-- Full Movie Title Banner (Expandable) -->
                        <div class="fwp-title-banner hidden" id="fwp-title-banner">
                            <div class="fwp-title-banner-content">
                                <span class="fwp-title-banner-label">Movie Name:</span>
                                <span class="fwp-title-banner-text" id="fwp-title-banner-text"></span>
                            </div>
                            <div class="fwp-title-banner-actions">
                                <button type="button" class="fwp-copy-title-btn" id="fwp-copy-title-btn" title="Copy movie name">
                                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                    <span>Copy</span>
                                </button>
                                <button type="button" class="fwp-close-banner-btn" id="fwp-close-banner-btn" title="Close">✕</button>
                            </div>
                        </div>
                        
                        <!-- 16:9 Clean Video Box -->
                        <div class="fwp-video-box" id="fwp-video-box">
                            <div id="fwp-yt-player-slot"></div>
                            <!-- 10-Bit Codec Diagnostic Banner -->
                            <div class="fwp-codec-warning hidden" id="fwp-codec-warning">
                                <div class="fwp-codec-icon">
                                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#fbbf24" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                                </div>
                                <div class="fwp-codec-text">
                                    <strong>10-Bit Codec / Audio-Only Notice:</strong>
                                    <span>Android Chrome lacks hardware decoders for 10-bit video (10Bit/Hi10P/Main10). If screen is black while audio plays, please use standard 8-bit MP4/MKV files on mobile.</span>
                                </div>
                                <button type="button" class="fwp-codec-dismiss" id="fwp-codec-dismiss" title="Dismiss">✕</button>
                            </div>
                            <!-- Shield active ONLY during drag/resize -->
                            <div class="fwp-drag-shield hidden" id="fwp-drag-shield"></div>
                            <!-- Corner Resize Handle with High-Affordance Grip -->
                            <div class="fwp-resize-handle" id="fwp-resize-handle" title="Drag to Resize">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                                    <line x1="20" y1="8" x2="8" y2="20"></line>
                                    <line x1="20" y1="13" x2="13" y2="20"></line>
                                    <line x1="20" y1="18" x2="18" y2="20"></line>
                                </svg>
                            </div>
                        </div>

                        <!-- Dedicated Thumb-Friendly Control & Seekbar Bar -->
                        <div class="fwp-controls-bar" id="fwp-controls-bar">
                            <button type="button" class="fwp-ctrl-btn fwp-play-pause-btn" id="fwp-play-pause-btn" title="Play/Pause">
                                <div id="fwp-play-icon-slot">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>
                                </div>
                            </button>
                            <button type="button" class="fwp-ctrl-btn" id="fwp-rewind-btn" title="Rewind 10s">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9l5 4V5z"/><path d="M18 5l-5 4 5 4V5z"/></svg>
                            </button>
                            <button type="button" class="fwp-ctrl-btn" id="fwp-forward-btn" title="Forward 10s">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5l5 4-5 4V5z"/><path d="M6 5l5 4-5 4V5z"/></svg>
                            </button>
                            <div class="fwp-seek-container" id="fwp-seek-container">
                                <input type="range" class="fwp-seek-slider" id="fwp-seek-slider" min="0" max="100" value="0" step="0.1">
                            </div>
                            <div class="fwp-time-text" id="fwp-time-text">0:00 / 0:00</div>
                        </div>
                    </div>
                    
                    <!-- Minimized 56px Floating Audio Bubble -->
                    <div class="fwp-bubble hidden" id="fwp-bubble" title="Tap to expand video">
                        <div class="fwp-bubble-ring"></div>
                        <div class="fwp-bubble-icon">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg>
                        </div>
                    </div>
                `;
                document.body.appendChild(container);
            }

            this.dom.container = container;
            this.dom.card = container.querySelector('#fwp-card');
            this.dom.header = container.querySelector('#fwp-header');
            this.dom.infoWrapper = container.querySelector('#fwp-info');
            this.dom.titleText = container.querySelector('#fwp-title');
            this.dom.titleRevealBtn = container.querySelector('#fwp-title-reveal');
            this.dom.titleBanner = container.querySelector('#fwp-title-banner');
            this.dom.titleBannerText = container.querySelector('#fwp-title-banner-text');
            this.dom.copyTitleBtn = container.querySelector('#fwp-copy-title-btn');
            this.dom.closeBannerBtn = container.querySelector('#fwp-close-banner-btn');
            this.dom.codecWarning = container.querySelector('#fwp-codec-warning');
            this.dom.codecDismissBtn = container.querySelector('#fwp-codec-dismiss');
            this.dom.statusBadge = container.querySelector('#fwp-badge');
            this.dom.resyncBtn = container.querySelector('#fwp-resync');
            this.dom.videoBox = container.querySelector('#fwp-video-box');
            this.dom.dragShield = container.querySelector('#fwp-drag-shield');
            this.dom.bubble = container.querySelector('#fwp-bubble');
            this.dom.resizeHandle = container.querySelector('#fwp-resize-handle');
            this.dom.minimizeBtn = container.querySelector('#fwp-minimize');
            this.dom.fullscreenBtn = container.querySelector('#fwp-fullscreen');
            this.dom.closeBtn = container.querySelector('#fwp-close');
            
            // Controls Bar Bindings
            this.dom.playPauseBtn = container.querySelector('#fwp-play-pause-btn');
            this.dom.playIconSlot = container.querySelector('#fwp-play-icon-slot');
            this.dom.rewindBtn = container.querySelector('#fwp-rewind-btn');
            this.dom.forwardBtn = container.querySelector('#fwp-forward-btn');
            this.dom.seekSlider = container.querySelector('#fwp-seek-slider');
            this.dom.timeText = container.querySelector('#fwp-time-text');

            this.initGestures();
            this.initEvents();
            this.initKeyboardProtection();
        }

        initEvents() {
            this.dom.resyncBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.resync();
            });

            this.dom.minimizeBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleMinimize();
            });

            this.dom.bubble?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleMinimize();
            });

            this.dom.fullscreenBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleFullscreen();
            });

            this.dom.closeBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeParty(true);
            });

            // Title Reveal Banner Toggle
            const toggleTitleBanner = (e) => {
                if (e) e.stopPropagation();
                if (!this.dom.titleBanner) return;
                const isHidden = this.dom.titleBanner.classList.contains('hidden');
                if (isHidden) {
                    if (this.dom.titleBannerText) {
                        this.dom.titleBannerText.textContent = this.title || 'Movie';
                    }
                    this.dom.titleBanner.classList.remove('hidden');
                } else {
                    this.dom.titleBanner.classList.add('hidden');
                }
            };

            this.dom.titleText?.addEventListener('click', toggleTitleBanner);
            this.dom.titleRevealBtn?.addEventListener('click', toggleTitleBanner);
            this.dom.closeBannerBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.dom.titleBanner?.classList.add('hidden');
            });

            this.dom.copyTitleBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                const textToCopy = this.title || '';
                if (!textToCopy) return;
                navigator.clipboard.writeText(textToCopy).then(() => {
                    const span = this.dom.copyTitleBtn?.querySelector('span');
                    if (span) {
                        const old = span.textContent;
                        span.textContent = 'Copied! ✓';
                        setTimeout(() => { span.textContent = old; }, 2000);
                    }
                }).catch(() => {});
            });

            this.dom.codecDismissBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.dom.codecWarning?.classList.add('hidden');
            });

            // Dedicated Play / Pause Button
            this.dom.playPauseBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.togglePlay();
            });

            // Rewind 10 Seconds
            this.dom.rewindBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                const cur = this.getCurrentTime();
                const target = Math.max(0, cur - 10);
                this.seekTo(target);
            });

            // Forward 10 Seconds
            this.dom.forwardBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                const cur = this.getCurrentTime();
                const dur = this.getDuration() || 9999;
                const target = Math.min(dur, cur + 10);
                this.seekTo(target);
            });

            // Smooth High-Precision Slider Scrubbing with Dynamic Progress Fill
            const onSeekInput = () => {
                this.isScrubbing = true;
                const targetTime = Number(this.dom.seekSlider.value) || 0;
                const dur = this.getDuration();
                const progressPct = dur > 0 ? (targetTime / dur) * 100 : 0;
                this.dom.seekSlider.style.setProperty('--progress', `${progressPct.toFixed(1)}%`);
                if (this.dom.timeText) {
                    this.dom.timeText.textContent = `${formatTime(targetTime)} / ${formatTime(dur)}`;
                }
            };

            const onSeekCommit = () => {
                this.isScrubbing = false;
                const targetTime = Number(this.dom.seekSlider.value) || 0;
                this.seekTo(targetTime);
            };

            this.dom.seekSlider?.addEventListener('input', onSeekInput);
            this.dom.seekSlider?.addEventListener('change', onSeekCommit);
            this.dom.seekSlider?.addEventListener('touchend', onSeekCommit);
        }

        seekTo(targetTime, broadcast = true) {
            this._suppressBroadcastUntil = Date.now() + 2500;
            this._lastReportedTime = targetTime;
            const wasPlaying = (this.lastSyncState === 'playing');
            if (this.mode === 'local') {
                if (this.localVideo) {
                    try {
                        this.localVideo.currentTime = targetTime;
                    } catch(e) {}
                    if (wasPlaying) {
                        this.lastSyncState = 'playing';
                        this.setStatus('Playing', '#22c55e', true);
                        this.updatePlayIcon(true);
                        // If video is not seeking and ready, resume; otherwise onseeked handles play safely once keyframes are loaded
                        if (!this.localVideo.seeking && this.localVideo.readyState >= 2 && this.localVideo.paused) {
                            const p = this.localVideo.play();
                            if (p && typeof p.catch === 'function') p.catch(() => {});
                        }
                    }
                }
            } else if (this.player && typeof this.player.seekTo === 'function') {
                this.player.seekTo(targetTime, true);
                if (wasPlaying && typeof this.player.playVideo === 'function') {
                    this.player.playVideo();
                }
            }
            if (broadcast) {
                this.broadcastAction('seek', targetTime, { wasPlaying });
            }
        }

        updatePlayIcon(isPlaying) {
            if (!this.dom.playIconSlot) return;
            if (isPlaying) {
                this.dom.playIconSlot.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
            } else {
                this.dom.playIconSlot.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>`;
            }
        }

        togglePlay() {
            const state = this.getPlayerState();
            const time = this.getCurrentTime();
            
            this._suppressBroadcastUntil = Date.now() + 1800;
            this._lastReportedTime = time;

            if (state === 1) { // Playing -> Pause
                if (this.mode === 'local') {
                    if (this.localVideo) this.localVideo.pause();
                } else if (this.player && typeof this.player.pauseVideo === 'function') {
                    this.player.pauseVideo();
                }
                this.lastSyncState = 'paused';
                this._lastDetectedState = 2;
                this.setStatus('Paused', '#fbbf24', false);
                this.updatePlayIcon(false);
                this.broadcastAction('pause', time);
            } else { // Paused -> Play
                this.isAutoplayBlocked = false;
                const playOverlay = document.getElementById('fwp-play-overlay');
                if (playOverlay) playOverlay.classList.add('hidden');
                if (this.mode === 'local') {
                    if (this.localVideo) {
                        this.localVideo.muted = false;
                        const p = this.localVideo.play();
                        if (p && typeof p.catch === 'function') p.catch(() => {});
                    }
                } else if (this.player && typeof this.player.playVideo === 'function') {
                    this.player.playVideo();
                }
                this.lastSyncState = 'playing';
                this._lastDetectedState = 1;
                this.setStatus('Playing', '#22c55e', true);
                this.updatePlayIcon(true);
                this.broadcastAction('play', time);
            }
        }

        // ======================================================================
        // 120 FPS Hardware Drag, 2-Finger Pinch Zoom & Corner Resize
        // ======================================================================
        initGestures() {
            const header = this.dom.header;
            const bubble = this.dom.bubble;
            const resizeHandle = this.dom.resizeHandle;
            if (!header) return;

            this.updatePosition(this.posX, this.posY);
            this.updateSize(this.width);

            const getTouchDistance = (t1, t2) => {
                return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
            };

            // 2-Finger Pinch to Zoom / Resize Window from Anywhere
            const onPinchStart = (e) => {
                if (!this.active || this.isMinimized || this.isFullscreen) return;
                if (e.touches && e.touches.length >= 2) {
                    this.isResizing = true;
                    this.isDragging = false;
                    this.initialPinchDist = getTouchDistance(e.touches[0], e.touches[1]);
                    this.initialWidth = this.width;
                    this.dom.dragShield?.classList.remove('hidden');
                    this.dom.card?.classList.add('is-dragging');
                }
            };

            const onPinchMove = (e) => {
                if (e.touches && e.touches.length >= 2 && this.isResizing) {
                    if (e.cancelable) e.preventDefault();
                    const currentDist = getTouchDistance(e.touches[0], e.touches[1]);
                    const scaleFactor = currentDist / Math.max(1, this.initialPinchDist);
                    let newWidth = Math.max(180, Math.min(window.innerWidth - 16, this.initialWidth * scaleFactor));
                    this.width = newWidth;
                    this.updateSize(newWidth);
                }
            };

            const onPinchEnd = (e) => {
                if (this.isResizing && (!e.touches || e.touches.length < 2)) {
                    this.isResizing = false;
                    this.dom.dragShield?.classList.add('hidden');
                    this.dom.card?.classList.remove('is-dragging');
                }
            };

            window.addEventListener('touchstart', onPinchStart, { passive: false });
            window.addEventListener('touchmove', onPinchMove, { passive: false });
            window.addEventListener('touchend', onPinchEnd, { passive: true });
            window.addEventListener('touchcancel', onPinchEnd, { passive: true });

            // 1-Finger Header Drag
            const onDragStart = (e) => {
                if (e.target.closest('.fwp-btn') || e.target.closest('.fwp-actions')) return;
                if (e.touches && e.touches.length > 1) return; // Delegate to pinch
                const point = e.touches ? e.touches[0] : e;
                this.isDragging = true;
                this.dragStartX = point.clientX;
                this.dragStartY = point.clientY;
                this.windowStartX = this.posX;
                this.windowStartY = this.posY;

                this.dom.dragShield?.classList.remove('hidden');
                this.dom.card?.classList.add('is-dragging');
                this.dom.bubble?.classList.add('is-dragging');

                window.addEventListener('mousemove', onDragMove, { passive: false });
                window.addEventListener('mouseup', onDragEnd, { passive: true });
                window.addEventListener('touchmove', onDragMove, { passive: false });
                window.addEventListener('touchend', onDragEnd, { passive: true });
                window.addEventListener('touchcancel', onDragEnd, { passive: true });
            };

            const onDragMove = (e) => {
                if (!this.isDragging) return;
                if (e.cancelable) e.preventDefault();

                const point = e.touches ? e.touches[0] : e;
                const deltaX = point.clientX - this.dragStartX;
                const deltaY = point.clientY - this.dragStartY;

                let nextX = this.windowStartX + deltaX;
                let nextY = this.windowStartY + deltaY;

                const cardWidth = this.isMinimized ? 56 : (this.width || 340);
                const cardHeight = this.isMinimized ? 56 : (this.dom.card?.offsetHeight || 240);
                const maxX = Math.max(0, window.innerWidth - cardWidth);
                const maxY = Math.max(0, window.innerHeight - cardHeight);

                this.posX = Math.max(0, Math.min(nextX, maxX));
                this.posY = Math.max(10, Math.min(nextY, maxY));

                if (this._dragRaf) cancelAnimationFrame(this._dragRaf);
                this._dragRaf = requestAnimationFrame(() => {
                    this.updatePosition(this.posX, this.posY);
                });
            };

            const onDragEnd = () => {
                this.isDragging = false;
                this.dom.dragShield?.classList.add('hidden');
                this.dom.card?.classList.remove('is-dragging');
                this.dom.bubble?.classList.remove('is-dragging');

                window.removeEventListener('mousemove', onDragMove);
                window.removeEventListener('mouseup', onDragEnd);
                window.removeEventListener('touchmove', onDragMove);
                window.removeEventListener('touchend', onDragEnd);
                window.removeEventListener('touchcancel', onDragEnd);

                const cardWidth = this.isMinimized ? 56 : (this.width || 340);
                const midX = window.innerWidth / 2;
                const targetX = (this.posX + cardWidth / 2 < midX) ? 10 : Math.max(10, window.innerWidth - cardWidth - 10);
                
                this.posX = targetX;
                this.dom.container?.classList.add('fwp-snapping');
                this.updatePosition(this.posX, this.posY);
                setTimeout(() => {
                    this.dom.container?.classList.remove('fwp-snapping');
                }, 300);
            };

            header.addEventListener('mousedown', onDragStart);
            header.addEventListener('touchstart', onDragStart, { passive: false });
            bubble.addEventListener('mousedown', onDragStart);
            bubble.addEventListener('touchstart', onDragStart, { passive: false });

            // Corner Resize Handle (1-finger drag resize)
            const onResizeStart = (e) => {
                e.stopPropagation();
                if (e.cancelable) e.preventDefault();
                this.isResizing = true;
                const point = e.touches ? e.touches[0] : e;
                this.dragStartX = point.clientX;
                this.initialWidth = this.width;
                this.dom.dragShield?.classList.remove('hidden');

                const onResizeMove = (ev) => {
                    if (!this.isResizing) return;
                    if (ev.cancelable) ev.preventDefault();
                    const p = ev.touches ? ev.touches[0] : ev;
                    const deltaX = p.clientX - this.dragStartX;
                    let newWidth = Math.max(180, Math.min(window.innerWidth - 16, this.initialWidth + deltaX));
                    this.width = newWidth;
                    this.updateSize(newWidth);
                };

                const onResizeEnd = () => {
                    this.isResizing = false;
                    this.dom.dragShield?.classList.add('hidden');
                    window.removeEventListener('mousemove', onResizeMove);
                    window.removeEventListener('mouseup', onResizeEnd);
                    window.removeEventListener('touchmove', onResizeMove);
                    window.removeEventListener('touchend', onResizeEnd);
                };

                window.addEventListener('mousemove', onResizeMove, { passive: false });
                window.addEventListener('mouseup', onResizeEnd, { passive: true });
                window.addEventListener('touchmove', onResizeMove, { passive: false });
                window.addEventListener('touchend', onResizeEnd, { passive: true });
            };

            resizeHandle?.addEventListener('mousedown', onResizeStart);
            resizeHandle?.addEventListener('touchstart', onResizeStart, { passive: false });
        }

        updatePosition(x, y) {
            if (!this.dom.container) return;
            this.dom.container.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        }

        updateSize(width) {
            if (!this.dom.card) return;
            this.dom.card.style.width = `${Math.round(width)}px`;
        }

        initKeyboardProtection() {
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', () => {
                    const isKeyboardOpen = window.innerHeight - window.visualViewport.height > 150;
                    if (isKeyboardOpen && !this.isMinimized && this.active) {
                        this.posY = Math.max(10, Math.min(this.posY, 45));
                        this.posX = Math.max(10, window.innerWidth - (this.width || 340) - 10);
                        this.updatePosition(this.posX, this.posY);
                    }
                }, { passive: true });
            }
        }

        toggleMinimize() {
            this.isMinimized = !this.isMinimized;
            if (this.isMinimized) {
                this.dom.card?.classList.add('hidden');
                this.dom.bubble?.classList.remove('hidden');
            } else {
                this.dom.bubble?.classList.add('hidden');
                this.dom.card?.classList.remove('hidden');
            }
        }

        toggleFullscreen() {
            this.isFullscreen = !this.isFullscreen;
            if (this.isFullscreen) {
                this.dom.card?.classList.add('fwp-fullscreen');
            } else {
                this.dom.card?.classList.remove('fwp-fullscreen');
            }
        }

        setStatus(text, color = '#22c55e', isLive = true) {
            if (!this.dom.statusBadge) return;
            const textEl = this.dom.statusBadge.querySelector('.fwp-badge-text');
            const dotEl = this.dom.statusBadge.querySelector('.fwp-badge-dot');
            if (textEl) textEl.textContent = text;
            if (dotEl) {
                dotEl.style.background = color;
                if (isLive) {
                    dotEl.classList.add('fwp-pulse');
                } else {
                    dotEl.classList.remove('fwp-pulse');
                }
            }
        }

        // Instant Re-sync Button
        resync() {
            this.setStatus('Syncing...', '#38bdf8', true);
            this._suppressBroadcastUntil = Date.now() + 2000;
            const chatId = window.state?.activeChatId;
            if (chatId && typeof window.apiFetch === 'function') {
                window.apiFetch(`/api/chat/${chatId}/watch_party`).then(res => {
                    if (res && res.active && res.session) {
                        const targetTime = res.session.calculatedTime !== undefined ? res.session.calculatedTime : (res.session.lastTime || 0);
                        this._lastReportedTime = targetTime;
                        if (this.player && typeof this.player.seekTo === 'function') {
                            this.player.seekTo(targetTime, true);
                            if (res.session.state === 'playing' && typeof this.player.playVideo === 'function') {
                                this.player.playVideo();
                            }
                        }
                        this.setStatus(res.session.state === 'playing' ? 'Synced' : 'Paused', res.session.state === 'playing' ? '#22c55e' : '#fbbf24', res.session.state === 'playing');
                        this.updatePlayIcon(res.session.state === 'playing');
                    } else {
                        this.setStatus('Synced', '#22c55e', true);
                    }
                }).catch(() => {
                    this.setStatus('Synced', '#22c55e', true);
                });
            }
            this.broadcastAction('request_sync', 0);
        }

        // ======================================================================
        // Start or Join Watch Party (YouTube & Cinema Sync)
        // ======================================================================
        async startParty(videoId, url, isHost = true, initialTime = 0) {
            this.init();
            this.closePlayerInstance();
            this.mode = 'youtube';
            this.active = true;
            this.videoId = videoId;
            this.url = url || `https://youtu.be/${videoId}`;
            this.isHost = isHost;
            this._suppressBroadcastUntil = Date.now() + 2500;
            this._lastReportedTime = initialTime;

            if (this.dom.titleText) {
                this.dom.titleText.textContent = this.title;
            }

            this.dom.container.classList.remove('hidden');
            this.dom.card.classList.remove('hidden');
            this.dom.bubble.classList.add('hidden');
            this.isMinimized = false;
            window.BackNavManager?.push('watchparty', () => {
                this.closeParty(true, true);
            });

            this.setStatus(isHost ? 'Host' : 'Synced', '#22c55e', true);

            if (isHost) {
                this.broadcastAction('start', initialTime, { url: this.url, host: window.state?.user || 'Host' });
                const chatId = window.state?.activeChatId;
                if (chatId && typeof window.apiFetch === 'function') {
                    window.apiFetch(`/api/chat/${chatId}/watch_party`, {
                        method: 'POST',
                        body: JSON.stringify({ videoId: this.videoId, url: this.url, host: window.state?.user || 'Host', state: 'playing', time: initialTime })
                    }).catch(() => {});
                }
            }

            this.setStatus('Loading YouTube...', '#38bdf8', true);
            await loadYouTubeApi();
            this.mountPlayer(videoId, initialTime);
            this.startStatePolling();
            this.startHeartbeat();
            this.startHttpFallback();
        }

        startLocalParty(file, title, shouldBroadcastStart = true, initialTime = 0, cinemaId = null, knownDuration = 0) {
            this.init();
            this.closePlayerInstance();
            this.mode = 'local';
            this.active = true;
            this.localFile = file;
            this.isHost = true; // Symmetric full authority in local cinema mode
            this.isAutoplayBlocked = false;
            // Deterministic tie-breaker: device with alphabetically lower username is authoritative time leader
            const myUser = window.state?.user || '';
            const peerUser = window.state?.activePeer || '';
            this.isTimeLeader = (myUser && peerUser) ? (myUser < peerUser) : Boolean(shouldBroadcastStart);
            this.cinemaId = cinemaId;
            if (knownDuration > 0) {
                this.cinemaDuration = knownDuration;
            }

            // Clean title with extension
            let cleanTitle = title || file?.name || 'Movie.mp4';
            if (!/\.[a-z0-9]{2,5}$/i.test(cleanTitle)) {
                let ext = '.mp4';
                if (file?.type?.includes('matroska') || file?.type?.includes('mkv')) ext = '.mkv';
                else if (file?.type?.includes('webm')) ext = '.webm';
                cleanTitle += ext;
            }
            this.title = cleanTitle;

            this._suppressBroadcastUntil = Date.now() + 3000;
            this._lastReportedTime = initialTime;

            if (this.dom.titleText) {
                this.dom.titleText.textContent = this.title;
            }
            if (this.dom.titleBannerText) {
                this.dom.titleBannerText.textContent = this.title;
            }

            this.dom.container.classList.remove('hidden');
            this.dom.card.classList.remove('hidden');
            this.dom.bubble.classList.add('hidden');
            this.isMinimized = false;
            window.BackNavManager?.push('watchparty', () => {
                this.closeParty(true, true);
            });

            this.setStatus('Synced', '#22c55e', true);

            this.mountLocalVideo(file, initialTime);
            this.startStatePolling();
            this.startHeartbeat();

            if (this.cinemaId && window.CinemaManager?.updateCardUI) {
                window.CinemaManager.updateCardUI(this.cinemaId);
            }

            if (shouldBroadcastStart) {
                this.broadcastAction('start', initialTime, { 
                    mode: 'local', 
                    title: this.title, 
                    cinemaId: this.cinemaId, 
                    duration: this.cinemaDuration || this.getDuration(),
                    sender: window.state?.user || 'Host' 
                });
            }
        }

        mountLocalVideo(file, startTime = 0) {
            const slot = document.getElementById('fwp-yt-player-slot');
            if (!slot) return;

            // Immediate hardware decoder release on Android MediaCodec
            if (this.localVideo) {
                try {
                    this.localVideo.pause();
                    this.localVideo.removeAttribute('src');
                    this.localVideo.load();
                } catch(e) {}
                try { this.localVideo.remove(); } catch(e) {}
                this.localVideo = null;
            }
            if (this.localVideoUrl) {
                try { URL.revokeObjectURL(this.localVideoUrl); } catch(e) {}
                this.localVideoUrl = null;
            }

            slot.innerHTML = '';

            const video = document.createElement('video');
            video.className = 'fwp-local-video';
            video.style.width = '100%';
            video.style.height = '100%';
            video.style.objectFit = 'contain';
            video.style.backgroundColor = '#000';
            video.style.transform = 'translateZ(0)';
            video.preload = 'auto';
            video.setAttribute('preload', 'auto');
            video.playsInline = true;
            video.setAttribute('playsinline', '');
            video.setAttribute('webkit-playsinline', '');
            video.setAttribute('x5-playsinline', '');
            video.controls = false;
            
            this.localVideoUrl = URL.createObjectURL(file);
            video.src = this.localVideoUrl;
            this.localVideo = video;
            slot.appendChild(video);

            // Tap to Play / Unmute Overlay (guarantees 1-tap playback & unmute if autoplay blocked on Android)
            const playOverlay = document.createElement('div');
            playOverlay.id = 'fwp-play-overlay';
            playOverlay.className = 'fwp-play-overlay hidden';
            playOverlay.innerHTML = `
                <div class="fwp-play-overlay-circle">
                    <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>
                </div>
                <span class="fwp-play-overlay-label">Tap to Start Video</span>
            `;
            slot.appendChild(playOverlay);

            const clearAutoplayBlockAndUnmute = () => {
                this.isAutoplayBlocked = false;
                playOverlay.classList.add('hidden');
                if (video) {
                    video.muted = false;
                    video.play().then(() => {
                        this.setStatus(this.isHost ? 'Host' : 'Synced', '#22c55e', true);
                        this.updatePlayIcon(true);
                        if (this.mode === 'local') {
                            this.broadcastAction('request_sync', this.getCurrentTime());
                        }
                    }).catch(() => {});
                }
            };

            playOverlay.addEventListener('click', (e) => {
                e.stopPropagation();
                clearAutoplayBlockAndUnmute();
            });

            video.addEventListener('click', () => {
                if (video.muted || this.isAutoplayBlocked) {
                    clearAutoplayBlockAndUnmute();
                } else if (video.paused) {
                    video.muted = false;
                    video.play().then(() => {
                        playOverlay.classList.add('hidden');
                        this.updatePlayIcon(true);
                    }).catch(() => {});
                }
            });

            const attemptPlay = () => {
                video.muted = false;
                const p = video.play();
                if (p && typeof p.catch === 'function') {
                    p.catch((err) => {
                        console.warn('[WatchParty] Unmuted play blocked by browser autoplay policy:', err);
                        this.isAutoplayBlocked = true;
                        // Autoplay blocked without user gesture: start muted in 0ms visual sync
                        video.muted = true;
                        const pMuted = video.play();
                        if (pMuted && typeof pMuted.catch === 'function') pMuted.catch(() => {});
                        const label = playOverlay.querySelector('.fwp-play-overlay-label');
                        if (label) label.textContent = 'Tap to Unmute Sound 🔊';
                        playOverlay.classList.remove('hidden');
                        this.setStatus('Tap to Unmute', '#38bdf8', false);
                    });
                }
            };

            const isTenBitFile = /10bit|10-bit|hi10p|main10/i.test(file.name || '');
            const isMkvFile = /\.mkv$/i.test(file.name || '');
            const isAndroid = /Android/i.test(navigator.userAgent || '');

            if (this.dom.codecWarning) {
                const textSpan = this.dom.codecWarning.querySelector('.fwp-codec-text span');
                if (isTenBitFile && isAndroid) {
                    if (textSpan) textSpan.textContent = 'Android lacks hardware decoders for 10-bit video. If screen is black while audio plays, please use standard 8-bit MP4 files.';
                    this.dom.codecWarning.classList.remove('hidden');
                } else if (isMkvFile) {
                    if (textSpan) textSpan.textContent = 'Tip: If video plays without audio/sound, this MKV may contain Dolby AC3/DTS audio which browsers cannot decode. MP4 files with AAC audio work with sound on all mobile devices.';
                    this.dom.codecWarning.classList.remove('hidden');
                } else {
                    this.dom.codecWarning.classList.add('hidden');
                }
            }

            let waitingTimer = null;
            const clearBuffering = (broadcast = true) => {
                if (waitingTimer) {
                    clearTimeout(waitingTimer);
                    waitingTimer = null;
                }
                if (this.isBuffering && (!video || !video.seeking)) {
                    this.isBuffering = false;
                    this.setStatus(this.isHost ? 'Host' : 'Synced', '#22c55e', true);
                    if (broadcast && this.mode === 'local') {
                        this.broadcastAction('buffering', this.getCurrentTime(), { isBuffering: false, mode: 'local' });
                    }
                }
            };

            video.onplay = () => {
                playOverlay.classList.add('hidden');
                clearBuffering(true);
                this.onPlayerStateChange(1);
            };
            video.onpause = () => {
                if (waitingTimer) {
                    clearTimeout(waitingTimer);
                    waitingTimer = null;
                }
                this.onPlayerStateChange(2);
            };
            video.onwaiting = () => {
                if (waitingTimer) clearTimeout(waitingTimer);
                // Debounce seeking frames: seeking 10min forward in flash storage takes 400-800ms.
                // Do NOT immediately broadcast buffering during active seek.
                const delay = video.seeking ? 2000 : 400;
                waitingTimer = setTimeout(() => {
                    if (video && !video.paused && (video.seeking || video.readyState < 2)) {
                        this.onPlayerStateChange(3);
                    }
                }, delay);
            };
            video.onseeked = () => {
                clearBuffering(true);
                if (this.lastSyncState === 'playing' && video.paused) {
                    video.play().then(() => {
                        this.updatePlayIcon(true);
                        this.setStatus('Playing', '#22c55e', true);
                    }).catch(() => {});
                }
            };
            video.ontimeupdate = () => clearBuffering(true);
            video.oncanplay = () => {
                clearBuffering(true);
                applyInitialSeek();
            };
            video.onplaying = () => {
                playOverlay.classList.add('hidden');
                clearBuffering();
                this.onPlayerStateChange(1);
                // Hardware decoder reset-to-zero safeguard on Android
                if (targetStartTime > 0 && Math.abs(video.currentTime - targetStartTime) > 2.0 && !initialSeekDone) {
                    try { video.currentTime = targetStartTime; initialSeekDone = true; } catch(e) {}
                }
                setTimeout(() => { targetStartTime = 0; }, 3000);

                // Frame decode check after playback starts on Android
                if (isAndroid && this.dom.codecWarning) {
                    setTimeout(() => {
                        if (video && !video.paused && video.currentTime > 1) {
                            if (typeof video.getVideoPlaybackQuality === 'function') {
                                const quality = video.getVideoPlaybackQuality();
                                if (quality && quality.totalVideoFrames === 0) {
                                    const textSpan = this.dom.codecWarning.querySelector('.fwp-codec-text span');
                                    if (textSpan) {
                                        textSpan.textContent = 'Black screen detected: Android lacks hardware decoder for this video format (e.g. 10-bit or unsupported profile). Audio may play, but video frames cannot be rendered.';
                                    }
                                    this.dom.codecWarning.classList.remove('hidden');
                                }
                            }
                        }
                    }, 3500);
                }
            };

            let targetStartTime = startTime;
            let initialSeekDone = false;
            const applyInitialSeek = () => {
                if (targetStartTime > 0 && !initialSeekDone) {
                    try { 
                        video.currentTime = targetStartTime;
                        if (Math.abs(video.currentTime - targetStartTime) < 1.0) {
                            initialSeekDone = true;
                        }
                    } catch(e) {}
                }
            };

            video.onloadedmetadata = () => {
                if (video.duration && isFinite(video.duration) && video.duration > 0) {
                    this.cinemaDuration = video.duration;
                }
                this.setStatus(this.isHost ? 'Host' : 'Synced', '#22c55e', true);
                applyInitialSeek();
                attemptPlay();
            };

            video.oncanplay = () => {
                applyInitialSeek();
            };

            video.onerror = () => {
                const err = video.error;
                let detail = 'Playback error';
                if (err) {
                    if (err.code === 3) detail = 'Decode Error (hardware decoder failed on stream)';
                    else if (err.code === 4) detail = 'Unsupported Format (codec unsupported by mobile)';
                    else if (err.code === 2) detail = 'File Read Error';
                    else if (err.code === 1) detail = 'Aborted';
                }
                console.error('[WatchParty] Local video error:', err, detail);
                this.setStatus(detail, '#ef4444', false);
                if (this.dom.codecWarning) {
                    const textSpan = this.dom.codecWarning.querySelector('.fwp-codec-text span');
                    if (textSpan) {
                        textSpan.textContent = `Playback error: ${detail}. If this MKV has Dolby AC3/5.1 audio or 10-bit video, Android Chrome cannot decode it. Use standard MP4 with 2-channel Stereo AAC audio.`;
                    }
                    this.dom.codecWarning.classList.remove('hidden');
                }
            };
        }

        mountPlayer(videoId, startTime = 0) {
            const slot = document.getElementById('fwp-yt-player-slot');
            if (!slot) return;
            slot.innerHTML = '';

            const playerElementId = 'fwp-yt-iframe-' + Date.now();
            const playerDiv = document.createElement('div');
            playerDiv.id = playerElementId;
            slot.appendChild(playerDiv);

            const isPublicWeb = (window.location.protocol === 'http:' || window.location.protocol === 'https:') &&
                                window.location.hostname !== 'localhost' &&
                                window.location.hostname !== '127.0.0.1' &&
                                !window.location.hostname.includes('capacitor');
            const playerVars = {
                autoplay: 1,
                controls: 0, // Clean video without intrusive channel cards or tiny unclickable buttons
                enablejsapi: 1,
                modestbranding: 1,
                playsinline: 1,
                rel: 0,
                fs: 0,
                disablekb: 1,
                iv_load_policy: 3,
                start: Math.floor(startTime)
            };
            if (isPublicWeb && window.location.origin && window.location.origin !== 'null') {
                playerVars.origin = window.location.origin;
            }

            try {
                this.player = new window.YT.Player(playerElementId, {
                    videoId: videoId,
                    host: 'https://www.youtube-nocookie.com',
                    width: '100%',
                    height: '100%',
                    playerVars: playerVars,
                    events: {
                        onReady: (e) => {
                            this.setStatus(this.isHost ? 'Host' : 'Synced', '#22c55e', true);
                            if (startTime > 0) {
                                e.target.seekTo(startTime, true);
                            }
                            try {
                                const p = e.target.playVideo();
                                if (p && typeof p.catch === 'function') {
                                    p.catch(() => {
                                        // Autoplay policy on mobile/WebView: attempt muted playback fallback
                                        try {
                                            e.target.mute();
                                            e.target.playVideo();
                                            this.setStatus('Tap to Unmute', '#38bdf8', false);
                                        } catch(mErr) {}
                                    });
                                }
                            } catch(err) {}
                        },
                        onStateChange: (e) => {
                            this.onPlayerStateChange(e.data);
                        },
                        onError: (e) => {
                            console.warn('[WatchParty] YouTube Player Error Code:', e.data);
                            let errMsg = 'Playback error';
                            let isBlocked = false;
                            if (e.data === 101 || e.data === 150) {
                                errMsg = 'Owner disabled embed';
                                isBlocked = true;
                            } else if (e.data === 100) {
                                errMsg = 'Video removed/private';
                            } else if (e.data === 2) {
                                errMsg = 'Invalid video ID';
                            }
                            this.setStatus(errMsg, '#ef4444', false);
                            if (isBlocked && this.dom.titleText) {
                                this.dom.titleText.innerHTML = `<a href="${this.url}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;text-decoration:underline;">Watch on YouTube ↗</a>`;
                            }
                        }
                    }
                });
            } catch (err) {
                console.error('[WatchParty] Player mount error:', err);
                this.setStatus('Player error', '#ef4444', false);
            }
        }

        onPlayerStateChange(state) {
            if (state === 3) { // Buffering (low internet / network stall)
                this.isBuffering = true;
                this.setStatus('Buffering...', '#38bdf8', true);
                if (this.mode === 'local') {
                    this.broadcastAction('buffering', this.getCurrentTime(), { isBuffering: true, mode: 'local' });
                }
                return;
            } else {
                this.isBuffering = false;
            }

            // In YouTube mode, only host broadcasts state changes
            if (this.mode !== 'local' && !this.isHost) return;

            // In local mode, suppress broadcast if actively processing a remote command to avoid echo loops
            if (this.isRemoteSyncing || Date.now() < this._suppressBroadcastUntil) return;
            const currentTime = this.getCurrentTime();

            if (state === 1) { // Playing
                this.lastSyncState = 'playing';
                this.setStatus('Playing', '#22c55e', true);
                this.updatePlayIcon(true);
                this._suppressBroadcastUntil = Date.now() + 1500;
                this._lastReportedTime = currentTime;
                this.broadcastAction('play', currentTime, { mode: this.mode });
            } else if (state === 2) { // Paused
                // KILL ECHO-PAUSE: If this device is paused purely because Android Chrome blocked autoplay, NEVER broadcast pause to peer!
                if (this.isAutoplayBlocked) {
                    console.log('[WatchParty] Playback held by autoplay gesture policy; suppressing echo-pause broadcast to peer.');
                    return;
                }
                this.lastSyncState = 'paused';
                this.setStatus('Paused', '#fbbf24', false);
                this.updatePlayIcon(false);
                this._suppressBroadcastUntil = Date.now() + 1500;
                this._lastReportedTime = currentTime;
                this.broadcastAction('pause', currentTime, { mode: this.mode });
            }
        }

        startStatePolling() {
            if (this.pollStateInterval) clearInterval(this.pollStateInterval);
            this.pollStateInterval = setInterval(() => {
                if (!this.active || (!this.player && !this.localVideo)) return;
                
                try {
                    const time = this.getCurrentTime();
                    const dur = this.getDuration();
                    const state = this.getPlayerState();

                    // Update UI Controls
                    if (!this.isScrubbing && this.dom.seekSlider && dur > 0) {
                        this.dom.seekSlider.max = dur;
                        this.dom.seekSlider.value = time;
                        const progressPct = (time / dur) * 100;
                        this.dom.seekSlider.style.setProperty('--progress', `${progressPct.toFixed(1)}%`);
                    }
                    if (this.dom.timeText) {
                        this.dom.timeText.textContent = `${formatTime(time)} / ${formatTime(dur)}`;
                    }
                    this.updatePlayIcon(state === 1);

                    if (this.isRemoteSyncing || Date.now() < this._suppressBroadcastUntil) {
                        this._lastReportedTime = time;
                        return;
                    }

                    // Detect play/pause change
                    if (state !== this._lastDetectedState && state !== -1 && state !== 3) {
                        // If autoplay is blocked and video is paused waiting for user tap, DO NOT broadcast pause!
                        if (this.isAutoplayBlocked && state === 2) {
                            this._lastReportedTime = time;
                            return;
                        }
                        this._lastDetectedState = state;
                        this.onPlayerStateChange(state);
                    } else if (state === 3 && this._lastDetectedState !== 3) {
                        this._lastDetectedState = 3;
                        this.onPlayerStateChange(3);
                    }

                    this._lastReportedTime = time;
                } catch(e) {}
            }, 350);
        }

        broadcastAction(action, time, extra = {}) {
            const ws = window.state?.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const payload = {
                type: 'watch_party',
                action: action,
                videoId: this.videoId,
                time: time,
                sender: window.state?.user,
                senderTs: Date.now(),
                ...extra
            };
            ws.send(JSON.stringify(payload));
        }

        startHeartbeat() {
            if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = setInterval(() => {
                if (this.active && (this.player || this.localVideo) && this.lastSyncState === 'playing') {
                    if (Date.now() < this._suppressBroadcastUntil) return;
                    if (this.mode === 'local') {
                        // Healthy playback guard: do NOT broadcast sync heartbeat if locally buffering, seeking, or stalled
                        if (!this.localVideo || this.isBuffering || this.localVideo.seeking || this.localVideo.readyState < 2 || this.localVideo.paused) {
                            return;
                        }
                        if (!this.isTimeLeader) return;
                    }
                    if (this.mode !== 'local' && !this.isHost) return;
                    const currentTime = this.getCurrentTime();
                    this.broadcastAction('sync', currentTime, { mode: this.mode });
                }
            }, 3000);
        }

        startHttpFallback() {
            if (this.httpFallbackInterval) clearInterval(this.httpFallbackInterval);
            this.httpFallbackInterval = setInterval(() => {
                if (!this.active || this.isHost || this.isRemoteSyncing || Date.now() < this._suppressBroadcastUntil || this.mode === 'local') return;
                const chatId = window.state?.activeChatId;
                if (chatId && typeof window.apiFetch === 'function') {
                    window.apiFetch(`/api/chat/${chatId}/watch_party`).then(res => {
                        if (res && res.active && res.session && res.session.state === 'playing') {
                            const targetTime = res.session.calculatedTime !== undefined ? res.session.calculatedTime : (res.session.lastTime || 0);
                            if (this.player && typeof this.player.getCurrentTime === 'function') {
                                const cur = this.player.getCurrentTime();
                                const now = Date.now();
                                // Only correct huge drifts (> 5.0 seconds) and avoid thrashing during buffering
                                if (!this.isBuffering && (now - this.lastSyncSeekTs > 6000) && Math.abs(cur - targetTime) > 5.0) {
                                    this.lastSyncSeekTs = now;
                                    this._suppressBroadcastUntil = Date.now() + 2500;
                                    this._lastReportedTime = targetTime;
                                    this.player.seekTo(targetTime, true);
                                }
                            }
                        }
                    }).catch(() => {});
                }
            }, 8000);
        }

        // ======================================================================
        // Sub-50ms WebSocket Signal Router (Anti-Ping-Pong & Jitter Filter)
        // ======================================================================
        handleSignal(packet) {
            if (!packet || !packet.action) return;
            if (packet.sender && window.state && packet.sender === window.state.user) return;

            console.log('[WatchParty] Signal received:', packet.action, packet.time, 'from:', packet.sender);

            if (packet.action === 'start') {
                if (packet.mode === 'local') {
                    if (this.active && this.cinemaId && packet.cinemaId && this.cinemaId === packet.cinemaId) {
                        return;
                    }

                    const matchedFile = (packet.cinemaId && window.CinemaManager?.matchedPeerFiles?.get(packet.cinemaId)) ||
                                        (packet.cinemaId && window.CinemaManager?.pendingMatches?.get(packet.cinemaId));
                    if (matchedFile) {
                        this.startLocalParty(matchedFile, packet.title, false, Number(packet.time) || 0, packet.cinemaId, Number(packet.duration) || 0);
                    } else {
                        // Hard gate: Both users must have selected their files before playback can start
                        console.warn('[WatchParty] Ignored start packet: Local movie file not selected on this device.');
                    }
                    return;
                }
                if (!this.active || this.videoId !== packet.videoId) {
                    const delaySec = packet.senderTs ? Math.max(0, (Date.now() - packet.senderTs) / 1000) : 0;
                    const calculatedTime = (Number(packet.time) || 0) + delaySec;
                    this.startParty(packet.videoId, packet.url, false, calculatedTime);
                }
                return;
            }

            if (packet.action === 'close' || packet.action === 'stop') {
                this.closeParty(false);
                return;
            }

            if (packet.action === 'buffering') {
                if (this.mode === 'local' && this.localVideo) {
                    if (this._bufferingSafetyTimer) {
                        clearTimeout(this._bufferingSafetyTimer);
                        this._bufferingSafetyTimer = null;
                    }
                    if (packet.isBuffering) {
                        this.setStatus('Friend Buffering...', '#38bdf8', true);
                        if (!this.localVideo.paused) {
                            this._pausedForFriendBuffering = true;
                            this.localVideo.pause();
                        }
                        // Safety watchdog: never stay stuck on Friend Buffering for more than 7.5s (handles up to 5000ms lagging networks)
                        this._bufferingSafetyTimer = setTimeout(() => {
                            if (this._pausedForFriendBuffering) {
                                this._pausedForFriendBuffering = false;
                                this.setStatus('Synced', '#22c55e', true);
                                if (this.lastSyncState === 'playing' && this.localVideo && this.localVideo.paused) {
                                    this.localVideo.play().catch(() => {});
                                    this.updatePlayIcon(true);
                                }
                            }
                        }, 7500);
                    } else {
                        this.setStatus('Synced', '#22c55e', true);
                        if (this._pausedForFriendBuffering || this.lastSyncState === 'playing') {
                            this._pausedForFriendBuffering = false;
                            this.localVideo.play().then(() => {
                                this.updatePlayIcon(true);
                            }).catch(() => {});
                        }
                    }
                }
                return;
            }

            if (packet.action === 'peer_left_chat') {
                if (this.mode === 'local' && this.localVideo) {
                    this.localVideo.pause();
                    this.setStatus('Friend Left Chat (Paused)', '#fbbf24', false);
                    this.updatePlayIcon(false);
                    if (window.CinemaManager) {
                        window.CinemaManager.setPeerInRoom(false);
                    }
                }
                return;
            }

            if (packet.action === 'request_sync') {
                if (this.active && (this.player || this.localVideo)) {
                    const curTime = this.getCurrentTime();
                    this.broadcastAction('sync', curTime, { mode: this.mode });
                    if (this.lastSyncState === 'playing') {
                        this.broadcastAction('play', curTime, { mode: this.mode });
                    } else if (this.lastSyncState === 'paused') {
                        this.broadcastAction('pause', curTime, { mode: this.mode });
                    }
                }
                return;
            }

            if ((!this.player && !this.localVideo) || !this.active) return;

            // Lockout echo reflections for 2.0s
            this.isRemoteSyncing = true;
            this._suppressBroadcastUntil = Date.now() + 5000;

            if (packet.action === 'play') {
                const transitDelay = (packet.senderTs && packet.senderTs > 0) ? Math.max(0, Math.min(6.0, (Date.now() - packet.senderTs) / 1000)) : 0;
                const targetTime = (Number(packet.time) || 0) + transitDelay;
                this._lastReportedTime = targetTime;
                this._lastDetectedState = 1;
                this.lastSyncState = 'playing';
                if (this.mode === 'local') {
                    if (this.localVideo) {
                        if (Math.abs(this.localVideo.currentTime - targetTime) > 2.5) {
                            try { this.localVideo.currentTime = targetTime; } catch(e) {}
                        }
                        this.localVideo.playbackRate = 1.0;
                        this.localVideo.muted = false;
                        const p = this.localVideo.play();
                        if (p && typeof p.catch === 'function') {
                            p.catch((err) => {
                                console.warn('[WatchParty] Remote unmuted play blocked by browser autoplay:', err);
                                this.isAutoplayBlocked = true;
                                // Instant Muted Sync Fallback: Play video muted in 0ms visual sync!
                                this.localVideo.muted = true;
                                const pMuted = this.localVideo.play();
                                if (pMuted && typeof pMuted.catch === 'function') pMuted.catch(() => {});
                                const ov = document.getElementById('fwp-play-overlay');
                                if (ov) {
                                    const label = ov.querySelector('.fwp-play-overlay-label');
                                    if (label) label.textContent = 'Tap to Unmute Sound 🔊';
                                    ov.classList.remove('hidden');
                                }
                                this.setStatus('Tap to Unmute', '#38bdf8', false);
                            });
                        } else {
                            this.isAutoplayBlocked = false;
                        }
                    }
                } else {
                    if (typeof this.player.seekTo === 'function') this.player.seekTo(targetTime, true);
                    if (typeof this.player.playVideo === 'function') this.player.playVideo();
                }
                if (!this.isAutoplayBlocked) {
                    this.setStatus('Playing', '#22c55e', true);
                    this.updatePlayIcon(true);
                }
            } else if (packet.action === 'pause') {
                this.isAutoplayBlocked = false;
                const targetTime = Number(packet.time) || 0;
                this._lastReportedTime = targetTime;
                this._lastDetectedState = 2;
                this.lastSyncState = 'paused';
                if (this.mode === 'local') {
                    if (this.localVideo) {
                        this.localVideo.currentTime = targetTime;
                        this.localVideo.pause();
                        this.localVideo.playbackRate = 1.0;
                    }
                } else {
                    if (typeof this.player.seekTo === 'function') this.player.seekTo(targetTime, true);
                    if (typeof this.player.pauseVideo === 'function') this.player.pauseVideo();
                }
                this.setStatus('Paused', '#fbbf24', false);
                this.updatePlayIcon(false);
            } else if (packet.action === 'seek') {
                const targetTime = Number(packet.time) || 0;
                this._lastReportedTime = targetTime;
                const shouldPlay = (packet.wasPlaying !== undefined) ? packet.wasPlaying : (this.lastSyncState === 'playing');
                if (shouldPlay) {
                    this.lastSyncState = 'playing';
                    this._lastDetectedState = 1;
                }
                if (this.mode === 'local') {
                    if (this.localVideo) {
                        try { this.localVideo.currentTime = targetTime; } catch(e) {}
                        this.localVideo.playbackRate = 1.0;
                        if (shouldPlay) {
                            this.updatePlayIcon(true);
                            this.setStatus('Playing', '#22c55e', true);
                            if (!this.localVideo.seeking && this.localVideo.readyState >= 2 && this.localVideo.paused) {
                                const p = this.localVideo.play();
                                if (p && typeof p.catch === 'function') p.catch(() => {});
                            }
                        } else {
                            this.localVideo.pause();
                            this.updatePlayIcon(false);
                            this.setStatus('Paused', '#fbbf24', false);
                        }
                    }
                } else {
                    if (typeof this.player.seekTo === 'function') this.player.seekTo(targetTime, true);
                    if (shouldPlay && typeof this.player.playVideo === 'function') this.player.playVideo();
                }
            } else if (packet.action === 'sync') {
                if (this.mode === 'local' && this.localVideo) {
                    if (this.isTimeLeader || this.lastSyncState !== 'playing' || this.isBuffering) return;
                    const current = this.getCurrentTime();
                    const transitDelay = (packet.senderTs && packet.senderTs > 0) ? Math.max(0, Math.min(6.0, (Date.now() - packet.senderTs) / 1000)) : 0;
                    const target = (Number(packet.time) || 0) + transitDelay;
                    const diff = target - current;
                    // Smooth micro-rate drift correction (Resilient to high ping & jitter up to 3.0s)
                    if (Math.abs(diff) < 0.35) {
                        if (this.localVideo.playbackRate !== 1.0) this.localVideo.playbackRate = 1.0;
                    } else if (diff > 0.35 && diff <= 3.0) {
                        // Gentle 5% speedup without pitch distortion to catch up across slow network
                        this.localVideo.playbackRate = 1.05;
                    } else if (diff < -0.35 && diff >= -3.0) {
                        // Gentle 5% slowdown to allow lagging peer to realign
                        this.localVideo.playbackRate = 0.95;
                    } else if (diff > 3.0) {
                        // Hard drift > 3.0s: ONLY snap forward if THIS local device is lagging behind leader!
                        // NEVER snap backward when diff < -3.0s (which caused the 5s jump back loop when remote lagged)
                        const now = Date.now();
                        if (now - this.lastSyncSeekTs > 5000) {
                            this.lastSyncSeekTs = now;
                            try { this.localVideo.currentTime = target; } catch(e) {}
                            this.localVideo.playbackRate = 1.0;
                        }
                    } else if (diff < -3.0) {
                        // Remote peer is lagging far behind us. Keep smooth 1.0x playback; remote peer will catch up or buffer.
                        if (this.localVideo.playbackRate !== 1.0) this.localVideo.playbackRate = 1.0;
                    }
                } else if (this.player && !this.isHost) {
                    const current = this.getCurrentTime();
                    const transitDelay = (packet.senderTs && packet.senderTs > 0) ? Math.max(0, Math.min(6.0, (Date.now() - packet.senderTs) / 1000)) : 0;
                    const target = (Number(packet.time) || 0) + transitDelay;
                    const now = Date.now();
                    if (!this.isBuffering && (now - this.lastSyncSeekTs > 6000) && Math.abs(current - target) > 4.5) {
                        this.lastSyncSeekTs = now;
                        this._lastReportedTime = target;
                        this.player.seekTo(target, true);
                    }
                }
            }

            setTimeout(() => {
                this.isRemoteSyncing = false;
            }, 2000);
        }

        pauseLocalOnChatExit() {
            if (this.active && this.mode === 'local' && this.localVideo) {
                this.localVideo.pause();
                this.broadcastAction('peer_left_chat', this.getCurrentTime(), { cinemaId: this.cinemaId, mode: 'local' });
                this.setStatus('Paused (Left Chat)', '#fbbf24', false);
                this.updatePlayIcon(false);
            }
        }

        closeParty(broadcast = true, fromPop = false) {
            if (!fromPop && window.BackNavManager?.has('watchparty')) {
                window.BackNavManager.pop('watchparty');
            }
            if (broadcast) {
                this.broadcastAction('close', 0, { mode: this.mode });
                const chatId = window.state?.activeChatId;
                if (chatId && typeof window.apiFetch === 'function') {
                    window.apiFetch(`/api/chat/${chatId}/watch_party`, { method: 'DELETE' }).catch(() => {});
                }
            }

            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            if (this.pollStateInterval) {
                clearInterval(this.pollStateInterval);
                this.pollStateInterval = null;
            }
            if (this.httpFallbackInterval) {
                clearInterval(this.httpFallbackInterval);
                this.httpFallbackInterval = null;
            }

            const closedCinemaId = this.cinemaId;
            this.closePlayerInstance();
            this.mode = 'youtube';

            this.active = false;
            this.videoId = null;
            this.cinemaId = null;
            this.isMinimized = false;
            this.isFullscreen = false;
            this.isBuffering = false;
            this.lastSyncSeekTs = 0;

            if (closedCinemaId && window.CinemaManager?.updateCardUI) {
                window.CinemaManager.updateCardUI(closedCinemaId);
            }

            if (this.dom.container) {
                this.dom.container.classList.add('hidden');
                this.dom.card?.classList.remove('fwp-fullscreen');
            }
        }
    }

    // Expose global instance
    window.WatchPartyEngine = new WatchPartyManager();

})(window);
