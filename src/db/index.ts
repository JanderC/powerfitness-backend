import pg from 'pg';
import { CamelCasePlugin, Kysely, PostgresDialect, type Transaction } from 'kysely';
import { env } from '../config/env.js';
import type { DB } from './types.js';

// numeric → number, date → 'YYYY-MM-DD', bigint (count) → number
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

/** Conexión a la BD de la app: DATABASE_URL o DB_HOST/DB_PORT/… */
export function connectionConfig(database?: string): pg.ClientConfig {
  const base: pg.ClientConfig = env.DATABASE_URL
    ? { connectionString: env.DATABASE_URL }
    : { host: env.DB_HOST, port: env.DB_PORT, database: database ?? env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD };
  return {
    ...base,
    ...(env.DB_SSL && { ssl: { rejectUnauthorized: false } }),
    // Los DEFAULT CURRENT_TIMESTAMP de la BD también quedan en hora de Colombia
    options: `-c timezone=${env.TZ}`,
  };
}

export const poolConfig: pg.PoolConfig = { ...connectionConfig(), max: 15 };

export const pool = new pg.Pool(poolConfig);

/** camelCase ↔ snake_case, con la excepción de huella_template_1..5 del esquema original. */
class GymCasePlugin extends CamelCasePlugin {
  protected override snakeCase(str: string): string {
    return super.snakeCase(str).replace(/^huella_template(\d)$/, 'huella_template_$1');
  }
}

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
  plugins: [new GymCasePlugin()],
});

export type Db = Kysely<DB> | Transaction<DB>;

export async function checkDatabase(): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}
