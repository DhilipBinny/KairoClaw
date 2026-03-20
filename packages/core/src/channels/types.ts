/**
 * Channel abstraction types.
 *
 * An `AgentRunner` wraps the agent loop with session resolution and
 * context setup so that channels don't need to know those details.
 * Each channel implements the `Channel` interface for lifecycle control.
 */

import type { InboundMessage, AgentResult, AgentCallbacks } from '@agw/types';

/** Callback-enabled agent invocation function provided to channels. */
export type AgentRunner = (
  inbound: InboundMessage,
  callbacks?: AgentCallbacks,
) => Promise<AgentResult>;

/** Lifecycle interface for a message channel (Telegram, WebSocket, etc.). */
export interface Channel {
  /** Human-readable channel name. */
  name: string;
  /** Start the channel, using the provided runner for agent calls. */
  start(runner: AgentRunner): Promise<void>;
  /** Gracefully shut down the channel. */
  stop(): Promise<void>;
}
