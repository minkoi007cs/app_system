import { describe, expect, it } from 'vitest';
import { sqlIntent } from '../src/lib/sql-intent';
import { DEFAULT_LIMIT, localRefusal, sweep } from '../src/lib/rate-limit';

describe('sqlIntent', () => {
  it('treats plain selects as reads', () => {
    expect(sqlIntent('select * from notes')).toBe('read');
    expect(sqlIntent('  SELECT 1  ')).toBe('read');
    expect(sqlIntent('with recent as (select 1) select * from recent')).toBe('read');
  });

  it('treats mutations as writes', () => {
    for (const sql of [
      'insert into notes (id) values ($1)',
      'UPDATE notes set title = $1',
      'delete from notes where id = $1',
      'drop table notes',
      'alter table notes add column x int',
      'truncate notes',
    ]) {
      expect(sqlIntent(sql)).toBe('write');
    }
  });

  it('is not fooled by a leading comment', () => {
    expect(sqlIntent('-- harmless\n delete from notes')).toBe('write');
    expect(sqlIntent('/* block */ update notes set a = 1')).toBe('write');
  });

  it('treats select … for update as a write', () => {
    expect(sqlIntent('select * from notes for update')).toBe('write');
  });
});

describe('rate limit — the local layer', () => {
  // The shared counter in the Master DB is the authority; this layer exists only to turn away
  // abusive traffic without a round trip. So the property under test is negative.

  it('never returns an allowed verdict — it can only refuse or defer', () => {
    const key = `key-${Math.random()}`;
    const now = 1_000_000;

    for (let i = 0; i < DEFAULT_LIMIT + 50; i += 1) {
      const verdict = localRefusal(key, DEFAULT_LIMIT, now);
      // Either "ask the shared store" (null) or a refusal. Never a local yes.
      if (verdict !== null) expect(verdict.allowed).toBe(false);
    }
  });

  it('defers while under the limit, then refuses', () => {
    const key = `key-${Math.random()}`;
    const now = 1_000_000;

    for (let i = 0; i < DEFAULT_LIMIT; i += 1) {
      expect(localRefusal(key, DEFAULT_LIMIT, now)).toBeNull();
    }
    expect(localRefusal(key, DEFAULT_LIMIT, now)?.allowed).toBe(false);
  });

  it('starts a new window once the old one has passed', () => {
    const key = `key-${Math.random()}`;
    expect(localRefusal(key, 1, 0)).toBeNull();
    expect(localRefusal(key, 1, 10)?.allowed).toBe(false);
    expect(localRefusal(key, 1, 60_001)).toBeNull();
  });

  it('keeps separate budgets per identity', () => {
    expect(localRefusal(`a-${Math.random()}`, 1, 0)).toBeNull();
    expect(localRefusal(`b-${Math.random()}`, 1, 0)).toBeNull();
  });

  it('sweeps closed windows', () => {
    const key = `key-${Math.random()}`;
    localRefusal(key, 1, 0);
    sweep(120_000);
    expect(localRefusal(key, 1, 120_001)).toBeNull();
  });

  it('reports how long the refusal lasts', () => {
    const key = `key-${Math.random()}`;
    localRefusal(key, 1, 0);
    const verdict = localRefusal(key, 1, 1_000);
    expect(verdict?.resetInMs).toBe(59_000);
    expect(verdict?.remaining).toBe(0);
  });
});
