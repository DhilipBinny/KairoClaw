/**
 * @agw/tools-common — generic tools for any agentic platform.
 *
 * Includes file operations, exec, web, grep, glob, sleep, todo,
 * PDF reading, email, patching, plan mode, tool search, and memory tools.
 */

// Shared utilities
export { safePath, scopedSafePath } from './safe-path.js';
export { getWorkspace } from './utils.js';
export * from './constants.js';

// Tool registrations
export { fileTools, safePath as fileSafePath } from './files.js';
export { execTools } from './exec.js';
export { webTools } from './web.js';
export { grepTools } from './grep.js';
export { globTools } from './glob.js';
export { sleepTools } from './sleep.js';
export { todoTools } from './todo.js';
export { pdfTools } from './pdf.js';
export { emailTools } from './email.js';
export { applyPatchTools } from './apply-patch.js';
export { planModeTools } from './plan-mode.js';
export { toolSearchTools } from './tool-search.js';
export { memoryTools } from './memory.js';
export { memoryWriteTools } from './memory-write.js';

// Combined registration array for convenience
import type { ToolRegistration } from '@agw/tool-platform';
import { fileTools } from './files.js';
import { execTools } from './exec.js';
import { webTools } from './web.js';
import { grepTools } from './grep.js';
import { globTools } from './glob.js';
import { sleepTools } from './sleep.js';
import { todoTools } from './todo.js';
import { pdfTools } from './pdf.js';
import { emailTools } from './email.js';
import { applyPatchTools } from './apply-patch.js';
import { planModeTools } from './plan-mode.js';
import { toolSearchTools } from './tool-search.js';
import { memoryTools } from './memory.js';
import { memoryWriteTools } from './memory-write.js';

export const commonTools: ToolRegistration[] = [
  ...fileTools,
  ...execTools,
  ...webTools,
  ...grepTools,
  ...globTools,
  ...sleepTools,
  ...todoTools,
  ...pdfTools,
  ...emailTools,
  ...applyPatchTools,
  ...planModeTools,
  ...toolSearchTools,
  ...memoryTools,
  ...memoryWriteTools,
];
