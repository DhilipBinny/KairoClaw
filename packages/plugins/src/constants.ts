/** Max stdout bytes from CLI plugin execution. */
export const EXEC_MAX_STDOUT = 10 * 1024;

/** Max stderr bytes from CLI plugin execution. */
export const EXEC_MAX_STDERR = 5 * 1024;

/** Environment variables safe to pass to child processes. */
export const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'NODE_ENV', 'TZ', 'TMPDIR', 'COLORTERM',
];
