import { fileTools } from './files.js';
import { execTools } from './exec.js';
import { webTools } from './web.js';
import { memoryTools } from './memory.js';
import { messagingTools } from './messaging.js';
import { emailTools } from './email.js';
import { pluginTools } from './plugins.js';
import { pdfTools } from './pdf.js';
import { subagentTools } from './subagent.js';
import { browseTools } from './browse.js';
import { skillTools } from './skills.js';
import type { ToolRegistration } from '../types.js';

export const builtinTools: ToolRegistration[] = [
  ...fileTools,
  ...execTools,
  ...webTools,
  ...memoryTools,
  ...messagingTools,
  ...emailTools,
  ...pluginTools,
  ...pdfTools,
  ...subagentTools,
  ...browseTools,
  ...skillTools,
];

export { fileTools } from './files.js';
export { execTools } from './exec.js';
export { webTools } from './web.js';
export { memoryTools, setMemorySystem } from './memory.js';
export { messagingTools } from './messaging.js';
export { emailTools } from './email.js';
export { pluginTools } from './plugins.js';
export { pdfTools } from './pdf.js';
export { subagentTools } from './subagent.js';
export { safePath } from './files.js';
export { skillTools, setSkillRegistry } from './skills.js';
