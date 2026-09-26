/* ==========================================================================
   cinema.js — FastChat Cinema Sync (Offline Movie Watch Together Engine)
   ========================================================================== */

(function(window) {
    'use strict';

    function formatFileSize(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function formatDuration(sec) {
        sec = Math.max(0, Math.floor(sec || 0));
        const hrs = Math.floor(sec / 3600);
        const mins = Math.floor((sec % 3600) / 60);
        const secs = sec % 60;
        if (hrs > 0) {
            return `${hrs}h ${mins < 10 ? '0' : ''}${mins}m ${secs < 10 ? '0' : ''}${secs}s`;
        }
        return `${mins}m ${secs < 10 ? '0' : ''}${secs}s`;
    }

    function formatRuntime(sec) {
        sec = Math.max(0, Math.round(sec || 0));
        const hrs = Math.floor(sec / 3600);
        const mins = Math.floor((sec % 3600) / 60);
        const secs = sec % 60;
        if (hrs > 0) {
            return `${hrs}h ${mins}m`;
        }
        if (mins > 0) {
            return `${mins}m`;
        }
        return `${secs}s`;
    }

    function cleanVideoTitle(s) {
        if (!s) return '';
        return String(s)
            .replace(/\.[a-z0-9]{2,5}$/i, '')
            .replace(/[_.\-+]/g, ' ')
            .replace(/\b(1080p|720p|480p|4k|2160p|x264|x265|hevc|h264|web-dl|webrip|bluray|aac|mp4|mkv)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function computeWordDiff(expectedName, selectedName) {
        const tokenize = (s) => {
            if (!s) return [];
            return String(s)
                .replace(/\.[a-z0-9]{2,5}$/i, '')
                .replace(/[._\-+\[\](){},!@#$%^&*]/g, ' ')
                .split(/\s+/)
                .filter(w => w.trim().length > 0);
        };

        const expectedTokens = tokenize(expectedName);
        const selectedTokens = tokenize(selectedName);

        const selectedSet = new Set(selectedTokens.map(t => t.toLowerCase()));
        const expectedSet = new Set(expectedTokens.map(t => t.toLowerCase()));

        const expectedDiff = expectedTokens.map(tok => ({
            text: tok,
            matched: selectedSet.has(tok.toLowerCase())
        }));

        const selectedDiff = selectedTokens.map(tok => ({
            text: tok,
            matched: expectedSet.has(tok.toLowerCase())
        }));

        return {
            expectedDiff,
            selectedDiff,
            missingCount: expectedDiff.filter(d => !d.matched).length,
            extraCount: selectedDiff.filter(d => !d.matched).length
        };
    }

    function extractVideoDuration(file) {
        return new Promise((resolve) => {
            const video = document.createElement('video');
            video.preload = 'metadata';
            const url = URL.createObjectURL(file);
            video.src = url;

            let resolved = false;
            const finish = (dur) => {
                if (resolved) return;
                resolved = true;
                try {
                    video.pause();
                    video.removeAttribute('src');
                    video.load();
                } catch(e) {}
                URL.revokeObjectURL(url);
                try { video.remove(); } catch(e) {}
                resolve(dur || 0);
            };

            video.onloadedmetadata = () => finish(video.duration);
            video.ondurationchange = () => { if (video.duration && video.duration > 0) finish(video.duration); };
            video.onloadeddata = () => { if (video.duration && video.duration > 0) finish(video.duration); };
            video.oncanplay = () => { if (video.duration && video.duration > 0) finish(video.duration); };
            video.onerror = () => finish(0);
            setTimeout(() => finish(video.duration || 0), 8000); // 8s watchdog for large files on mobile
        });
    }

    class CinemaManagerClass {
        constructor() {
            this.activeLocalFile = null;
            this.activeMetadata = null;
            this.myReadyInvites = new Set();     // cinemaIds where THIS device has local file loaded
            this.peerReadyInvites = new Set();   // cinemaIds where REMOTE peer has confirmed local file in current live session
            this.isPeerInRoom = false;           // True ONLY when 2+ peers are actively connected in the chat room WebSocket
            // Clean up any legacy localStorage keys that previously poisoned peer matching state across sessions
            try {
                const staleKeys = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith('cinema_peer_matched_')) {
                        staleKeys.push(k);
                    }
                }
                staleKeys.forEach(k => localStorage.removeItem(k));
            } catch(e) {}
            this.matchedPeerFiles = new Map();   // inviteId -> local File matched by this user
            this.matchedDetails = new Map();     // inviteId -> match result data (durations, sizes, pills)
            this.pendingMatches = new Map();     // Compatibility map
            this.lastSelectedPeerFile = new Map(); // inviteId -> last picked File
            this.pendingIncomingSession = null;  // Active watch party session
            this.modal = null;
        }

        setPeerInRoom(inRoom) {
            this.isPeerInRoom = Boolean(inRoom);
            if (!this.isPeerInRoom) {
                // When peer leaves or disconnects (e.g. page refresh, tab close, or network drop),
                // invalidate peer readiness because their in-memory file handle is terminated.
                this.peerReadyInvites.clear();
            }
            this.updateAllCardsUI();
        }

        resetSessionReadiness() {
            this.peerReadyInvites.clear();
            this.isPeerInRoom = false;
            this.updateAllCardsUI();
        }

        announceReadiness(ws) {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const readyIds = new Set([...this.myReadyInvites, ...this.matchedPeerFiles.keys()]);
            readyIds.forEach(id => {
                const file = this.matchedPeerFiles.get(id);
                try {
                    ws.send(JSON.stringify({
                        type: 'watch_party',
                        action: 'cinema_ready',
                        cinemaId: id,
                        sender: window.state?.user,
                        size: file?.size || 0
                    }));
                } catch(e) {}
            });
        }

        markMyReady(id) {
            if (!id) return;
            this.myReadyInvites.add(id);
            this.updateCardUI(id);
        }

        markPeerReady(id) {
            if (!id) return;
            this.peerReadyInvites.add(id);
            this.updateCardUI(id);
        }

        markPeerMatched(id) {
            // Local match alias
            if (!id) return;
            this.markMyReady(id);
        }

        initModal() {
            if (this.modal) return;

            let modal = document.getElementById('cinema-setup-modal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'cinema-setup-modal';
                modal.className = 'cinema-modal hidden';
                modal.innerHTML = `
                    <div class="cinema-modal-backdrop"></div>
                    <div class="cinema-modal-card">
                        <div class="cinema-modal-header">
                            <div class="cinema-title-row">
                                <div class="cinema-header-icon">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
                                        <line x1="7" y1="2" x2="7" y2="22"></line>
                                        <line x1="17" y1="2" x2="17" y2="22"></line>
                                        <line x1="2" y1="12" x2="22" y2="12"></line>
                                        <line x1="2" y1="7" x2="7" y2="7"></line>
                                        <line x1="2" y1="17" x2="7" y2="17"></line>
                                        <line x1="17" y1="17" x2="22" y2="17"></line>
                                        <line x1="17" y1="7" x2="22" y2="7"></line>
                                    </svg>
                                </div>
                                <div>
                                    <h3 class="cinema-title">Cinema Sync</h3>
                                    <p class="cinema-subtitle">Watch offline downloaded movies synchronized in real-time</p>
                                </div>
                            </div>
                            <button type="button" class="cinema-close-btn" id="cinema-modal-close" aria-label="Close">
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                        </div>

                        <div class="cinema-modal-body">
                            <!-- Dropzone & Selector -->
                            <div class="cinema-dropzone" id="cinema-dropzone">
                                <input type="file" id="cinema-file-input" accept="video/mp4,video/mkv,video/webm,video/x-matroska,video/quicktime,video/*" class="cinema-hidden-input">
                                <div class="cinema-dropzone-content" id="cinema-dropzone-content">
                                    <div class="cinema-film-reel">
                                        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                            <circle cx="12" cy="12" r="10"></circle>
                                            <circle cx="12" cy="12" r="3"></circle>
                                            <line x1="12" y1="2" x2="12" y2="9"></line>
                                            <line x1="12" y1="15" x2="12" y2="22"></line>
                                            <line x1="2" y1="12" x2="9" y2="12"></line>
                                            <line x1="15" y1="12" x2="22" y2="12"></line>
                                        </svg>
                                    </div>
                                    <p class="cinema-dropzone-prompt">Tap to choose a downloaded movie file</p>
                                    <span class="cinema-dropzone-sub">Supports MP4, MKV, WebM, MOV files</span>
                                </div>
                            </div>

                            <!-- Selected Video Info Card (Hidden until chosen) -->
                            <div class="cinema-file-card hidden" id="cinema-file-card">
                                <div class="cinema-file-main">
                                    <div class="cinema-file-icon">
                                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <polygon points="23 7 16 12 23 17 23 7"></polygon>
                                            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                                        </svg>
                                    </div>
                                    <div class="cinema-file-details">
                                        <div class="cinema-file-name-row">
                                            <label for="cinema-file-name-input" class="cinema-file-name-label">Movie Title & Extension:</label>
                                            <div class="cinema-input-ext-box">
                                                <input type="text" class="cinema-file-name-input" id="cinema-file-name-input" placeholder="e.g. Inception.2010.mp4" maxlength="120" spellcheck="false">
                                                <span class="cinema-file-ext-badge" id="cinema-file-ext-badge">.MP4</span>
                                            </div>
                                        </div>
                                        <div class="cinema-file-rename-hint" id="cinema-file-rename-hint">
                                            ✏️ Tip: If your phone gave this file random numbers, type the real movie name and extension (.mp4, .mkv) above!
                                        </div>
                                        <div class="cinema-file-specs">
                                            <span class="cinema-spec-pill" id="cinema-spec-size">0 MB</span>
                                            <span class="cinema-spec-pill" id="cinema-spec-dur">0:00</span>
                                            <span class="cinema-spec-pill" id="cinema-spec-hash">Movie Ready</span>
                                        </div>
                                    </div>
                                    <button type="button" class="cinema-file-remove" id="cinema-file-remove" title="Choose another file">
                                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                    </button>
                                </div>

                                <div class="cinema-verification-status">
                                    <span class="cinema-dot-verified"></span>
                                    <span>Movie file analyzed and ready. Tap send to invite friend.</span>
                                </div>
                            </div>
                        </div>

                        <div class="cinema-modal-footer">
                            <button type="button" class="cinema-btn cinema-cancel-btn" id="cinema-cancel-btn">Cancel</button>
                            <button type="button" class="cinema-btn cinema-send-btn" id="cinema-send-btn" disabled>
                                <span>Send Cinema Invite</span>
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                            </button>
                        </div>
                    </div>
                `;
                document.body.appendChild(modal);
            }

            this.modal = modal;
            this.bindModalEvents();
        }

        bindModalEvents() {
            const modal = this.modal;
            const dropzone = modal.querySelector('#cinema-dropzone');
            const fileInput = modal.querySelector('#cinema-file-input');
            const closeBtn = modal.querySelector('#cinema-modal-close');
            const cancelBtn = modal.querySelector('#cinema-cancel-btn');
            const removeBtn = modal.querySelector('#cinema-file-remove');
            const sendBtn = modal.querySelector('#cinema-send-btn');
            const backdrop = modal.querySelector('.cinema-modal-backdrop');

            const nameInput = modal.querySelector('#cinema-file-name-input');
            nameInput?.addEventListener('input', () => {
                if (this.activeMetadata) {
                    this.activeMetadata.name = nameInput.value.trim() || this.activeMetadata.name;
                }
            });

            dropzone?.addEventListener('click', () => fileInput?.click());
            backdrop?.addEventListener('click', () => this.closeSetupModal());
            closeBtn?.addEventListener('click', () => this.closeSetupModal());
            cancelBtn?.addEventListener('click', () => this.closeSetupModal());

            removeBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.resetSelection();
            });

            fileInput?.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                await this.handleFileSelected(file);
            });

            sendBtn?.addEventListener('click', () => {
                this.sendActiveInvite();
            });
        }

        async handleFileSelected(file) {
            const card = this.modal.querySelector('#cinema-file-card');
            const dropzone = this.modal.querySelector('#cinema-dropzone');
            const nameInput = this.modal.querySelector('#cinema-file-name-input');
            const extBadge = this.modal.querySelector('#cinema-file-ext-badge');
            const renameHint = this.modal.querySelector('#cinema-file-rename-hint');
            const specSizeEl = this.modal.querySelector('#cinema-spec-size');
            const specDurEl = this.modal.querySelector('#cinema-spec-dur');
            const specHashEl = this.modal.querySelector('#cinema-spec-hash');
            const sendBtn = this.modal.querySelector('#cinema-send-btn');

            // 1. Detect and preserve extension
            let ext = '';
            const match = (file.name || '').match(/\.([a-z0-9]{2,5})$/i);
            if (match) {
                ext = '.' + match[1].toLowerCase();
            } else {
                try {
                    const slice = await file.slice(0, 8).arrayBuffer();
                    const view = new DataView(slice);
                    // Matroska / WebM EBML magic: 0x1A 0x45 0xDF 0xA3
                    if (view.byteLength >= 4 && view.getUint8(0) === 0x1A && view.getUint8(1) === 0x45 && view.getUint8(2) === 0xDF && view.getUint8(3) === 0xA3) {
                        ext = '.mkv';
                    }
                } catch(e) {}
                if (!ext) {
                    if (file.type && (file.type.includes('matroska') || file.type.includes('mkv'))) ext = '.mkv';
                    else if (file.type && file.type.includes('webm')) ext = '.webm';
                    else if (file.type && file.type.includes('quicktime')) ext = '.mov';
                    else ext = '.mp4';
                }
            }

            let initialName = file.name || ('Movie' + ext);
            if (!initialName.toLowerCase().endsWith(ext)) {
                initialName += ext;
            }

            const isNumericOnly = /^\d+(\.[a-z0-9]{2,5})?$/i.test(file.name || '');
            if (nameInput) {
                nameInput.value = initialName;
                if (isNumericOnly) {
                    nameInput.classList.add('highlight-rename');
                    if (renameHint) renameHint.style.display = 'block';
                } else {
                    nameInput.classList.remove('highlight-rename');
                    if (renameHint) renameHint.style.display = 'none';
                }
            }
            if (extBadge) {
                extBadge.textContent = ext.toUpperCase();
            }

            specSizeEl.textContent = formatFileSize(file.size);
            specDurEl.textContent = 'Calculating duration...';
            specHashEl.textContent = 'Analyzing...';

            dropzone.classList.add('hidden');
            card.classList.remove('hidden');

            const duration = await extractVideoDuration(file);

            specDurEl.textContent = formatRuntime(duration);
            specHashEl.textContent = 'Ready';

            this.activeLocalFile = file;
            this.activeMetadata = {
                name: initialName,
                ext: ext,
                size: file.size,
                sizeFormatted: formatFileSize(file.size),
                duration: Math.round(duration || 0),
                durationFormatted: formatRuntime(duration)
            };

            sendBtn.disabled = false;
        }

        resetSelection() {
            this.activeLocalFile = null;
            this.activeMetadata = null;
            const fileInput = this.modal?.querySelector('#cinema-file-input');
            if (fileInput) fileInput.value = '';
            const nameInput = this.modal?.querySelector('#cinema-file-name-input');
            if (nameInput) {
                nameInput.value = '';
                nameInput.classList.remove('highlight-rename');
            }
            const renameHint = this.modal?.querySelector('#cinema-file-rename-hint');
            if (renameHint) renameHint.style.display = 'none';
            this.modal?.querySelector('#cinema-dropzone')?.classList.remove('hidden');
            this.modal?.querySelector('#cinema-file-card')?.classList.add('hidden');
            const sendBtn = this.modal?.querySelector('#cinema-send-btn');
            if (sendBtn) sendBtn.disabled = true;
        }

        openSetupModal() {
            this.initModal();
            this.resetSelection();
            this.modal.classList.remove('hidden');
            window.BackNavManager?.push('cinema-modal', () => {
                this.closeSetupModal(true);
            });
        }

        closeSetupModal(fromPop = false) {
            if (!fromPop && window.BackNavManager?.has('cinema-modal')) {
                window.BackNavManager.pop('cinema-modal');
            }
            if (this.modal) {
                this.modal.classList.add('hidden');
            }
        }

        sendActiveInvite() {
            if (!this.activeLocalFile || !this.activeMetadata) return;
            const nameInput = this.modal?.querySelector('#cinema-file-name-input');
            let finalName = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : this.activeMetadata.name;
            const ext = this.activeMetadata.ext || '.mp4';
            if (!/\.[a-z0-9]{2,5}$/i.test(finalName)) {
                finalName += ext;
            }
            this.activeMetadata.name = finalName;
            const meta = this.activeMetadata;
            this.closeSetupModal();

            const cinemaId = 'cinema_' + Date.now();
            this.matchedPeerFiles.set(cinemaId, this.activeLocalFile);
            this.myReadyInvites.add(cinemaId);
            setTimeout(() => this.updateCardUI(cinemaId), 50);
            const invitePayload = {
                type: 'cinema_invite',
                cinemaInvite: {
                    id: cinemaId,
                    name: meta.name,
                    size: meta.size,
                    sizeFormatted: meta.sizeFormatted,
                    duration: meta.duration,
                    durationFormatted: meta.durationFormatted,
                    from: window.state?.user || 'Host'
                }
            };

            const displayText = `Cinema Sync: ${meta.name}`;

            // Send into chat stream via unified sender
            if (typeof window.sendDirectCustomMessage === 'function') {
                window.sendDirectCustomMessage(displayText, invitePayload);
            } else if (typeof window.sendMessageWithPayload === 'function') {
                window.sendMessageWithPayload(displayText, invitePayload);
            } else {
                const ws = window.state?.ws;
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'message',
                        text: displayText,
                        cinemaInvite: invitePayload.cinemaInvite
                    }));
                }
            }
        }

        // Peer file matching handler called when recipient selects local file
        async matchPeerMovieFile(invite, file) {
            if (!invite || !file) return { match: false, reason: 'No file provided' };
            this.lastSelectedPeerFile.set(invite.id, file);

            const duration = await extractVideoDuration(file);
            const localDur = Math.round(duration || 0);
            const inviteDur = Math.round(invite.duration || 0);

            // 1. Duration check: hard gate - must match within 15 seconds (accounts for distributor logos/intros)
            const durDiff = Math.abs(localDur - inviteDur);
            const durMatch = (inviteDur > 0 && localDur > 0) ? (durDiff <= 15) : (localDur > 0);

            // 2. File size check: informative soft gate - NEVER blocks playback
            const localSize = file.size || 0;
            const inviteSize = Number(invite.size) || 0;
            const sizeDiffBytes = localSize - inviteSize;
            const sizeDiffMB = (sizeDiffBytes / (1024 * 1024)).toFixed(1);
            const absSizeDiffMB = Math.abs(sizeDiffBytes) / (1024 * 1024);
            const isExactSize = Math.abs(sizeDiffBytes) <= (10 * 1024 * 1024); // within 10MB considered exact/near-exact

            let sizeDiffText = '';
            if (inviteSize > 0) {
                if (isExactSize) {
                    sizeDiffText = `Identical (${formatFileSize(localSize)})`;
                } else {
                    const sign = sizeDiffBytes >= 0 ? '+' : '-';
                    sizeDiffText = `${sign}${absSizeDiffMB.toFixed(0)} MB diff (${formatFileSize(localSize)} vs Host: ${formatFileSize(inviteSize)})`;
                }
            }

            // Duration is the ONLY hard requirement! Filename is completely ignored.
            if (durMatch) {
                this.activeLocalFile = file;
                this.matchedPeerFiles.set(invite.id, file);
                this.pendingMatches.set(invite.id, file);
                this.myReadyInvites.add(invite.id);

                const matchData = {
                    match: true,
                    duration: duration,
                    durDiff: durDiff,
                    localDur: localDur,
                    inviteDur: inviteDur,
                    localDurFormatted: formatRuntime(localDur),
                    inviteDurFormatted: formatRuntime(inviteDur),
                    durDiffFormatted: formatRuntime(durDiff),
                    sizeDiffBytes: sizeDiffBytes,
                    sizeDiffMB: sizeDiffMB,
                    isExactSize: isExactSize,
                    localSize: localSize,
                    inviteSize: inviteSize,
                    localSizeFormatted: formatFileSize(localSize),
                    inviteSizeFormatted: formatFileSize(inviteSize)
                };
                this.matchedDetails.set(invite.id, matchData);

                this.updateCardUI(invite.id);

                // Broadcast ready confirmation to peer over WebSocket
                const ws = window.state?.ws;
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'watch_party',
                        action: 'cinema_ready',
                        cinemaId: invite.id,
                        sender: window.state?.user,
                        size: localSize,
                        duration: localDur
                    }));
                }

                return matchData;
            }

            // Mismatch: clear any existing matched records
            this.matchedPeerFiles.delete(invite.id);
            this.pendingMatches.delete(invite.id);
            this.matchedDetails.delete(invite.id);
            this.myReadyInvites.delete(invite.id);
            this.updateCardUI(invite.id);

            const hostDurStr = formatRuntime(inviteDur);
            const userDurStr = formatRuntime(localDur);
            const diffDurStr = formatRuntime(durDiff);

            return {
                match: false,
                reason: `Duration Mismatch: Host movie is ${hostDurStr}, but your file is ${userDurStr} (Diff: ${diffDurStr}). Please select the matching movie file.`,
                comparison: {
                    expectedName: invite.name || 'Movie',
                    selectedName: file.name || 'File',
                    hostDuration: inviteDur,
                    userDuration: localDur,
                    hostDurationFormatted: hostDurStr,
                    userDurationFormatted: userDurStr,
                    durationDiff: durDiff,
                    durationDiffFormatted: diffDurStr,
                    isDurationMatched: false,
                    sizeDiffText: sizeDiffText,
                    isExactSize: isExactSize,
                    hostSizeFormatted: invite.sizeFormatted || (inviteSize ? formatFileSize(inviteSize) : ''),
                    userSizeFormatted: formatFileSize(file.size || 0),
                    expectedSizeFormatted: invite.sizeFormatted || (inviteSize ? formatFileSize(inviteSize) : ''),
                    selectedSizeFormatted: formatFileSize(file.size || 0)
                }
            };
        }

        // Force match user's selected file if within hard duration gate
        async forceMatchPeerMovieFile(inviteId) {
            const file = this.lastSelectedPeerFile.get(inviteId);
            if (!file) return;

            const cardEl = document.getElementById(`cinema-card-${inviteId}`);
            const inviteDur = cardEl ? Number(cardEl.dataset.cinemaDuration) || 0 : 0;
            if (inviteDur > 0) {
                const dur = await extractVideoDuration(file);
                const pickedDur = Math.round(dur || 0);
                if (Math.abs(pickedDur - inviteDur) > 10) {
                    alert(`Cannot start: Duration mismatch!\n\nHost movie is ${formatRuntime(inviteDur)}, but selected file is ${formatRuntime(pickedDur)}.\nPlease choose the correct movie file.`);
                    return;
                }
            }

            this.activeLocalFile = file;
            this.matchedPeerFiles.set(inviteId, file);
            this.pendingMatches.set(inviteId, file);
            this.markMyReady(inviteId);
            this.updateCardUI(inviteId);

            const ws = window.state?.ws;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'watch_party',
                    action: 'cinema_ready',
                    cinemaId: inviteId,
                    sender: window.state?.user
                }));
            }
        }

        // Interactive modal prompting user to select their local movie file when an incoming start signal arrives
        promptToJoinActiveSession(sessionData) {
            if (!sessionData || !sessionData.cinemaId) return;
            this.pendingIncomingSession = sessionData;

            // Remove existing modal if any
            const existing = document.getElementById('cinema-join-modal');
            if (existing) existing.remove();

            const modal = document.createElement('div');
            modal.id = 'cinema-join-modal';
            modal.className = 'cinema-join-overlay';
            modal.innerHTML = `
                <div class="cinema-join-dialog">
                    <div class="cinema-join-badge">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                        <span>Watch Party Started!</span>
                    </div>
                    <div class="cinema-join-title">${escapeHtml(sessionData.title || 'Movie')}</div>
                    <div class="cinema-join-desc">
                        <strong>${escapeHtml(sessionData.sender || sessionData.host || 'Your friend')}</strong> has started the movie! Select your local video file to join and watch in sync.
                    </div>
                    <div class="cinema-join-actions">
                        <button type="button" class="cinema-join-pick-btn" id="cinema-modal-pick-btn">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                            <span>Select Movie & Join Now</span>
                        </button>
                        <button type="button" class="cinema-join-dismiss-btn" id="cinema-modal-dismiss-btn">Dismiss</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const pickBtn = modal.querySelector('#cinema-modal-pick-btn');
            const dismissBtn = modal.querySelector('#cinema-modal-dismiss-btn');

            if (dismissBtn) {
                dismissBtn.onclick = () => {
                    modal.remove();
                };
            }

            if (pickBtn) {
                pickBtn.onclick = () => {
                    // DIRECT USER GESTURE -> fileInput.click() is 100% permitted by browser
                    const fileInput = document.createElement('input');
                    fileInput.type = 'file';
                    fileInput.accept = 'video/mp4,video/mkv,video/webm,video/x-matroska,video/quicktime,video/*';
                    fileInput.style.display = 'none';
                    document.body.appendChild(fileInput);
                    fileInput.onchange = async () => {
                        const picked = fileInput.files?.[0];
                        fileInput.remove();
                        if (!picked) return;

                        // Verify duration against active session duration (hard gate: <= 10s)
                        const sessionDur = Math.round(sessionData.duration || 0);
                        if (sessionDur > 0) {
                            const dur = await extractVideoDuration(picked);
                            const pickedDur = Math.round(dur || 0);
                            const diff = Math.abs(pickedDur - sessionDur);
                            if (diff > 10) {
                                const hostDurStr = formatRuntime(sessionDur);
                                const pickedDurStr = formatRuntime(pickedDur);
                                const diffStr = formatRuntime(diff);
                                alert(`Duration Mismatch!\n\nHost movie is ${hostDurStr}, but your selected file is ${pickedDurStr} (Diff: ${diffStr}).\n\nPlease select the matching movie file.`);
                                return;
                            }
                        }

                        modal.remove();
                        this.activeLocalFile = picked;
                        this.matchedPeerFiles.set(sessionData.cinemaId, picked);
                        if (window.WatchPartyEngine) {
                            const elapsed = (Date.now() - (sessionData.receivedTs || Date.now())) / 1000;
                            const targetTime = Math.max(0, (sessionData.time || 0) + elapsed);
                            window.WatchPartyEngine.startLocalParty(picked, sessionData.title, false, targetTime, sessionData.cinemaId, sessionData.duration || 0);
                        }
                    };
                    fileInput.click();
                };
            }
        }

        // Launch party in floating player (EITHER user can start synced playback, but ONLY if both users are in chat and both have selected their files!)
        launchParty(cinemaInvite) {
            if (!cinemaInvite || !cinemaInvite.id) return;

            // If already active in this cinema session, simply bring player to view
            if (window.WatchPartyEngine?.active && window.WatchPartyEngine?.cinemaId === cinemaInvite.id) {
                window.WatchPartyEngine.dom.container?.classList.remove('hidden');
                window.WatchPartyEngine.dom.card?.classList.remove('hidden');
                window.WatchPartyEngine.dom.bubble?.classList.add('hidden');
                window.WatchPartyEngine.isMinimized = false;
                return;
            }

            const hasMyFile = Boolean(this.matchedPeerFiles.has(cinemaInvite.id) || this.pendingMatches.has(cinemaInvite.id));
            const isPeerReady = Boolean(this.peerReadyInvites.has(cinemaInvite.id));
            const isPeerInRoom = Boolean(this.isPeerInRoom);

            if (!hasMyFile) {
                console.warn('[Cinema] Blocked launch: Local file not selected');
                this.updateCardUI(cinemaInvite.id);
                return;
            }

            if (!isPeerReady || !isPeerInRoom) {
                console.warn('[Cinema] Blocked launch: Peer is not ready or not in chat', { isPeerReady, isPeerInRoom });
                alert('Cannot start movie yet!\n\nBoth you and your friend must be in this chat and both must have selected your matching movie files.');
                this.updateCardUI(cinemaInvite.id);
                return;
            }

            let file = this.matchedPeerFiles.get(cinemaInvite.id) || this.pendingMatches.get(cinemaInvite.id);
            if (!file) {
                this.updateCardUI(cinemaInvite.id);
                return;
            }

            // Launch local party as initiator (shouldBroadcastStart = true)
            if (window.WatchPartyEngine) {
                window.WatchPartyEngine.startLocalParty(file, cinemaInvite.name, true, 0, cinemaInvite.id, cinemaInvite.duration || 0);
            }
        }

        updateAllCardsUI() {
            document.querySelectorAll('.message-cinema-card').forEach(card => {
                const id = card.dataset.cinemaId;
                if (id) this.updateCardUI(id);
            });
        }

        // Dynamically update card in chat when local file is picked or player becomes active
        updateCardUI(cinemaId) {
            if (!cinemaId) return;
            const cardEl = document.getElementById(`cinema-card-${cinemaId}`);
            if (!cardEl) return;

            const isPlayerActive = Boolean(
                window.WatchPartyEngine?.active &&
                window.WatchPartyEngine?.cinemaId === cinemaId
            );
            const hasMyFile = Boolean(
                this.matchedPeerFiles.has(cinemaId) ||
                this.pendingMatches.has(cinemaId)
            );
            const isPeerReady = Boolean(
                this.peerReadyInvites.has(cinemaId)
            );
            const isPeerInRoom = Boolean(this.isPeerInRoom);

            const statusEl = cardEl.querySelector('.cinema-card-status');
            const actionsEl = cardEl.querySelector('.cinema-card-actions');
            const icons = window.CINEMA_CARD_ICONS || {
                play: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>',
                folder: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>'
            };

            if (isPlayerActive) {
                if (statusEl) {
                    statusEl.className = 'cinema-card-status';
                    statusEl.innerHTML = `
                        <span class="cinema-status-dot green"></span>
                        <span>Cinema Player active in floating window.</span>
                    `;
                }
                if (actionsEl) {
                    actionsEl.innerHTML = `
                        <button type="button" class="cinema-action-btn cinema-launch-btn" data-cinema-id="${escapeHtml(cinemaId)}">
                            ${icons.play}
                            <span>Bring Player to Front</span>
                        </button>
                    `;
                }
                return;
            }

            if (!hasMyFile) {
                // Client has not picked file yet
                if (statusEl) {
                    statusEl.className = 'cinema-card-status';
                    statusEl.innerHTML = `
                        <span class="cinema-status-dot blue"></span>
                        <span>Wants to watch this movie with you.</span>
                    `;
                }
                if (actionsEl) {
                    actionsEl.innerHTML = `
                        <button type="button" class="cinema-action-btn cinema-match-btn" data-cinema-id="${escapeHtml(cinemaId)}">
                            ${icons.folder}
                            <span>Choose Movie File</span>
                        </button>
                    `;
                }
            } else if (!isPeerReady) {
                // Client has picked file, waiting for friend to pick matching file
                if (statusEl) {
                    statusEl.className = 'cinema-card-status';
                    statusEl.innerHTML = `
                        <span class="cinema-status-dot amber"></span>
                        <span>Your file is ready! Waiting for friend to select movie file...</span>
                    `;
                }
                if (actionsEl) {
                    actionsEl.innerHTML = `
                        <button type="button" class="cinema-action-btn cinema-waiting-btn" disabled style="opacity: 0.75; cursor: not-allowed;">
                            <span class="cinema-status-dot amber"></span>
                            <span>Waiting for Friend's File...</span>
                        </button>
                    `;
                }
            } else if (!isPeerInRoom) {
                // Both files are ready, but friend is not inside this chat window!
                if (statusEl) {
                    statusEl.className = 'cinema-card-status';
                    statusEl.innerHTML = `
                        <span class="cinema-status-dot amber"></span>
                        <span>Both files ready! Waiting for friend to enter chat...</span>
                    `;
                }
                if (actionsEl) {
                    actionsEl.innerHTML = `
                        <button type="button" class="cinema-action-btn cinema-waiting-btn" disabled style="opacity: 0.75; cursor: not-allowed;">
                            <span class="cinema-status-dot amber"></span>
                            <span>Friend Not in Chat</span>
                        </button>
                    `;
                }
            } else {
                // BOTH READY AND BOTH IN SAME CHAT WINDOW!
                if (statusEl) {
                    statusEl.className = 'cinema-card-status matched-status';
                    statusEl.innerHTML = `
                        <div class="cinema-match-row">
                            <span class="cinema-status-dot green"></span>
                            <span class="cinema-match-text">Movie ready on both devices! Either can start now.</span>
                        </div>
                    `;
                }
                if (actionsEl) {
                    actionsEl.innerHTML = `
                        <button type="button" class="cinema-action-btn cinema-launch-btn cinema-ready-start-btn" data-cinema-id="${escapeHtml(cinemaId)}">
                            ${icons.play}
                            <span>Start Movie Together</span>
                        </button>
                    `;
                }
            }
        }
    }

    const cinemaManagerInstance = new CinemaManagerClass();
    cinemaManagerInstance.computeWordDiff = computeWordDiff;
    cinemaManagerInstance.formatDuration = formatDuration;
    cinemaManagerInstance.formatRuntime = formatRuntime;
    cinemaManagerInstance.formatFileSize = formatFileSize;
    cinemaManagerInstance.cleanVideoTitle = cleanVideoTitle;

    window.CinemaManager = cinemaManagerInstance;

})(window);
