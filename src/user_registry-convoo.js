import { UserRegistry } from './user_registry.js';

export class UserRegistryConvoo extends UserRegistry {
    constructor(state, env) {
        super(state, env);
    }

    async _addMutualContact(userA, userB) {
        if (!userA || !userB || userA === userB) return;
        try {
            let chatsA = await this.storage.get(`chats:${userA}`) || {};
            if (!chatsA[userB]) {
                chatsA[userB] = {
                    other: userB,
                    lastMessage: 'Contact added',
                    lastTs: Date.now(),
                    unread: 0
                };
                await this.storage.put(`chats:${userA}`, chatsA);
            }

            let chatsB = await this.storage.get(`chats:${userB}`) || {};
            if (!chatsB[userB]) {
                chatsB[userA] = {
                    other: userA,
                    lastMessage: 'Contact added',
                    lastTs: Date.now(),
                    unread: 0
                };
                await this.storage.put(`chats:${userB}`, chatsB);
            }
        } catch (e) {
            console.warn('[UserRegistryConvoo] _addMutualContact error:', e);
        }
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


        // ============ EXISTING CONVOO GROUP / SPACE ROUTES ============

        if (path === '/add_space' || path === '/add_group') {
            const { username, spaceId, groupId, name, topic, memberCount, lastMessage, ts, isSender } = await request.json();
            const id = groupId || spaceId;
            let chats = await this.storage.get(`chats:${username}`) || {};
            const current = chats[id] || { unread: 0 };
            chats[id] = {
                other: id,
                isGroup: true,
                isSpace: true,
                name: name || current.name || id,
                topic: (topic !== undefined && topic !== '') ? topic : (current.topic || ''),
                memberCount: memberCount || current.memberCount || 1,
                lastMessage: lastMessage !== undefined ? lastMessage : (current.lastMessage || ''),
                lastTs: ts || Date.now(),
                unread: isSender ? 0 : (current.unread || 0) + 1
            };
            await this.storage.put(`chats:${username}`, chats);
            return jsonResponse({ status: "group_added" });
        }

        if (path === '/remove_space' || path === '/remove_group') {
            const { username, spaceId, groupId } = await request.json();
            const id = groupId || spaceId;
            let chats = await this.storage.get(`chats:${username}`) || {};
            if (chats[id]) {
                delete chats[id];
                await this.storage.put(`chats:${username}`, chats);
            }
            return jsonResponse({ status: "group_removed" });
        }

        if (path === '/save_mutual_contact' || path === '/add_friend') {
            const { userA, userB } = await request.json();
            await this._addMutualContact(userA, userB);
            return jsonResponse({ status: "friends_added" });
        }

        return super.fetch(request);
    }
}


