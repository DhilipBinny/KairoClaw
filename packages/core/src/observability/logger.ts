// Re-export from @agw/logger — backward compatible
export {
  type LogEntry,
  type LogCategory,
  LogBuffer,
  logBuffer,
  getLogsDir,
  createLogger,
  createModuleLogger,
  createServerLogger,
  listLogFiles,
  searchLogFiles,
  getLogFilePath,
  toAgwLogger,
} from '@agw/logger';
