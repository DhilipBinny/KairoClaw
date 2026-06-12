/**
 * Security principal resolution for an inbound turn.
 *
 * Centralises the decision of *what permissions a turn runs with* so it can be
 * unit-tested in isolation and reused consistently for both tool-loading
 * (which tools are offered) and tool-execution (which tools are permitted).
 */

export interface ResolvedUserRow {
  id: string;
  role: string;
  elevated: number | boolean;
}

export interface Principal {
  id: string;
  role: string;
  elevated: boolean;
}

/**
 * Channels that originate from the system itself rather than a human on a
 * messaging surface. A user-owned cron is dispatched on the `internal` channel
 * carrying its owner's user id; a system-owned cron uses `cron` with no
 * specific user.
 */
const SYSTEM_CHANNELS = new Set(['cron', 'internal', 'heartbeat']);

/**
 * Decide the security principal for a turn.
 *
 * SECURITY (issue #179 — cron privilege escalation):
 * System channels default to a system-admin principal ONLY when no *specific*
 * user is claimed. A user-owned cron carries its owner's id; if that owner no
 * longer resolves to an active account (deactivated or deleted), this function
 * returns `null` so the caller can REFUSE the turn. It must never fall through
 * to the system-admin principal, which would let a deactivated user's stored
 * prompt execute with full elevated privileges.
 *
 * Note the ordering: a `resolvedUser` always wins, so an active user-owned cron
 * runs as its owner. Only an *unresolved* specific claim on a system channel is
 * refused. Unauthenticated senders on real messaging channels (e.g. an unlinked
 * Telegram user) are NOT refused — they degrade to a restricted anonymous user.
 *
 * @param channel        the inbound channel
 * @param claimedUserId  the user id asserted by the inbound message, if any
 * @param resolvedUser   the active user row that `claimedUserId` resolved to, if any
 * @returns the resolved {@link Principal}, or `null` when the turn must be refused.
 */
export function resolvePrincipal(
  channel: string,
  claimedUserId: string | undefined,
  resolvedUser: ResolvedUserRow | undefined,
): Principal | null {
  if (resolvedUser) {
    return { id: resolvedUser.id, role: resolvedUser.role, elevated: !!resolvedUser.elevated };
  }

  const claimedSpecificUser = !!claimedUserId && claimedUserId !== 'system';
  const systemChannel = SYSTEM_CHANNELS.has(channel);

  if (systemChannel) {
    if (claimedSpecificUser) {
      // A specific owner was claimed but did not resolve to an active user.
      // Refuse rather than escalate to system admin.
      return null;
    }
    return { id: 'system', role: 'admin', elevated: true };
  }

  // Real channel sender with no linked account → restricted anonymous user.
  return { id: 'anonymous', role: 'user', elevated: false };
}
