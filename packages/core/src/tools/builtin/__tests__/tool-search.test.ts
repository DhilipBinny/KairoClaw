import { describe, it, expect } from 'vitest';
import { scoreTool } from '../tool-search.js';

describe('scoreTool', () => {
  const tool = (name: string, desc: string, hint?: string) => ({
    name,
    description: desc,
    searchHint: hint,
  });

  it('scores higher when term matches name (10 pts) vs description (2 pts)', () => {
    const email = tool('send_email', 'Send an email message', 'email smtp');
    const other = tool('exec', 'Execute a command — can send email via CLI');
    const emailScore = scoreTool(email, ['email'], []);
    const otherScore = scoreTool(other, ['email'], []);
    expect(emailScore).toBeGreaterThan(otherScore);
  });

  it('scores higher when term matches searchHint (5 pts)', () => {
    const withHint = tool('read_pdf', 'Read a PDF file', 'pdf document extract pages');
    const withoutHint = tool('read_pdf_alt', 'Read a PDF file');
    const hintScore = scoreTool(withHint, ['pages'], []);
    const noHintScore = scoreTool(withoutHint, ['pages'], []);
    expect(hintScore).toBeGreaterThan(noHintScore);
  });

  it('returns -Infinity when a required term is missing', () => {
    const t = tool('write_file', 'Write content to a file');
    expect(scoreTool(t, ['write'], ['email'])).toBe(-Infinity);
  });

  it('returns positive score when required term is present', () => {
    const t = tool('send_email', 'Send email messages', 'email smtp');
    expect(scoreTool(t, ['send'], ['email'])).toBeGreaterThan(0);
  });

  it('returns 0 when no terms match', () => {
    const t = tool('exec', 'Execute shell commands');
    expect(scoreTool(t, ['zebra'], [])).toBe(0);
  });

  it('is case-insensitive', () => {
    const t = tool('Send_Email', 'Send EMAIL messages');
    expect(scoreTool(t, ['EMAIL'], [])).toBeGreaterThan(0);
    expect(scoreTool(t, ['send'], [])).toBeGreaterThan(0);
  });

  it('accumulates score across multiple matching terms', () => {
    const t = tool('send_email', 'Send email messages via SMTP', 'email smtp');
    const singleTerm = scoreTool(t, ['email'], []);
    const multiTerm = scoreTool(t, ['email', 'smtp'], []);
    expect(multiTerm).toBeGreaterThan(singleTerm);
  });
});
