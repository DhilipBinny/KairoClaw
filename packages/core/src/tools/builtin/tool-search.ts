/**
 * `tool_search` — find and load deferred tools by query.
 *
 * Phase 8: when deferred tool loading is enabled, the agent only
 * sees a small "always-load" core set in its initial tool list
 * (read_file, write_file, edit_file, grep, glob, exec, todo_write,
 * memory_search, web_fetch, spawn_agent, tool_search itself). All
 * other tools are hidden from the system prompt until the agent
 * explicitly discovers and loads them via this tool.
 *
 * The agent calls `tool_search({ query })` with a natural-language
 * description of what it needs. This tool:
 *   1. matches against every registered tool's name + description +
 *      searchHint using a simple scoring heuristic
 *   2. registers the top-N matches on the current session's loaded
 *      set (via `ToolRegistry.loadForSession`)
 *   3. returns an envelope with the full definitions of the matches
 *      so the agent sees exactly what it just loaded
 *   4. the agent loop's `refreshTools` callback picks them up on the
 *      next round, and the LLM can call them from there
 *
 * Query forms:
 *   - `select:name1,name2,...` — exact selection by tool name
 *   - `+foo bar` — require "foo", rank by remaining terms
 *   - free-form keywords — substring/score-based ranking
 */

import type { ToolRegistration } from '../types.js';
import type { ToolRegistry } from '../registry.js';
import type { Session } from '@agw/types';
import { textEnvelope } from '../envelope.js';

/**
 * Score a tool against a set of query terms. Higher = better match.
 * Rough heuristic tuned for LLM intent matching, not a real search
 * engine — a tiny scoring function is fine because the tool surface
 * is measured in tens of tools, not thousands.
 */
function scoreTool(
  tool: { name: string; description: string; searchHint?: string },
  terms: string[],
  requiredTerms: string[],
): number {
  const haystack = `${tool.name.toLowerCase()} ${(tool.searchHint ?? '').toLowerCase()} ${tool.description.toLowerCase()}`;
  // Required terms must all be present, or we bail with -Infinity
  for (const req of requiredTerms) {
    if (!haystack.includes(req.toLowerCase())) return -Infinity;
  }
  let score = 0;
  for (const term of terms) {
    const t = term.toLowerCase();
    if (tool.name.toLowerCase().includes(t)) score += 10;
    if ((tool.searchHint ?? '').toLowerCase().includes(t)) score += 5;
    if (tool.description.toLowerCase().includes(t)) score += 2;
  }
  return score;
}

export const toolSearchTools: ToolRegistration[] = [
  {
    definition: {
      name: 'tool_search',
      // Always present in the initial prompt so the agent can
      // discover how to discover everything else.
      alwaysLoad: true,
      searchHint: 'find and load deferred tools',
      description:
        'Discover deferred tools by natural-language query, then load them into this session so you can call them on the next turn. ' +
        'Use this when you need a tool that isn\'t in your current tool list — e.g. "send email", "read pdf", "browse web page". ' +
        'Query forms: "select:name1,name2" for exact picks, "+foo bar" to require "foo" and rank by "bar", or free-form keywords. ' +
        'Returns the full definitions of the top matches and loads them for the rest of this session.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What you\'re looking for. Natural language, or "select:name1,name2" for exact picks.',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of tools to load (default 5).',
          },
        },
        required: ['query'],
      },
    },
    executor: async (args, context) => {
      const rawQuery = typeof args.query === 'string' ? args.query : '';
      if (!rawQuery.trim()) {
        return { error: 'query is required and must be a non-empty string' };
      }
      const maxResults = typeof args.max_results === 'number' && args.max_results > 0
        ? Math.min(args.max_results, 20)
        : 5;

      // Registry + session id are passed through the context extension
      // pattern (same as fileState / resultBudget / loopDetector).
      const ctx = context as unknown as {
        toolRegistry?: ToolRegistry;
        session?: Session | { id?: string };
      };
      const registry = ctx.toolRegistry;
      if (!registry) {
        return { error: 'tool_search: registry not available in context' };
      }
      const session = ctx.session;
      const sessionId =
        (session as { id?: string })?.id
        ?? (session as Session | undefined)?.sessionId;
      if (!sessionId) {
        return { error: 'tool_search: no session id in context' };
      }

      // Fetch the FULL tool list (ignoring deferred loading) so we can
      // search across everything the registry knows.
      const all = await registry.getDefinitions({
        userRole: (context.user?.role) ?? 'user',
        db: context.db as never,
        tenantId: context.tenant || 'default',
        elevated: !!context.user?.elevated,
      });

      // Parse query variants
      let selectNames: string[] | null = null;
      const requiredTerms: string[] = [];
      let rankTerms: string[] = [];

      if (rawQuery.startsWith('select:')) {
        selectNames = rawQuery
          .slice('select:'.length)
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      } else {
        // Split on whitespace; terms starting with `+` are required
        const parts = rawQuery.split(/\s+/).filter((s) => s.length > 0);
        for (const p of parts) {
          if (p.startsWith('+') && p.length > 1) {
            requiredTerms.push(p.slice(1));
          } else {
            rankTerms.push(p);
          }
        }
        if (rankTerms.length === 0 && requiredTerms.length > 0) {
          // All required, no rank terms — use required as rank too
          rankTerms = [...requiredTerms];
        }
      }

      // Pick matches
      let matches: Array<{ def: (typeof all)[number]; score: number }> = [];
      if (selectNames) {
        // Exact-name path: just filter
        for (const def of all) {
          if (selectNames.includes(def.name)) {
            matches.push({ def, score: 100 });
          }
        }
      } else {
        for (const def of all) {
          const s = scoreTool(def, rankTerms, requiredTerms);
          if (s > 0) matches.push({ def, score: s });
        }
        matches.sort((a, b) => b.score - a.score);
        matches = matches.slice(0, maxResults);
      }

      if (matches.length === 0) {
        const loadedBefore = registry.getSessionLoaded(sessionId);
        return textEnvelope(
          `tool_search: no matches for query "${rawQuery}".\n\n` +
          `Currently loaded tools: ${loadedBefore.length === 0 ? '(none beyond always-load)' : loadedBefore.join(', ')}\n\n` +
          `Try different keywords or use select:<name> if you already know the tool name.`,
        );
      }

      // Register with the session's loaded set so the agent loop's
      // refreshTools callback includes them on the next round.
      const addedCount = registry.loadForSession(sessionId, matches.map((m) => m.def.name));

      // Render the matched definitions as a readable text block. Each
      // definition includes the full JSON schema so the agent has
      // everything it needs to call the tool next turn.
      const lines: string[] = [
        `tool_search: "${rawQuery}" → ${matches.length} match${matches.length === 1 ? '' : 'es'} (${addedCount} newly loaded for this session)`,
        '',
      ];
      for (const m of matches) {
        lines.push(`── ${m.def.name} ─────────────`);
        if (m.def.searchHint) lines.push(`hint: ${m.def.searchHint}`);
        lines.push(`description: ${m.def.description}`);
        lines.push(`parameters: ${JSON.stringify(m.def.parameters, null, 2)}`);
        lines.push('');
      }
      lines.push(
        'The tools above are now loaded for this session. You can call them directly on your next turn — no need to call tool_search again unless you need more tools.',
      );

      return textEnvelope(lines.join('\n'));
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
    isReadOnly: true,
    getActivityDescription: (input) => {
      const q = (input as { query?: string })?.query ?? '';
      return `tool_search: ${q.slice(0, 60)}`;
    },
  },
];
