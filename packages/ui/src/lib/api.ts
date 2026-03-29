/**
 * API client — fetch wrapper for all REST calls.
 * Automatically attaches the API key from localStorage.
 */

const API_BASE = '/api/v1';

function getApiKey(): string | null {
  return localStorage.getItem('agw_api_key');
}

export function setApiKey(key: string): void {
  localStorage.setItem('agw_api_key', key);
}

export function clearApiKey(): void {
  localStorage.removeItem('agw_api_key');
}

export function hasApiKey(): boolean {
  return !!localStorage.getItem('agw_api_key');
}

interface FetchOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T = unknown>(path: string, opts: FetchOptions = {}): Promise<T> {
  const apiKey = getApiKey();
  const headers: Record<string, string> = {
    ...opts.headers,
  };
  if (opts.body) {
    headers['Content-Type'] = 'application/json';
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data.error || data.message || msg;
    } catch {
      // ignore parse error
    }
    throw new ApiError(msg, res.status);
  }

  // Handle empty responses (204 No Content, etc.)
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError('Invalid JSON response from server', res.status);
  }
}

// ── Authenticated Media Fetch ─────────────────────
/**
 * Fetch a media file with auth and return a blob URL.
 * Used by <img> tags to load scoped media without leaking tokens in URLs.
 */
export async function fetchMediaBlobUrl(fileName: string): Promise<string> {
  const apiKey = getApiKey();
  const res = await fetch(`${API_BASE}/media/${encodeURIComponent(fileName)}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`Failed to load media: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// ── File Upload ──────────────────────────────────
export async function uploadFile(file: File): Promise<{ filename: string; filePath: string; originalName: string; mediaUrl: string; mimeType: string; sizeBytes: number }> {
  const apiKey = getApiKey();
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/media/upload`, {
    method: 'POST',
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: formData,
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const data = await res.json(); msg = data.error || msg; } catch {}
    throw new ApiError(msg, res.status);
  }

  return res.json();
}

// ── Auth ──────────────────────────────────
export async function login(apiKey: string): Promise<{ user: { id: string; name: string; role: string; email: string }; tenantId: string }> {
  const result = await request<{ user: { id: string; name: string; role: string; email: string }; tenantId: string }>('/auth/login', {
    method: 'POST',
    body: { apiKey },
  });
  setApiKey(apiKey);
  return result;
}

export async function getMe(): Promise<{ user: { id: string; name: string; role: string } }> {
  return request('/auth/me');
}

// ── Health ────────────────────────────────
export async function getHealth(): Promise<{ status: string; version: string; uptime: number; model: string; firstRun?: boolean }> {
  return request('/health');
}

// ── Sessions ──────────────────────────────
export async function getSessions(limit = 50): Promise<{ sessions: Array<{ id: string; channel: string; turns: number; input_tokens: number; output_tokens: number; created_at: string; updated_at: string }> }> {
  return request(`/sessions?limit=${limit}`);
}

export async function getSession(id: string): Promise<{ session: Record<string, unknown>; messages: Array<{ role: string; content: string; created_at: string }> }> {
  return request(`/sessions/${id}`);
}

export interface ToolCallInfo {
  id: string;
  tool_name: string;
  arguments: string;
  result: string | null;
  status: string;
  duration_ms: number | null;
  created_at: string;
}

export async function getSessionToolCalls(sessionId: string): Promise<{ toolCalls: ToolCallInfo[] }> {
  return request(`/sessions/${sessionId}/tool-calls`);
}

export async function deleteSession(id: string): Promise<{ success: boolean }> {
  return request(`/sessions/${id}`, { method: 'DELETE' });
}

export async function renameSession(id: string, title: string): Promise<{ success: boolean }> {
  return request(`/sessions/${id}`, { method: 'PATCH', body: { title } });
}

export async function deleteMessage(sessionId: string, messageId: string): Promise<{ success: boolean }> {
  return request(`/sessions/${sessionId}/messages/${messageId}`, { method: 'DELETE' });
}

// ── Admin: Config ─────────────────────────
export async function getConfig(): Promise<{ config: Record<string, unknown> }> {
  return request('/admin/config');
}

export async function updateConfig(configPath: string, value: unknown): Promise<{ success: boolean }> {
  return request('/admin/config', { method: 'PATCH', body: { path: configPath, value } });
}

export async function saveFullConfig(config: Record<string, unknown>): Promise<{ success: boolean }> {
  return request('/admin/config', { method: 'PUT', body: { config } });
}

// ── Admin: System ─────────────────────────
export async function getSystemInfo(): Promise<Record<string, unknown>> {
  return request('/admin/system');
}

export async function runDoctor(): Promise<{ overall: string; checks: Array<{ name: string; status: string; message: string }>; timestamp: string }> {
  return request('/admin/doctor');
}

// ── Admin: Provider Status ────────────────
export interface ProviderStatus {
  hasApiKey?: boolean;
  hasAuthToken?: boolean;
  hasBaseUrl?: boolean;
  configured: boolean;
}

export async function getProviderStatus(): Promise<Record<string, ProviderStatus>> {
  return request('/admin/providers/status');
}

// ── Admin: Model ──────────────────────────
export interface ModelCapabilitiesInfo {
  contextWindow: number;
  maxOutputTokens: number;
  supportsVision: boolean;
  supportsToolCalling: boolean;
  supportsStreaming: boolean;
  costPer1M: { input: number; output: number } | null;
  timeoutMs: number;
}

export interface ModelInfo {
  id: string;
  provider: string;
  modelId: string;
  capabilities: ModelCapabilitiesInfo;
}

export async function getModelInfo(): Promise<{ primary: ModelInfo; fallback: ModelInfo | null }> {
  return request('/admin/model');
}

// ── Admin: Providers ──────────────────────
export async function testProvider(data: { provider: string; apiKey?: string; authToken?: string; baseUrl?: string; useExisting?: boolean }): Promise<{ success: boolean; models?: Array<{ id: string; name: string }>; error?: string; authType?: string }> {
  return request('/admin/providers/test', { method: 'POST', body: data });
}

export async function saveProviderCredentials(
  providerId: string,
  credentials: { apiKey?: string; authToken?: string; baseUrl?: string },
): Promise<{ success: boolean }> {
  return request(`/admin/providers/${providerId}/credentials`, { method: 'PATCH', body: credentials });
}

export async function saveModelCapabilities(
  modelId: string,
  capabilities: Record<string, unknown>,
): Promise<{ success: boolean }> {
  return request('/admin/models/capabilities', { method: 'PATCH', body: { modelId, capabilities } });
}

export async function saveChannelCredentials(
  channelId: string,
  credentials: { botToken?: string },
): Promise<{ success: boolean }> {
  return request(`/admin/channels/${channelId}/credentials`, { method: 'PATCH', body: credentials });
}

// ── Admin: Usage ──────────────────────────
export async function getUsage(days = 30): Promise<Record<string, unknown>> {
  return request(`/admin/usage?days=${days}`);
}

// ── Admin: Logs ───────────────────────────
export interface LogEntry { level: string; msg: string; time: number; [key: string]: unknown; }
export interface LogFile { date: string; file: string; sizeBytes: number; }

export async function getLogs(lines = 200): Promise<{ entries: LogEntry[]; buffered: number }> {
  return request(`/admin/logs?lines=${lines}`);
}

export async function getLogFiles(): Promise<{ files: LogFile[] }> {
  return request('/admin/logs/files');
}

export async function searchLogs(opts: { q?: string; level?: string; from?: string; to?: string; limit?: number }): Promise<{ entries: LogEntry[]; count: number }> {
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.level) params.set('level', opts.level);
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
  if (opts.limit) params.set('limit', String(opts.limit));
  return request(`/admin/logs/search?${params.toString()}`);
}

export function getLogDownloadUrl(date: string): string {
  const token = localStorage.getItem('agw_api_key') || '';
  return `${API_BASE}/admin/logs/download/${date}?token=${encodeURIComponent(token)}`;
}

export async function setLogLevel(level: string): Promise<{ success: boolean; level: string }> {
  return request('/admin/log-level', { method: 'PUT', body: { level } });
}

// ── Admin: MCP ────────────────────────────
export async function getMCPServers(): Promise<{ servers: Array<{ id: string; status: string; tools: string[] }> }> {
  return request('/mcp/servers');
}

export async function installMCPServer(data: { id: string; transport?: string; command?: string; args?: string[]; url?: string; env?: Record<string, string> }): Promise<{ success: boolean; status: unknown }> {
  return request('/mcp/servers', { method: 'POST', body: data });
}

export async function removeMCPServer(id: string): Promise<{ success: boolean }> {
  return request(`/mcp/servers/${id}`, { method: 'DELETE' });
}

export async function reconnectMCPServer(id: string): Promise<{ success: boolean }> {
  return request(`/mcp/servers/${id}/reconnect`, { method: 'POST', body: {} });
}

export async function disableMCPServer(id: string): Promise<{ success: boolean }> {
  return request(`/mcp/servers/${id}/disable`, { method: 'POST', body: {} });
}

export async function enableMCPServer(id: string): Promise<{ success: boolean }> {
  return request(`/mcp/servers/${id}/enable`, { method: 'POST', body: {} });
}

export async function updateMCPServer(id: string, data: { env?: Record<string, string> }): Promise<{ success: boolean }> {
  return request(`/mcp/servers/${id}`, { method: 'PATCH', body: data });
}


export async function getMCPCatalog(): Promise<{ catalog: Array<Record<string, unknown>> }> {
  return request('/mcp/catalog');
}

export async function searchMCPMarketplace(search: string, limit = 20): Promise<{ servers: Array<{ id: string; name: string; description: string; qualifiedName: string }> }> {
  return request(`/mcp/marketplace?search=${encodeURIComponent(search)}&limit=${limit}`);
}

// ── Admin: Database ──────────────────────
export async function getDatabaseStatus(): Promise<Record<string, unknown>> {
  return request('/admin/database');
}

export async function migrateDatabase(): Promise<Record<string, unknown>> {
  return request('/admin/database/migrate', { method: 'POST', body: {} });
}

// ── Admin: Cron ───────────────────────────
export interface CronJobSchedule {
  type: 'at' | 'every' | 'cron';
  value: string | number;
  tz?: string;
}

export interface CronJobDelivery {
  mode: 'none' | 'announce' | 'always';
  /** Per-channel delivery targets (new format). */
  targets?: Array<{ channel: string; to?: string }>;
  /** Legacy: single channel or array. */
  channel?: string | string[];
  /** Legacy: single target ID. */
  to?: string;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: CronJobSchedule;
  prompt: string;
  delivery: CronJobDelivery | string;
  enabled: boolean;
  createdAt: string;
  lastRun: string | null;
  lastResult: string | null;
  lastError: string | null;
  lastDelivered: boolean | null;
  lastDeliveryChannel: string | null;
  runCount: number;
}

export interface CreateCronJob {
  name?: string;
  schedule: { type: string; value: string | number; tz?: string };
  prompt: string;
  delivery?: CronJobDelivery | string;
  enabled?: boolean;
}

export async function getCronJobs(): Promise<{ jobs: CronJob[] }> {
  return request('/admin/cron');
}

export async function createCronJob(job: CreateCronJob): Promise<{ success: boolean }> {
  return request('/admin/cron', { method: 'POST', body: job });
}

export async function updateCronJob(id: string, updates: Partial<CreateCronJob>): Promise<{ success: boolean; job: CronJob }> {
  return request(`/admin/cron/${id}`, { method: 'PATCH', body: updates });
}

export async function deleteCronJob(id: string): Promise<{ success: boolean }> {
  return request(`/admin/cron/${id}`, { method: 'DELETE' });
}

export async function runCronJob(id: string): Promise<{ success: boolean; lastResult?: string }> {
  return request(`/admin/cron/${id}/run`, { method: 'POST', body: {} });
}

// ── Admin: Channels (unified) ────────────
export async function getChannelsStatus(): Promise<{
  telegram: { enabled: boolean; connected: boolean; botUsername: string | null; hasToken?: boolean; tokenHint?: string | null };
  whatsapp: { enabled: boolean; status: string; phone: string | null; name: string | null };
}> {
  return request('/admin/channels/status');
}

// ── Admin: WhatsApp ──────────────────────
export async function getWhatsAppStatus(): Promise<{ status: string; phone: string | null; name: string | null }> {
  return request('/admin/whatsapp/status');
}

export async function getWhatsAppQR(): Promise<{ qr: string | null; qrDataUrl: string | null; status: string }> {
  return request('/admin/whatsapp/qr');
}

export async function unpairWhatsApp(): Promise<{ success: boolean }> {
  return request('/admin/whatsapp/unpair', { method: 'POST', body: {} });
}

// ── Admin: Telegram Test ─────────────────
export async function testTelegramBot(token?: string): Promise<{ success: boolean; username?: string; error?: string }> {
  return request('/admin/channels/telegram/test', { method: 'POST', body: { token } });
}

// ── Admin: Tools Config ──────────────────
export interface ToolField {
  key: string;
  type: 'boolean' | 'number' | 'text';
  label?: string;
  hint?: string;
  showWhen?: string;
  min?: number;
}

export interface ToolMeta {
  key: string;
  label: string;
  hint: string;
  fields: ToolField[];
}

export async function getToolsConfig(): Promise<{ tools: ToolMeta[] }> {
  return request('/admin/tools');
}

// ── Admin: Email/SMTP ────────────────────
export async function saveEmailCredentials(creds: { user?: string; pass?: string }): Promise<{ success: boolean }> {
  return request('/admin/tools/email/credentials', { method: 'PATCH', body: creds });
}

export async function testEmailConnection(creds?: { user?: string; pass?: string }): Promise<{ success: boolean; error?: string }> {
  return request('/admin/tools/email/test', { method: 'POST', body: creds || {} });
}

// ── Admin: Pending Senders ───────────────
export interface PendingSender {
  id: number;
  channel: string;
  sender_id: string;
  sender_name: string;
  first_seen: string;
  last_seen: string;
  message_count: number;
  status: string;
}

export async function getPendingSenders(): Promise<{ senders: PendingSender[] }> {
  return request('/admin/channels/pending-senders');
}

export async function approveSender(id: number, userId?: string): Promise<{ success: boolean }> {
  return request(`/admin/channels/pending-senders/${id}/approve`, { method: 'POST', body: userId ? { userId } : {} });
}

export async function onboardSender(id: number, data: { name: string; email?: string; role?: string; elevated?: boolean }): Promise<{ user: UserInfo; api_key: string }> {
  return request(`/admin/channels/pending-senders/${id}/onboard`, { method: 'POST', body: data });
}

export async function rejectSender(id: number): Promise<{ success: boolean }> {
  return request(`/admin/channels/pending-senders/${id}/reject`, { method: 'POST', body: {} });
}

// ── Admin: Export/Import ──────────────────
export function getExportUrl(): string {
  const token = localStorage.getItem('agw_api_key') || '';
  return `${API_BASE}/admin/export?token=${encodeURIComponent(token)}`;
}

export async function importState(file: File): Promise<{ success: boolean; message?: string }> {
  const apiKey = getApiKey();
  const formData = new FormData();
  formData.append('file', file);

  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(`${API_BASE}/admin/import`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const data = await res.json(); msg = data.error || msg; } catch {}
    throw new ApiError(msg, res.status);
  }

  return res.json();
}

// ── Admin: Workspace ──────────────────────
export async function getWorkspaceFiles(): Promise<{ files: Array<{ name: string; exists: boolean; size: number; modified: string | null }> }> {
  return request('/workspace/files');
}

export async function getWorkspaceFile(name: string): Promise<{ name: string; content: string; exists: boolean }> {
  return request(`/workspace/files/${name}`);
}

export async function saveWorkspaceFile(name: string, content: string): Promise<{ success: boolean }> {
  return request(`/workspace/files/${name}`, { method: 'PUT', body: { content } });
}

// ── Scoped Users ─────────────────────────────────

export interface ScopeEntry {
  scopeKey: string;
  channel: string;
  userId: string;
  hasUserMd: boolean;
  hasProfile: boolean;
  sessionCount: number;
  lastSession: string | null;
}

export async function getScopes(): Promise<{ scopes: ScopeEntry[] }> {
  return request('/workspace/scopes');
}

export async function getScopeDetail(key: string): Promise<{
  scopeKey: string;
  userMd: string;
  profile: string;
  sessions: Array<{ date: string; content: string }>;
}> {
  return request(`/workspace/scopes/${encodeURIComponent(key)}`);
}

// ── Plugins ──────────────────────────────────────

export async function getPlugins(): Promise<{ plugins: Record<string, unknown> }> {
  return request('/admin/plugins');
}

export async function savePlugins(plugins: Record<string, unknown>): Promise<{ success: boolean }> {
  return request('/admin/plugins', { method: 'PUT', body: { plugins } });
}

// ── Users ──────────────────────────────────────

export interface UserInfo {
  id: string;
  name: string;
  email: string | null;
  role: string;
  elevated: boolean;
  active: boolean;
  deactivated_at: string | null;
  created_at: string;
  updated_at: string;
  session_count: number;
  sender_links: Array<{ id: number; channel_type: string; sender_id: string }>;
  usage: { total_input: number; total_output: number; total_cost: number; request_count: number };
}

export async function getUsers(): Promise<UserInfo[]> {
  return request('/admin/users');
}

export async function getUser(id: string): Promise<UserInfo> {
  return request(`/admin/users/${id}`);
}

export async function createUser(data: { name: string; email?: string; role?: string; elevated?: boolean }): Promise<{ user: UserInfo; api_key: string }> {
  return request('/admin/users', { method: 'POST', body: data });
}

export async function updateUser(id: string, data: { name?: string; email?: string; role?: string; elevated?: boolean }): Promise<{ success: boolean }> {
  return request(`/admin/users/${id}`, { method: 'PATCH', body: data });
}

export async function deactivateUser(id: string): Promise<{ success: boolean }> {
  return request(`/admin/users/${id}`, { method: 'DELETE' });
}

export async function reactivateUser(id: string): Promise<{ success: boolean }> {
  return request(`/admin/users/${id}/reactivate`, { method: 'POST' });
}

export async function permanentDeleteUser(id: string): Promise<{ success: boolean }> {
  return request(`/admin/users/${id}/permanent`, { method: 'DELETE' });
}

export async function regenerateApiKey(id: string): Promise<{ api_key: string }> {
  return request(`/admin/users/${id}/api-key`, { method: 'POST' });
}

export interface UnlinkedSession {
  chat_id: string;
  channel: string;
  sender_id: string;
  sender_name: string | null;
  turns: number;
  created_at: string;
  updated_at: string;
}

export async function getUnlinkedSessions(): Promise<UnlinkedSession[]> {
  return request('/admin/users/unlinked-sessions');
}

export async function linkSender(userId: string, channelType: string, senderId: string): Promise<Record<string, unknown>> {
  return request(`/admin/users/${userId}/sender-links`, { method: 'POST', body: { channelType, senderId } });
}

export async function unlinkSender(userId: string, linkId: number): Promise<{ success: boolean }> {
  return request(`/admin/users/${userId}/sender-links/${linkId}`, { method: 'DELETE' });
}

// Tool permissions
export async function getToolList(): Promise<Array<{ name: string; description: string }>> {
  return request('/admin/tool-definitions');
}

export interface ToolPermRule { id?: number; tool_pattern: string; permission: string }

export async function getToolPermissions(role: string): Promise<{ role: string; rules: ToolPermRule[] }> {
  return request(`/admin/tool-permissions/${role}`);
}

export async function saveToolPermissions(role: string, permissions: Array<{ toolPattern: string; permission: string }>): Promise<{ success: boolean }> {
  return request(`/admin/tool-permissions/${role}`, { method: 'PUT', body: { permissions } });
}

// User portal (/my/) endpoints
export async function getMyDashboard(): Promise<{
  user: { id: string; name: string; role: string };
  sessions: number;
  usage: { tokens: number; cost: number };
}> {
  return request('/my/dashboard');
}

export async function getMyUsage(days = 30): Promise<Record<string, unknown>> {
  return request(`/my/usage?days=${days}`);
}

export async function getMyCrons(): Promise<{ jobs: Array<Record<string, unknown>> }> {
  return request('/my/cron');
}

export async function updateMyCron(id: string, updates: Record<string, unknown>): Promise<{ success: boolean; job: Record<string, unknown> }> {
  return request(`/my/cron/${id}`, { method: 'PATCH', body: updates });
}

export async function deleteMyCron(id: string): Promise<{ success: boolean }> {
  return request(`/my/cron/${id}`, { method: 'DELETE' });
}
