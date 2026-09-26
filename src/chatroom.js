export class ChatRoomV2 {
    constructor(state, env) {
        this.state = state;
        this.storage = state.storage;
        this.env = env;
        this.sessions = new Set();
        this.fcmToken = null;
        this.fcmTokenExpiry = 0;
        this._peerDisconnectTimer = null;
    }

    async fetch(request) {
        const url = new URL(request.url);
        switch (url.pathname) {
            case "/ws": return this.handleWebSocket(request);
            case "/messages": return this.handleMessages(url);
            case "/send": return this.handleSend(request);
            case "/read": return this.handleReadReceipt(request);
            case "/typing": return this.handleTyping(request);
            case "/react": return this.handleReaction(request);
            case "/message/edit": return this.handleEditMessage(request);
            case "/message/delete": return this.handleDeleteMessage(request);
            case "/wallpaper": return this.handleWallpaper(request);
            case "/theme": return this.handleTheme(request);
            case "/stealth_notify": return this.handleStealthNotify(request);
            case "/upload_chunk": return this.handleUploadChunk(request);
            case "/watch_party": return this.handleWatchParty(request);
            case "/arcade_game": return this.handleArcadeGame(request);
            case "/clear": return this.handleClear(request);
            case "/destroy": return this.handleDestroy(request); // New: Wipe chat
            default: return new Response("Not found", { status: 404 });
        }
    }

    async handleWebSocket(request) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.sessions.add(server);
        server.accept();

        // If a peer was reconnecting within the 60s grace period, cancel the disconnect timer
        if (this._peerDisconnectTimer) {
            clearTimeout(this._peerDisconnectTimer);
            this._peerDisconnectTimer = null;
        }

        const broadcastPresence = () => {
            const payload = JSON.stringify({ type: 'room_presence', count: this.sessions.size, ts: Date.now() });
            for (const s of this.sessions) {
                try { s.send(payload); } catch (e) { this.sessions.delete(s); }
            }
        };

        // Notify all clients of updated room count immediately
        broadcastPresence();

        // Handle ping/pong keep-alive, WebRTC signaling, Watch Party, and Gaming sync
        server.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'ping') {
                    server.send(JSON.stringify({ type: 'pong' }));
                } else if (['offer', 'answer', 'ice_candidate', 'call_end', 'call_status', 'typing', 'watch_party', 'gaming_presence', 'arcade_game', 'ghost_touch', 'friend_request', 'friend_request_received', 'friend_accept', 'friend_confirmed', 'friend_decline', 'friend_declined', 'peer_disconnected'].includes(data.type)) {
                    if (data.type === 'peer_disconnected') {
                        // Explicit exit (Skip or End Chat): cancel any pending timer
                        if (this._peerDisconnectTimer) {
                            clearTimeout(this._peerDisconnectTimer);
                            this._peerDisconnectTimer = null;
                        }
                    }
                    if (data.type === 'watch_party') {
                        this.updateWatchPartyFromWS(data);
                    } else if (data.type === 'gaming_presence') {
                        this.updateGamingPresenceFromWS(data);
                    } else if (data.type === 'arcade_game') {
                        this.updateArcadeGameFromWS(data);
                    }
                    // Broadcast immediately to other peers
                    for (const session of this.sessions) {
                        if (session !== server) {
                            try { session.send(event.data); } catch (e) { this.sessions.delete(session); }
                        }
                    }
                }
            } catch (e) { /* ignore non-JSON or parse errors */ }
        });

        const handleSessionTermination = async () => {
            this.sessions.delete(server);
            broadcastPresence();

            // If there's still a session connected (e.g. 1 peer remaining in a 2-peer random chat),
            // DO NOT immediately disconnect them! Give the other peer a 60-second grace period
            // to reconnect from background, lock screen, or network switch.
            if (this.sessions.size === 1) {
                if (this._peerDisconnectTimer) {
                    clearTimeout(this._peerDisconnectTimer);
                }
                this._peerDisconnectTimer = setTimeout(() => {
                    this._peerDisconnectTimer = null;
                    if (this.sessions.size === 1) {
                        for (const session of this.sessions) {
                            try { session.send(JSON.stringify({ type: 'peer_disconnected' })); } catch (e) { this.sessions.delete(session); }
                        }
                    }
                }, 60000); // 60 seconds grace period
            } else if (this.sessions.size === 0) {
                if (this._peerDisconnectTimer) {
                    clearTimeout(this._peerDisconnectTimer);
                    this._peerDisconnectTimer = null;
                }
                try { await this.storage.delete("active_watch_party"); } catch (e) {}
            }
        };

        server.addEventListener('close', handleSessionTermination);
        server.addEventListener('error', handleSessionTermination);

        return new Response(null, { status: 101, webSocket: client });
    }

    async handleUploadChunk(request) {
        const body = await request.json();
        const targetId = body.msgId || body.tempMsgId;
        const chunkIndex = body.chunkIndex;
        const chunkData = body.chunkData;
        if (!targetId || chunkIndex === undefined || !chunkData) {
            return new Response(JSON.stringify({ error: "Invalid chunk", success: false }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        await this.storage.put(`msg:${targetId}:chunk:${chunkIndex}`, chunkData);
        return new Response(JSON.stringify({ status: "ok", success: true, chunkIndex }), { headers: { "Content-Type": "application/json" } });
    }

    async handleSend(request) {
        const body = await request.json();
        const savedMsg = await this.processMessage(body);
        return new Response(JSON.stringify(savedMsg), { headers: { "Content-Type": "application/json" } });
    }

    // New: Handle Read Receipt Trigger
    async handleReadReceipt(request) {
        const { username, ts } = await request.json();
        const readTs = ts || Date.now();
        if (username) {
            await this.storage.put(`read:${username}`, readTs);
        }

        // Broadcast read receipt to all connected clients
        const broadcast = JSON.stringify({
            type: 'read_receipt',
            by: username,
            ts: readTs
        });

        for (const session of this.sessions) {
            try { session.send(broadcast); } catch (e) { this.sessions.delete(session); }
        }

        return new Response(JSON.stringify({ status: "broadcasted", ts: readTs }), { headers: { "Content-Type": "application/json" } });
    }

    // Typing indicator broadcast
    async handleTyping(request) {
        const { username, isTyping, text } = await request.json();
        const broadcast = JSON.stringify({
            type: 'typing',
            user: username,
            isTyping: !!isTyping,
            text: text || ''
        });

        for (const session of this.sessions) {
            try { session.send(broadcast); } catch (e) { this.sessions.delete(session); }
        }

        return new Response(JSON.stringify({ status: "ok" }), { headers: { "Content-Type": "application/json" } });
    }

    // Handle reaction add/remove
    async handleReaction(request) {
        const { msgId, emoji, username } = await request.json();
        if (!msgId || !emoji) {
            return new Response(JSON.stringify({ error: "Missing msgId or emoji" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }

        const found = await this.findMessage(msgId, null);
        if (!found || !found.msg) {
            return new Response(JSON.stringify({ error: "Message not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
        }

        const msg = found.msg;
        const msgKey = found.msgKey;

        // Initialize reactions if not exists
        if (!msg.reactions) msg.reactions = {};

        // Toggle reaction (add if not exists, remove if exists for this user)
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        const userIndex = msg.reactions[emoji].indexOf(username);
        if (userIndex === -1) {
            msg.reactions[emoji].push(username);
        } else {
            msg.reactions[emoji].splice(userIndex, 1);
            if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
        }

        await this.storage.put(msgKey, msg);

        // Broadcast reaction update to all clients
        this.broadcast(msgId, "reaction_update", { reactions: msg.reactions });
        return new Response(JSON.stringify({ status: "ok" }), { headers: { "Content-Type": "application/json" } });
    }

    // Helper to find a message by msgId or clientId (full history backwards search)
    async findMessage(msgId, clientId) {
        if (msgId) {
            const msg = await this.storage.get(`msg:${msgId}`);
            if (msg) return { msg, msgKey: `msg:${msgId}` };
        }
        if (clientId && clientId !== msgId) {
            const msg = await this.storage.get(`msg:${clientId}`);
            if (msg) return { msg, msgKey: `msg:${clientId}` };
        }
        // Fallback: search backwards through index in 100-key chunks
        const index = await this.getMessageIndex();
        if (index && index.length > 0) {
            for (let i = index.length; i > 0; i -= 100) {
                const start = Math.max(0, i - 100);
                const chunk = index.slice(start, i);
                const keys = chunk.map(id => `msg:${id}`);
                const messagesMap = await this.storage.get(keys);
                for (const [key, m] of messagesMap.entries()) {
                    if (m && (
                        m.id === msgId || 
                        m.clientId === msgId || 
                        (clientId && (m.id === clientId || m.clientId === clientId)) ||
                        String(m.id) === String(msgId) ||
                        String(m.clientId) === String(msgId)
                    )) {
                        return { msg: m, msgKey: key };
                    }
                }
            }
        }
        return null;
    }

    // Edit message text
    async handleEditMessage(request) {
        if (request.method !== 'POST') return new Response("Method not allowed", { status: 405 });
        const { msgId, clientId, newText, sender } = await request.json();
        if ((!msgId && !clientId) || typeof newText !== 'string') {
            return new Response(JSON.stringify({ error: "Invalid payload" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }

        const found = await this.findMessage(msgId, clientId);
        if (!found || !found.msg) {
            return new Response(JSON.stringify({ error: "Message not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
        }

        if (sender && found.msg.from && found.msg.from !== sender) {
            return new Response(JSON.stringify({ error: "Unauthorized to edit this message" }), { status: 403, headers: { "Content-Type": "application/json" } });
        }

        found.msg.text = newText;
        found.msg.edited = true;
        found.msg.editedAt = Date.now();
        await this.storage.put(found.msgKey, found.msg);
        if (found.msg.id && found.msgKey !== `msg:${found.msg.id}`) {
            await this.storage.put(`msg:${found.msg.id}`, found.msg);
        }

        // Broadcast to all connected clients with dual identifiers
        const broadcast = JSON.stringify({
            type: 'message_edited',
            id: found.msg.id,
            clientId: found.msg.clientId,
            msgId: found.msg.id || msgId,
            newText: found.msg.text,
            edited: true,
            editedAt: found.msg.editedAt
        });

        for (const session of this.sessions) {
            try { session.send(broadcast); } catch (e) { this.sessions.delete(session); }
        }

        return new Response(JSON.stringify({ status: "ok", msg: found.msg }), {
            headers: { "Content-Type": "application/json" }
        });
    }

    // Delete message for everyone
    async handleDeleteMessage(request) {
        if (request.method !== 'POST') return new Response("Method not allowed", { status: 405 });
        const { msgId, clientId, sender } = await request.json();
        if (!msgId && !clientId) {
            return new Response(JSON.stringify({ error: "Missing msgId" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }

        const targetIds = new Set([String(msgId || ''), String(clientId || '')].filter(Boolean));
        const found = await this.findMessage(msgId, clientId);

        if (found && found.msg) {
            if (sender && found.msg.from && found.msg.from !== sender) {
                const spaceMeta = await this.storage.get("space_meta");
                const role = spaceMeta?.members?.[sender]?.role;
                if (role !== 'founder' && role !== 'moderator') {
                    return new Response(JSON.stringify({ error: "Unauthorized: only message sender or group moderator can delete this message" }), { status: 403, headers: { "Content-Type": "application/json" } });
                }
            }

            if (found.msg.id) targetIds.add(String(found.msg.id));
            if (found.msg.clientId) targetIds.add(String(found.msg.clientId));

            // Clean up chunked media if present
            if (typeof found.msg.text === 'string' && found.msg.text.startsWith('__chunked__:')) {
                const numChunks = parseInt(found.msg.text.split(':')[1]) || 0;
                for (let i = 0; i < numChunks; i++) {
                    await this.storage.delete(`msg:${found.msg.id}:chunk:${i}`).catch(() => {});
                    if (found.msg.clientId) {
                        await this.storage.delete(`msg:${found.msg.clientId}:chunk:${i}`).catch(() => {});
                    }
                }
            }

            await this.storage.delete(found.msgKey).catch(() => {});
            if (found.msg.id) await this.storage.delete(`msg:${found.msg.id}`).catch(() => {});
            if (found.msg.clientId) await this.storage.delete(`msg:${found.msg.clientId}`).catch(() => {});
        } else {
            if (msgId) await this.storage.delete(`msg:${msgId}`).catch(() => {});
            if (clientId) await this.storage.delete(`msg:${clientId}`).catch(() => {});
        }

        // Remove all matched targetIds from index
        const index = await this.getMessageIndex();
        const newIndex = index.filter(id => !targetIds.has(String(id)));
        await this.storage.put("message_index", newIndex);

        // Broadcast to all connected clients with dual identifiers
        const broadcast = JSON.stringify({
            type: 'message_deleted',
            id: found?.msg?.id || msgId,
            clientId: found?.msg?.clientId || clientId,
            msgId: found?.msg?.id || msgId
        });

        for (const session of this.sessions) {
            try { session.send(broadcast); } catch (e) { this.sessions.delete(session); }
        }

        return new Response(JSON.stringify({ status: "ok", msgId, targetIds: Array.from(targetIds) }), {
            headers: { "Content-Type": "application/json" }
        });
    }

    async updateWatchPartyFromWS(data) {
        if (!data || !data.action) return;
        if (data.action === 'close' || data.action === 'stop') {
            await this.storage.delete("active_watch_party");
            return;
        }
        if (data.action === 'start' || data.action === 'play' || data.action === 'pause' || data.action === 'seek' || data.action === 'sync') {
            const current = (await this.storage.get("active_watch_party")) || {};
            const updated = {
                mode: data.mode || current.mode || (data.cinemaId ? 'local' : 'youtube'),
                cinemaId: data.cinemaId || current.cinemaId || '',
                videoId: data.videoId || current.videoId || '',
                url: data.url || current.url || '',
                title: data.title || current.title || 'Video',
                host: data.host || current.host || data.from || 'User',
                state: data.action === 'pause' ? 'paused' : (data.action === 'play' || data.action === 'start' ? 'playing' : (data.state || current.state || 'playing')),
                lastTime: (data.time !== undefined && data.time !== null) ? Number(data.time) : (current.lastTime || 0),
                duration: data.duration !== undefined ? Number(data.duration) : (current.duration || 0),
                lastTs: Date.now()
            };
            if (updated.cinemaId || updated.videoId || updated.url) {
                await this.storage.put("active_watch_party", updated);
            }
        }
    }

    async handleWatchParty(request) {
        if (request.method === 'GET') {
            const session = await this.storage.get("active_watch_party");
            if (!session || (!session.videoId && !session.url && !session.cinemaId)) {
                return new Response(JSON.stringify({ active: false }), { headers: { "Content-Type": "application/json" } });
            }

            // Expiration check: If host heartbeat is older than 20 seconds or no sessions connected, session is inactive
            const isStale = (Date.now() - (session.lastTs || 0)) > 20000;
            const hasConnectedSockets = this.sessions && this.sessions.size > 0;
            if (isStale || !hasConnectedSockets) {
                await this.storage.delete("active_watch_party");
                return new Response(JSON.stringify({ active: false }), { headers: { "Content-Type": "application/json" } });
            }

            let liveTime = session.lastTime || 0;
            if (session.state === 'playing' && session.lastTs) {
                const deltaSec = (Date.now() - session.lastTs) / 1000;
                liveTime += Math.max(0, deltaSec);
            }
            return new Response(JSON.stringify({
                active: true,
                session: {
                    ...session,
                    calculatedTime: liveTime
                }
            }), { headers: { "Content-Type": "application/json" } });
        }

        if (request.method === 'POST') {
            const body = await request.json();
            if (body.action === 'clear' || body.action === 'close' || body.action === 'stop') {
                await this.storage.delete("active_watch_party");
                return new Response(JSON.stringify({ status: "cleared" }), { headers: { "Content-Type": "application/json" } });
            }
            const session = {
                mode: body.mode || (body.cinemaId ? 'local' : 'youtube'),
                cinemaId: body.cinemaId || '',
                videoId: body.videoId || '',
                url: body.url || '',
                title: body.title || 'Video',
                host: body.host || body.user || 'User',
                state: body.state || 'playing',
                lastTime: Number(body.time || 0),
                duration: Number(body.duration || 0),
                lastTs: Date.now()
            };
            await this.storage.put("active_watch_party", session);
            return new Response(JSON.stringify({ status: "ok", session }), { headers: { "Content-Type": "application/json" } });
        }

        if (request.method === 'DELETE') {
            await this.storage.delete("active_watch_party");
            return new Response(JSON.stringify({ status: "cleared" }), { headers: { "Content-Type": "application/json" } });
        }

        return new Response("Method not allowed", { status: 405 });
    }

    // Clear all messages but keep wallpaper and settings
    // Clear all messages but keep wallpaper and settings (Nuclear Prefix Sweeper)
    async handleClear(request) {
        // 1. Nuclear sweep of all keys starting with 'msg:' (messages, chunks, metadata)
        const allMsgKeysMap = await this.storage.list({ prefix: "msg:" });
        const allKeys = Array.from(allMsgKeysMap.keys());
        allKeys.push("message_index", "messages");

        // 2. Batch-delete in safe chunks of 100 keys
        for (let i = 0; i < allKeys.length; i += 100) {
            await this.storage.delete(allKeys.slice(i, i + 100)).catch(() => {});
        }

        // 3. Record permanent cleared_at timestamp
        const clearedAt = Date.now();
        await this.storage.put("cleared_at", clearedAt);

        // 4. Broadcast to all connected clients so their UI and IndexedDB clears instantly
        const payload = JSON.stringify({ type: 'chat_cleared', clearedAt });
        for (const session of this.sessions) {
            try { session.send(payload); } catch (e) { this.sessions.delete(session); }
        }

        return new Response(JSON.stringify({ status: "cleared", clearedAt, deletedCount: allKeys.length }), { headers: { "Content-Type": "application/json" } });
    }

    // NEW: Wipe all data
    async handleDestroy(request) {
        // Delete all storage in this DO
        await this.storage.deleteAll();

        // Close all active connections
        for (const session of this.sessions) {
            try {
                session.close(1001, "Chat room deleted");
            } catch (e) { }
        }
        this.sessions.clear();

        return new Response(JSON.stringify({ status: "destroyed" }), { headers: { "Content-Type": "application/json" } });
    }

    async broadcast(msgId, type, data) {
        const payload = JSON.stringify({ type, msgId, ...data });
        for (const session of this.sessions) {
            try { session.send(payload); } catch (e) { this.sessions.delete(session); }
        }
    }

    // Get or migrate message index (backward compatible)
    async getMessageIndex() {
        let index = await this.storage.get("message_index");
        if (index) return index;

        // Backward compatibility: migrate old 'messages' array to new format
        const oldMessages = await this.storage.get("messages");
        if (oldMessages && Array.isArray(oldMessages) && oldMessages.length > 0) {
            index = [];
            for (const msg of oldMessages) {
                if (!msg.id) msg.id = crypto.randomUUID();
                await this.storage.put(`msg:${msg.id}`, msg);
                index.push(msg.id);
            }
            await this.storage.put("message_index", index);
            await this.storage.delete("messages"); // Clean up old format
            return index;
        }

        return [];
    }

    async processMessage(body) {
        const CHUNK_SIZE = 500000;
        const { from, text, clientId, chatId, replyTo, effect, tempMsgId, mediaType, mediaSize, duration, cinemaInvite, friendRequest } = body;
        const index = await this.getMessageIndex();

        // Deduplicate by clientId using a single bulk storage.get of the last 20 messages
        if (clientId && index.length > 0) {
            const recentIds = index.slice(-20);
            const keys = recentIds.map(id => `msg:${id}`);
            const messagesMap = await this.storage.get(keys);
            for (const m of messagesMap.values()) {
                if (m && m.clientId === clientId) return m;
            }
        }

        const isPreChunked = Boolean(tempMsgId && typeof text === 'string' && text.startsWith('__chunked__:'));
        const msgId = isPreChunked ? tempMsgId : crypto.randomUUID();

        const msg = {
            id: msgId,
            clientId,
            from,
            text,
            ts: Date.now()
        };

        if (cinemaInvite) msg.cinemaInvite = cinemaInvite;
        if (friendRequest) msg.friendRequest = friendRequest;
        if (mediaType) msg.mediaType = mediaType;
        if (mediaSize) msg.mediaSize = mediaSize;
        if (typeof duration === 'number' && duration > 0) msg.duration = Math.round(duration);

        // Detect mediaType & mediaSize for data: URLs
        if (typeof text === 'string' && text.startsWith('data:')) {
            const mimeMatch = text.match(/^data:(.*?);/);
            if (mimeMatch) {
                const mime = mimeMatch[1].toLowerCase();
                if (mime.includes('gif')) msg.mediaType = 'gif';
                else if (mime.startsWith('image/')) msg.mediaType = 'image';
                else if (mime.startsWith('video/')) msg.mediaType = 'video';
                else if (mime.startsWith('audio/')) msg.mediaType = 'audio';
            }
            const base64Len = text.length - text.indexOf(',') - 1;
            msg.mediaSize = Math.max(0, Math.floor(base64Len * 0.75));
        }

        // Include effect if provided
        if (effect) msg.effect = effect;

        // Include replyTo if provided
        if (replyTo && replyTo.from && (replyTo.text || replyTo.media)) {
            msg.replyTo = { 
                from: replyTo.from, 
                text: (replyTo.text || '').slice(0, 150) 
            };
            if (replyTo.id) msg.replyTo.id = replyTo.id;
            if (replyTo.media && typeof replyTo.media === 'string' && replyTo.media.length < 65000) {
                msg.replyTo.media = replyTo.media;
            }
            if (replyTo.mediaType) {
                msg.replyTo.mediaType = String(replyTo.mediaType).slice(0, 20);
            }
        }

        let savedMeta = msg;

        // If pre-uploaded via tempMsgId chunks:
        if (isPreChunked) {
            if (tempMsgId !== msg.id) {
                const count = parseInt(text.split(':')[1]) || 0;
                const BATCH_SIZE = 25;
                for (let i = 0; i < count; i += BATCH_SIZE) {
                    const batchCount = Math.min(BATCH_SIZE, count - i);
                    const readKeys = Array.from({ length: batchCount }, (_, k) => `msg:${tempMsgId}:chunk:${i + k}`);
                    const chunkMap = await this.storage.get(readKeys);
                    const writeEntries = {};
                    const deleteKeys = [];
                    for (let k = 0; k < batchCount; k++) {
                        const chunkIdx = i + k;
                        const data = chunkMap.get(`msg:${tempMsgId}:chunk:${chunkIdx}`);
                        if (data) {
                            writeEntries[`msg:${msg.id}:chunk:${chunkIdx}`] = data;
                            deleteKeys.push(`msg:${tempMsgId}:chunk:${chunkIdx}`);
                        }
                    }
                    if (Object.keys(writeEntries).length > 0) {
                        await this.storage.put(writeEntries);
                        await this.storage.delete(deleteKeys);
                    }
                }
            }
            if (body && body.mediaType) msg.mediaType = body.mediaType;
            if (body && body.mediaSize) msg.mediaSize = body.mediaSize;
            await this.storage.put(`msg:${msg.id}`, msg);
            savedMeta = msg;
        }
        // Large message chunking: if text > 500KB, store in chunks
        else if (text && text.length > CHUNK_SIZE) {
            const chunks = [];
            for (let i = 0; i < text.length; i += CHUNK_SIZE) {
                chunks.push(text.slice(i, i + CHUNK_SIZE));
            }
            // Store chunks in batches of 40 keys per write to stay well under Cloudflare DO key limits
            const BATCH_LIMIT = 40;
            let currentBatch = {};
            let batchCount = 0;
            for (let i = 0; i < chunks.length; i++) {
                currentBatch[`msg:${msg.id}:chunk:${i}`] = chunks[i];
                batchCount++;
                if (batchCount >= BATCH_LIMIT) {
                    await this.storage.put(currentBatch);
                    currentBatch = {};
                    batchCount = 0;
                }
            }
            const meta = { 
                ...msg, 
                text: `__chunked__:${chunks.length}`,
                mediaSize: msg.mediaSize || Math.floor(text.length * 0.75),
                mediaType: msg.mediaType || (text.startsWith('data:image/gif') ? 'gif' : (text.startsWith('data:image/') ? 'image' : (text.startsWith('data:video/') ? 'video' : (text.startsWith('data:audio/') ? 'audio' : 'media'))))
            };
            currentBatch[`msg:${msg.id}`] = meta;
            await this.storage.put(currentBatch);
            savedMeta = meta;
        } else {
            await this.storage.put(`msg:${msg.id}`, msg);
        }

        // Update index
        index.push(msg.id);
        // Cap at 2000 messages: remove old ones in a smart batch to avoid blocking CPU time
        if (index.length > 2200) {
            const toRemove = index.splice(0, index.length - 2000);
            const keysToDelete = toRemove.map(oldId => `msg:${oldId}`);

            // Delete keys in batches of 100
            this.state.waitUntil((async () => {
                try {
                    // Fetch metadata in bulk to check if any are chunked messages
                    const messagesMap = await this.storage.get(keysToDelete);
                    const allKeysToDelete = [...keysToDelete];
                    for (const [key, msg] of messagesMap.entries()) {
                        if (msg && typeof msg.text === 'string' && msg.text.startsWith('__chunked__:')) {
                            const numChunks = parseInt(msg.text.split(':')[1]) || 0;
                            const oldId = key.split(':')[1];
                            for (let i = 0; i < numChunks; i++) {
                                allKeysToDelete.push(`msg:${oldId}:chunk:${i}`);
                            }
                        }
                    }
                    for (let i = 0; i < allKeysToDelete.length; i += 100) {
                        const batch = allKeysToDelete.slice(i, i + 100);
                        await this.storage.delete(batch).catch(() => {});
                    }
                } catch (e) { console.error('Failed to clean up old messages batch:', e); }
            })());
        }
        await this.storage.put("message_index", index);

        // Broadcast to connected clients
        // For large or chunked messages, send lightweight notification (WS has ~1MB frame limit)
        if (text && (text.length > CHUNK_SIZE || text.startsWith('__chunked__:'))) {
            const notification = JSON.stringify({
                type: 'new_large_message',
                id: msg.id,
                from: msg.from,
                ts: msg.ts,
                mediaType: savedMeta.mediaType || msg.mediaType || 'media',
                mediaSize: savedMeta.mediaSize || msg.mediaSize || Math.floor(text.length * 0.75)
            });
            for (const session of this.sessions) {
                try { session.send(notification); } catch (e) { this.sessions.delete(session); }
            }
        } else {
            const broadcast = JSON.stringify(msg);
            for (const session of this.sessions) {
                try { session.send(broadcast); } catch (e) { this.sessions.delete(session); }
            }
        }

        const previewText = (text && (text.startsWith('data:') || text.startsWith('__chunked__:'))) ? '[Media]' : (text || '[Media]');

        // Background tasks: Push notification and Chat Registry update (never block HTTP response)
        if (chatId) {
            this.state.waitUntil((async () => {
                try {
                    const [u1, u2] = chatId.split(':');
                    const recipient = (from === u1) ? u2 : u1;
                    await this.sendPushNotification(recipient, from, previewText, chatId).catch(() => { });
                    await this.notifyRegistry(u1, u2, { ...msg, text: previewText }).catch(() => { });
                    await this.notifyRegistry(u2, u1, { ...msg, text: previewText }).catch(() => { });
                } catch (e) { console.error('Background tasks error:', e); }
            })());
        }

        return msg;
    }

    async notifyRegistry(me, other, msg) {
        const id = this.env.USER_REGISTRY.idFromName("global_registry");
        const stub = this.env.USER_REGISTRY.get(id);
        const isSender = (msg.from === me);

        await stub.fetch("http://internal/add_chat", {
            method: "POST",
            body: JSON.stringify({
                username: me,
                other,
                lastMessage: msg.text,
                ts: msg.ts,
                isSender
            })
        });
    }

    async handleMessages(url) {
        const messageId = url.searchParams.get("id");
        const fetchFull = url.searchParams.get("full") === "true";
        const clearedAt = (await this.storage.get("cleared_at")) || 0;
        let rawMessages = [];

        if (messageId) {
            // First try direct lookup by DO msg.id
            let directMsg = await this.storage.get(`msg:${messageId}`);
            if (!directMsg) {
                // Search by clientId or ID in index if direct lookup misses
                const index = await this.getMessageIndex();
                const keys = index.map(id => `msg:${id}`);
                const rawMap = await this.storage.get(keys);
                directMsg = Array.from(rawMap.values()).find(m => m && (m.id === messageId || m.clientId === messageId));
            }
            if (directMsg && (!clearedAt || (directMsg.ts && directMsg.ts > clearedAt))) {
                rawMessages = [directMsg];
            }
        } else {
            const index = await this.getMessageIndex();

            // Active Auto-Prune on read if index exceeds 2200
            if (index.length > 2200) {
                const toRemove = index.splice(0, index.length - 2000);
                const keysToDelete = toRemove.map(oldId => `msg:${oldId}`);
                this.state.waitUntil((async () => {
                    try {
                        const messagesMap = await this.storage.get(keysToDelete);
                        const allKeysToDelete = [...keysToDelete];
                        for (const [key, msg] of messagesMap.entries()) {
                            if (msg && typeof msg.text === 'string' && msg.text.startsWith('__chunked__:')) {
                                const numChunks = parseInt(msg.text.split(':')[1]) || 0;
                                const oldId = key.split(':')[1];
                                for (let i = 0; i < numChunks; i++) {
                                    allKeysToDelete.push(`msg:${oldId}:chunk:${i}`);
                                }
                            }
                        }
                        for (let i = 0; i < allKeysToDelete.length; i += 100) {
                            await this.storage.delete(allKeysToDelete.slice(i, i + 100)).catch(() => {});
                        }
                    } catch (e) { console.error('Auto-prune read error:', e); }
                })());
                await this.storage.put("message_index", index);
            }

            const limit = Math.min(parseInt(url.searchParams.get("limit")) || 200, 2000);
            const beforeId = url.searchParams.get("before");
            let ids = [];
            if (beforeId) {
                let beforeIndex = index.indexOf(beforeId);
                if (beforeIndex === -1) {
                    // ID not found directly in active index. Resolve cursor by timestamp fallback.
                    let cursorTs = null;
                    const cursorMsg = await this.storage.get(`msg:${beforeId}`);
                    if (cursorMsg && cursorMsg.ts) {
                        cursorTs = cursorMsg.ts;
                    } else if (/^\d{10,14}/.test(beforeId)) {
                        // Support numeric clientIds (e.g. 1788405531121-xxx)
                        const parsed = parseInt(beforeId.split(/[-_]/)[0]);
                        if (!isNaN(parsed) && parsed > 1600000000000) cursorTs = parsed;
                    }

                    if (cursorTs && index.length > 0) {
                        // Sample oldest message in index
                        const oldestMsg = await this.storage.get(`msg:${index[0]}`);
                        if (oldestMsg && oldestMsg.ts && cursorTs <= oldestMsg.ts) {
                            // Cursor is older than the oldest message in index
                            beforeIndex = 0;
                        } else {
                            // Find closest message older than cursorTs
                            for (let i = index.length - 1; i >= 0; i--) {
                                const m = await this.storage.get(`msg:${index[i]}`);
                                if (m && m.ts < cursorTs) {
                                    beforeIndex = i + 1;
                                    break;
                                }
                            }
                        }
                    } else if (index.length > 0) {
                        // If no timestamp found, fallback to oldest slice so user is never locked out
                        beforeIndex = Math.min(limit, index.length);
                    }
                }

                if (beforeIndex > 0) {
                    ids = index.slice(Math.max(0, beforeIndex - limit), beforeIndex);
                } else {
                    ids = [];
                }
            } else {
                ids = index.slice(-limit);
            }
            const keys = ids.map(id => `msg:${id}`);
            const rawMessagesMap = await this.storage.get(keys);
            rawMessages = keys.map(key => rawMessagesMap.get(key));
        }

        // Fetch stored read timestamps for participants
        const readMap = await this.storage.list({ prefix: "read:" });

        // Reassemble chunked messages ONLY when a specific messageId or full=true is requested
        const messages = [];
        for (const msg of rawMessages) {
            if (!msg) continue;
            if (clearedAt && msg.ts && msg.ts <= clearedAt) continue;

            if (msg.text && msg.text.startsWith('__chunked__:')) {
                if (fetchFull) {
                    const chunkCount = parseInt(msg.text.split(':')[1]) || 0;
                    const chunks = [];
                    const BATCH_SIZE = 25;
                    for (let i = 0; i < chunkCount; i += BATCH_SIZE) {
                        const batchCount = Math.min(BATCH_SIZE, chunkCount - i);
                        const batchKeys = Array.from({ length: batchCount }, (_, k) => `msg:${msg.id}:chunk:${i + k}`);
                        let chunkMap = await this.storage.get(batchKeys);
                        if (chunkMap.size === 0 && msg.clientId) {
                            const altKeys = Array.from({ length: batchCount }, (_, k) => `msg:${msg.clientId}:chunk:${i + k}`);
                            chunkMap = await this.storage.get(altKeys);
                        }
                        for (let k = 0; k < batchCount; k++) {
                            const chunkIdx = i + k;
                            chunks.push(chunkMap.get(`msg:${msg.id}:chunk:${chunkIdx}`) || (msg.clientId ? chunkMap.get(`msg:${msg.clientId}:chunk:${chunkIdx}`) : null) || '');
                        }
                    }
                    msg.text = chunks.join('');
                } else {
                    const chunkCount = parseInt(msg.text.split(':')[1]) || 0;
                    if (!msg.mediaSize) msg.mediaSize = Math.floor(chunkCount * 500000 * 0.75);
                }
            }

            // Check if any recipient has read this message
            if (readMap && readMap.size > 0 && msg.from) {
                for (const [key, readTs] of readMap.entries()) {
                    const reader = key.replace('read:', '');
                    if (reader !== msg.from && typeof readTs === 'number' && readTs >= msg.ts) {
                        msg.read = true;
                        break;
                    }
                }
            }

            messages.push(msg);
        }

        const resHeaders = {
            "Content-Type": "application/json",
            "X-Cleared-At": String(clearedAt || 0)
        };

        return new Response(JSON.stringify(messages), {
            headers: resHeaders
        });
    }

    async handleWallpaper(request) {
        // GET: Retrieve stored wallpaper
        if (request.method === 'GET') {
            const wallpaper = await this.storage.get("wallpaper");
            return new Response(JSON.stringify(wallpaper || { image: null, opacity: 0 }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        // POST: Set wallpaper
        const { image, opacity } = await request.json();

        // Store wallpaper
        await this.storage.put("wallpaper", { image, opacity });

        // Broadcast to all connected clients
        const broadcast = JSON.stringify({
            type: 'wallpaper',
            image,
            opacity
        });

        for (const session of this.sessions) {
            try { session.send(broadcast); } catch (e) { this.sessions.delete(session); }
        }

        return new Response(JSON.stringify({ status: "ok" }), {
            headers: { "Content-Type": "application/json" }
        });
    }

    async handleTheme(request) {
        // GET: Retrieve stored theme
        if (request.method === 'GET') {
            const theme = await this.storage.get("theme");
            return new Response(JSON.stringify({ theme: theme || "default" }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        // POST: Set theme
        const { theme } = await request.json();
        const themeId = theme || "default";

        // Store theme
        await this.storage.put("theme", themeId);

        // Broadcast to all connected clients
        const broadcast = JSON.stringify({
            type: 'theme',
            theme: themeId
        });

        for (const session of this.sessions) {
            try { session.send(broadcast); } catch (e) { this.sessions.delete(session); }
        }

        return new Response(JSON.stringify({ status: "ok", theme: themeId }), {
            headers: { "Content-Type": "application/json" }
        });
    }

    // Handle stealth notification — broadcast to peer so their app shows an innocent notification
    async handleStealthNotify(request) {
        const { from } = await request.json();
        const broadcast = JSON.stringify({ type: 'stealth_notify', from: from || 'unknown' });
        for (const session of this.sessions) {
            try { session.send(broadcast); } catch (e) { this.sessions.delete(session); }
        }
        return new Response(JSON.stringify({ status: "ok" }), {
            headers: { "Content-Type": "application/json" }
        });
    }

    // Send push notification via FCM V1 API (Multi-device support & auto-pruning)
    async sendPushNotification(recipient, senderName, messageText, chatId) {
        try {
            // Get recipient's FCM tokens from registry
            const regStub = this.env.USER_REGISTRY.get(this.env.USER_REGISTRY.idFromName("global_registry"));
            const tokenRes = await regStub.fetch(`http://internal/fcm_token?user=${recipient}`);
            const tokenData = await tokenRes.json();

            let tokens = tokenData.tokens || (tokenData.token ? [tokenData.token] : []);
            if (!tokens || tokens.length === 0) {
                console.log(`No FCM token for user: ${recipient}`);
                return;
            }

            // Get FCM credentials from environment
            const fcmCredentials = this.env.FCM_CREDENTIALS;
            if (!fcmCredentials) {
                console.log('FCM_CREDENTIALS not configured');
                return;
            }

            let credentials;
            try {
                credentials = JSON.parse(fcmCredentials);
            } catch (e) {
                console.log('Invalid FCM_CREDENTIALS JSON');
                return;
            }

            // Create JWT for FCM V1 API authentication
            const accessToken = await this.getGoogleAccessToken(credentials);
            if (!accessToken) {
                console.log('Failed to get Google access token');
                return;
            }

            const fcmUrl = `https://fcm.googleapis.com/v1/projects/${credentials.project_id}/messages:send`;
            const cleanBody = messageText.length > 100 ? messageText.slice(0, 100) + '...' : messageText;

            // Dispatch to all device tokens in parallel
            await Promise.allSettled(tokens.map(async (targetToken) => {
                const fcmPayload = {
                    message: {
                        token: targetToken,
                        notification: {
                            title: senderName,
                            body: cleanBody
                        },
                        data: {
                            chatId: chatId,
                            peer: senderName,
                            type: 'message'
                        },
                        android: {
                            priority: 'high',
                            notification: {
                                sound: 'default',
                                channel_id: 'fcm_default_channel',
                                default_vibrate_timings: true,
                                notification_priority: 'PRIORITY_HIGH',
                                click_action: 'OPEN_CHAT'
                            }
                        }
                    }
                };

                const fcmRes = await fetch(fcmUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(fcmPayload)
                });

                if (!fcmRes.ok) {
                    const errText = await fcmRes.text();
                    console.log(`FCM send failed: ${fcmRes.status} - ${errText}`);
                    // If token is invalid or unregistered, prune it from UserRegistry
                    if (fcmRes.status === 404 || errText.includes('UNREGISTERED') || errText.includes('registration-token-not-registered')) {
                        try {
                            await regStub.fetch("http://internal/fcm_token", {
                                method: "DELETE",
                                body: JSON.stringify({ username: recipient, token: targetToken })
                            });
                            console.log(`Pruned stale FCM token for ${recipient}`);
                        } catch (e) { }
                    }
                } else {
                    console.log(`Push sent to ${recipient}`);
                }
            }));
        } catch (e) {
            console.log(`Push notification error: ${e.message}`);
        }
    }

    // Get Google OAuth2 access token using service account
    async getGoogleAccessToken(credentials) {
        // Return cached token if valid
        if (this.fcmToken && Date.now() < this.fcmTokenExpiry) {
            return this.fcmToken;
        }

        try {
            const now = Math.floor(Date.now() / 1000);
            const expiry = now + 3600;

            // JWT Header
            const header = { alg: 'RS256', typ: 'JWT' };

            // JWT Payload
            const payload = {
                iss: credentials.client_email,
                sub: credentials.client_email,
                aud: 'https://oauth2.googleapis.com/token',
                iat: now,
                exp: expiry,
                scope: 'https://www.googleapis.com/auth/firebase.messaging'
            };

            // Base64url encode
            const b64url = (str) => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const headerB64 = b64url(JSON.stringify(header));
            const payloadB64 = b64url(JSON.stringify(payload));
            const signInput = `${headerB64}.${payloadB64}`;

            // Import private key and sign
            const privateKeyPem = credentials.private_key;
            const pemContents = privateKeyPem
                .replace('-----BEGIN PRIVATE KEY-----', '')
                .replace('-----END PRIVATE KEY-----', '')
                .replace(/\s/g, '');
            const keyBuffer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

            const cryptoKey = await crypto.subtle.importKey(
                'pkcs8',
                keyBuffer,
                { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
                false,
                ['sign']
            );

            const signatureBuffer = await crypto.subtle.sign(
                'RSASSA-PKCS1-v1_5',
                cryptoKey,
                new TextEncoder().encode(signInput)
            );

            const signatureB64 = b64url(String.fromCharCode(...new Uint8Array(signatureBuffer)));
            const jwt = `${signInput}.${signatureB64}`;

            // Exchange JWT for access token
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
            });

            if (!tokenRes.ok) {
                console.log('Token exchange failed:', await tokenRes.text());
                return null;
            }

            const tokenData = await tokenRes.json();

            // Cache the token and set expiry to 3500 seconds from now (100s buffer)
            this.fcmToken = tokenData.access_token;
            this.fcmTokenExpiry = Date.now() + (3500 * 1000);

            return this.fcmToken;
        } catch (e) {
            console.log('Access token error:', e.message);
            return null;
        }
    }

    // Gaming Presence & Arcade Game Session Handlers
    async handleArcadeGame(request) {
        const JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
        if (request.method === "GET") {
            if (!this.activeArcadeSession) {
                this.activeArcadeSession = await this.state.storage.get("active_arcade_session") || null;
            }
            return new Response(JSON.stringify({
                success: true,
                session: this.activeArcadeSession,
                presence: this.gamingPresence || {}
            }), { headers: JSON_HEADERS });
        }
        if (request.method === "POST") {
            try {
                const body = await request.json();
                this.activeArcadeSession = body;
                await this.state.storage.put("active_arcade_session", body);
                return new Response(JSON.stringify({ success: true, session: body }), { headers: JSON_HEADERS });
            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: JSON_HEADERS });
            }
        }
        if (request.method === "DELETE") {
            this.activeArcadeSession = null;
            await this.state.storage.delete("active_arcade_session");
            return new Response(JSON.stringify({ success: true, message: "Arcade session cleared" }), { headers: JSON_HEADERS });
        }
        return new Response("Method not allowed", { status: 405 });
    }

    async updateGamingPresenceFromWS(data) {
        this.gamingPresence = this.gamingPresence || {};
        if (data.user) {
            this.gamingPresence[data.user] = {
                status: data.status || 'in_arena',
                currentGame: data.currentGame || null,
                updatedAt: Date.now()
            };
        }
    }

    async updateArcadeGameFromWS(data) {
        if (data.action === 'leave_game' || data.action === 'close') {
            this.activeArcadeSession = null;
            await this.state.storage.delete("active_arcade_session");
        } else if (data.action === 'launch_game' || data.action === 'move' || data.action === 'game_over') {
            this.activeArcadeSession = data;
            await this.state.storage.put("active_arcade_session", data);
        }
    }
}

