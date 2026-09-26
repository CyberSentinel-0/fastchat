import { ChatRoomV2 } from './chatroom.js';

export class ChatRoomConvoo extends ChatRoomV2 {
    constructor(state, env) {
        super(state, env);
        this.pulseQueue = [];
        this.exchangeOffers = {};
    }

    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (path === '/pulse_ws') {
            return this.handlePulseWebSocket(request);
        }
        if (path === '/space/init') {
            return this.handleSpaceInit(request);
        }
        if (path === '/space/info') {
            return this.handleSpaceInfo(request);
        }
        if (path === '/space/members/add') {
            return this.handleSpaceAddMembers(request);
        }
        if (path === '/space/members/remove') {
            return this.handleSpaceRemoveMember(request);
        }
        if (path === '/space/leave') {
            return this.handleSpaceLeave(request);
        }
        if (path === '/space/role') {
            return this.handleSpaceSetRole(request);
        }

        return super.fetch(request);
    }

    // =========================================================================
    // PULSE (ANONYMOUS 1:1 PEER DISCOVERY) MATCHMAKER
    // =========================================================================
    async handlePulseWebSocket(request) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();

        const url = new URL(request.url);
        const alias = url.searchParams.get('alias') || ('Peer #' + Math.random().toString(16).slice(2, 6).toUpperCase());
        const userId = url.searchParams.get('userId') || ('anon_' + Math.random().toString(36).slice(2, 8));
        const rawTopics = url.searchParams.get('topic') || url.searchParams.get('topics') || '';
        const topics = rawTopics.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

        const entry = {
            ws: server,
            alias,
            userId,
            topics,
            ts: Date.now()
        };

        const matchesTopics = (t1, t2) => {
            const isWild1 = !t1 || t1.length === 0 || t1.includes('all') || t1.includes('any');
            const isWild2 = !t2 || t2.length === 0 || t2.includes('all') || t2.includes('any');
            if (isWild1 || isWild2) return true;
            return t1.some(t => t2.includes(t));
        };

        const tryMatch = (targetEntry) => {
            // Find peer with matching topic first
            let matchIdx = this.pulseQueue.findIndex(p => 
                p.ws !== targetEntry.ws &&
                p.userId !== targetEntry.userId &&
                matchesTopics(targetEntry.topics, p.topics)
            );

            // Fallback: any available waiting peer
            if (matchIdx === -1) {
                matchIdx = this.pulseQueue.findIndex(p => 
                    p.ws !== targetEntry.ws &&
                    p.userId !== targetEntry.userId
                );
            }

            while (matchIdx !== -1) {
                const peer = this.pulseQueue.splice(matchIdx, 1)[0];
                const roomId = 'rnd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                const commonTopics = targetEntry.topics.filter(t => peer.topics.includes(t));

                let targetSent = false;
                let peerSent = false;

                try {
                    targetEntry.ws.send(JSON.stringify({
                        type: 'matched',
                        roomId,
                        peerAlias: peer.alias || 'Anonymous',
                        commonTopics,
                        initiator: true
                    }));
                    targetSent = true;
                } catch(e) {}

                try {
                    peer.ws.send(JSON.stringify({
                        type: 'matched',
                        roomId,
                        peerAlias: targetEntry.alias || 'Anonymous',
                        commonTopics,
                        initiator: false
                    }));
                    peerSent = true;
                } catch(e) {}

                if (targetSent && peerSent) {
                    return true;
                }

                // If peer socket was dead, try next peer for targetEntry
                if (targetSent && !peerSent) {
                    matchIdx = this.pulseQueue.findIndex(p => 
                        p.ws !== targetEntry.ws &&
                        p.userId !== targetEntry.userId
                    );
                    continue;
                } else if (!targetSent && peerSent) {
                    // Target socket was dead, return peer to waiting queue
                    this.pulseQueue.unshift(peer);
                    return false;
                } else {
                    return false;
                }
            }

            return false;
        };

        // Try immediate match
        if (!tryMatch(entry)) {
            this.pulseQueue.push(entry);
            try { server.send(JSON.stringify({ type: 'searching' })); } catch(e) {}
        }

        server.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'skip' || data.type === 'search') {
                    this.pulseQueue = this.pulseQueue.filter(p => p.ws !== server);
                    if (data.topic) {
                        entry.topics = String(data.topic).split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
                    } else if (Array.isArray(data.topics)) {
                        entry.topics = data.topics.map(t => String(t).trim().toLowerCase()).filter(Boolean);
                    }
                    if (!tryMatch(entry)) {
                        this.pulseQueue.push(entry);
                        try { server.send(JSON.stringify({ type: 'searching' })); } catch(e) {}
                    }
                } else if (data.type === 'ping') {
                    try { server.send(JSON.stringify({ type: 'pong' })); } catch(e) {}
                }
            } catch(e) {}
        });

        server.addEventListener('close', () => {
            this.pulseQueue = this.pulseQueue.filter(p => p.ws !== server);
        });

        server.addEventListener('error', () => {
            this.pulseQueue = this.pulseQueue.filter(p => p.ws !== server);
        });

        return new Response(null, { status: 101, webSocket: client });
    }

    // =========================================================================
    // SPACES (GROUP CHANNELS) MANAGEMENT
    // =========================================================================
    async handleSpaceInit(request) {
        try {
            const body = await request.json();
            const { id, name, topic, creator, isPublic, initialMembers } = body;
            if (!id || !name || !creator) {
                return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers: { "Content-Type": "application/json" } });
            }

            const members = {
                [creator]: { role: 'founder', joinedAt: Date.now() }
            };

            if (Array.isArray(initialMembers)) {
                for (const m of initialMembers) {
                    if (m && typeof m === 'string' && m !== creator) {
                        members[m] = { role: 'member', joinedAt: Date.now() };
                    }
                }
            }

            const meta = {
                id,
                name: String(name).slice(0, 60),
                topic: String(topic || '').slice(0, 200),
                creator,
                isPublic: !!isPublic,
                members,
                created: Date.now()
            };

            await this.storage.put('space_meta', meta);
            return new Response(JSON.stringify({ status: "ok", space: meta }), { headers: { "Content-Type": "application/json" } });
        } catch(e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }

    async handleSpaceInfo(request) {
        try {
            const meta = await this.storage.get('space_meta');
            if (!meta) {
                return new Response(JSON.stringify({ error: "Space not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
            }
            const memberEntries = Object.entries(meta.members || {}).map(([username, data]) => ({
                username,
                role: (data && data.role) || 'member',
                joinedAt: (data && data.joinedAt) || meta.created || Date.now()
            }));
            const responseData = {
                ...meta,
                members: meta.members,
                memberList: memberEntries,
                memberCount: memberEntries.length
            };
            return new Response(JSON.stringify(responseData), { headers: { "Content-Type": "application/json" } });
        } catch(e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }

    async handleSpaceAddMembers(request) {
        try {
            const { members, by } = await request.json();
            const meta = await this.storage.get('space_meta');
            if (!meta) return new Response(JSON.stringify({ error: "Space not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

            const callerRole = meta.members[by]?.role;
            if (!callerRole || (callerRole !== 'founder' && callerRole !== 'moderator')) {
                return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403, headers: { "Content-Type": "application/json" } });
            }

            const added = [];
            if (Array.isArray(members)) {
                for (const m of members) {
                    if (m && typeof m === 'string' && !meta.members[m]) {
                        meta.members[m] = { role: 'member', joinedAt: Date.now() };
                        added.push(m);
                    }
                }
            }

            await this.storage.put('space_meta', meta);

            // Broadcast to connected sessions
            const payload = JSON.stringify({ type: 'space_members_added', added, by });
            for (const s of this.sessions) {
                try { s.send(payload); } catch(err) { this.sessions.delete(s); }
            }

            return new Response(JSON.stringify({ status: "ok", added, members: meta.members }), { headers: { "Content-Type": "application/json" } });
        } catch(e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }

    async handleSpaceRemoveMember(request) {
        try {
            const { username, by } = await request.json();
            const meta = await this.storage.get('space_meta');
            if (!meta) return new Response(JSON.stringify({ error: "Space not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

            const callerRole = meta.members[by]?.role;
            const targetRole = meta.members[username]?.role;

            if (!callerRole || (callerRole !== 'founder' && callerRole !== 'moderator')) {
                return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
            if (targetRole === 'founder') {
                return new Response(JSON.stringify({ error: "Cannot remove Founder" }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
            if (callerRole === 'moderator' && targetRole === 'moderator') {
                return new Response(JSON.stringify({ error: "Moderator cannot remove another Moderator" }), { status: 403, headers: { "Content-Type": "application/json" } });
            }

            delete meta.members[username];
            await this.storage.put('space_meta', meta);

            const payload = JSON.stringify({ type: 'space_member_removed', username, by });
            for (const s of this.sessions) {
                try { s.send(payload); } catch(err) { this.sessions.delete(s); }
            }

            return new Response(JSON.stringify({ status: "ok", username }), { headers: { "Content-Type": "application/json" } });
        } catch(e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }

    async handleSpaceLeave(request) {
        try {
            const { username } = await request.json();
            const meta = await this.storage.get('space_meta');
            if (!meta) return new Response(JSON.stringify({ error: "Space not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

            if (meta.members[username]) {
                delete meta.members[username];
                await this.storage.put('space_meta', meta);

                const payload = JSON.stringify({ type: 'space_member_left', username });
                for (const s of this.sessions) {
                    try { s.send(payload); } catch(err) { this.sessions.delete(s); }
                }
            }

            return new Response(JSON.stringify({ status: "ok" }), { headers: { "Content-Type": "application/json" } });
        } catch(e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }

    async handleSpaceSetRole(request) {
        try {
            const { targetUser, role, by } = await request.json();
            const meta = await this.storage.get('space_meta');
            if (!meta) return new Response(JSON.stringify({ error: "Space not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

            if (meta.members[by]?.role !== 'founder') {
                return new Response(JSON.stringify({ error: "Only Founder can assign roles" }), { status: 403, headers: { "Content-Type": "application/json" } });
            }

            if (meta.members[targetUser] && (role === 'moderator' || role === 'member')) {
                meta.members[targetUser].role = role;
                await this.storage.put('space_meta', meta);

                const payload = JSON.stringify({ type: 'space_role_updated', targetUser, role });
                for (const s of this.sessions) {
                    try { s.send(payload); } catch(err) { this.sessions.delete(s); }
                }

                return new Response(JSON.stringify({ status: "ok", targetUser, role }), { headers: { "Content-Type": "application/json" } });
            }

            return new Response(JSON.stringify({ error: "Invalid target or role" }), { status: 400, headers: { "Content-Type": "application/json" } });
        } catch(e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }

    // =========================================================================
    // WEBSOCKET OVERRIDE: DELEGATE BROADCAST TO SUPER (NO DUPLICATE LISTENERS)
    // =========================================================================
    async handleWebSocket(request) {
        return super.handleWebSocket(request);
    }
}
