'use strict';

const DEFAULT_BASE = 'https://graph.microsoft.com/v1.0';

/** Strip HTML tags and collapse whitespace from a Teams message body. */
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>(?=)/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Microsoft Graph client. This is the single seam that talks to the network;
 * unit tests replace this whole object with a fake exposing the same methods.
 *
 * @param {object}   opts
 * @param {object}   opts.tokenProvider  { getToken(): Promise<string> }
 * @param {Function} [opts.fetchImpl]     defaults to global fetch
 * @param {string}   [opts.baseUrl]
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createGraphClient({
  tokenProvider,
  fetchImpl = fetch,
  baseUrl = DEFAULT_BASE,
  maxRetries = 4,
}) {
  let selfId = null;

  async function request(method, path, body, attempt = 0) {
    const token = await tokenProvider.getToken();
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // Graph throttles bursts (429) and has transient 5xx. Back off and retry,
    // honouring Retry-After when present. This is essential at 70+ participants.
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const header = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
      const waitS = Number(header) || Math.min(2 ** attempt, 30);
      await sleep(waitS * 1000);
      return request(method, path, body, attempt + 1);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Graph ${method} ${path} failed: ${res.status} ${detail}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function getSelfId() {
    if (selfId) return selfId;
    const me = await request('GET', '/me?$select=id');
    selfId = me.id;
    return selfId;
  }

  return {
    /**
     * Create (or get) a 1:1 chat between the signed-in user and a target user,
     * identified by their sign-in address (UPN/email). Graph resolves the member
     * from the bind reference, so no directory-read permission is required — the
     * email in the participant list must be the user's actual sign-in address.
     */
    async ensureOneOnOneChat(targetEmail) {
      const meId = await getSelfId();
      const bind = (idOrUpn) => `${baseUrl}/users('${idOrUpn}')`;
      const chat = await request('POST', '/chats', {
        chatType: 'oneOnOne',
        members: [
          {
            '@odata.type': '#microsoft.graph.aadUserConversationMember',
            roles: ['owner'],
            'user@odata.bind': bind(meId),
          },
          {
            '@odata.type': '#microsoft.graph.aadUserConversationMember',
            roles: ['owner'],
            'user@odata.bind': bind(targetEmail),
          },
        ],
      });
      return chat.id;
    },

    /**
     * Send an HTML message to a chat. Returns the created message's id and
     * server-assigned createdDateTime — the latter is used as a reply watermark
     * so we compare against Graph's own clock, never the bot's local clock.
     */
    async sendMessage(chatId, html) {
      const msg = await request('POST', `/chats/${chatId}/messages`, {
        body: { contentType: 'html', content: html },
      });
      return { id: msg.id, createdDateTime: msg.createdDateTime };
    },

    /**
     * Fetch the latest reply across ALL of the signed-in user's chats in a single
     * (paginated) sweep, rather than polling each chat separately. Uses
     * `/me/chats?$expand=lastMessagePreview` — delegated Chat.Read, unlike
     * getAllMessages which is app-only/protected and 412s in a delegated context.
     *
     * Returns one message per chat (its last), each tagged with `chatId` for
     * routing, keeping only genuine human replies newer than `sinceIso`. Excludes
     * the bot's own messages and system/event messages ("members added", etc.),
     * which are not `messageType: 'message'` and must never look like an answer.
     */
    async getAllMessagesSince(sinceIso) {
      const meId = await getSelfId();
      let path = '/me/chats?$expand=lastMessagePreview&$top=50';

      const out = [];
      let guard = 0;
      while (path && guard++ < 200) {
        const data = await request('GET', path);
        for (const chat of data.value || []) {
          const m = chat.lastMessagePreview;
          if (!m) continue;
          if (m.messageType && m.messageType !== 'message') continue;
          if (!(m.from && m.from.user && m.from.user.id) || m.from.user.id === meId) continue;
          if (sinceIso && !(m.createdDateTime > sinceIso)) continue;
          const text = htmlToText(m.body && m.body.content);
          if (!text) continue;
          out.push({
            chatId: chat.id,
            id: m.id,
            createdDateTime: m.createdDateTime,
            fromUserId: m.from.user.id,
            text,
          });
        }
        const next = data['@odata.nextLink'];
        path = next ? next.replace(baseUrl, '') : null;
      }
      return out.sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime));
    },

    /**
     * Fetch a chat's full message history (both sides), oldest first, for
     * auditing. Each message is labelled `kind`: 'bot' (sent by the signed-in
     * quiz account), 'participant', or 'system' (membership/created events).
     */
    async getChatMessages(chatId) {
      const meId = await getSelfId();
      let path = `/chats/${chatId}/messages?$top=50`;
      const out = [];
      let guard = 0;
      while (path && guard++ < 200) {
        const data = await request('GET', path);
        for (const m of data.value || []) {
          const isSystem = m.messageType && m.messageType !== 'message';
          const fromId = m.from && m.from.user ? m.from.user.id : null;
          out.push({
            id: m.id,
            createdDateTime: m.createdDateTime,
            kind: isSystem ? 'system' : fromId === meId ? 'bot' : 'participant',
            text: htmlToText(m.body && m.body.content),
          });
        }
        const next = data['@odata.nextLink'];
        path = next ? next.replace(baseUrl, '') : null;
      }
      return out
        .filter((m) => m.text || m.kind === 'system')
        .sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime));
    },
  };
}

module.exports = { createGraphClient, htmlToText };
