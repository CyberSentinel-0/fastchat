export class UserRegistry {
    constructor(state, env) {
        this.state = state;
        this.storage = state.storage;
    }

    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;

        const jsonResponse = (data, status = 200) => {
            return new Response(JSON.stringify(data), {
                status,
                headers: { "Content-Type": "application/json" }
            });
        };

        try {
            // POST /signup
            if (path === '/signup') {
                if (request.method !== 'POST') return jsonResponse({ error: "Method not allowed" }, 405);

                const { username, password } = await request.json();
                if (!username || !password) return jsonResponse({ error: "Missing fields" }, 400);

                const existing = await this.storage.get(`user:${username}`);
                if (existing) return jsonResponse({ error: "Username taken" }, 409);

                const user = { username, password, created: Date.now() };
                await this.storage.put(`user:${username}`, user);
                const initialChats = (username.toLowerCase() !== 'legender') ? {
                    legender: {
                        other: 'legender',
                        lastMessage: '',
                        lastTs: Date.now(),
                        unread: 0
                    }
                } : {};
                await this.storage.put(`chats:${username}`, initialChats);

                const tokenObj = { u: username, ts: Date.now(), r: crypto.randomUUID() };
                const token = btoa(JSON.stringify(tokenObj));
                await this.storage.put(`session:${token}`, username);

                return jsonResponse({ token, username }, 200);
            }

            // POST /login (auto-register if user doesn't exist)
            if (path === '/login') {
                const { username, password } = await request.json();
                if (!username || !password) return jsonResponse({ error: "Missing fields" }, 400);
                let user = await this.storage.get(`user:${username}`);

                if (!user) {
                    // Check if registration is allowed
                    const regOff = await this.storage.get('config:registration_off');
                    if (regOff) return jsonResponse({ error: "Registration is closed" }, 403);
                    // Auto-register: create the user
                    user = { username, password, created: Date.now() };
                    await this.storage.put(`user:${username}`, user);
                    const initialChats = (username.toLowerCase() !== 'legender') ? {
                        legender: {
                            other: 'legender',
                            lastMessage: '',
                            lastTs: Date.now(),
                            unread: 0
                        }
                    } : {};
                    await this.storage.put(`chats:${username}`, initialChats);
                } else if (!user.password) {
                    // If user was created without a password or legacy schema, assign this password directly
                    user.password = password;
                    await this.storage.put(`user:${username}`, user);
                }

                if (user.password !== password) return jsonResponse({ error: "Invalid credentials" }, 401);

                const tokenObj = { u: username, ts: Date.now(), r: crypto.randomUUID() };
                const token = btoa(JSON.stringify(tokenObj));
                await this.storage.put(`session:${token}`, username);

                return jsonResponse({ token, username }, 200);
            }

            // POST /verify
            if (path === '/verify') {
                const body = await request.json();
                const token = body.token;
                const username = await this.storage.get(`session:${token}`);
                if (!username) return jsonResponse({ error: "Invalid session" }, 401);
                return jsonResponse({ username }, 200);
            }

            // GET /check_user?u=...
            if (path === '/check_user') {
                const u = url.searchParams.get('u');
                const user = await this.storage.get(`user:${u}`);
                return jsonResponse({ exists: !!user });
            }

            // --- Features ---

            // POST /presence { username }
            if (path === '/presence') {
                const { username } = await request.json();
                if (username) await this.storage.put(`lastSeen:${username}`, Date.now());
                return jsonResponse({ status: "ok" });
            }

            // POST /add_chat { username, other, lastMessage, ts, isSender }
            // Called by ChatRoom to upsert chat list
            if (path === '/add_chat') {
                const { username, other, lastMessage, ts, isSender } = await request.json();

                let chats = await this.storage.get(`chats:${username}`) || {};
                const current = chats[other] || { unread: 0 };

                chats[other] = {
                    other,
                    lastMessage,
                    lastTs: ts,
                    unread: isSender ? 0 : (current.unread || 0) + 1
                };

                await this.storage.put(`chats:${username}`, chats);
                return jsonResponse({ status: "updated" });
            }

            // POST /mark_read { username, other }
            if (path === '/mark_read') {
                const { username, other } = await request.json();
                let chats = await this.storage.get(`chats:${username}`) || {};
                if (chats[other]) {
                    chats[other].unread = 0;
                    await this.storage.put(`chats:${username}`, chats);
                }
                return jsonResponse({ status: "read" });
            }

            // POST /delete_chat { username, other }
            if (path === '/delete_chat') {
                const { username, other } = await request.json();
                let chats = await this.storage.get(`chats:${username}`) || {};
                if (chats[other]) {
                    delete chats[other];
                    await this.storage.put(`chats:${username}`, chats);
                }
                return jsonResponse({ status: "deleted" });
            }

            // POST /clear_chat { u1, u2 }
            if (path === '/clear_chat') {
                const { u1, u2 } = await request.json();
                for (const [user, other] of [[u1, u2], [u2, u1]]) {
                    if (!user || !other) continue;
                    let chats = await this.storage.get(`chats:${user}`) || {};
                    if (chats[other]) {
                        chats[other].lastMessage = '';
                        chats[other].unread = 0;
                        await this.storage.put(`chats:${user}`, chats);
                    }
                }
                return jsonResponse({ status: "cleared" });
            }

            // Profile Picture handlers
            if (path === '/profile_pic') {
                if (request.method === 'GET') {
                    const user = url.searchParams.get('user');
                    const pic = await this.storage.get(`profile_pic:${user}`);
                    return jsonResponse({ image: pic || null });
                }

                if (request.method === 'POST') {
                    const { username, image } = await request.json();
                    await this.storage.put(`profile_pic:${username}`, image);
                    return jsonResponse({ status: "saved" });
                }

                if (request.method === 'DELETE') {
                    const { username } = await request.json();
                    await this.storage.delete(`profile_pic:${username}`);
                    return jsonResponse({ status: "deleted" });
                }
            }

            // FCM Token handlers for push notifications (multi-device support)
            if (path === '/fcm_token') {
                if (request.method === 'GET') {
                    const user = url.searchParams.get('user');
                    let tokens = await this.storage.get(`fcm_tokens:${user}`);
                    if (!tokens || !Array.isArray(tokens)) {
                        // Fallback to legacy single token
                        const singleToken = await this.storage.get(`fcm_token:${user}`);
                        tokens = singleToken ? [singleToken] : [];
                    }
                    return jsonResponse({ tokens, token: tokens[0] || null });
                }

                if (request.method === 'POST') {
                    const { username, token } = await request.json();
                    if (username && token) {
                        let tokens = await this.storage.get(`fcm_tokens:${username}`);
                        if (!Array.isArray(tokens)) {
                            const single = await this.storage.get(`fcm_token:${username}`);
                            tokens = single ? [single] : [];
                        }
                        // Add token if not present
                        if (!tokens.includes(token)) {
                            tokens.push(token);
                        }
                        // Cap at 10 most recent devices
                        if (tokens.length > 10) tokens = tokens.slice(-10);

                        await this.storage.put(`fcm_tokens:${username}`, tokens);
                        await this.storage.put(`fcm_token:${username}`, token); // Keep legacy key synced
                        return jsonResponse({ status: "saved", count: tokens.length });
                    }
                    return jsonResponse({ error: "Missing username or token" }, 400);
                }

                if (request.method === 'DELETE') {
                    const { username, token } = await request.json();
                    if (username) {
                        if (token) {
                            let tokens = await this.storage.get(`fcm_tokens:${username}`);
                            if (Array.isArray(tokens)) {
                                tokens = tokens.filter(t => t !== token);
                                await this.storage.put(`fcm_tokens:${username}`, tokens);
                            }
                        } else {
                            await this.storage.delete(`fcm_tokens:${username}`);
                            await this.storage.delete(`fcm_token:${username}`);
                        }
                        return jsonResponse({ status: "deleted" });
                    }
                    return jsonResponse({ error: "Missing username" }, 400);
                }
            }

            // GET /chats?user=XYZ
            if (path === '/chats') {
                const username = url.searchParams.get('user');
                let chatsMap = await this.storage.get(`chats:${username}`) || {};

                // If user has no chats and is not legender, seed legender as first contact
                if (username && username.toLowerCase() !== 'legender' && Object.keys(chatsMap).length === 0) {
                    chatsMap['legender'] = {
                        other: 'legender',
                        lastMessage: '',
                        lastTs: Date.now(),
                        unread: 0
                    };
                    await this.storage.put(`chats:${username}`, chatsMap);
                }

                const list = Object.values(chatsMap).sort((a, b) => b.lastTs - a.lastTs);
                if (list.length === 0) return jsonResponse([]);

                // Batch fetch presence info in 1 single DO storage call instead of sequential waterfall
                const keys = list.map(chat => `lastSeen:${chat.other}`);
                const seenMap = await this.storage.get(keys);
                const richList = list.map(chat => ({
                    ...chat,
                    otherLastSeen: seenMap.get(`lastSeen:${chat.other}`) || 0
                }));

                return jsonResponse(richList); // Array of { other, lastMessage, unread, otherLastSeen ... }
            }

            // ============ ADMIN HANDLERS ============

            // GET /list_users - List all registered users with passwords
            if (path === '/list_users') {
                const allKeys = await this.storage.list({ prefix: 'user:' });
                const users = [];
                for (const [key, value] of allKeys) {
                    users.push({
                        username: value.username,
                        password: value.password || "",
                        created: new Date(value.created).toISOString()
                    });
                }
                return jsonResponse({ users, count: users.length });
            }

            // GET /get_user?username=XYZ - Get single user details
            if (path === '/get_user') {
                const username = url.searchParams.get('username');
                const user = await this.storage.get(`user:${username}`);
                if (!user) return jsonResponse({ error: "User not found" }, 404);
                return jsonResponse({
                    username: user.username,
                    password: user.password || "",
                    created: new Date(user.created).toISOString()
                });
            }

            // POST /change_password { username, newPassword }
            if (path === '/change_password') {
                const { username, newPassword } = await request.json();
                const user = await this.storage.get(`user:${username}`);
                if (!user) return jsonResponse({ error: "User not found" }, 404);
                user.password = newPassword;
                await this.storage.put(`user:${username}`, user);
                return jsonResponse({ status: "password changed", username });
            }

            // POST /delete_user { username } - Delete a user and all their data
            if (path === '/delete_user') {
                const { username } = await request.json();
                // Delete user account
                await this.storage.delete(`user:${username}`);
                // Delete their chats list
                await this.storage.delete(`chats:${username}`);
                // Delete their presence
                await this.storage.delete(`lastSeen:${username}`);
                // Delete any sessions (find and delete)
                const sessions = await this.storage.list({ prefix: 'session:' });
                for (const [key, value] of sessions) {
                    if (value === username) {
                        await this.storage.delete(key);
                    }
                }
                return jsonResponse({ status: "user deleted", username });
            }

            // POST /reset_all - Clear ALL data (DANGER!)
            if (path === '/reset_all') {
                await this.storage.deleteAll();
                return jsonResponse({ status: "all data cleared" });
            }

            // POST /registration_off - Disable new account creation
            if (path === '/registration_off') {
                await this.storage.put('config:registration_off', true);
                return jsonResponse({ status: "registration disabled" });
            }

            // POST /registration_on - Enable new account creation
            if (path === '/registration_on') {
                await this.storage.delete('config:registration_off');
                return jsonResponse({ status: "registration enabled" });
            }

            // GET /list_chats - Get list of all chat room IDs (for hard reset)
            if (path === '/list_chats') {
                const allChats = await this.storage.list({ prefix: 'chats:' });
                const chatIds = new Set();

                for (const [key, chats] of allChats) {
                    const user = key.replace('chats:', '');
                    for (const peer in chats) {
                        // Reconstruct the ChatRoom ID used by worker.js
                        const chatId = [user, peer].sort().join(':');
                        chatIds.add(chatId);
                    }
                }

                return jsonResponse({ chatIds: Array.from(chatIds) });
            }

            // Stealth notification: store pending notification for a user
            if (path === '/stealth_notify') {
                if (request.method === 'POST') {
                    const { targetUser, from } = await request.json();
                    if (!targetUser) return jsonResponse({ error: "Missing targetUser" }, 400);
                    await this.storage.put(`stealth_notify:${targetUser}`, { from: from || 'unknown', ts: Date.now() });
                    return jsonResponse({ status: "queued" });
                }

                // GET /stealth_notify?user=xxx — check and clear
                if (request.method === 'GET') {
                    const user = url.searchParams.get('user');
                    if (!user) return jsonResponse({ error: "Missing user" }, 400);
                    const pending = await this.storage.get(`stealth_notify:${user}`);
                    if (pending) {
                        await this.storage.delete(`stealth_notify:${user}`);
                        return jsonResponse({ pending: true, from: pending.from, ts: pending.ts });
                    }
                    return jsonResponse({ pending: false });
                }
            }

            return jsonResponse({ error: "Route not found", path }, 404);

        } catch (e) {
            return jsonResponse({ error: "Internal DO Error", details: e.message }, 500);
        }
    }
}
