/**
 * Build a system prompt from an AgentDefinition.
 *
 * Converts the structured persona, rules, and tools into the
 * cached + dynamic system prompt format used by the agent loop.
 */

import type { ToolDefinition, StructuredSystemPrompt } from '@agw/types';
import type { AgentDefinition } from './types.js';

/**
 * Build a system prompt from an agent definition and tool list.
 * Returns the same StructuredSystemPrompt shape that buildSystemPrompt() produces,
 * so it plugs directly into the agent loop.
 */
export function buildPromptFromDefinition(
  def: AgentDefinition,
  tools: ToolDefinition[],
  opts?: { supportsVision?: boolean },
): StructuredSystemPrompt {
  const cached: string[] = [];

  // Identity
  cached.push(`You are ${def.name}${def.persona.identity ? ', ' + def.persona.identity : ''}.`);

  // Tone and traits
  if (def.persona.tone) {
    cached.push(`Communication style: ${def.persona.tone}`);
  }
  if (def.persona.traits && def.persona.traits.length > 0) {
    cached.push(`Key traits: ${def.persona.traits.join(', ')}`);
  }

  // Restrictions
  if (def.persona.restrictions && def.persona.restrictions.length > 0) {
    cached.push('## Restrictions\n' + def.persona.restrictions.map(r => `- ${r}`).join('\n'));
  }

  // Vision capability
  if (opts?.supportsVision) {
    cached.push(
      '## Vision\n' +
      'You **can see images**. When users attach images, you receive them as image content blocks and can analyze their visual content directly. ' +
      'Do not claim you cannot see images or lack vision capabilities.',
    );
  }

  // Tools
  if (tools.length > 0) {
    cached.push('## Tools');
    cached.push(`You have access to ${tools.length} tools. Use them when they help accomplish the user's request.`);
    cached.push('Available tools: ' + tools.map(t => t.name).join(', '));
  }

  // Rules
  if (def.rules.length > 0) {
    const safetyRules = def.rules.filter(r => r.type === 'safety');
    const behavioralRules = def.rules.filter(r => r.type === 'behavioral');
    const operationalRules = def.rules.filter(r => r.type === 'operational');

    if (safetyRules.length > 0) {
      cached.push('## Safety Rules\n' + safetyRules.map(r => `- [${r.enforcement.toUpperCase()}] ${r.description}`).join('\n'));
    }
    if (behavioralRules.length > 0) {
      cached.push('## Behavioral Rules\n' + behavioralRules.map(r => `- ${r.description}`).join('\n'));
    }
    if (operationalRules.length > 0) {
      cached.push('## Operational Rules\n' + operationalRules.map(r => `- ${r.description}`).join('\n'));
    }
  }

  // Dynamic section
  const dynamic: string[] = [];
  dynamic.push(`## Current Date & Time\n${new Date().toISOString()}\nModel: ${def.model}`);

  return {
    cached: cached.join('\n\n'),
    dynamic: dynamic.join('\n\n'),
  };
}
