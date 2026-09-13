import { describe, expect, it } from 'vitest';
import { corsHeaders, originAllowed, preflightResponse } from '../src/lib/cors';

const ALLOWED = ['https://learning.vercel.app', 'http://localhost:3001'];

describe('originAllowed', () => {
  it('accepts exactly the registered origins', () => {
    expect(originAllowed('https://learning.vercel.app', ALLOWED)).toBe(true);
    expect(originAllowed('http://localhost:3001', ALLOWED)).toBe(true);
  });

  it('rejects near-misses and anything unregistered', () => {
    for (const origin of [
      'https://learning.vercel.app.evil.com',
      'http://learning.vercel.app',
      'https://evil.com',
      '',
      null,
    ]) {
      expect(originAllowed(origin, ALLOWED)).toBe(false);
    }
  });
});

describe('corsHeaders', () => {
  it('echoes an allowed origin and varies on it', () => {
    const headers = corsHeaders('https://learning.vercel.app', ALLOWED);
    expect(headers['access-control-allow-origin']).toBe('https://learning.vercel.app');
    expect(headers['vary']).toBe('Origin');
  });

  it('never answers with a wildcard, and never allows credentials', () => {
    const headers = corsHeaders('https://learning.vercel.app', ALLOWED);
    expect(Object.values(headers)).not.toContain('*');
    expect(headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('gives an unregistered origin nothing to work with', () => {
    const headers = corsHeaders('https://evil.com', ALLOWED);
    expect(headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('preflightResponse', () => {
  it('answers 204 for a registered origin', () => {
    expect(preflightResponse('http://localhost:3001', ALLOWED).status).toBe(204);
  });

  it('answers 403 for an unregistered one instead of defaulting open', () => {
    expect(preflightResponse('https://evil.com', ALLOWED).status).toBe(403);
    expect(preflightResponse(null, ALLOWED).status).toBe(403);
  });
});
