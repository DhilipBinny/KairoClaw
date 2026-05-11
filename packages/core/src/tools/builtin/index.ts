// Generic tools — re-exported from @agw/tools-common
import {
  fileTools,
  execTools,
  webTools,
  memoryTools,
  memoryWriteTools,
  emailTools,
  pdfTools,
  toolSearchTools,
  grepTools,
  globTools,
  todoTools,
  sleepTools,
  applyPatchTools,
  planModeTools,
  commonTools,
} from '@agw/tools-common';

// Product-specific tools — stay in core
import { messagingTools } from './messaging.js';
import { pluginTools } from './plugins.js';
import { subagentTools } from './subagent.js';
import { browseTools } from './browse.js';
import type { ToolRegistration } from '@agw/tool-platform';

export const builtinTools: ToolRegistration[] = [
  ...commonTools,
  ...messagingTools,
  ...pluginTools,
  ...subagentTools,
  ...browseTools,
];

// Re-exports for backward compatibility
export {
  fileTools,
  execTools,
  webTools,
  memoryTools,
  memoryWriteTools,
  emailTools,
  pdfTools,
  toolSearchTools,
  grepTools,
  globTools,
  todoTools,
  sleepTools,
  applyPatchTools,
  planModeTools,
} from '@agw/tools-common';
export { setMemorySystem } from '@agw/tools-common';
export { safePath } from '@agw/tools-common';
export { messagingTools } from './messaging.js';
export { pluginTools } from './plugins.js';
export { subagentTools } from './subagent.js';
export { browseTools } from './browse.js';
