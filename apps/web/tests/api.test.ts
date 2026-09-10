import { describe, expect, it } from 'vitest';
import { sqlIntent } from '../src/lib/sql-intent';
import { consume, DEFAULT_LIMIT, sweep } from '../src/lib/rate-limit';

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

describe('rate limit', () => {
  it('allows up to the limit inside one window', () => {
    const key = `key-${Math.random()}`;
    const now = 1_000_000;
    for (let i = 0; i < DEFAULT_LIMIT; i += 1) {
      expect(consume(key, DEFAULT_LIMIT, now).allowed).toBe(true);
    }
    expect(consume(key, DEFAULT_LIMIT, now).allowed).toBe(false);
  });

  it('resets after the window elapses', () => {
    const key = `key-${Math.random()}`;
    expect(consume(key, 1, 0).allowed).toBe(true);
    expect(consume(key, 1, 10).allowed).toBe(false);
    expect(consume(key, 1, 60_001).allowed).toBe(true);
  });

  it('keeps separate budgets per key', () => {
    expect(consume('key-a', 1, 0).allowed).toBe(true);
    expect(consume('key-b', 1, 0).allowed).toBe(true);
  });

  it('sweeps expired windows', () => {
    consume('key-sweep', 1, 0);
    sweep(120_000);
    expect(consume('key-sweep', 1, 120_001).allowed).toBe(true);
  });
});
