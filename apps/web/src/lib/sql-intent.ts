/** Decides whether a statement needs db:write, so read-only keys stay read-only. */
const WRITE_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'merge',
  'create',
  'drop',
  'alter',
  'truncate',
  'grant',
  'revoke',
  'copy',
  'vacuum',
];

export type SqlIntent = 'read' | 'write';

export function sqlIntent(sql: string): SqlIntent {
  const normalised = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .toLowerCase();

  const firstWord = normalised.split(/[\s(;]+/)[0] ?? '';
  if (WRITE_KEYWORDS.includes(firstWord)) return 'write';
  // `with … insert` / `select … for update` also mutate.
  if (/\breturning\b/.test(normalised) && WRITE_KEYWORDS.some((word) => normalised.includes(`${word} `))) {
    return 'write';
  }
  if (/\bfor\s+update\b/.test(normalised)) return 'write';
  return 'read';
}
