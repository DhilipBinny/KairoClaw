/**
 * System alerting types — alert events, state machine, delivery, and config.
 */

export const ALERT_TYPES = {
  CHANNEL_DISCONNECTED: 'channel.disconnected',
  CHANNEL_AUTH_LOST: 'channel.auth_lost',
  PROVIDER_AUTH_ERROR: 'provider.auth_error',
  PROVIDER_ALL_DOWN: 'provider.all_down',
  CRON_CONSECUTIVE_FAILURES: 'cron.consecutive_failures',
  SYSTEM_TEST: 'system.test',
  SYSTEM_BACKUP_FAILED: 'system.backup_failed',
} as const;

export type AlertType = typeof ALERT_TYPES[keyof typeof ALERT_TYPES];

export type AlertSeverity = 'critical' | 'warning';

export type AlertState = 'inactive' | 'pending' | 'firing' | 'resolved';

export interface AlertEvent {
  type: string;
  severity: AlertSeverity;
  source: string;
  fingerprint: string;
  labels: Record<string, string>;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface AlertInstance {
  fingerprint: string;
  type: string;
  severity: AlertSeverity;
  state: AlertState;
  labels: Record<string, string>;
  title: string;
  message: string;
  failureCount: number;
  successCount: number;
  pendingSince: number | null;
  firedAt: number | null;
  resolvedAt: number | null;
  lastNotifiedAt: number | null;
  lastEventAt: number;
}

export interface AlertTimingConfig {
  groupWaitMs: number;
  cooldownCriticalMs: number;
  cooldownWarningMs: number;
  repeatCriticalMs: number;
  repeatWarningMs: number;
  resolutionDelayMs: number;
}

export interface AlertThresholdsConfig {
  failureThreshold: number;
  recoveryThreshold: number;
}

export interface AlertEventOverride {
  enabled?: boolean;
  severity?: AlertSeverity;
  delivery?: string[];
  failureThreshold?: number;
  recoveryThreshold?: number;
}

export interface AlertsConfig {
  enabled: boolean;
  delivery: {
    telegram: { enabled: boolean; chatIds: string[] };
    whatsapp: { enabled: boolean; jids: string[] };
    websocket: { enabled: boolean };
    webhook: { enabled: boolean; urls: string[]; secret: string };
  };
  timing: AlertTimingConfig;
  thresholds: AlertThresholdsConfig;
  events: Record<string, AlertEventOverride>;
}

export interface AlertDeliveryChannel {
  readonly name: string;
  send(alert: AlertEvent, instance: AlertInstance, kind: 'firing' | 'resolved'): Promise<void>;
}