/**
 * QuerySpec → parameterised SQL, for Postgres and LibSQL.
 *
 * The contract this file has to keep, in one sentence: **no caller-supplied string ever appears in
 * the returned `sql`.** Identifiers came through `assertIdentifier` and are re-quoted here; values
 * are pushed onto `params` and referenced by placeholder. If a future edit ever interpolates a
 * value into the text, every other defence in this system becomes decoration, so the test suite
 * asserts the absence of caller strings in the SQL rather than merely the presence of placeholders.
 *
 * The second job is placeholder arithmetic. Postgres numbers parameters (`$1`, `$2`) while LibSQL
 * uses positional `?`, and the policy condition's parameters have to interleave with the query's
 * own in the exact order the driver will bind them. Getting that wrong on Postgres produces a
 * confusing error; getting it wrong on LibSQL produces *silently shifted values* — a filter that
 * compares the wrong column to the wrong value and still returns rows. So the injected condition
 * is compiled by this function, from a callback, rather than being handed in pre-numbered.
 */
import { InfraError } from './errors.js';
import type { Filter, QuerySpec } from './query-dsl.js';
import { IDENTIFIER_PATTERN, type SqlDialect } from './policy.js';

export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

/**
 * Produces the policy fragment, told where its parameters start AND which dialect to speak.
 *
 * The dialect is passed in rather than captured by the caller on purpose. A condition compiled as
 * postgres (`$1`) and spliced into a libsql statement (`?`) still *looks* fine — the text is valid,
 * the parameter array is the right length minus one, and every subsequent value binds to the wrong
 * column. Making the compiler dictate the dialect removes that mistake from the API.
 */
export type ConditionCompiler = (
  startIndex: number,
  dialect: SqlDialect,
) => { sql: string; params: unknown[] };

export interface CompileOptions {
  dialect: SqlDialect;
  /**
   * The server-side row filter. ANDed into WHERE, so a caller's own filters can only ever narrow
   * the result — there is no arrangement of client input that widens it.
   */
  condition?: ConditionCompiler;
}

function quote(identifier: string, dialect: SqlDialect): string {
  const value = identifier.trim().toLowerCase();
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new InfraError('VALIDATION_FAILED', 'invalid identifier reached the compiler', {
      details: { identifier },
    });
  }
  return dialect === 'postgres' ? `"${value}"` : `\`${value}\``;
}

const COMPARISONS: Readonly<Record<string, string>> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/** Collects parameters and hands out the right placeholder for the dialect. */
class Binder {
  readonly params: unknown[] = [];

  constructor(private readonly dialect: SqlDialect) {}

  bind(value: unknown): string {
    this.params.push(value);
    return this.dialect === 'postgres' ? `$${this.params.length}` : '?';
  }

  get nextIndex(): number {
    return this.params.length + 1;
  }

  /** Appends a pre-compiled fragment's parameters, keeping the two numbering schemes in step. */
  absorb(fragment: { sql: string; params: unknown[] }): string {
    this.params.push(...fragment.params);
    return fragment.sql;
  }
}

function compileFilter(filter: Filter, binder: Binder, dialect: SqlDialect): string {
  const column = quote(filter.column, dialect);

  switch (filter.op) {
    case 'is_null':
      return `${column} is null`;
    case 'is_not_null':
      return `${column} is not null`;
    case 'ilike':
      // lower() on both sides, on both dialects: see the note on FILTER_OPERATORS. The pattern is
      // still a bound parameter — only the function call is text.
      return `lower(${column}) like lower(${binder.bind(filter.value)})`;
    case 'in':
    case 'not_in': {
      const markers = filter.values.map((value) => binder.bind(value));
      return `${column} ${filter.op === 'in' ? 'in' : 'not in'} (${markers.join(', ')})`;
    }
    default: {
      // `= null` is never true in SQL; a caller filtering on null means IS NULL.
      if (filter.value === null) {
        return filter.op === 'eq' ? `${column} is null` : `${column} is not null`;
      }
      return `${column} ${COMPARISONS[filter.op]} ${binder.bind(filter.value)}`;
    }
  }
}

/**
 * Builds the WHERE clause: the server's condition first, then the caller's filters.
 *
 * Order matters for readability, not for correctness — but the policy fragment goes first so that
 * anyone reading a logged statement sees the security predicate before the application's own.
 */
function compileWhere(
  spec: QuerySpec,
  binder: Binder,
  dialect: SqlDialect,
  condition: ConditionCompiler | undefined,
): string {
  const clauses: string[] = [];

  if (condition !== undefined) {
    // Wrapped unconditionally: a fragment that is a bare `a or b` would, ANDed with the caller's
    // filters, bind more loosely than intended and widen the result. Redundant parentheses are a
    // cheap price for that never being possible.
    const fragment = condition(binder.nextIndex, dialect);
    clauses.push(`(${binder.absorb(fragment)})`);
  }

  for (const filter of spec.filters) clauses.push(compileFilter(filter, binder, dialect));

  if (clauses.length === 0) return '';
  return ` where ${clauses.join(' and ')}`;
}

function compileSelect(spec: QuerySpec, binder: Binder, options: CompileOptions): string {
  const { dialect } = options;
  const columns = spec.select.length === 0 ? '*' : spec.select.map((c) => quote(c, dialect)).join(', ');

  let sql = `select ${columns} from ${quote(spec.resource, dialect)}`;
  sql += compileWhere(spec, binder, dialect, options.condition);

  if (spec.order.length > 0) {
    const terms = spec.order.map((term) => `${quote(term.column, dialect)} ${term.direction}`);
    sql += ` order by ${terms.join(', ')}`;
  }

  // limit and offset are bound too. They are integers this module produced, so interpolating them
  // would be safe — binding them anyway means there is no "safe interpolation" precedent in here
  // for a future edit to copy.
  sql += ` limit ${binder.bind(spec.limit)}`;
  if (spec.offset > 0) sql += ` offset ${binder.bind(spec.offset)}`;

  return sql;
}

function compileInsert(spec: QuerySpec, binder: Binder, options: CompileOptions): string {
  const { dialect } = options;
  const first = spec.values[0];
  if (first === undefined) throw new InfraError('VALIDATION_FAILED', 'insert has no rows');

  // The parser guaranteed every row sets the same columns, so this one list describes them all.
  const columns = Object.keys(first);
  const columnSql = columns.map((c) => quote(c, dialect)).join(', ');

  const tuples = spec.values.map((row) => {
    const markers = columns.map((column) => binder.bind(row[column] ?? null));
    return `(${markers.join(', ')})`;
  });

  let sql = `insert into ${quote(spec.resource, dialect)} (${columnSql}) values ${tuples.join(', ')}`;
  if (spec.returning.length > 0) {
    sql += ` returning ${spec.returning.map((c) => quote(c, dialect)).join(', ')}`;
  }
  return sql;
}

function compileUpdate(spec: QuerySpec, binder: Binder, options: CompileOptions): string {
  const { dialect } = options;
  const row = spec.values[0];
  if (row === undefined) throw new InfraError('VALIDATION_FAILED', 'update has no values');

  const assignments = Object.entries(row).map(
    ([column, value]) => `${quote(column, dialect)} = ${binder.bind(value)}`,
  );

  // SET is bound before WHERE because that is the order the driver will bind them in.
  let sql = `update ${quote(spec.resource, dialect)} set ${assignments.join(', ')}`;
  sql += compileWhere(spec, binder, dialect, options.condition);

  if (spec.returning.length > 0) {
    sql += ` returning ${spec.returning.map((c) => quote(c, dialect)).join(', ')}`;
  }
  return sql;
}

function compileDelete(spec: QuerySpec, binder: Binder, options: CompileOptions): string {
  const { dialect } = options;
  let sql = `delete from ${quote(spec.resource, dialect)}`;
  sql += compileWhere(spec, binder, dialect, options.condition);

  if (spec.returning.length > 0) {
    sql += ` returning ${spec.returning.map((c) => quote(c, dialect)).join(', ')}`;
  }
  return sql;
}

export function compileQuerySpec(spec: QuerySpec, options: CompileOptions): CompiledQuery {
  const binder = new Binder(options.dialect);

  const sql =
    spec.action === 'select'
      ? compileSelect(spec, binder, options)
      : spec.action === 'insert'
        ? compileInsert(spec, binder, options)
        : spec.action === 'update'
          ? compileUpdate(spec, binder, options)
          : compileDelete(spec, binder, options);

  return { sql, params: binder.params };
}

/**
 * Fingerprint for the audit log: the statement shape with every literal already gone.
 *
 * Statements out of this compiler contain no literals by construction, so this is really a
 * belt-and-braces normaliser — and a canary. If a fingerprint ever contains something that looks
 * like data, the compiler has regressed.
 */
export function queryShape(spec: QuerySpec): string {
  const parts = [
    spec.action,
    spec.resource,
    spec.select.length === 0 ? '*' : spec.select.join('+'),
    spec.filters.map((f) => `${f.column}:${f.op}`).join('&'),
    spec.order.map((o) => `${o.column}:${o.direction}`).join('&'),
  ];
  return parts.filter((part) => part !== '').join('|');
}
