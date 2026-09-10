import { InfraError } from '@infra/core';

/** Rejects with DB_QUERY_TIMEOUT if the operation outlives its budget. */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  context: Record<string, unknown> = {},
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new InfraError('DB_QUERY_TIMEOUT', `query exceeded ${timeoutMs}ms`, { details: context }));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([operation, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
