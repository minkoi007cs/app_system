/**
 * `infra.from('notes').select('id', 'title').eq('done', false)` — the fluent face of the query DSL.
 *
 * The builder produces the same JSON the gateway validates; it has no privileges of its own and
 * skipping it changes nothing, because the server re-parses whatever arrives. That is the point: a
 * builder that the server trusted would be a builder an attacker could simply not use.
 *
 * It is a thin layer by design. Every method either appends a filter or sets a field, and the
 * terminal `run()` is the only thing that touches the network — so a half-built query costs
 * nothing and a typo is a TypeScript error rather than a silent unfiltered read.
 */
import { request } from './http.js';
import type { InfraClientOptions, Result } from './types.js';

export type JsonScalar = string | number | boolean | null;

export type QueryFilter =
  | { column: string; op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'; value: JsonScalar }
  | { column: string; op: 'ilike'; value: string }
  | { column: string; op: 'in' | 'not_in'; values: JsonScalar[] }
  | { column: string; op: 'is_null' | 'is_not_null' };

export interface QueryPayload {
  action: 'select' | 'insert' | 'update' | 'delete';
  select?: string[];
  filters?: QueryFilter[];
  order?: Array<{ column: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  offset?: number;
  values?: Record<string, JsonScalar> | Array<Record<string, JsonScalar>>;
  returning?: string[];
}

export interface QueryResponse<R> {
  rows: R[];
  rowCount: number;
  durationMs: number;
}

export class QueryBuilder<R = Record<string, unknown>> {
  private readonly filters: QueryFilter[] = [];
  private readonly order: Array<{ column: string; direction: 'asc' | 'desc' }> = [];
  private columns: string[] = [];
  private returningColumns: string[] = [];
  private action: QueryPayload['action'] = 'select';
  private rows: QueryPayload['values'];
  private limitValue: number | undefined;
  private offsetValue: number | undefined;

  constructor(
    private readonly options: InfraClientOptions,
    private readonly resource: string,
  ) {}

  select(...columns: string[]): this {
    this.columns = columns;
    return this;
  }

  eq(column: string, value: JsonScalar): this {
    this.filters.push({ column, op: 'eq', value });
    return this;
  }

  neq(column: string, value: JsonScalar): this {
    this.filters.push({ column, op: 'neq', value });
    return this;
  }

  gt(column: string, value: JsonScalar): this {
    this.filters.push({ column, op: 'gt', value });
    return this;
  }

  gte(column: string, value: JsonScalar): this {
    this.filters.push({ column, op: 'gte', value });
    return this;
  }

  lt(column: string, value: JsonScalar): this {
    this.filters.push({ column, op: 'lt', value });
    return this;
  }

  lte(column: string, value: JsonScalar): this {
    this.filters.push({ column, op: 'lte', value });
    return this;
  }

  /** Case-insensitive on every provider — see FILTER_OPERATORS in the core grammar. */
  ilike(column: string, pattern: string): this {
    this.filters.push({ column, op: 'ilike', value: pattern });
    return this;
  }

  in(column: string, values: JsonScalar[]): this {
    this.filters.push({ column, op: 'in', values });
    return this;
  }

  notIn(column: string, values: JsonScalar[]): this {
    this.filters.push({ column, op: 'not_in', values });
    return this;
  }

  isNull(column: string): this {
    this.filters.push({ column, op: 'is_null' });
    return this;
  }

  isNotNull(column: string): this {
    this.filters.push({ column, op: 'is_not_null' });
    return this;
  }

  orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): this {
    this.order.push({ column, direction });
    return this;
  }

  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  offset(count: number): this {
    this.offsetValue = count;
    return this;
  }

  returning(...columns: string[]): this {
    this.returningColumns = columns;
    return this;
  }

  insert(values: Record<string, JsonScalar> | Array<Record<string, JsonScalar>>): this {
    this.action = 'insert';
    this.rows = values;
    return this;
  }

  update(values: Record<string, JsonScalar>): this {
    this.action = 'update';
    this.rows = values;
    return this;
  }

  delete(): this {
    this.action = 'delete';
    return this;
  }

  /** The JSON that goes on the wire. Exposed so a caller can inspect or log it before sending. */
  toJSON(): QueryPayload {
    const payload: QueryPayload = { action: this.action };
    if (this.columns.length > 0) payload.select = this.columns;
    if (this.filters.length > 0) payload.filters = this.filters;
    if (this.order.length > 0) payload.order = this.order;
    if (this.limitValue !== undefined) payload.limit = this.limitValue;
    if (this.offsetValue !== undefined) payload.offset = this.offsetValue;
    if (this.rows !== undefined) payload.values = this.rows;
    if (this.returningColumns.length > 0) payload.returning = this.returningColumns;
    return payload;
  }

  async run(): Promise<Result<QueryResponse<R>>> {
    return request<QueryResponse<R>>(this.options, {
      method: 'POST',
      path: `/api/v1/data/${encodeURIComponent(this.resource)}`,
      body: this.toJSON(),
      useApiKey: true,
    });
  }

  /** Convenience for the common case — just the rows. */
  async rowsOnly(): Promise<Result<R[]>> {
    const result = await this.run();
    if (result.error !== null) return { data: null, error: result.error };
    return { data: result.data.rows, error: null };
  }

  /** Awaiting the builder directly runs it, so `await infra.from('notes').eq(...)` works. */
  then<TResult1 = Result<QueryResponse<R>>, TResult2 = never>(
    onfulfilled?: ((value: Result<QueryResponse<R>>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }
}
