/**
 * Importa la INFORMACIÓN desde la base de datos del sistema .NET anterior (PostgreSQL local,
 * DB_HOST/DB_USER/DB_PASSWORD) hacia la BD de la app (DATABASE_URL si existe, p. ej. Railway).
 * (El esquema ya lo crea `npm run db:migrate`; este script solo copia datos.)
 *
 *   npm run db:import-legacy -- --from nosirve            (simulación, no escribe)
 *   npm run db:import-legacy -- --from nosirve --apply    (importa de verdad)
 *
 * - Copia tabla por tabla solo las columnas que existen en ambas bases.
 * - Los registros que ya existen (mismo id) se omiten: se puede ejecutar varias veces.
 * - Corrige datos huérfanos típicos del sistema anterior (usuario "sistema" 0000…,
 *   deudas sin cliente) para que respeten las nuevas llaves foráneas.
 */
import pg from 'pg';
import { env } from '../config/env.js';
import { connectionConfig } from './index.js';

const args = process.argv.slice(2);
const from = args[args.indexOf('--from') + 1];
const apply = args.includes('--apply');

if (!from || args.indexOf('--from') === -1) {
  console.error('Uso: npm run db:import-legacy -- --from <bd_origen> [--apply]');
  process.exit(1);
}

// Orden respetando dependencias
const TABLES = [
  'usuarios', 'clientes', 'planes', 'productos', 'empleados',
  'membresias', 'pagos', 'ventas_productos', 'checkins', 'notificaciones',
  'cierres_caja', 'movimientos_caja', 'caja_fuerte', 'configuracion_caja_fuerte',
  'movimientos_caja_fuerte', 'consolidados_mensuales', 'movimientos_eliminados',
  'pagos_empleados', 'deudas_clientes', 'abonos_deuda',
];

const base = { host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD };

async function columns(c: pg.Client, table: string) {
  const { rows } = await c.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_schema='public' and table_name=$1`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

async function main() {
  const src = new pg.Client({ ...base, database: from });
  const dst = new pg.Client(connectionConfig());
  await src.connect();
  await dst.connect();
  console.log(`Origen: ${from} (local)  →  Destino: ${env.DATABASE_URL ? 'DATABASE_URL' : env.DB_NAME}  ${apply ? '(APLICANDO)' : '(simulación)'}`);

  const admin = await dst.query<{ id: string }>(
    `select id from usuarios where rol='admin' and activo order by created_at limit 1`,
  );
  const adminId = admin.rows[0]?.id;

  await dst.query('begin');
  try {
    for (const table of TABLES) {
      const srcCols = await columns(src, table);
      if (!srcCols.size) {
        console.log(`• ${table}: no existe en origen, se omite`);
        continue;
      }
      const dstCols = await columns(dst, table);
      const cols = [...srcCols].filter((c) => dstCols.has(c));
      // Tablas de un solo registro: se reemplaza el creado por el seed con el más reciente del sistema anterior
      const singleton = table === 'caja_fuerte' || table === 'configuracion_caja_fuerte';
      if (singleton) await dst.query(`delete from "${table}"`);
      const { rows } = await src.query(
        `select ${cols.map((c) => `"${c}"`).join(',')} from "${table}"${singleton ? ' order by updated_at desc nulls last limit 1' : ''}`,
      );
      let inserted = 0;
      for (const row of rows) {
        if (table === 'deudas_clientes' && row.estado && !['pendiente', 'pagada', 'vencida', 'cancelada'].includes(row.estado)) {
          row.estado = 'pendiente';
        }
        if ((table === 'cierres_caja' || table === 'movimientos_caja_fuerte') && adminId) {
          const ok = await dst.query('select 1 from usuarios where id=$1', [row.usuario_id]);
          if (!ok.rowCount) row.usuario_id = adminId;
        }
        if (table === 'deudas_clientes') {
          const ok = await dst.query('select 1 from clientes where id=$1', [row.cliente_id]);
          if (!ok.rowCount) {
            console.log(`  ⚠ deuda ${row.id} sin cliente válido, se omite`);
            continue;
          }
        }
        const values = cols.map((c) => row[c]);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
        const res = await dst.query(
          `insert into "${table}" (${cols.map((c) => `"${c}"`).join(',')}) values (${placeholders}) on conflict do nothing`,
          values,
        );
        inserted += res.rowCount ?? 0;
      }
      console.log(`✓ ${table}: ${inserted}/${rows.length} registros`);
    }
    if (apply) {
      await dst.query('commit');
      console.log('✅ Importación completada');
    } else {
      await dst.query('rollback');
      console.log('ℹ Simulación terminada (no se guardó nada). Usa --apply para importar.');
    }
  } catch (err) {
    await dst.query('rollback');
    console.error('❌ Error, no se importó nada:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await dst.end();
  }
}

main();
