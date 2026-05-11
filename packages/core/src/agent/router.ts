/**
 * Re-export shim — delegates to @agw/agent-core.
 */
import { setRouterLogger } from '@agw/agent-core';
import { createModuleLogger } from '../observability/logger.js';

// Wire the core logger into the agent-core router module
const log = createModuleLogger('llm');
setRouterLogger(log as any);

export {
  classifyByRules,
  classifyByLLM,
  stripModelOverride,
  routeModel,
  setRouterLogger,
} from '@agw/agent-core';
export type { RoutingTier, RoutingResult } from '@agw/agent-core';
