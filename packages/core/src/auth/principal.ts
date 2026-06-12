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
 * Channels dispatched by the system itself (scheduler/heartbeat) with no human
 * owner. These — and ONLY these — may run as the system-admin principal.
 * A system-owned cron is dispatched here with no specific user (or the
 * placeholder `'system'`).
 */
const SYSTEM_ADMIN_CHANNELS = new Set(['cron', 'heartbeat']);

/**
 * Channels that always represent a *user-owned* turn and therefore MUST resolve
 * to a real active user. A user-owned cron is dispatched on `internal` carrying
 * its owner's user id. Crucially, `internal` is NOT a system-admin channel:
 * if its owner does not resolve (deactivated, deleted, or a forged `'system'`
 * claim) the turn is refused — never escalated.
 */
const USER_OWNED_CHANNELS = new Set(['internal']);

/**
 * Decide the security principal for a turn.
 *
 * SECURITY (issue #179 — cron privilege escalation):
 * A resolved active user always wins, so an active user-owned cron runs as its
 * owner. Otherwise:
 *  - `cron`/`heartbeat` (genuine system dispatch) → system admin, UNLESS a
 *    *specific* real user was claimed but failed to resolve → refuse.
 *  - `internal` (user-owned cron) → MUST have resolved to a real user above;
 *    any unresolved case (deactivated owner, or a forged `'system'`/other
 *    ownership claim injected via the cron-update route) → refuse. This channel
 *    can never yield the system-admin principal.
 *  - real messaging channels with an unlinked sender → restricted anonymous
 *    user (NOT refused).
 *
 * Returns `null` whenever the turn must be refused; the caller throws so no
 * tools execute.
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

  if (SYSTEM_ADMIN_CHANNELS.has(channel)) {
    if (claimedSpecificUser) {
      // A specific owner was claimed but did not resolve to an active user.
      // Refuse rather than escalate to system admin.
      return null;
    }
    return { id: 'system', role: 'admin', elevated: true };
  }

  if (USER_OWNED_CHANNELS.has(channel)) {
    // Owner must have resolved above. An unresolved user-owned turn — including
    // a forged `'system'` claim — is refused, never escalated.
    return null;
  }

  // Real channel sender with no linked account → restricted anonymous user.
  return { id: 'anonymous', role: 'user', elevated: false };
}
