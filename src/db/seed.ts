/**
 * Crea el usuario administrador inicial y los registros únicos de Caja Fuerte.
 *   npm run db:seed
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { hashPassword, sha256Base64 } from '../lib/security.js';
import { db } from './index.js';

export async function seed() {
  const admin = await db.selectFrom('usuarios').select('id').where('email', '=', env.ADMIN_EMAIL).executeTakeFirst();
  if (!admin) {
    await db
      .insertInto('usuarios')
      .values({
        nombre: env.ADMIN_NOMBRE,
        email: env.ADMIN_EMAIL,
        passwordHash: await hashPassword(env.ADMIN_PASSWORD),
        rol: 'admin',
        activo: true,
        telefono: null,
      })
      .execute();
    console.log(`✓ Administrador creado: ${env.ADMIN_EMAIL}`);
  } else {
    console.log(`• El administrador ${env.ADMIN_EMAIL} ya existe`);
  }

  const caja = await db.selectFrom('cajaFuerte').select('id').executeTakeFirst();
  if (!caja) {
    await db.insertInto('cajaFuerte').defaultValues().execute();
    console.log('✓ Caja Fuerte inicializada en $0');
  }

  const config = await db.selectFrom('configuracionCajaFuerte').select('id').executeTakeFirst();
  if (!config) {
    await db
      .insertInto('configuracionCajaFuerte')
      .values({ passwordHash: sha256Base64(env.CAJA_FUERTE_PASSWORD), requiereCambioPassword: true })
      .execute();
    console.log('✓ Contraseña inicial de Caja Fuerte configurada (se pedirá cambiarla)');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  seed()
    .then(() => db.destroy())
    .catch(async (err) => {
      console.error('❌', err.message);
      await db.destroy();
      process.exit(1);
    });
}
