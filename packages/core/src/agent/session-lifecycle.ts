import type { SessionConfig } from '@agw/types';
import type { SessionRow } from '../db/repositories/session.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/**
 * Returns the current hour (0-23) in the given IANA timezone.
 * Falls back to UTC on invalid timezone.
 */
function nowInTimezone(timezone: string): Date {
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).format(new Date());
    return new Date(formatted);
  } catch {
    return new Date();
  }
}

/**
 * Determines if a session should be expired and replaced with a fresh one.
 *
 * Two independent checks (whichever fires first wins):
 * 1. Idle timeout: session has been inactive longer than idleMinutes (0 = disabled)
 * 2. Daily reset: session's last activity was before the most recent resetHour boundary
 *
 * The resetHour boundary is computed in the configured timezone so that
 * "4 AM reset" means 4 AM in the user's timezone, not the server's.
 */
export function isSessionExpired(
  session: SessionRow,
  sessionConfig: SessionConfig,
  timezone = 'UTC',
): boolean {
  const lastActivity = new Date(session.updated_at).getTime();
  if (Number.isNaN(lastActivity)) return false;

  const now = Date.now();

  if (sessionConfig.idleMinutes > 0) {
    const idleMs = sessionConfig.idleMinutes * MS_PER_MINUTE;
    if (now - lastActivity > idleMs) return true;
  }

  // Compute the most recent resetHour boundary in the configured timezone.
  // E.g. timezone=Asia/Singapore, resetHour=4: if it's 5 AM SGT, the boundary
  // is 4 AM SGT today. If it's 3 AM SGT, the boundary is 4 AM SGT yesterday.
  const tzNow = nowInTimezone(timezone);
  const tzResetToday = new Date(tzNow);
  tzResetToday.setHours(sessionConfig.resetHour, 0, 0, 0);

  const resetBoundary = tzNow >= tzResetToday
    ? tzResetToday.getTime()
    : tzResetToday.getTime() - MS_PER_DAY;

  if (lastActivity < resetBoundary) return true;

  return false;
}
