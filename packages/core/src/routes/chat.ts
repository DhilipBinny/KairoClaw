/**
 * Chat route registration.
 *
 * Wires up the REST chat endpoints under /api/v1.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { ChatApiOptions } from '../channels/api.js';
import { registerChatRoutes } from '../channels/api.js';

export interface ChatRoutesOptions {
  runner: ChatApiOptions['runner'];
}

export const chatRoutes: FastifyPluginAsync<ChatRoutesOptions> = async (app, opts) => {
  await app.register(registerChatRoutes, { runner: opts.runner });
};
