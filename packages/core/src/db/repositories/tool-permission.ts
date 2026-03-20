import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../index.js';

export interface ToolPermissionRow {
  id: number;
  tenant_id: string;
  role: string;
  tool_pattern: string;
  permission: string;
  created_at: string;
}

/**
 * Match a tool name against a glob-like pattern.
 *
 * Supports:
 * - Exact match: "read_file" matches "read_file"
 * - Wildcard: "*" matches everything
 * - Prefix wildcard: "mcp__*" matches "mcp__github__list_issues"
 */
function globMatch(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === toolName;

  // Convert glob to regex: escape special chars, replace * with .*
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(toolName);
}

/**
 * Compute specificity of a pattern for ordering matches.
 * More specific (longer, fewer wildcards) wins.
 */
function patternSpecificity(pattern: string): number {
  if (!pattern.includes('*')) return 1000 + pattern.length; // exact match is most specific
  if (pattern === '*') return 0; // catch-all is least specific
  return pattern.replace(/\*/g, '').length; // length of non-wildcard portion
}

export class ToolPermissionRepository {
  constructor(private db: DatabaseAdapter) {}

  create(perm: {
    tenantId: string;
    role: string;
    toolPattern: string;
    permission: string;
  }): void {
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [perm.tenantId, perm.role, perm.toolPattern, perm.permission, now],
    );
  }

  listByTenantAndRole(tenantId: string, role: string): ToolPermissionRow[] {
    return this.db.query<ToolPermissionRow>(
      'SELECT * FROM tool_permissions WHERE tenant_id = ? AND role = ?',
      [tenantId, role],
    );
  }

  delete(id: number): void {
    this.db.run('DELETE FROM tool_permissions WHERE id = ?', [id]);
  }

  checkPermission(tenantId: string, role: string, toolName: string): 'allow' | 'deny' | 'confirm' {
    const permissions = this.listByTenantAndRole(tenantId, role);

    // Find all matching permissions and pick the most specific
    let bestMatch: ToolPermissionRow | null = null;
    let bestSpecificity = -1;

    for (const perm of permissions) {
      if (globMatch(perm.tool_pattern, toolName)) {
        const specificity = patternSpecificity(perm.tool_pattern);
        if (specificity > bestSpecificity) {
          bestSpecificity = specificity;
          bestMatch = perm;
        }
      }
    }

    if (!bestMatch) return 'deny';

    return bestMatch.permission as 'allow' | 'deny' | 'confirm';
  }
}
