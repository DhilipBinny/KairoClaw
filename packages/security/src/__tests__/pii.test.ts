import { describe, it, expect, afterEach } from 'vitest';
import { filterOutput, enablePiiRedaction } from '../output.js';

afterEach(() => {
  enablePiiRedaction(false);
});

describe('PII redaction (opt-in)', () => {
  it('does not redact PII when disabled', () => {
    enablePiiRedaction(false);
    expect(filterOutput('Contact me at john@example.com')).toBe('Contact me at john@example.com');
    expect(filterOutput('Call 123-45-6789')).toBe('Call 123-45-6789');
  });

  describe('when enabled', () => {
    it('redacts email addresses', () => {
      enablePiiRedaction(true);
      expect(filterOutput('Email john.doe@example.com for details')).toBe('Email ***EMAIL_REDACTED*** for details');
    });

    it('redacts multiple emails', () => {
      enablePiiRedaction(true);
      const input = 'Send to alice@test.org and bob@company.co.uk';
      const output = filterOutput(input);
      expect(output).toContain('***EMAIL_REDACTED***');
      expect(output).not.toContain('alice@');
      expect(output).not.toContain('bob@');
    });

    it('redacts US SSN', () => {
      enablePiiRedaction(true);
      expect(filterOutput('SSN: 123-45-6789')).toBe('SSN: ***SSN_REDACTED***');
    });

    it('does not redact invalid SSN (000, 666, 9xx prefix)', () => {
      enablePiiRedaction(true);
      expect(filterOutput('000-12-3456')).toBe('000-12-3456');
      expect(filterOutput('666-12-3456')).toBe('666-12-3456');
      expect(filterOutput('900-12-3456')).toBe('900-12-3456');
    });

    it('redacts credit card numbers with valid Luhn', () => {
      enablePiiRedaction(true);
      expect(filterOutput('Card: 4111 1111 1111 1111')).toBe('Card: ***CARD_REDACTED***');
      expect(filterOutput('Visa: 4111-1111-1111-1111')).toBe('Visa: ***CARD_REDACTED***');
    });

    it('does not redact credit card numbers with invalid Luhn', () => {
      enablePiiRedaction(true);
      expect(filterOutput('Not a card: 4111 1111 1111 1112')).toBe('Not a card: 4111 1111 1111 1112');
    });

    it('redacts Singapore NRIC', () => {
      enablePiiRedaction(true);
      expect(filterOutput('NRIC: S1234567D')).toBe('NRIC: ***NRIC_REDACTED***');
      expect(filterOutput('FIN: G1234567X')).toBe('FIN: ***NRIC_REDACTED***');
    });

    it('redacts phone numbers with country code', () => {
      enablePiiRedaction(true);
      expect(filterOutput('Call +65 (91) 234-5678')).toContain('***PHONE_REDACTED***');
    });

    it('secrets take priority over PII (DB URL with email-like user)', () => {
      enablePiiRedaction(true);
      const input = 'postgres://admin:pass@db.host.com:5432/mydb';
      const output = filterOutput(input);
      expect(output).toContain('***DB_URL_REDACTED***');
      expect(output).not.toContain('***EMAIL_REDACTED***');
    });

    it('redacts PII in streaming output via filterOutput', () => {
      enablePiiRedaction(true);
      const chunks = ['Contact ', 'john@example.com', ' for more info'];
      const full = chunks.join('');
      expect(filterOutput(full)).toBe('Contact ***EMAIL_REDACTED*** for more info');
    });
  });
});
