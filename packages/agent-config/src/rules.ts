/**
 * Rule enforcement — checks input/output against agent-specific rules.
 *
 * Uses @agw/security for base injection detection, then applies
 * agent-specific rules from the AgentDefinition.
 */

import { detectPromptInjection } from '@agw/security';
import type { AgentRule } from './types.js';

export interface RuleCheckResult {
  allowed: boolean;
  blockedBy?: AgentRule;
  warnings: AgentRule[];
}

/**
 * Check input text against an agent's rules.
 * Returns whether the input is allowed, and any warnings.
 */
export function enforceRules(input: string, rules: AgentRule[]): RuleCheckResult {
  const warnings: AgentRule[] = [];

  // Base prompt injection check
  const injection = detectPromptInjection(input);
  if (injection.suspicious) {
    const blockRules = rules.filter(r => r.type === 'safety' && r.enforcement === 'block');
    if (blockRules.length > 0) {
      return { allowed: false, blockedBy: blockRules[0], warnings };
    }
    const warnRules = rules.filter(r => r.type === 'safety' && r.enforcement === 'warn');
    warnings.push(...warnRules);
  }

  // Check each rule's description as a keyword match against input
  // This is a basic implementation — enterprise can extend with LLM-based evaluation
  for (const rule of rules) {
    if (rule.enforcement === 'block') {
      const keywords = rule.description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const inputLower = input.toLowerCase();
      const matchCount = keywords.filter(k => inputLower.includes(k)).length;
      if (matchCount >= Math.ceil(keywords.length * 0.5)) {
        warnings.push(rule);
      }
    }
  }

  return { allowed: true, warnings };
}

/**
 * Filter a tool list to only the tools an agent definition allows.
 */
export function resolveAgentTools<T extends { name: string }>(
  agentDef: { tools: string[] },
  allTools: T[],
): T[] {
  if (agentDef.tools.length === 0) return allTools;
  const allowed = new Set(agentDef.tools);
  return allTools.filter(t => allowed.has(t.name));
}
