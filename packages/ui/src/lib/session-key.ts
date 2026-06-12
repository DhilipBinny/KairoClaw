/**
 * Derive the bare session key from a web session's chat_id.
 *
 * Web chat_ids are namespaced by the connected client's identity for per-user
 * isolation (#178): `web:<clientId>:<sessionKey>`. The UI only ever works with
 * the bare `<sessionKey>`. This also tolerates the legacy `web:<sessionKey>`
 * format (no client segment) for sessions created before the fix.
 *
 * `clientId` never contains a colon and `sessionKey` is validated server-side
 * to contain no colon, so the segment after the FIRST colon (post `web:`) is
 * the session key.
 */
export function sessionKeyFromChatId(chatId: string): string {
  if (!chatId || !chatId.startsWith('web:')) return chatId;
  const rest = chatId.slice(4); // strip "web:"
  const colon = rest.indexOf(':');
  return colon >= 0 ? rest.slice(colon + 1) : rest;
}
