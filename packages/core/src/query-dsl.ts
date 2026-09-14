/**
 * The typed query grammar child apps send instead of SQL.
 *
 * The whole reason this exists: `/api/v1/query` takes raw SQL, so it can only ever be given to a
 * server holding an `sk_` key. A browser needs a way to read data too, and the only safe way to
 * give it one is to stop accepting SQL. Here, every string that reaches the statement text is
 * either a keyword this file chose or an identifier that passed `IDENTIFIER_PATTERN`; every value
 * the caller supplies becomes a bound parameter and nothing else. There is deliberately no escape
 * hatch — no `raw`, no `sql` fragment, no `having` free-text — because one escape hatch makes the
 * other ninety-nine rules decorative.
 *
 * Three rules here are safety rather than taste:
 *
 *   - **Unknown keys are refused, not ignored.** A client that sends `wheres` instead of `where`
 *     and gets a silent unfiltered result is worse off than one that gets an error: it believes it
 *     filtered. Every object in this grammar is closed.
 *   - **`update` and `delete` require at least one filter.** The policy condition is ANDed in, but
 *     a permissive policy compiles to `1 = 1`, and `delete from notes where 1 = 1` is the whole
 *     table. A missing WHERE must be impossible to express, not merely unlikely.
 *   - **`limit` is capped and defaulted.** An unbounded select against a 0.5 GB free-tier database
 *     is a denial of service that costs the attacker one request.
 */
import { InfraError } from './errors.js';
// One identifier rule for the whole system: the policy engine and this grammar must agree on what
// a column name is, or a name one of them accepts could reach SQL the other never checked.
import { IDENTIFIER_PATTERN } from './policy.js';

export const QUERY_ACTIONS = ['select', 'insert', 'update', 'delete'] as const;
export type QueryAction = (typeof QUERY_ACTIONS)[number];

/**
 * `ilike` is the only pattern operator, and it is case-insensitive on every dialect.
 *
 * Postgres `LIKE` is case-sensitive; SQLite `LIKE` is case-insensitive for ASCII. Offering `like`
 * would mean the same query quietly returns different rows depending on which free-tier provider
 * an app happens to sit on. One operator with one meaning is worth more than two with a trap.
 */
export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gte',
  'gt',
  'in',
  'not_in',
  'ilike',
  'is_null',
  'is_not_null',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type JsonScalar = string | number | boolean | null;

export type Filter =
  | { column: string; op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'; value: JsonScalar }
  | { column: string; op: 'ilike'; value: string }
  | { column: string; op: 'in' | 'not_in'; values: JsonScalar[] }
  | { column: string; op: 'is_null' | 'is_not_null' };

export interface OrderTerm {
  column: string;
  direction: 'asc' | 'desc';
}

export type QueryRow = Record<string, JsonScalar>;

export interface QuerySpec {
  resource: string;
  action: QueryAction;
  /** Empty means every column. Never a free-text expression. */
  select: string[];
  filters: Filter[];
  order: OrderTerm[];
  limit: number;
  offset: number;
  /** insert / update only. Always at least one row for insert, exactly one for update. */
  values: QueryRow[];
  returning: string[];
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1_000;
export const MAX_FILTERS = 25;
export const MAX_IN_VALUES = 200;
export const MAX_INSERT_ROWS = 100;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_COLUMNS = 100;

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new InfraError('VALIDATION_FAILED', message, { details });
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Closed-object check. See the header: a silently ignored key is a silently dropped filter. */
function rejectUnknownKeys(source: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`unknown ${what} field(s): ${unknown.join(', ')}`, { unknown });
}

/**
 * Names that pass the identifier pattern but must never be accepted as columns.
 *
 * Found by the adversarial suite. `__proto__` is a legal-looking identifier — letters and
 * underscores — so the pattern admits it, and `row['__proto__'] = 'x'` on a plain object silently
 * sets nothing at all: the key vanishes, the column list comes back empty, and the compiler emits
 * `insert into "notes" () values ()`. Rejecting the three reserved names is clearer than switching
 * the row to a null-prototype object, because it also keeps them out of select, order and
 * returning, where they would be equally surprising.
 */
const RESERVED_IDENTIFIERS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

export function assertIdentifier(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`${what} must be a string`);
  const normalised = value.trim().toLowerCase();
  if (!IDENTIFIER_PATTERN.test(normalised)) {
    // The offending value is echoed because it is the caller's own input, never a secret.
    fail(`${what} is not a valid identifier: "${value}"`, { value });
  }
  if (RESERVED_IDENTIFIERS.includes(normalised)) {
    fail(`${what} may not be "${normalised}"`, { value: normalised });
  }
  return normalised;
}

function assertScalar(value: unknown, what: string): JsonScalar {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value as JsonScalar;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) fail(`${what} must be a finite number`);
    return value as number;
  }
  // Objects and arrays are refused rather than stringified: a driver that receives one is the
  // start of a type-confusion bug, and JSON columns can be written as strings deliberately.
  fail(`${what} must be a string, number, boolean or null`);
}

function parseFilter(raw: unknown, index: number): Filter {
  const source = asObject(raw, `filter[${index}]`);
  rejectUnknownKeys(source, ['column', 'op', 'value', 'values'], `filter[${index}]`);

  const column = assertIdentifier(source['column'], `filter[${index}].column`);
  const op = source['op'];

  if (typeof op !== 'string' || !(FILTER_OPERATORS as readonly string[]).includes(op)) {
    fail(`filter[${index}].op must be one of: ${FILTER_OPERATORS.join(', ')}`, { op });
  }

  const operator = op as FilterOperator;

  if (operator === 'is_null' || operator === 'is_not_null') {
    if ('value' in source || 'values' in source) {
      fail(`filter[${index}].${operator} takes no value`);
    }
    return { column, op: operator };
  }

  if (operator === 'in' || operator === 'not_in') {
    const values = source['values'];
    if (!Array.isArray(values)) fail(`filter[${index}].${operator} requires "values" as an array`);
    if (values.length === 0) fail(`filter[${index}].${operator} requires at least one value`);
    if (values.length > MAX_IN_VALUES) {
      fail(`filter[${index}].${operator} accepts at most ${MAX_IN_VALUES} values`);
    }
    return {
      column,
      op: operator,
      values: values.map((value, i) => assertScalar(value, `filter[${index}].values[${i}]`)),
    };
  }

  if (operator === 'ilike') {
    const value = source['value'];
    if (typeof value !== 'string') fail(`filter[${index}].ilike requires a string pattern`);
    if (value.length > MAX_PATTERN_LENGTH) {
      fail(`filter[${index}].ilike pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
    }
    return { column, op: 'ilike', value };
  }

  return { column, op: operator, value: assertScalar(source['value'], `filter[${index}].value`) };
}

function parseOrder(raw: unknown, index: number): OrderTerm {
  const source = asObject(raw, `order[${index}]`);
  rejectUnknownKeys(source, ['column', 'direction'], `order[${index}]`);

  const column = assertIdentifier(source['column'], `order[${index}].column`);
  const direction = source['direction'] ?? 'asc';
  if (direction !== 'asc' && direction !== 'desc') {
    fail(`order[${index}].direction must be "asc" or "desc"`);
  }
  return { column, direction };
}

function parseRow(raw: unknown, index: number): QueryRow {
  const source = asObject(raw, `values[${index}]`);
  const entries = Object.entries(source);
  if (entries.length === 0) fail(`values[${index}] must set at least one column`);
  if (entries.length > MAX_COLUMNS) fail(`values[${index}] sets more than ${MAX_COLUMNS} columns`);

  const row: QueryRow = {};
  for (const [key, value] of entries) {
    row[assertIdentifier(key, `values[${index}] column name`)] = assertScalar(
      value,
      `values[${index}].${key}`,
    );
  }
  return row;
}

function parseColumnList(raw: unknown, what: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`${what} must be an array of column names`);
  if (raw.length > MAX_COLUMNS) fail(`${what} lists more than ${MAX_COLUMNS} columns`);
  return raw.map((value, index) => assertIdentifier(value, `${what}[${index}]`));
}

function parseBoundedInteger(raw: unknown, what: string, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    fail(`${what} must be a non-negative integer`);
  }
  if (raw > max) fail(`${what} must be at most ${max}`, { max });
  return raw;
}

const TOP_LEVEL_KEYS = [
  'resource',
  'action',
  'select',
  'filters',
  'order',
  'limit',
  'offset',
  'values',
  'returning',
] as const;

/**
 * Parses untrusted JSON into a QuerySpec, or throws.
 *
 * `resource` is accepted here as a syntactically valid identifier only. Whether this caller may
 * touch that table at all is the policy engine's decision, made by the gateway — this function
 * deliberately knows nothing about who is asking.
 */
export function parseQuerySpec(raw: unknown, resourceFromPath?: string): QuerySpec {
  const source = asObject(raw, 'query');
  rejectUnknownKeys(source, TOP_LEVEL_KEYS, 'query');

  const resource = assertIdentifier(source['resource'] ?? resourceFromPath, 'resource');

  const action = source['action'] ?? 'select';
  if (typeof action !== 'string' || !(QUERY_ACTIONS as readonly string[]).includes(action)) {
    fail(`action must be one of: ${QUERY_ACTIONS.join(', ')}`, { action });
  }

  const rawFilters = source['filters'] ?? [];
  if (!Array.isArray(rawFilters)) fail('filters must be an array');
  if (rawFilters.length > MAX_FILTERS) fail(`at most ${MAX_FILTERS} filters are accepted`);
  const filters = rawFilters.map(parseFilter);

  const rawOrder = source['order'] ?? [];
  if (!Array.isArray(rawOrder)) fail('order must be an array');
  const order = rawOrder.map(parseOrder);

  const spec: QuerySpec = {
    resource,
    action: action as QueryAction,
    select: parseColumnList(source['select'], 'select'),
    filters,
    order,
    limit: parseBoundedInteger(source['limit'], 'limit', DEFAULT_LIMIT, MAX_LIMIT),
    offset: parseBoundedInteger(source['offset'], 'offset', 0, Number.MAX_SAFE_INTEGER),
    values: [],
    returning: parseColumnList(source['returning'], 'returning'),
  };

  const rawValues = source['values'];

  if (spec.action === 'insert') {
    const rows = Array.isArray(rawValues) ? rawValues : [rawValues];
    if (rawValues === undefined) fail('insert requires "values"');
    if (rows.length === 0) fail('insert requires at least one row');
    if (rows.length > MAX_INSERT_ROWS) fail(`insert accepts at most ${MAX_INSERT_ROWS} rows`);

    spec.values = rows.map(parseRow);

    // Every row must set the same columns: a ragged batch has no single column list, and guessing
    // one means silently writing NULL over a column the caller thought they were setting.
    const shape = Object.keys(spec.values[0] ?? {}).sort().join(',');
    for (const [index, row] of spec.values.entries()) {
      if (Object.keys(row).sort().join(',') !== shape) {
        fail(`values[${index}] does not set the same columns as values[0]`);
      }
    }

    if (spec.filters.length > 0) fail('insert does not take filters');
  } else if (spec.action === 'update') {
    if (rawValues === undefined) fail('update requires "values"');
    if (Array.isArray(rawValues)) fail('update takes a single row of values, not an array');
    spec.values = [parseRow(rawValues, 0)];
  } else if (rawValues !== undefined) {
    fail(`${spec.action} does not take "values"`);
  }

  // See the header: a permissive policy compiles to `1 = 1`, so a filterless update or delete
  // would rewrite or empty the table.
  if ((spec.action === 'update' || spec.action === 'delete') && spec.filters.length === 0) {
    fail(`${spec.action} requires at least one filter`);
  }

  if (spec.action !== 'select' && (spec.order.length > 0 || source['limit'] !== undefined)) {
    fail(`${spec.action} does not take order or limit`);
  }

  return spec;
}
