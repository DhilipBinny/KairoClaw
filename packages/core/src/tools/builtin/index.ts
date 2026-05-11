import { fileTools } from './files.js';
import { execTools } from './exec.js';
import { webTools } from './web.js';
import { memoryTools } from './memory.js';
import { memoryWriteTools } from './memory-write.js';
import { messagingTools } from './messaging.js';
import { emailTools } from './email.js';
import { pluginTools } from './plugins.js';
import { pdfTools } from './pdf.js';
import { subagentTools } from './subagent.js';
import { browseTools } from './browse.js';
import { toolSearchTools } from './tool-search.js';
import { grepTools } from './grep.js';
import { globTools } from './glob.js';
import { todoTools } from './todo.js';
import { sleepTools } from './sleep.js';
import { applyPatchTools } from './apply-patch.js';
import { planModeTools } from './plan-mode.js';
import type { ToolRegistration } from '@agw/tool-platform';

export const builtinTools: ToolRegistration[] = [
  ...fileTools,
  ...execTools,
  ...webTools,
  ...memoryTools,
  ...memoryWriteTools,
  ...messagingTools,
  ...emailTools,
  ...pluginTools,
  ...pdfTools,
  ...subagentTools,
  ...browseTools,
  ...toolSearchTools,
  ...grepTools,
  ...globTools,
  ...todoTools,
  ...sleepTools,
  ...applyPatchTools,
  ...planModeTools,
];

export { fileTools } from './files.js';
export { execTools } from './exec.js';
export { webTools } from './web.js';
export { memoryTools, setMemorySystem } from './memory.js';
export { memoryWriteTools } from './memory-write.js';
export { messagingTools } from './messaging.js';
export { emailTools } from './email.js';
export { pluginTools } from './plugins.js';
export { pdfTools } from './pdf.js';
export { subagentTools } from './subagent.js';
export { toolSearchTools } from './tool-search.js';
export { grepTools } from './grep.js';
export { globTools } from './glob.js';
export { todoTools } from './todo.js';
export { sleepTools } from './sleep.js';
export { applyPatchTools } from './apply-patch.js';
export { planModeTools } from './plan-mode.js';
export { safePath } from './files.js';
