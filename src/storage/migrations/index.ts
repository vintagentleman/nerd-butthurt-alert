import type { Migration } from '../migrate.ts';
import migration001 from './001_init_probes.ts';

// Ordered list of all shipped migrations, consumed by runMigrations() at
// startup (T10's main()) and by the migration test suite.
export const MIGRATIONS: Migration[] = [migration001];
