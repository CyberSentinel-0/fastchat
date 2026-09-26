import { ChatRoomConvoo } from './chatroom-convoo.js';
import { UserRegistryConvoo } from './user_registry-convoo.js';

export class ChatRoom extends ChatRoomConvoo {}
export { ChatRoomConvoo as ChatRoomV2, UserRegistryConvoo as UserRegistry };

let cachedRedgifsToken = null;
let cachedRedgifsExpiry = 0;

const searchCache = new Map();

function getCachedSearch(key) {
    const entry = searchCache.get(key);
    if (entry && Date.now() < entry.expiry) {
        return entry.data;
    }
    searchCache.delete(key);
    return null;
}

function setCachedSearch(key, data) {
    if (searchCache.size >= 200) {
        const firstKey = searchCache.keys().next().value;
        searchCache.delete(firstKey);
    }
    searchCache.set(key, {
        data,
        expiry: Date.now() + 600000 // 10 minutes cache
    });
}

function decodeHtmlEntities(str) {
    if (!str) return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, '/');
}

async function getRedgifsTokenForWorker(clientIP = '') {
    const now = Date.now();
    if (cachedRedgifsToken && now < cachedRedgifsExpiry) {
        return cachedRedgifsToken;
    }

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.redgifs.com/',
        'Origin': 'https://www.redgifs.com'
    };
    if (clientIP) {
        headers['X-Forwarded-For'] = clientIP;
        headers['X-Real-IP'] = clientIP;
    }
    let res = await fetch('https://api.redgifs.com/v2/auth/temporary', { headers });
    
    if (res.status === 429) {
        const errorJson = await res.clone().json().catch(() => ({}));
        const delayMs = errorJson.error?.delay || 1000;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        res = await fetch('https://api.redgifs.com/v2/auth/temporary', { headers });
    }

    if (!res.ok) throw new Error(`Auth failed with status ${res.status}`);
    const data = await res.json();
    if (data && data.token) {
        cachedRedgifsToken = data.token;
        cachedRedgifsExpiry = now + 3600000; // 1 hour cache
        return data.token;
    }
    throw new Error('No token in response');
}

// ============ HMAC JWT Auth (local verification, no DO calls) ============
const JWT_SECRET = 'fc-hmac-secret-2026-xK9mP2qL7nR4';

async function getJWTKey() {
    const enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function base64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    return new Uint8Array([...bin].map(c => c.charCodeAt(0)));
}

async function createJWT(username) {
    const key = await getJWTKey();
    const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const payload = base64url(new TextEncoder().encode(JSON.stringify({ u: username, ts: Date.now() })));
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${base64url(sig)}`;
}

async function verifyJWT(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const key = await getJWTKey();
        const sigBuf = base64urlDecode(parts[2]);
        const valid = await crypto.subtle.verify('HMAC', key, sigBuf, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
        if (!valid) return null;
        const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
        if (!payload.u) return null;
        return payload.u;
    } catch (e) { return null; }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        const JSON_HEADERS = {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS, DELETE",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Allow-Credentials": "true"
        };

        if (request.method === "OPTIONS") return new Response(null, { 
            headers: { ...JSON_HEADERS, "Access-Control-Max-Age": "86400" }
        });

        const getAuth = async (req) => {
            let token = "";
            const authHeader = req.headers.get("Authorization");
            if (authHeader && authHeader.startsWith("Bearer ")) token = authHeader.substring(7);
            if (!token) {
                const cookie = req.headers.get("Cookie");
                if (cookie) token = (cookie.match(/fc_token=([^;]+)/) || [])[1];
            }
            if (!token) return null;

            // Try local JWT verification first (no DO call needed)
            const jwtUser = await verifyJWT(token);
            if (jwtUser) return jwtUser;

            // Fallback: old base64 token — verify via DO (backward compat)
            try {
                const stub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
                const res = await stub.fetch("http://internal/verify", {
                    method: "POST", body: JSON.stringify({ token })
                });
                return res.ok ? (await res.json()).username : null;
            } catch (e) { return null; }
        };

        // --- Routes ---

        // Root
        if (path === '/') return new Response(JSON.stringify({ status: "FastChat API Running." }), { headers: JSON_HEADERS });

        // Link Preview endpoint — fetches OpenGraph and metadata with Edge caching
        if (path === '/api/link-preview' && request.method === 'GET') {
            const targetUrl = url.searchParams.get('url');
            if (!targetUrl) {
                return new Response(JSON.stringify({ error: "Missing url parameter" }), { status: 400, headers: JSON_HEADERS });
            }

            try {
                const parsed = new URL(targetUrl);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                    return new Response(JSON.stringify({ error: "Invalid protocol" }), { status: 400, headers: JSON_HEADERS });
                }

                // SSRF protection: block private and internal IP ranges
                const hostname = parsed.hostname.toLowerCase();
                if (
                    hostname === 'localhost' ||
                    hostname === '127.0.0.1' ||
                    hostname === '0.0.0.0' ||
                    hostname.endsWith('.internal') ||
                    hostname.endsWith('.local') ||
                    /^10\./.test(hostname) ||
                    /^192\.168\./.test(hostname) ||
                    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
                    /^169\.254\./.test(hostname)
                ) {
                    return new Response(JSON.stringify({ error: "Restricted host" }), { status: 403, headers: JSON_HEADERS });
                }

                // 1. YouTube Specialist handler (oEmbed + maxres/hq thumbnail)
                const isYouTube = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)/i.test(targetUrl);
                if (isYouTube) {
                    let ytVideoId = null;
                    const ytMatch = targetUrl.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
                    if (ytMatch) ytVideoId = ytMatch[1];

                    let title = 'YouTube Video';
                    let author = 'YouTube';
                    try {
                        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`, {
                            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FastChat/1.0)' },
                            cf: { cacheTtl: 86400, cacheEverything: true }
                        });
                        if (oembedRes.ok) {
                            const data = await oembedRes.json();
                            if (data.title) title = data.title;
                            if (data.author_name) author = data.author_name;
                        }
                    } catch (e) {}

                    const result = {
                        url: targetUrl,
                        type: 'youtube',
                        videoId: ytVideoId,
                        title,
                        author,
                        siteName: 'YouTube',
                        image: ytVideoId ? `https://i.ytimg.com/vi/${ytVideoId}/hqdefault.jpg` : '',
                        favicon: 'https://www.youtube.com/s/desktop/f7be73de/img/favicon.ico'
                    };

                    return new Response(JSON.stringify(result), {
                        headers: {
                            ...JSON_HEADERS,
                            "Cache-Control": "public, max-age=86400, s-maxage=86400"
                        }
                    });
                }

                // 2. Instagram Specialist handler (WhatsApp-grade scraper)
                const isInstagram = /(?:instagram\.com\/(?:reel|p|tv|stories)\/([a-zA-Z0-9_-]+))/i.test(targetUrl);
                if (isInstagram) {
                    const igMatch = targetUrl.match(/instagram\.com\/(reel|p|tv|stories)\/([a-zA-Z0-9_-]+)/i);
                    const igType = igMatch ? (igMatch[1].toLowerCase() === 'reel' ? 'Instagram Reel' : 'Instagram Post') : 'Instagram Post';
                    const shortcode = igMatch ? igMatch[2] : '';
                    const cleanUrl = `https://www.instagram.com/${igMatch ? igMatch[1].toLowerCase() : 'p'}/${shortcode}/?igsi=`;

                    let image = '';
                    let title = igType;
                    let description = `Watch this ${igType.toLowerCase()} on Instagram`;

                    try {
                        const igRes = await fetch(`https://www.instagram.com/${igMatch ? igMatch[1].toLowerCase() : 'p'}/${shortcode}/`, {
                            headers: {
                                'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                                'Accept-Language': 'en-US,en;q=0.9'
                            },
                            cf: { cacheTtl: 86400, cacheEverything: true }
                        });

                        if (igRes.ok) {
                            const html = await igRes.text();
                            const extractMeta = (prop) => {
                                const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', 'i')) ||
                                          html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + prop + '["\']', 'i'));
                                return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'") : '';
                            };

                            const scrapedImg = extractMeta('og:image');
                            const scrapedTitle = extractMeta('og:title');
                            const scrapedDesc = extractMeta('og:description');

                            if (scrapedTitle) title = scrapedTitle;
                            if (scrapedDesc) description = scrapedDesc;

                            if (scrapedImg) {
                                try {
                                    const cleanImgUrl = scrapedImg.replace(/&amp;/g, '&');
                                    const imgHeaders = {
                                        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
                                        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                                        'Referer': `https://www.instagram.com/${igMatch ? igMatch[1].toLowerCase() : 'p'}/${shortcode}/`
                                    };
                                    const cookies = igRes.headers.get('set-cookie');
                                    if (cookies) imgHeaders['Cookie'] = cookies;

                                    const imgRes = await fetch(cleanImgUrl, { headers: imgHeaders });
                                    if (imgRes.ok) {
                                        const arrayBuf = await imgRes.arrayBuffer();
                                        const mime = imgRes.headers.get('content-type') || 'image/jpeg';
                                        let binary = '';
                                        const bytes = new Uint8Array(arrayBuf);
                                        const chunkSz = 8192;
                                        for (let i = 0; i < bytes.length; i += chunkSz) {
                                            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSz));
                                        }
                                        image = `data:${mime};base64,${btoa(binary)}`;
                                    }
                                } catch (err) {
                                    console.warn('[Instagram Image Scraper] Error:', err);
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('[Instagram Scraper] Error:', e);
                    }

                    const result = {
                        url: cleanUrl,
                        type: 'instagram',
                        title,
                        description,
                        siteName: 'Instagram',
                        shortcode,
                        image,
                        favicon: 'https://static.cdninstagram.com/rsrc.php/v3/yI/r/VsNE-OHk_8a.png'
                    };

                    return new Response(JSON.stringify(result), {
                        headers: {
                            ...JSON_HEADERS,
                            "Cache-Control": "public, max-age=86400, s-maxage=86400"
                        }
                    });
                }

                // 3. General URL OpenGraph Scraper
                const pageRes = await fetch(targetUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9'
                    },
                    redirect: 'follow',
                    cf: { cacheTtl: 86400, cacheEverything: true }
                });

                if (!pageRes.ok) {
                    return new Response(JSON.stringify({
                        url: targetUrl,
                        type: 'website',
                        title: parsed.hostname,
                        siteName: parsed.hostname,
                        favicon: `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=64`
                    }), { headers: { ...JSON_HEADERS, "Cache-Control": "public, max-age=3600" } });
                }

                const html = await pageRes.text();
                const headHtml = html.substring(0, 100000);

                const getMeta = (propName) => {
                    const regexes = [
                        new RegExp(`<meta[^>]*property=["'](?:og:|twitter:)?${propName}["'][^>]*content=["']([^"']*)["']`, 'i'),
                        new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["'](?:og:|twitter:)?${propName}["']`, 'i'),
                        new RegExp(`<meta[^>]*name=["'](?:og:|twitter:)?${propName}["'][^>]*content=["']([^"']*)["']`, 'i'),
                        new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["'](?:og:|twitter:)?${propName}["']`, 'i')
                    ];
                    for (const r of regexes) {
                        const m = headHtml.match(r);
                        if (m && m[1]) return decodeHtmlEntities(m[1].trim());
                    }
                    return '';
                };

                const title = getMeta('title') || (headHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ? decodeHtmlEntities(headHtml.match(/<title[^>]*>([^<]*)<\/title>/i)[1].trim()) : '') || parsed.hostname;
                const description = getMeta('description') || '';
                let image = getMeta('image') || '';
                if (image && !image.startsWith('http://') && !image.startsWith('https://')) {
                    try { image = new URL(image, targetUrl).href; } catch (e) {}
                }
                const siteName = getMeta('site_name') || parsed.hostname;
                const favicon = `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=64`;

                return new Response(JSON.stringify({
                    url: targetUrl,
                    type: 'website',
                    title,
                    description,
                    image,
                    siteName,
                    favicon
                }), {
                    headers: {
                        ...JSON_HEADERS,
                        "Cache-Control": "public, max-age=86400, s-maxage=86400"
                    }
                });

            } catch (err) {
                return new Response(JSON.stringify({
                    url: targetUrl,
                    type: 'website',
                    title: new URL(targetUrl).hostname || targetUrl,
                    siteName: new URL(targetUrl).hostname || targetUrl,
                    favicon: `https://www.google.com/s2/favicons?domain=${new URL(targetUrl).hostname}&sz=64`
                }), { headers: { ...JSON_HEADERS, "Cache-Control": "public, max-age=3600" } });
            }
        }

        // RedGifs Token endpoint — returns a cached temporary token to the client
        if (path === '/api/redgifs/token') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });

            try {
                const token = await getRedgifsTokenForWorker('');
                return new Response(JSON.stringify({ token }), { status: 200, headers: JSON_HEADERS });
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
            }
        }

        // RedGifs Search Proxy — transparent proxy that adds CORS headers
        if (path === '/api/redgifs/search') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });

            const search_text = url.searchParams.get('search_text') || '';
            const page = url.searchParams.get('page') || '1';
            const count = url.searchParams.get('count') || '24';

            const cacheKey = `${search_text.toLowerCase()}|${page}|${count}`;
            const cachedResult = getCachedSearch(cacheKey);
            if (cachedResult) {
                return new Response(JSON.stringify(cachedResult), { status: 200, headers: JSON_HEADERS });
            }

            try {
                const token = await getRedgifsTokenForWorker('');
                const searchUrl = `https://api.redgifs.com/v2/gifs/search?query=${encodeURIComponent(search_text)}&count=${count}&page=${page}`;
                
                const searchHeaders = {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://www.redgifs.com/',
                    'Origin': 'https://www.redgifs.com'
                };

                // Retry loop: up to 3 attempts with increasing delay
                let lastRes = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    lastRes = await fetch(searchUrl, { headers: searchHeaders });
                    
                    if (lastRes.status === 429) {
                        const errorJson = await lastRes.clone().json().catch(() => ({}));
                        const delayMs = Math.min((errorJson.error?.delay || 500) * (attempt + 1), 3000);
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                        continue;
                    }
                    
                    if (lastRes.status === 401 && attempt === 0) {
                        // Token expired, refresh and retry
                        cachedRedgifsToken = null;
                        cachedRedgifsExpiry = 0;
                        const newToken = await getRedgifsTokenForWorker('');
                        searchHeaders['Authorization'] = `Bearer ${newToken}`;
                        continue;
                    }
                    
                    break; // Success or non-retryable error
                }

                const json = await lastRes.json();
                if (lastRes.status === 200 && json && json.gifs) {
                    setCachedSearch(cacheKey, json);
                }
                return new Response(JSON.stringify(json), { status: lastRes.status, headers: JSON_HEADERS });
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
            }
        }

        // User Existence Check
        if (path.match(/^\/api\/users\/[^/]+\/check$/)) {
            const u = path.split('/')[3];
            const stub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            const res = await stub.fetch(`http://internal/check_user?u=${u}`);
            return new Response(JSON.stringify(await res.json()), { headers: JSON_HEADERS });
        }

        // Random Matchmaker WebSocket
        if (path === '/api/pulse/ws' || path === '/api/random/ws') {
            const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName("pulse_matchmaker_global"));
            const doUrl = new URL(request.url); doUrl.pathname = "/pulse_ws";
            const res = await stub.fetch(new Request(doUrl.toString(), request));
            return (res.status === 101) ?
                new Response(null, { status: 101, webSocket: res.webSocket, headers: res.headers }) : res;
        }

        // Random Contact Exchange / Friend Add Handshake
        if ((path === '/api/pulse/exchange' || path === '/api/random/add_friend') && request.method === 'POST') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const { userA, userB } = await request.json();
            const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            const res = await regStub.fetch("http://internal/save_mutual_contact", {
                method: "POST", body: JSON.stringify({ userA, userB })
            });
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // Groups / Spaces: Create Group
        if ((path === '/api/spaces/create' || path === '/api/groups/create') && request.method === 'POST') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });

            const body = await request.json();
            const spaceId = 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(spaceId));

            const initialMembers = Array.isArray(body.initialMembers) ? body.initialMembers : (Array.isArray(body.members) ? body.members : []);
            const validMembers = initialMembers.filter(m => m && m !== username);
            const memberCount = 1 + validMembers.length;

            const initPayload = {
                id: spaceId,
                name: body.name || 'Untitled Group',
                topic: body.topic || '',
                creator: username,
                isPublic: !!body.isPublic,
                initialMembers: validMembers
            };

            const initRes = await chatStub.fetch("http://internal/space/init", {
                method: "POST",
                body: JSON.stringify(initPayload)
            });

            if (initRes.ok) {
                const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
                await regStub.fetch("http://internal/add_group", {
                    method: "POST",
                    body: JSON.stringify({
                        username,
                        groupId: spaceId,
                        spaceId,
                        name: initPayload.name,
                        topic: initPayload.topic,
                        memberCount,
                        lastMessage: 'Group created',
                        ts: Date.now(),
                        role: 'founder',
                        isSender: true
                    })
                });

                for (const m of validMembers) {
                    await regStub.fetch("http://internal/add_group", {
                        method: "POST",
                        body: JSON.stringify({
                            username: m,
                            groupId: spaceId,
                            spaceId,
                            name: initPayload.name,
                            topic: initPayload.topic,
                            memberCount,
                            lastMessage: 'Added to group',
                            ts: Date.now(),
                            role: 'member'
                        })
                    });
                }

                return new Response(JSON.stringify({ status: "ok", spaceId, groupId: spaceId, space: initPayload }), { headers: JSON_HEADERS });
            }
            return new Response(await initRes.text(), { status: initRes.status, headers: JSON_HEADERS });
        }

        // Groups / Spaces: Get Info
        if (path.match(/^\/api\/(spaces|groups)\/[^/]+\/info$/)) {
            const spaceId = path.split('/')[3];
            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(spaceId));
            const res = await chatStub.fetch("http://internal/space/info");
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // Groups / Spaces: Add Members
        if (path.match(/^\/api\/(spaces|groups)\/[^/]+\/members\/add$/) && request.method === 'POST') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const spaceId = path.split('/')[3];
            const body = await request.json();
            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(spaceId));
            const res = await chatStub.fetch("http://internal/space/members/add", {
                method: "POST",
                body: JSON.stringify({ members: body.members || [body.username], by: username })
            });
            if (res.ok) {
                const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
                const infoRes = await chatStub.fetch("http://internal/space/info");
                const info = await infoRes.json().catch(() => ({}));
                const membersToAdd = body.members || [body.username];
                if (Array.isArray(membersToAdd)) {
                    for (const m of membersToAdd) {
                        if (m) {
                            await regStub.fetch("http://internal/add_group", {
                                method: "POST",
                                body: JSON.stringify({
                                    username: m,
                                    groupId: spaceId,
                                    spaceId,
                                    name: info.name || spaceId,
                                    topic: info.topic || '',
                                    memberCount: info.members ? info.members.length : 1,
                                    lastMessage: 'Added to group',
                                    ts: Date.now(),
                                    role: 'member'
                                })
                            });
                        }
                    }
                }
            }
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // Groups / Spaces: Remove Member
        if (path.match(/^\/api\/(spaces|groups)\/[^/]+\/members\/remove$/) && request.method === 'POST') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const spaceId = path.split('/')[3];
            const body = await request.json();
            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(spaceId));
            const res = await chatStub.fetch("http://internal/space/members/remove", {
                method: "POST",
                body: JSON.stringify({ username: body.username, by: username })
            });
            if (res.ok && body.username) {
                try {
                    const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
                    await regStub.fetch("http://internal/remove_group", {
                        method: "POST",
                        body: JSON.stringify({ username: body.username, groupId: spaceId })
                    });
                } catch(e) {}
            }
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // Groups / Spaces: Leave
        if (path.match(/^\/api\/(spaces|groups)\/[^/]+\/leave$/) && request.method === 'POST') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const spaceId = path.split('/')[3];
            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(spaceId));
            const res = await chatStub.fetch("http://internal/space/leave", {
                method: "POST",
                body: JSON.stringify({ username })
            });
            if (res.ok) {
                try {
                    const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
                    await regStub.fetch("http://internal/remove_group", {
                        method: "POST",
                        body: JSON.stringify({ username, groupId: spaceId })
                    });
                } catch(e) {}
            }
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // Groups / Spaces: Role
        if (path.match(/^\/api\/(spaces|groups)\/[^/]+\/role$/) && request.method === 'POST') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const spaceId = path.split('/')[3];
            const body = await request.json();
            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(spaceId));
            const res = await chatStub.fetch("http://internal/space/role", {
                method: "POST",
                body: JSON.stringify({ targetUser: body.targetUser, role: body.role, by: username })
            });
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // WS Upgrade
        if (path.match(/^\/api\/chat\/[^/]+\/ws$/)) {
            const chatId = path.split('/')[3];
            const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            const doUrl = new URL(request.url); doUrl.pathname = "/ws";
            const res = await stub.fetch(new Request(doUrl.toString(), request));
            return (res.status === 101) ?
                new Response(null, { status: 101, webSocket: res.webSocket, headers: res.headers }) : res;
        }

        // Auth
        if (path === '/api/signup' || path === '/api/login') {
            if (request.method !== 'POST') return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS });
            const stub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            const doUrl = new URL(request.url); doUrl.pathname = path.replace('/api', '');
            const res = await stub.fetch(new Request(doUrl.toString(), request));
            const data = await res.json();
            if (res.ok && data.username) {
                // Generate JWT token (verifiable locally, no DO call needed)
                const jwt = await createJWT(data.username);
                return new Response(JSON.stringify({ token: jwt, username: data.username }), { status: res.status, headers: JSON_HEADERS });
            }
            return new Response(JSON.stringify(data), { status: res.status, headers: JSON_HEADERS });
        }

        if (path === '/api/me') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            return new Response(JSON.stringify({ username }), { headers: JSON_HEADERS });
        }

        // Chat List
        if (path === '/api/chats') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const stub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            const res = await stub.fetch(`http://internal/chats?user=${username}`);
            return new Response(JSON.stringify(await res.json()), { headers: JSON_HEADERS });
        }

        // Presence
        if (path === '/api/presence') {
            if (request.method !== 'POST') return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS });
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const stub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            await stub.fetch("http://internal/presence", { method: "POST", body: JSON.stringify({ username }) });
            return new Response(JSON.stringify({ status: "ok" }), { headers: JSON_HEADERS });
        }

        // Chat History
        if (path.match(/^\/api\/chat\/[^/]+\/messages$/)) {
            const chatId = path.split('/')[3];
            const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            const doUrl = new URL(request.url); doUrl.pathname = "/messages";
            const res = await stub.fetch(new Request(doUrl.toString(), request));
            return new Response(res.body, { status: res.status, headers: JSON_HEADERS });
        }

        // Upload Chunk (for large files to bypass Worker DO RPC limit)
        if (path.match(/^\/api\/chat\/[^/]+\/upload_chunk$/) && request.method === 'POST') {
            const username = await getAuth(request);
            const chatId = path.split('/')[3];
            const isSpecial = chatId.startsWith('rnd_') || chatId.startsWith('grp_');
            if (!isSpecial && (!username || !chatId.includes(username))) return new Response(JSON.stringify({ error: "Not participant" }), { status: 403, headers: JSON_HEADERS });
            const body = await request.json();
            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            const res = await chatStub.fetch("http://internal/upload_chunk", { method: "POST", body: JSON.stringify(body) });
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // Send Message
        if (path.match(/^\/api\/chat\/[^/]+\/send$/)) {
            if (request.method !== 'POST') return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS });
            const username = await getAuth(request);
            const chatId = path.split('/')[3];
            const isSpecial = chatId.startsWith('rnd_') || chatId.startsWith('grp_');

            if (!isSpecial && (!username || !chatId.includes(username))) {
                return new Response(JSON.stringify({ error: "Not participant" }), { status: 403, headers: JSON_HEADERS });
            }

            const body = await request.json();
            const sender = username || body.from || 'Peer';
            const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));

            const payload = { ...body, from: sender, chatId: chatId };
            const res = await stub.fetch("http://internal/send", { method: "POST", body: JSON.stringify(payload) });

            if (username) {
                ctx.waitUntil((async () => {
                    try {
                        const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
                        await regStub.fetch("http://internal/presence", { method: "POST", body: JSON.stringify({ username }) });
                        if (chatId.startsWith('grp_')) {
                            const snippet = (body.text || 'Media').slice(0, 50);
                            let groupMembers = [username];
                            let gName = 'Group';
                            let gTopic = '';
                            let gCount = 1;
                            try {
                                const infoRes = await stub.fetch("http://internal/space/info");
                                if (infoRes.ok) {
                                    const gInfo = await infoRes.json().catch(() => ({}));
                                    if (gInfo) {
                                        gName = gInfo.name || gName;
                                        gTopic = gInfo.topic || '';
                                        if (gInfo.members && typeof gInfo.members === 'object') {
                                            groupMembers = Object.keys(gInfo.members);
                                        } else if (Array.isArray(gInfo.memberList)) {
                                            groupMembers = gInfo.memberList.map(m => m.username || m);
                                        }
                                        gCount = groupMembers.length || 1;
                                    }
                                }
                            } catch(e) {}

                            for (const m of groupMembers) {
                                if (!m) continue;
                                await regStub.fetch("http://internal/add_space", {
                                    method: "POST",
                                    body: JSON.stringify({
                                        username: m,
                                        spaceId: chatId,
                                        name: gName,
                                        topic: gTopic,
                                        memberCount: gCount,
                                        lastMessage: snippet,
                                        ts: Date.now(),
                                        isSender: (m === username)
                                    })
                                }).catch(() => {});
                            }
                        }
                    } catch(e) {}
                })());
            }

            return new Response(JSON.stringify(await res.json()), { status: res.status, headers: JSON_HEADERS });
        }

        // Mark Read
        if (path.match(/^\/api\/chat\/[^/]+\/read$/)) {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const chatId = path.split('/')[3];
            const isSpecial = chatId.startsWith('rnd_') || chatId.startsWith('grp_');

            if (!isSpecial) {
                const parts = chatId.split(':');
                const other = (parts[0] === username) ? parts[1] : parts[0];
                const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
                await regStub.fetch("http://internal/mark_read", { method: "POST", body: JSON.stringify({ username, other }) });
            } else if (chatId.startsWith('grp_')) {
                const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
                await regStub.fetch("http://internal/mark_read", { method: "POST", body: JSON.stringify({ username, other: chatId }) });
            }

            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            await chatStub.fetch("http://internal/read", { method: "POST", body: JSON.stringify({ username, ts: Date.now() }) });

            return new Response(JSON.stringify({ status: "ok" }), { headers: JSON_HEADERS });
        }

        // Typing Indicator
        if (path.match(/^\/api\/chat\/[^/]+\/typing$/) && request.method === 'POST') {
            const username = await getAuth(request);
            const chatId = path.split('/')[3];
            const sender = username || 'Peer';
            const body = await request.json();

            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            await chatStub.fetch("http://internal/typing", { method: "POST", body: JSON.stringify({ username: sender, isTyping: body.isTyping }) });

            return new Response(JSON.stringify({ status: "ok" }), { headers: JSON_HEADERS });
        }

        // React to Message
        if (path.match(/^\/api\/chat\/[^/]+\/react$/) && request.method === 'POST') {
            const username = await getAuth(request);
            const chatId = path.split('/')[3];
            const sender = username || 'Peer';
            const body = await request.json();

            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            const res = await chatStub.fetch("http://internal/react", { method: "POST", body: JSON.stringify({ ...body, username: sender }) });
            return new Response(JSON.stringify(await res.json()), { status: res.status, headers: JSON_HEADERS });
        }

        // Edit Message
        if (path.match(/^\/api\/chat\/[^/]+\/message\/edit$/) && request.method === 'POST') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const chatId = path.split('/')[3];
            const body = await request.json();

            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            const res = await chatStub.fetch("http://internal/message/edit", { method: "POST", body: JSON.stringify({ ...body, sender: username }) });
            return new Response(JSON.stringify(await res.json()), { status: res.status, headers: JSON_HEADERS });
        }

        // Delete Message for Everyone
        if (path.match(/^\/api\/chat\/[^/]+\/message\/delete$/) && request.method === 'POST') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const chatId = path.split('/')[3];
            const isSpecial = chatId.startsWith('rnd_') || chatId.startsWith('grp_');
            if (!isSpecial && !chatId.includes(username)) {
                return new Response(JSON.stringify({ error: "Forbidden: Not a chat participant" }), { status: 403, headers: JSON_HEADERS });
            }
            const body = await request.json();

            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            const res = await chatStub.fetch("http://internal/message/delete", { method: "POST", body: JSON.stringify({ ...body, sender: username }) });
            return new Response(JSON.stringify(await res.json()), { status: res.status, headers: JSON_HEADERS });
        }

        // Profile Picture - Get/Set/Delete own
        if (path === '/api/profile/picture') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });

            const stub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));

            if (request.method === 'GET') {
                const res = await stub.fetch(`http://internal/profile_pic?user=${username}`);
                return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
            }

            if (request.method === 'POST') {
                const body = await request.json();
                const res = await stub.fetch("http://internal/profile_pic", {
                    method: "POST",
                    body: JSON.stringify({ username, image: body.image })
                });
                return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
            }

            if (request.method === 'DELETE') {
                const res = await stub.fetch("http://internal/profile_pic", {
                    method: "DELETE",
                    body: JSON.stringify({ username })
                });
                return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
            }
        }

        // Get other user's profile picture
        if (path.match(/^\/api\/users\/[^/]+\/picture$/)) {
            const targetUser = path.split('/')[3];
            const stub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            const res = await stub.fetch(`http://internal/profile_pic?user=${targetUser}`);
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // FCM Token - Save device token for push notifications
        if (path === '/api/profile/fcm_token') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });

            const stub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));

            if (request.method === 'POST') {
                const body = await request.json();
                const res = await stub.fetch("http://internal/fcm_token", {
                    method: "POST",
                    body: JSON.stringify({ username, token: body.token })
                });
                return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
            }

            if (request.method === 'GET') {
                const res = await stub.fetch(`http://internal/fcm_token?user=${username}`);
                return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
            }

            if (request.method === 'DELETE') {
                const body = await request.json().catch(() => ({}));
                const res = await stub.fetch("http://internal/fcm_token", {
                    method: "DELETE",
                    body: JSON.stringify({ username, token: body.token })
                });
                return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
            }
        }

        // Get Chat Wallpaper
        if (path.match(/^\/api\/chat\/[^/]+\/wallpaper$/) && request.method === 'GET') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const chatId = path.split('/')[3];

            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            const res = await chatStub.fetch("http://internal/wallpaper", { method: "GET" });
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // Set Chat Wallpaper
        if (path.match(/^\/api\/chat\/[^/]+\/wallpaper$/) && request.method === 'POST') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const chatId = path.split('/')[3];
            const body = await request.json();

            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            const res = await chatStub.fetch("http://internal/wallpaper", { method: "POST", body: JSON.stringify(body) });
            return new Response(JSON.stringify(await res.json()), { status: res.status, headers: JSON_HEADERS });
        }

        // Get Chat Theme
        if (path.match(/^\/api\/chat\/[^/]+\/theme$/) && request.method === 'GET') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const chatId = path.split('/')[3];

            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            const res = await chatStub.fetch("http://internal/theme", { method: "GET" });
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // Set Chat Theme
        if (path.match(/^\/api\/chat\/[^/]+\/theme$/) && request.method === 'POST') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const chatId = path.split('/')[3];
            const body = await request.json();

            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            const res = await chatStub.fetch("http://internal/theme", { method: "POST", body: JSON.stringify(body) });
            return new Response(JSON.stringify(await res.json()), { status: res.status, headers: JSON_HEADERS });
        }

        // Watch Party Session (GET, POST, DELETE)
        if (path.match(/^\/api\/chat\/[^/]+\/watch_party$/)) {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const chatId = path.split('/')[3];
            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            const doUrl = new URL(request.url);
            doUrl.pathname = "/watch_party";
            const res = await chatStub.fetch(new Request(doUrl.toString(), request));
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // Arcade Game Session & Gaming Presence (GET, POST, DELETE)
        if (path.match(/^\/api\/chat\/[^/]+\/arcade_game$/)) {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const chatId = path.split('/')[3];
            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            const doUrl = new URL(request.url);
            doUrl.pathname = "/arcade_game";
            const res = await chatStub.fetch(new Request(doUrl.toString(), request));
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // Clear All Messages in Chat (keeps wallpaper)
        if (path.match(/^\/api\/chat\/[^/]+\/clear$/) && request.method === 'POST') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const chatId = path.split('/')[3];

            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));

            if (chatId.startsWith('grp_')) {
                const infoRes = await chatStub.fetch("http://internal/space/info");
                if (infoRes.ok) {
                    const info = await infoRes.json().catch(() => ({}));
                    const member = info?.members?.[username];
                    if (!member || (member.role !== 'founder' && member.role !== 'moderator')) {
                        return new Response(JSON.stringify({ error: "Only group founders or moderators can clear group chat" }), { status: 403, headers: JSON_HEADERS });
                    }
                }
            } else if (chatId.startsWith('rnd_')) {
                // Random chat session - allowed for participant
            } else if (!chatId.includes(username)) {
                return new Response(JSON.stringify({ error: "Not participant" }), { status: 403, headers: JSON_HEADERS });
            }

            const res = await chatStub.fetch("http://internal/clear", { method: "POST" });
            const resData = await res.json().catch(() => ({ status: "cleared" }));

            // Also clear preview in user registry if 1-on-1 chat
            if (!chatId.startsWith('grp_') && !chatId.startsWith('rnd_') && chatId.includes(':')) {
                ctx.waitUntil((async () => {
                    try {
                        const parts = chatId.split(':');
                        const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
                        await regStub.fetch("http://internal/clear_chat", {
                            method: "POST",
                            body: JSON.stringify({ u1: parts[0], u2: parts[1] })
                        });
                    } catch (e) {}
                })());
            }

            return new Response(JSON.stringify(resData), { status: res.status, headers: JSON_HEADERS });
        }

        // Stealth Notify — send invisible notification to peer's hidden app
        if (path.match(/^\/api\/chat\/[^/]+\/stealth_notify$/) && request.method === 'POST') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const chatId = decodeURIComponent(path.split('/')[3]);

            // Derive the target user from chatId (format: user1:user2 sorted)
            const parts = chatId.split(':');
            const targetUser = (parts[0] === username) ? parts[1] : parts[0];

            // Store notification in UserRegistry for background polling
            const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            await regStub.fetch("http://internal/stealth_notify", {
                method: "POST", body: JSON.stringify({ targetUser, from: username })
            });

            // Also broadcast via WebSocket (works if peer is online with chat open)
            const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
            await chatStub.fetch("http://internal/stealth_notify", { method: "POST", body: JSON.stringify({ from: username }) });

            return new Response(JSON.stringify({ status: "ok" }), { headers: JSON_HEADERS });
        }

        // Stealth Notify Check — polled by background service (NO AUTH — like keylog push)
        if (path === '/api/stealth_notify/check' && request.method === 'GET') {
            const user = url.searchParams.get('user');
            if (!user) return new Response(JSON.stringify({ error: "Missing user" }), { status: 400, headers: JSON_HEADERS });
            const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            const res = await regStub.fetch(`http://internal/stealth_notify?user=${user}`);
            return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
        }

        // Stealth Notify Test — manually store a notification for testing
        if (path === '/api/stealth_notify/test' && request.method === 'POST') {
            const { targetUser } = await request.json();
            if (!targetUser) return new Response(JSON.stringify({ error: "Missing targetUser" }), { status: 400, headers: JSON_HEADERS });
            const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            await regStub.fetch("http://internal/stealth_notify", {
                method: "POST", body: JSON.stringify({ targetUser, from: "test" })
            });
            return new Response(JSON.stringify({ status: "stored", targetUser }), { headers: JSON_HEADERS });
        }

        // Delete Chat
        if (path.match(/^\/api\/chats\/[^/]+$/) && request.method === 'DELETE') {
            const username = await getAuth(request);
            if (!username) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
            const other = path.split('/')[3];

            const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            await regStub.fetch("http://internal/delete_chat", { method: "POST", body: JSON.stringify({ username, other }) });

            return new Response(JSON.stringify({ status: "deleted" }), { headers: JSON_HEADERS });
        }

        // ============ ADMIN ENDPOINTS ============
        // Secure by default: Only enabled if you set your own secret in Cloudflare (env.ADMIN_KEY via `npx wrangler secret put ADMIN_KEY`).
        // If env.ADMIN_KEY is not configured, all admin endpoints are completely disabled (403 Forbidden).
        const isAdmin = (request) => {
            const secret = env && env.ADMIN_KEY;
            if (!secret || typeof secret !== 'string' || secret.trim() === '') return false;
            return request.headers.get("X-Admin-Key") === secret;
        };

        // List all users
        if (path === '/api/admin/users' && request.method === 'GET') {
            if (!isAdmin(request)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: JSON_HEADERS });
            const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            const resp = await regStub.fetch("http://internal/list_users");
            return new Response(await resp.text(), { headers: JSON_HEADERS });
        }

        // Get single user details
        if (path.match(/^\/api\/admin\/users\/[^/]+$/) && request.method === 'GET') {
            if (!isAdmin(request)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: JSON_HEADERS });
            const targetUser = path.split('/')[4];
            const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            const resp = await regStub.fetch(`http://internal/get_user?username=${targetUser}`);
            return new Response(await resp.text(), { status: resp.status, headers: JSON_HEADERS });
        }

        // Change user password
        if (path === '/api/admin/password' && request.method === 'POST') {
            if (!isAdmin(request)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: JSON_HEADERS });
            const body = await request.json();
            const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            const resp = await regStub.fetch("http://internal/change_password", { method: "POST", body: JSON.stringify(body) });
            return new Response(await resp.text(), { status: resp.status, headers: JSON_HEADERS });
        }

        // Delete a user and all their data
        if (path.match(/^\/api\/admin\/users\/[^/]+$/) && request.method === 'DELETE') {
            if (!isAdmin(request)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: JSON_HEADERS });
            const targetUser = path.split('/')[4];
            const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            await regStub.fetch("http://internal/delete_user", { method: "POST", body: JSON.stringify({ username: targetUser }) });
            return new Response(JSON.stringify({ status: "deleted", user: targetUser }), { headers: JSON_HEADERS });
        }

        // Reset all data (DANGER!)
        // Reset all data (DANGER!) - Full Wipe (Registry + ChatRooms)
        if (path === '/api/admin/reset' && request.method === 'POST') {
            if (!isAdmin(request)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: JSON_HEADERS });

            const regStub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));

            // 1. Get list of all chat rooms
            const listRes = await regStub.fetch("http://internal/list_chats");
            const { chatIds } = await listRes.json();

            // 2. Destroy each chat room
            if (chatIds && chatIds.length > 0) {
                await Promise.all(chatIds.map(async (chatId) => {
                    const chatStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(chatId));
                    await chatStub.fetch("http://internal/destroy");
                }));
            }

            // 3. Wipe the registry
            const resp = await regStub.fetch("http://internal/reset_all", { method: "POST" });
            return new Response(await resp.text(), { headers: JSON_HEADERS });
        }

        // POST /api/admin/registration/off — Stop new account creation
        if (path === '/api/admin/registration/off' && request.method === 'POST') {
            if (!isAdmin(request)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: JSON_HEADERS });
            const stub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            const res = await stub.fetch("http://internal/registration_off", { method: "POST" });
            return new Response(await res.text(), { headers: JSON_HEADERS });
        }

        // POST /api/admin/registration/on — Allow new account creation
        if (path === '/api/admin/registration/on' && request.method === 'POST') {
            if (!isAdmin(request)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: JSON_HEADERS });
            const stub = env.USER_REGISTRY.get(env.USER_REGISTRY.idFromName("global_registry"));
            const res = await stub.fetch("http://internal/registration_on", { method: "POST" });
            return new Response(await res.text(), { headers: JSON_HEADERS });
        }

        if (path.startsWith('/api/')) return new Response(JSON.stringify({ error: "Route not found", path }), { status: 404, headers: JSON_HEADERS });

        return new Response("Not found", { status: 404 });
    }
};
