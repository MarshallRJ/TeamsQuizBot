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
function createGraphClient({ tokenProvider, fetchImpl = fetch, baseUrl = DEFAULT_BASE }) {
  let selfId = null;

  async function request(method, path, body) {
    const token = await tokenProvider.getToken();
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
     * Return messages in a chat created strictly after `sinceIso`, excluding
     * messages sent by the signed-in user (the bot). Oldest first.
     */
    async getMessagesSince(chatId, sinceIso) {
      const meId = await getSelfId();
      const data = await request('GET', `/chats/${chatId}/messages?$top=50`);
      const messages = (data.value || [])
        .filter((m) => m.createdDateTime && (!sinceIso || m.createdDateTime > sinceIso))
        .filter((m) => !(m.from && m.from.user && m.from.user.id === meId))
        .map((m) => ({
          id: m.id,
          createdDateTime: m.createdDateTime,
          fromUserId: m.from && m.from.user ? m.from.user.id : null,
          text: htmlToText(m.body && m.body.content),
        }))
        .sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime));
      return messages;
    },
  };
}

module.exports = { createGraphClient, htmlToText };
