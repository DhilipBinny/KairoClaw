export const SCOPE_DIR_NAME = 'scopes';
export const SHARED_DIR = 'shared';
export const DOCUMENTS_DIR = 'documents';
export const PERSONA_FILES = ['IDENTITY.md', 'SOUL.md', 'RULES.md'];
export const FILE_MAX_WRITE_SIZE = 10 * 1024 * 1024; // 10 MB
export const EXEC_MAX_STDOUT = 10 * 1024;
export const EXEC_MAX_STDERR = 5 * 1024;
export const EXEC_MAX_TIMEOUT_SECONDS = 120;
export const EXEC_DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TOOL_RESULT_CHARS = 10_000;
export const PDF_MAX_PAGES = 50;
export const PDF_OCR_MIN_CHARS_PER_PAGE = 50;
export const PDF_TIMEOUT_MS = 60_000;

// Document extraction (DOCX, XLSX, PPTX)
export const DOC_MAX_EXTRACT_CHARS = 50_000;
export const DOC_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB — prevents OOM on large uploads
export const XLSX_MAX_ROWS_PER_SHEET = 500;
export const PPTX_MAX_SLIDES = 50;
