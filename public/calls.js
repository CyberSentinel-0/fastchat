/* =========================================
   calls.js - WebRTC Engine & Kebab Menu UI
   ========================================= */

let localStream = null;
let remoteStream = null;
let peerConnection = null;
let isVideoCall = false;
let currentCallPeer = null;
let callStartTime = 0;
let callTimerInterval = null;

// Audio context for ringtone
const ringtoneAudio = document.getElementById('ringtone-audio');

// WebRTC ICE Candidate queue for early candidates
let pendingIceCandidates = [];

// WebRTC Configuration
// TURN credentials are fetched dynamically from Metered.ca Open Relay (free 20GB/mo)
const METERED_API_KEY = '4b50472dfa1c2b7d3eed18b57924ae8f9b3d';
let rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ]
};

// TURN credentials cache (1 hour TTL) to eliminate call initiation network lag
let _cachedTurnServers = null;
let _turnServersFetchedTs = 0;
const TURN_CACHE_TTL = 3600000; // 1 hour

// Fetch TURN credentials from Metered.ca API (call before each call, reuses cache if fresh)
async function fetchTurnCredentials() {
    if (!METERED_API_KEY) {
        console.warn('[WebRTC] No Metered API key set — using STUN only (may fail cross-country)');
        return;
    }

    // Reuse fresh cached credentials (saves 200-500ms network round-trip on call initiation)
    if (_cachedTurnServers && (Date.now() - _turnServersFetchedTs < TURN_CACHE_TTL)) {
        rtcConfig.iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            ..._cachedTurnServers
        ];
        return;
    }

    try {
        const resp = await fetch(`https://fastchat1.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`);
        if (resp.ok) {
            const meteredServers = await resp.json();
            _cachedTurnServers = meteredServers;
            _turnServersFetchedTs = Date.now();
            rtcConfig = {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun3.l.google.com:19302' },
                    { urls: 'stun:stun4.l.google.com:19302' },
                    ...meteredServers
                ]
            };
            console.log('[WebRTC] TURN credentials fetched and cached:', meteredServers.length, 'servers');
        }
    } catch (e) {
        console.error('[WebRTC] Failed to fetch TURN credentials:', e);
    }
}

// =========================================
// Signaling Router (Called by app.js)
// =========================================
window.handleWebRTCSignal = async (signal) => {
    // Ignore signals that originated from ourselves (echoed back via stale/duplicate WS sessions)
    const signalFrom = signal.callerUser || signal.from;
    if (signalFrom && signalFrom === state.user) {
        console.log('[WebRTC] Ignoring own signal echo:', signal.type);
        return;
    }
    switch(signal.type) {
        case 'offer':
            return handleCallOffer(signal);
        case 'answer':
            return handleCallAnswer(signal);
        case 'ice_candidate':
            return handleIceCandidate(signal);
        case 'call_end':
            return cleanupCall();
    }
};

// =========================================
// Start Call Flow
// =========================================
async function initCall(video) {
    if (!state.activeChatId) {
        alert("Please select a chat first.");
        return;
    }
    if (state.isGroup || (state.activeChatId && state.activeChatId.startsWith('grp_'))) {
        alert("Audio and video calling are not supported in group chats yet.");
        return;
    }
    if (state.isRandom || (state.activeChatId && state.activeChatId.startsWith('rnd_'))) {
        alert("Calls are disabled during anonymous random chat.");
        return;
    }
    
    isVideoCall = video;
    currentCallPeer = state.activePeer || state.activeChatId.replace(state.user, '').replace(':', '');
    
    // Show active call screen immediately in outgoing state
    showActiveCallScreen(currentCallPeer, "Calling...");
    
    try {
        await fetchTurnCredentials();
        await setupMedia(isVideoCall);
        peerConnection = new RTCPeerConnection(rtcConfig);
        
        // Add local tracks to peer connection
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
        
        // Handle incoming remote tracks
        peerConnection.ontrack = (event) => {
            if (!remoteStream) {
                remoteStream = new MediaStream();
            }
            remoteStream.addTrack(event.track);
            
            const remoteVid = document.getElementById('remote-video');
            const remoteAud = document.getElementById('remote-audio');
            
            if (isVideoCall) {
                if (remoteVid.srcObject !== remoteStream) {
                    remoteVid.srcObject = remoteStream;
                    remoteVid.classList.remove('hidden');
                }
                remoteVid.play().catch(e => console.log("Video autoplay blocked", e));
            } else {
                if (remoteAud.srcObject !== remoteStream) {
                    remoteAud.srcObject = remoteStream;
                }
                remoteAud.play().catch(e => console.log("Audio autoplay blocked", e));
            }
        };
        
        // Monitor ICE connection state for debugging
        peerConnection.oniceconnectionstatechange = () => {
            console.log('[WebRTC] ICE state:', peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
                document.getElementById('active-call-duration').textContent = 'Connected';
            } else if (peerConnection.iceConnectionState === 'failed') {
                console.error('[WebRTC] ICE connection failed — may need TURN server');
                document.getElementById('active-call-duration').textContent = 'Connection failed';
            }
        };
        
        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                sendSignal({
                    type: 'ice_candidate',
                    candidate: event.candidate,
                    target: currentCallPeer,
                    from: state.user
                });
            }
        };
        
        // Create Offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        // Send Offer
        sendSignal({
            type: 'offer',
            offer: offer,
            target: currentCallPeer,
            video: isVideoCall,
            callerUser: state.user
        });
        
    } catch (err) {
        console.error("Failed to start call:", err);
        alert("Failed to access camera/microphone.");
        cleanupCall();
    }
}

// =========================================
// Handle Incoming Call
// =========================================
async function handleCallOffer(signal) {
    // If already in a call or already ringing for someone else, auto-reject
    if (peerConnection || (currentCallPeer && currentCallPeer !== signal.callerUser)) {
        sendSignal({ type: 'call_end', target: signal.callerUser, from: state.user });
        return;
    }
    
    currentCallPeer = signal.callerUser;
    isVideoCall = signal.video;
    
    // Play ringtone and show incoming screen
    if(ringtoneAudio) ringtoneAudio.play().catch(e => console.log('Audio autoplay blocked'));
    
    const callerAvatar = document.getElementById('caller-avatar');
    if (callerAvatar) {
        callerAvatar.textContent = currentCallPeer ? currentCallPeer[0].toUpperCase() : '';
        const cachedPic = localStorage.getItem(`profile_pic_${currentCallPeer}`);
        if (cachedPic) {
            callerAvatar.style.backgroundImage = `url(${cachedPic})`;
            callerAvatar.classList.add('has-pic');
            callerAvatar.textContent = '';
        } else {
            callerAvatar.style.backgroundImage = '';
            callerAvatar.classList.remove('has-pic');
        }
    }
    
    document.getElementById('caller-name').textContent = document.getElementById('chat-title').textContent || currentCallPeer;
    document.getElementById('call-type-text').textContent = isVideoCall ? 'Incoming Video Call...' : 'Incoming Audio Call...';
    document.getElementById('incoming-call-screen').classList.remove('hidden');
    window.BackNavManager?.push('incoming-call', () => {
        document.getElementById('decline-call-btn')?.click();
    });
    
    // Store offer globally to be used if accepted
    window.__pendingCallOffer = signal.offer;
}

// =========================================
// Accept / Decline Responses
// =========================================
document.getElementById('accept-call-btn')?.addEventListener('click', async () => {
    document.getElementById('incoming-call-screen').classList.add('hidden');
    if(ringtoneAudio) {
        ringtoneAudio.pause();
        ringtoneAudio.currentTime = 0;
    }
    
    showActiveCallScreen(currentCallPeer, "Connecting...");
    
    try {
        await fetchTurnCredentials();
        await setupMedia(isVideoCall);
        peerConnection = new RTCPeerConnection(rtcConfig);
        
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
        
        peerConnection.ontrack = (event) => {
            if (!remoteStream) {
                remoteStream = new MediaStream();
            }
            remoteStream.addTrack(event.track);
            
            const remoteVid = document.getElementById('remote-video');
            const remoteAud = document.getElementById('remote-audio');
            
            if (isVideoCall) {
                if (remoteVid.srcObject !== remoteStream) {
                    remoteVid.srcObject = remoteStream;
                    remoteVid.classList.remove('hidden');
                }
                remoteVid.play().catch(e => console.log("Video autoplay blocked", e));
            } else {
                if (remoteAud.srcObject !== remoteStream) {
                    remoteAud.srcObject = remoteStream;
                }
                remoteAud.play().catch(e => console.log("Audio autoplay blocked", e));
            }
        };
        
        // Monitor ICE connection state
        peerConnection.oniceconnectionstatechange = () => {
            console.log('[WebRTC] ICE state:', peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
                document.getElementById('active-call-duration').textContent = 'Connected';
            } else if (peerConnection.iceConnectionState === 'failed') {
                console.error('[WebRTC] ICE connection failed — may need TURN server');
                document.getElementById('active-call-duration').textContent = 'Connection failed';
            }
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                sendSignal({ type: 'ice_candidate', candidate: event.candidate, target: currentCallPeer, from: state.user });
            }
        };
        
        // Set remote description from pending offer
        await peerConnection.setRemoteDescription(new RTCSessionDescription(window.__pendingCallOffer));
        window.__pendingCallOffer = null;
        
        // Create Answer
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        // Send Answer
        sendSignal({ type: 'answer', answer: answer, target: currentCallPeer, from: state.user });
        
        startCallTimer();
        
        // Process queued ICE candidates
        while (pendingIceCandidates.length > 0) {
            const candidate = pendingIceCandidates.shift();
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.error("Error adding queued ice candidate", e);
            }
        }
        
    } catch (err) {
        console.error("Failed to accept call", err);
        sendSignal({ type: 'call_end', target: currentCallPeer, from: state.user });
        cleanupCall();
    }
});

document.getElementById('decline-call-btn')?.addEventListener('click', () => {
    if(ringtoneAudio) ringtoneAudio.pause();
    sendSignal({ type: 'call_end', target: currentCallPeer, from: state.user });
    cleanupCall();
});

// =========================================
// Complete Handshake & ICE
// =========================================
async function handleCallAnswer(signal) {
    if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.answer));
        startCallTimer();
        // Process queued ICE candidates
        while (pendingIceCandidates.length > 0) {
            const candidate = pendingIceCandidates.shift();
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.error("Error adding queued ice candidate", e);
            }
        }
    }
}

async function handleIceCandidate(signal) {
    if (peerConnection && peerConnection.remoteDescription && signal.candidate) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (e) {
            console.error("Error adding received ice candidate", e);
        }
    } else if (signal.candidate) {
        pendingIceCandidates.push(signal.candidate);
    }
}

// =========================================
// Helpers and Cleanup
// =========================================
async function setupMedia(video) {
    localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: video ? { facingMode: "user" } : false
    });
    
    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = localStream;
    if (video) localVideo.classList.remove('hidden');
}

function sendSignal(data) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(data));
    }
}

function showActiveCallScreen(peerName, initialText) {
    document.getElementById('active-call-name').textContent = document.getElementById('chat-title').textContent || peerName;
    document.getElementById('active-call-duration').textContent = initialText;
    
    const activeAvatar = document.getElementById('active-call-avatar-wrapper');
    if (activeAvatar) {
        activeAvatar.textContent = peerName ? peerName[0].toUpperCase() : '';
        const cachedPic = localStorage.getItem(`profile_pic_${currentCallPeer}`);
        if (cachedPic) {
            activeAvatar.style.backgroundImage = `url(${cachedPic})`;
            activeAvatar.classList.add('has-pic');
            activeAvatar.textContent = '';
        } else {
            activeAvatar.style.backgroundImage = '';
            activeAvatar.classList.remove('has-pic');
        }
    }
    
    if (isVideoCall) {
        document.getElementById('active-call-bg')?.classList.add('hidden');
        document.getElementById('toggle-camera-btn')?.classList.remove('hidden');
        document.getElementById('camera-flip-btn')?.classList.remove('hidden');
    } else {
        document.getElementById('active-call-bg')?.classList.remove('hidden');
        document.getElementById('toggle-camera-btn')?.classList.add('hidden');
        document.getElementById('camera-flip-btn')?.classList.add('hidden');
    }
    
    document.getElementById('active-call-screen').classList.remove('hidden');
    window.BackNavManager?.push('active-call', () => {
        document.getElementById('end-call-btn')?.click();
    });
}

function startCallTimer() {
    callStartTime = Date.now();
    callTimerInterval = setInterval(() => {
        if (peerConnection && (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed')) {
            const diff = Math.floor((Date.now() - callStartTime) / 1000);
            const mins = Math.floor(diff / 60).toString().padStart(2, '0');
            const secs = (diff % 60).toString().padStart(2, '0');
            document.getElementById('active-call-duration').textContent = `${mins}:${secs}`;
        }
    }, 1000);
}

function cleanupCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    remoteStream = null;
    currentCallPeer = null;
    isVideoCall = false;
    pendingIceCandidates = [];
    
    clearInterval(callTimerInterval);
    if(ringtoneAudio) ringtoneAudio.pause();
    
    if (window.BackNavManager?.has('incoming-call')) window.BackNavManager.pop('incoming-call');
    if (window.BackNavManager?.has('active-call')) window.BackNavManager.pop('active-call');
    document.getElementById('incoming-call-screen')?.classList.add('hidden');
    document.getElementById('active-call-screen')?.classList.add('hidden');
    
    const remoteVid = document.getElementById('remote-video');
    const localVid = document.getElementById('local-video');
    const remoteAud = document.getElementById('remote-audio');
    
    if (remoteVid) { remoteVid.classList.add('hidden'); remoteVid.srcObject = null; }
    if (localVid) { localVid.classList.add('hidden'); localVid.srcObject = null; }
    if (remoteAud) { remoteAud.srcObject = null; }
}

// =========================================
// UI Event Listeners (Header & Controls)
// =========================================
document.getElementById('video-call-btn')?.addEventListener('click', () => initCall(true));
document.getElementById('audio-call-btn')?.addEventListener('click', () => initCall(false));

document.getElementById('end-call-btn')?.addEventListener('click', () => {
    sendSignal({ type: 'call_end', target: currentCallPeer, from: state.user });
    cleanupCall();
});

document.getElementById('toggle-mic-btn')?.addEventListener('click', (e) => {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            e.currentTarget.classList.toggle('muted', !audioTrack.enabled);
        }
    }
});

document.getElementById('toggle-camera-btn')?.addEventListener('click', (e) => {
    if (localStream && isVideoCall) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            e.currentTarget.classList.toggle('muted', !videoTrack.enabled);
            document.getElementById('local-video').style.opacity = videoTrack.enabled ? 1 : 0;
        }
    }
});

// Switch camera (front/back)
document.getElementById('camera-flip-btn')?.addEventListener('click', async () => {
    if (localStream && isVideoCall) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (!videoTrack) return;
        
        const currentFacingMode = videoTrack.getSettings().facingMode;
        const newFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
        const isEnabled = videoTrack.enabled;
        
        videoTrack.stop();
        
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: newFacingMode }
            });
            
            const newVideoTrack = newStream.getVideoTracks()[0];
            if (newVideoTrack) {
                newVideoTrack.enabled = isEnabled;
                localStream.removeTrack(videoTrack);
                localStream.addTrack(newVideoTrack);
                
                document.getElementById('local-video').srcObject = localStream;
                
                if (peerConnection) {
                    const senders = peerConnection.getSenders();
                    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
                    if (videoSender) {
                        await videoSender.replaceTrack(newVideoTrack);
                    }
                }
            }
        } catch (e) {
            console.error("Camera flip error:", e);
        }
    }
});

// =========================================
// Kebab Menu & Themes Logic — JS-injected to guarantee rendering
// =========================================
const THEMES_LIST = [
    { id: 'default', name: 'Classic Dark', desc: 'Default dark mode', swatch: '#005c4b' },
    { id: 'instagram', name: 'Instagram Sunrise', desc: 'Signature sunset gradient', swatch: 'linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045)' },
    { id: 'cyberpunk', name: 'Cyberpunk Neon', desc: 'Electric violet & cyan', swatch: 'linear-gradient(135deg, #7928ca, #0070f3, #00dfd8)' },
    { id: 'sunset', name: 'Twilight Sunset', desc: 'Flame peach & ruby', swatch: 'linear-gradient(135deg, #eb3349, #f45c43)' },
    { id: 'ocean', name: 'Pacific Ocean', desc: 'Azure & sapphire blue', swatch: 'linear-gradient(135deg, #00c6ff, #0072ff)' },
    { id: 'aurora', name: 'Aurora Borealis', desc: 'Fresh mint glow (Dark Text)', swatch: 'linear-gradient(135deg, #a7f3d0, #67e8f9)' },
    { id: 'sakura', name: 'Sakura Blush', desc: 'Soft pastel rose (Dark Text)', swatch: 'linear-gradient(135deg, #fed7aa, #fecdd3)' },
    { id: 'midnight', name: 'OLED Pitch Black', desc: 'Pure 100% true black', swatch: '#27272a' },
    { id: 'lofi', name: 'Lofi Lavender', desc: 'Dreamy pastel indigo', swatch: 'linear-gradient(135deg, #667eea, #764ba2)' },
    { id: 'emerald', name: 'Emerald Mint', desc: 'Fresh jungle & mint', swatch: 'linear-gradient(135deg, #11998e, #38ef7d)' },
    { id: 'cosmic', name: 'Cosmic Galaxy', desc: 'Star cluster magenta', swatch: 'linear-gradient(135deg, #8e2de2, #4a00e0)' },
    { id: 'crimson', name: 'Blood Moon', desc: 'Intense scarlet red', swatch: 'linear-gradient(135deg, #cb2d3e, #ef473a)' },
    { id: 'amber', name: 'Solar Amber', desc: 'Warm sunshine gold (Dark Text)', swatch: 'linear-gradient(135deg, #f59e0b, #fbbf24)' },
    { id: 'bubblegum', name: 'Cotton Candy', desc: 'Pastel bubblegum (Dark Text)', swatch: 'linear-gradient(135deg, #fbcfe8, #f472b6)' },
    { id: 'matrix', name: 'Matrix Terminal', desc: 'Cyber hacker green', swatch: 'linear-gradient(135deg, #0f2027, #203a43, #2c5364)' },
    { id: 'slate', name: 'Monochrome Slate', desc: 'Modern minimal grey', swatch: '#374151' },
    { id: 'desert', name: 'Desert Mirage', desc: 'Blazing flame & amber', swatch: 'linear-gradient(135deg, #f12711, #f5af19)' },
    { id: 'flamingo', name: 'Coral Flamingo', desc: 'Vibrant coral ruby', swatch: 'linear-gradient(135deg, #ff416c, #ff4b2b)' },
    { id: 'synthwave', name: 'Synthwave 80s', desc: 'Retro neon magenta & blue', swatch: 'linear-gradient(135deg, #f72585, #7209b7, #3a0ca3)' },
    { id: 'neon_purple', name: 'Ultraviolet Neon', desc: 'Vivid electric purple', swatch: 'linear-gradient(135deg, #b5179e, #7209b7)' },
    { id: 'hyperdrive', name: 'Hyperdrive Indigo', desc: 'Deep galactic indigo', swatch: 'linear-gradient(135deg, #2e0854, #1e3c72, #2a5298)' },
    { id: 'deep_blue', name: 'Seafoam Aqua', desc: 'Deep teal to seafoam', swatch: 'linear-gradient(135deg, #13547a, #80d0c7)' },
    { id: 'skyline', name: 'Electric Azure', desc: 'Bright sky azure blue', swatch: 'linear-gradient(135deg, #4facfe, #00f2fe)' },
    { id: 'iceberg', name: 'Arctic Iceberg', desc: 'Frosty arctic cyan', swatch: 'linear-gradient(135deg, #2193b0, #6dd5ed)' },
    { id: 'matcha', name: 'Matcha Green Tea', desc: 'Fresh matcha lime (Dark Text)', swatch: 'linear-gradient(135deg, #56ab2f, #a8e063)' },
    { id: 'eucalyptus', name: 'Eucalyptus Sage', desc: 'Soothing forest sage', swatch: 'linear-gradient(135deg, #134e5e, #71b280)' },
    { id: 'peach', name: 'Peach Smoothie', desc: 'Warm cream peach (Dark Text)', swatch: 'linear-gradient(135deg, #ffecd2, #fcb69f)' },
    { id: 'lavender', name: 'Pastel Lilac', desc: 'Soft violet mist (Dark Text)', swatch: 'linear-gradient(135deg, #e0c3fc, #8ec5fc)' },
    { id: 'lemon', name: 'Citrus Lemonade', desc: 'Tangy citrus glow (Dark Text)', swatch: 'linear-gradient(135deg, #f6d365, #fda085)' },
    { id: 'champagne', name: 'Champagne Gold', desc: 'Royal gilded gold', swatch: 'linear-gradient(135deg, #8a733e, #c5a059)' },
    { id: 'velvet', name: 'Plum Velvet', desc: 'Velvet plum & warm amber', swatch: 'linear-gradient(135deg, #3a1c71, #d76d77, #ffaf7b)' },
    { id: 'carbon', name: 'Carbon Stealth', desc: 'Modern titanium dark', swatch: 'linear-gradient(135deg, #141e30, #243b55)' }
];

window.setTheme = function(themeId) {
    const tid = themeId || 'default';
    const chatArea = document.getElementById('chat-area');
    if (chatArea) {
        chatArea.dataset.theme = tid;
    }
};

(function initKebabMenu() {
    // Remove any existing dropdown from HTML (cleanup)
    document.getElementById('kebab-dropdown')?.remove();
    document.getElementById('clear-chat-modal')?.remove();
    document.getElementById('theme-modal')?.remove();

        // Build dropdown as Apple macOS Floating Menu Card
    const dropdown = document.createElement('div');
    dropdown.id = 'kebab-dropdown';
    dropdown.className = 'kebab-menu-popover hidden';
    dropdown.innerHTML = `
        <div class="kebab-menu-card">
            <button type="button" id="menu-wallpaper" class="kebab-menu-row" aria-label="Wallpaper">
                <div class="kebab-row-icon icon-wallpaper">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect pathLength="100" x="3" y="3" width="18" height="18" rx="4" ry="4"></rect>
                        <circle pathLength="100" cx="8.5" cy="8.5" r="1.5"></circle>
                        <polyline pathLength="100" points="21 15 16 10 5 21"></polyline>
                    </svg>
                </div>
                <span class="kebab-row-label">Wallpaper</span>
                <span class="kebab-row-arrow">›</span>
            </button>

            <button type="button" id="menu-theme" class="kebab-menu-row" aria-label="Theme">
                <div class="kebab-row-icon icon-theme">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle pathLength="100" cx="13.5" cy="6.5" r=".5" fill="currentColor"></circle>
                        <circle pathLength="100" cx="17.5" cy="10.5" r=".5" fill="currentColor"></circle>
                        <circle pathLength="100" cx="8.5" cy="7.5" r=".5" fill="currentColor"></circle>
                        <circle pathLength="100" cx="6.5" cy="12.5" r=".5" fill="currentColor"></circle>
                        <path pathLength="100" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C22 6.5 17.5 2 12 2z"></path>
                    </svg>
                </div>
                <span class="kebab-row-label">Theme</span>
                <span class="kebab-row-arrow">›</span>
            </button>

            <button type="button" id="menu-cinema-sync" class="kebab-menu-row" aria-label="Cinema Sync">
                <div class="kebab-row-icon icon-cinema">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
                <span class="kebab-row-label">Cinema Sync</span>
                <span class="kebab-row-arrow">›</span>
            </button>

            <button type="button" id="menu-stealth-notify" class="kebab-menu-row" aria-label="Nudge">
                <div class="kebab-row-icon icon-nudge">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path pathLength="100" d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                        <path pathLength="100" d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                    </svg>
                </div>
                <span class="kebab-row-label">Nudge</span>
                <span class="kebab-row-arrow">›</span>
            </button>

            <button type="button" id="menu-clear-chat" class="kebab-menu-row row-danger" aria-label="Clear All">
                <div class="kebab-row-icon icon-clearchat">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline pathLength="100" points="3 6 5 6 21 6"></polyline>
                        <path pathLength="100" d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        <line pathLength="100" x1="10" y1="11" x2="10" y2="17"></line>
                        <line pathLength="100" x1="14" y1="11" x2="14" y2="17"></line>
                    </svg>
                </div>
                <span class="kebab-row-label">Clear All</span>
                <span class="kebab-row-arrow">›</span>
            </button>
        </div>
    `;
    document.body.appendChild(dropdown);

    // Build confirmation modal
    const clearModal = document.createElement('div');
    clearModal.id = 'clear-chat-modal';
    clearModal.className = 'modal hidden';
    clearModal.innerHTML = `
        <div class="modal-content glass-effect">
            <h3>Clear all messages?</h3>
            <p class="modal-desc">This will permanently delete all messages for both you and the other person. This cannot be undone.</p>
            <div class="modal-actions">
                <button id="clear-chat-cancel" class="secondary">Cancel</button>
                <button id="clear-chat-confirm" class="danger">Clear All</button>
            </div>
        </div>
    `;
    document.body.appendChild(clearModal);

    // Build Theme Picker modal with Live Interactive Preview Box
    const themeModal = document.createElement('div');
    themeModal.id = 'theme-modal';
    themeModal.className = 'modal hidden';
    themeModal.innerHTML = `
        <div class="modal-content glass-effect">
            <div class="theme-modal-header">
                <h3>
                    <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22" style="color:var(--accent,#22c55e);"><path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10c1.38 0 2.5-1.12 2.5-2.5 0-.61-.23-1.2-.64-1.67-.08-.1-.13-.21-.13-.33 0-.28.22-.5.5-.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 8 6.5 8 8 8.67 8 9.5 7.33 11 6.5 11zm3-4C8.67 7 8 6.33 8 5.5S8.67 4 9.5 4s1.5.67 1.5 1.5S10.33 7 9.5 7zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 4 14.5 4s1.5.67 1.5 1.5S15.33 7 14.5 7zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 8 17.5 8s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
                    Chat Themes <span style="font-size:12px;font-weight:normal;color:#a1a1aa;margin-left:4px;">(32 Styles)</span>
                </h3>
                <button type="button" id="theme-modal-close" class="modal-close-btn theme-modal-close" aria-label="Close themes"><svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none" style="pointer-events:none;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
            </div>

            <!-- Live Interactive Theme Preview Box -->
            <div class="theme-preview-box" id="theme-preview-box" data-theme="default">
                <div class="preview-box-label">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                    Live Preview
                </div>
                <div class="preview-messages">
                    <div class="message received preview-msg">
                        <div class="msg-content">
                            <span class="preview-text">Hey! How does this look?</span>
                            <div class="msg-footer">
                                <span class="timestamp">6:19 PM</span>
                            </div>
                        </div>
                    </div>
                    <div class="message sent preview-msg">
                        <div class="msg-content">
                            <span class="preview-text">Looks stunning! Love it ✨</span>
                            <div class="msg-footer">
                                <span class="timestamp">6:20 PM</span>
                                <span class="ticks read"><svg class="msg-tick read" viewBox="0 0 19 15" width="19" height="15" fill="currentColor" style="display:inline-block; vertical-align:middle;"><path d="M9.91 3.93L3.77 10.07L1.91 8.21L0.5 9.62L3.77 12.89L11.32 5.34L9.91 3.93Z"/><path d="M14.91 3.93L8.77 10.07L7.36 8.66L5.95 10.07L8.77 12.89L16.32 5.34L14.91 3.93Z"/></svg></span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 32 Themes Grid -->
            <div class="theme-grid" id="theme-grid">
                ${THEMES_LIST.map(t => `
                    <div class="theme-card" data-theme-id="${t.id}">
                        <div class="theme-swatch" style="background:${t.swatch};"></div>
                        <div class="theme-info">
                            <div class="theme-name">${t.name}</div>
                            <div class="theme-desc">${t.desc}</div>
                        </div>
                        <div class="theme-check">
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none" style="pointer-events:none;"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        </div>
                    </div>
                `).join('')}
            </div>
            <div class="modal-actions" style="margin-top:12px;">
                <button id="theme-cancel-btn" class="secondary">Cancel</button>
                <button id="theme-apply-btn" class="primary">Apply Theme</button>
            </div>
        </div>
    `;
    document.body.appendChild(themeModal);

    // Toggle dropdown
    let isOpen = false;

    function openKebabMenu() {
        isOpen = true;
        const btn = document.getElementById('kebab-menu-btn');
        if (!btn) return;
        const rect = btn.getBoundingClientRect();
        dropdown.style.top = (rect.bottom + 8) + 'px';
        dropdown.style.right = Math.max(12, window.innerWidth - rect.right) + 'px';

        const isGroup = state.isGroup || (state.activeChatId && state.activeChatId.startsWith('grp_'));
        const isRandom = state.isRandom || (state.activeChatId && state.activeChatId.startsWith('rnd_'));

        const nudgeBtn = document.getElementById('menu-stealth-notify');
        if (nudgeBtn) {
            nudgeBtn.style.display = (isGroup || isRandom) ? 'none' : 'flex';
        }

        dropdown.classList.remove('hidden');
    }

    function closeKebabMenu(fromPop = false) {
        isOpen = false;
        dropdown.classList.add('hidden');
    }

    window.__closeKebabInternal = closeKebabMenu;

    document.getElementById('kebab-menu-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof window._isModalJustClosed === 'function' && window._isModalJustClosed()) {
            e.preventDefault();
            return;
        }
        if (!isOpen) openKebabMenu();
        else closeKebabMenu();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (isOpen && !e.target.closest('#kebab-dropdown') && !e.target.closest('#kebab-menu-btn')) {
            closeKebabMenu();
        }
    });

    // Nudge
    document.getElementById('menu-stealth-notify')?.addEventListener('click', () => {
        closeKebabMenu();
        if (typeof sendStealthNotify === 'function') sendStealthNotify();
    });

    // Wallpaper Modal
    function openWallpaperModal() {
        closeKebabMenu();
        if (typeof window.openWallpaperModal === 'function') {
            window.openWallpaperModal();
            return;
        }
        document.getElementById('wallpaper-modal')?.classList.remove('hidden');
        window.BackNavManager?.push('wallpaper-modal', () => {
            closeWallpaperModal(true);
        });
    }

    function closeWallpaperModal(fromPop = false) {
        if (typeof window.closeWallpaperModal === 'function') {
            window.closeWallpaperModal(fromPop);
            return;
        }
        if (!fromPop && window.BackNavManager?.has('wallpaper-modal')) {
            window.BackNavManager.pop('wallpaper-modal');
        }
        document.getElementById('wallpaper-modal')?.classList.add('hidden');
    }

    document.getElementById('menu-wallpaper')?.addEventListener('click', openWallpaperModal);
    document.getElementById('wallpaper-close')?.addEventListener('click', () => closeWallpaperModal(false));

    // Theme Picker
    let selectedThemeId = 'default';
    let previousThemeId = 'default';

    const updateThemePreview = (tid) => {
        const previewBox = document.getElementById('theme-preview-box');
        if (previewBox) previewBox.dataset.theme = tid;
        window.setTheme(tid);
    };

    function openThemeModal() {
        closeKebabMenu();
        if (!state.activeChatId) return;

        const chatArea = document.getElementById('chat-area');
        previousThemeId = (chatArea && chatArea.dataset.theme) || localStorage.getItem('theme_' + state.activeChatId) || 'default';
        selectedThemeId = previousThemeId;

        // Update live preview box
        updateThemePreview(selectedThemeId);

        // Highlight active theme card and scroll into view
        themeModal.querySelectorAll('.theme-card').forEach(card => {
            if (card.dataset.themeId === selectedThemeId) {
                card.classList.add('active');
                setTimeout(() => card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
            } else {
                card.classList.remove('active');
            }
        });

        themeModal.classList.remove('hidden');
        window.BackNavManager?.push('theme-modal', () => {
            updateThemePreview(previousThemeId);
            closeThemeModal(true);
        });
    }

    const closeThemeModal = (fromPop = false) => {
        if (!fromPop && window.BackNavManager?.has('theme-modal')) {
            window.BackNavManager.pop('theme-modal');
        }
        themeModal.classList.add('hidden');
    };

    document.getElementById('menu-theme')?.addEventListener('click', openThemeModal);

    // Cinema Sync (Local Offline Movie Watch Together)
    document.getElementById('menu-cinema-sync')?.addEventListener('click', () => {
        closeKebabMenu();
        if (window.CinemaManager && typeof window.CinemaManager.openSetupModal === 'function') {
            window.CinemaManager.openSetupModal();
        }
    });

    // Select theme card in modal
    themeModal.querySelectorAll('.theme-card').forEach(card => {
        card.addEventListener('click', () => {
            selectedThemeId = card.dataset.themeId;
            themeModal.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            // Live update preview box + chat background
            updateThemePreview(selectedThemeId);
        });
    });

    document.getElementById('theme-modal-close')?.addEventListener('click', () => {
        updateThemePreview(previousThemeId);
        closeThemeModal(false);
    });

    document.getElementById('theme-cancel-btn')?.addEventListener('click', () => {
        updateThemePreview(previousThemeId);
        closeThemeModal(false);
    });

    // Apply Theme
    document.getElementById('theme-apply-btn')?.addEventListener('click', async () => {
        if (!state.activeChatId) return;
        const btn = document.getElementById('theme-apply-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Applying...';
        }

        try {
            updateThemePreview(selectedThemeId);
            localStorage.setItem('theme_' + state.activeChatId, selectedThemeId);

            await apiFetch(`/api/chat/${state.activeChatId}/theme`, {
                method: 'POST',
                body: JSON.stringify({ theme: selectedThemeId })
            });
        } catch (e) {
            console.error('Failed to apply theme:', e);
        }

        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Apply Theme';
        }
        closeThemeModal(false);
    });

    // Clear All Modal
    function openClearChatModal() {
        closeKebabMenu();
        document.getElementById('clear-chat-modal')?.classList.remove('hidden');
        window.BackNavManager?.push('clear-chat-modal', () => {
            closeClearChatModal(true);
        });
    }

    function closeClearChatModal(fromPop = false) {
        if (!fromPop && window.BackNavManager?.has('clear-chat-modal')) {
            window.BackNavManager.pop('clear-chat-modal');
        }
        document.getElementById('clear-chat-modal')?.classList.add('hidden');
    }

    document.getElementById('menu-clear-chat')?.addEventListener('click', openClearChatModal);
    document.getElementById('clear-chat-cancel')?.addEventListener('click', () => closeClearChatModal(false));

    // Confirm clear
    document.getElementById('clear-chat-confirm')?.addEventListener('click', async () => {
        if (!state.activeChatId) return;
        const btn = document.getElementById('clear-chat-confirm');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Clearing...';
        }
        try {
            const res = await apiFetch(`/api/chat/${state.activeChatId}/clear`, { method: 'POST' });
            if (res.error) {
                alert(res.error);
            } else if (res.status === 'cleared' || !res.error) {
                await ChatCache.clearMessages(state.activeChatId);
                if (ChatCache.chats) {
                    const targetChat = ChatCache.chats.find(c => c.other === state.activePeer || c.other === state.activeChatId);
                    if (targetChat) {
                        targetChat.lastMessage = '';
                        targetChat.unread = 0;
                        ChatCache.saveChats(ChatCache.chats);
                    }
                }
                document.getElementById('messages-list').innerHTML = '';
                state.hasMoreHistory = false;
                state.loadedMessageLimit = 200;
                if (typeof refreshChatList === 'function') refreshChatList();
            }
        } catch (e) {
            console.error('Clear chat failed:', e);
        }
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Clear All';
        }
        closeClearChatModal(false);
    });
})();
