import { describe, it, expect } from 'vitest';
import { toSuperscript, getModelShortName, appendModelIndicator, shouldShowModelIndicator } from '../utils.js';

// ── toSuperscript ──────────────────────────────────────────

describe('toSuperscript', () => {
  it('converts letters to superscript', () => {
    expect(toSuperscript('haiku')).toBe('ᴴᴬᴵᴷᵁ');
  });
  it('converts numbers to superscript', () => {
    expect(toSuperscript('gpt-4.1-mini')).toBe('ᴳᴾᵀ⁻⁴·¹⁻ᴹᴵᴺᴵ');
  });
  it('converts opus', () => {
    expect(toSuperscript('opus')).toBe('ᴼᴾᵁˢ');
  });
  it('converts sonnet', () => {
    expect(toSuperscript('sonnet')).toBe('ˢᴼᴺᴺᴱᵀ');
  });
  it('passes through unknown chars unchanged', () => {
    expect(toSuperscript('llama_3')).toBe('ᴸᴸᴬᴹᴬ_³');
  });
  it('is case insensitive (uppercases input)', () => {
    expect(toSuperscript('Haiku')).toBe('ᴴᴬᴵᴷᵁ');
  });
});

// ── getModelShortName ──────────────────────────────────────

describe('getModelShortName', () => {
  describe('Anthropic models', () => {
    it('extracts haiku', () => {
      expect(getModelShortName('anthropic/claude-haiku-4-5-20251001')).toBe('haiku');
    });
    it('extracts sonnet', () => {
      expect(getModelShortName('anthropic/claude-sonnet-4-20250514')).toBe('sonnet');
    });
    it('extracts opus', () => {
      expect(getModelShortName('anthropic/claude-opus-4-6')).toBe('opus');
    });
    it('case insensitive', () => {
      expect(getModelShortName('anthropic/Claude-Haiku-3')).toBe('haiku');
    });
  });

  describe('OpenAI models', () => {
    it('extracts gpt-4o', () => {
      expect(getModelShortName('openai/gpt-4o')).toBe('gpt-4o');
    });
    it('extracts gpt-4o-mini', () => {
      expect(getModelShortName('openai/gpt-4o-mini')).toBe('gpt-4o-mini');
    });
    it('extracts gpt-4.1-mini', () => {
      expect(getModelShortName('openai/gpt-4.1-mini')).toBe('gpt-4.1-mini');
    });
    it('extracts o3-mini', () => {
      expect(getModelShortName('openai/o3-mini')).toBe('o3-mini');
    });
  });

  describe('Ollama models', () => {
    it('extracts llama3', () => {
      expect(getModelShortName('ollama/llama3')).toBe('llama3');
    });
    it('extracts mistral', () => {
      expect(getModelShortName('ollama/mistral')).toBe('mistral');
    });
  });

  describe('Kairo Premium / unknown providers', () => {
    it('kairo-premium with Anthropic model name extracts by family', () => {
      expect(getModelShortName('kairo-premium/claude-sonnet-4-6')).toBe('sonnet');
    });
    it('returns model name after slash for unknown provider', () => {
      expect(getModelShortName('custom-provider/some-model')).toBe('some-model');
    });
    it('returns full ID if no slash', () => {
      expect(getModelShortName('gpt-4o')).toBe('gpt-4o');
    });
  });
});

// ── appendModelIndicator ───────────────────────────────────

describe('appendModelIndicator', () => {
  it('appends superscript for haiku', () => {
    expect(appendModelIndicator('Hello', 'anthropic/claude-haiku-4-5-20251001'))
      .toBe('Hello\n\nᴴᴬᴵᴷᵁ');
  });
  it('appends superscript for sonnet', () => {
    expect(appendModelIndicator('Response', 'anthropic/claude-sonnet-4-20250514'))
      .toBe('Response\n\nˢᴼᴺᴺᴱᵀ');
  });
  it('appends superscript for any unknown model dynamically', () => {
    expect(appendModelIndicator('Hi', 'openai/gpt-4.1-mini'))
      .toBe('Hi\n\nᴳᴾᵀ⁻⁴·¹⁻ᴹᴵᴺᴵ');
  });
  it('returns original text when modelId is undefined', () => {
    expect(appendModelIndicator('Hello', undefined)).toBe('Hello');
  });
  it('returns original text when text is empty', () => {
    expect(appendModelIndicator('', 'anthropic/claude-haiku-4-5-20251001')).toBe('');
  });
});

// ── shouldShowModelIndicator ───────────────────────────────

describe('shouldShowModelIndicator', () => {
  it('returns false when setting is off', () => {
    expect(shouldShowModelIndicator('off', 'admin')).toBe(false);
    expect(shouldShowModelIndicator('off', 'user')).toBe(false);
  });
  it('returns false when setting is undefined', () => {
    expect(shouldShowModelIndicator(undefined, 'admin')).toBe(false);
  });
  it('returns true for all roles when setting is all', () => {
    expect(shouldShowModelIndicator('all', 'user')).toBe(true);
    expect(shouldShowModelIndicator('all', 'admin')).toBe(true);
    expect(shouldShowModelIndicator('all', undefined)).toBe(true);
  });
  it('returns true for admin when setting is admin_only', () => {
    expect(shouldShowModelIndicator('admin_only', 'admin')).toBe(true);
  });
  it('returns true for power_user when setting is admin_only', () => {
    expect(shouldShowModelIndicator('admin_only', 'power_user')).toBe(true);
  });
  it('returns false for regular user when setting is admin_only', () => {
    expect(shouldShowModelIndicator('admin_only', 'user')).toBe(false);
  });
  it('returns false for undefined role when setting is admin_only', () => {
    expect(shouldShowModelIndicator('admin_only', undefined)).toBe(false);
  });
});
