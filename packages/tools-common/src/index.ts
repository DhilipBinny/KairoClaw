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
export { execTools, SAFE_ENV_KEYS, formatExecResult, checkExecCommandPolicy, type ExecPolicyResult } from './exec.js';
export { webTools, validateFetchUrl, validateResolvedIP, formatSearchResults } from './web.js';
export { grepTools } from './grep.js';
export { globTools } from './glob.js';
export { sleepTools } from './sleep.js';
export { todoTools, readTodos, writeTodos, type Todo } from './todo.js';
export { pdfTools, extractPdfText } from './pdf.js';
export { extractDocxText, extractXlsxText, extractPptxText, extractTextFromXml, getDocumentType, formatDocumentMeta, type DocxResult, type XlsxResult, type PptxResult, type DocumentResult } from './document.js';
export { emailTools } from './email.js';
export { applyPatchTools, extractPatchPaths } from './apply-patch.js';
export { planModeTools } from './plan-mode.js';
export { toolSearchTools, scoreTool } from './tool-search.js';
export { memoryTools, setMemorySystem } from './memory.js';
export { memoryWriteTools, appendProfileEntry, readPinned, writePinned, forgetById } from './memory-write.js';
export { sandboxExecTools, setSandboxManager } from './sandbox-exec.js';

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
import { sandboxExecTools } from './sandbox-exec.js';

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
  ...sandboxExecTools,
];
