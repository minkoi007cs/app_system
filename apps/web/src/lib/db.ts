import { masterDb } from '@infra/db';

export { masterDb };
export const db = () => masterDb();
