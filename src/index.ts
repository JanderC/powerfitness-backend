import { exec } from 'node:child_process';
import { env, isProd } from './config/env.js';
import { createApp } from './app.js';
import { checkDatabase, db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { iniciarTareas } from './jobs/scheduler.js';

function abrirNavegador(url: string) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => undefined);
}

async function main() {
  // Autonomía: deja la base de datos lista sin pasos manuales
  try {
    await migrate();
    await seed();
  } catch (err) {
    console.error('❌ No se pudo preparar la base de datos:', (err as Error).message);
    console.error('   Revisa que PostgreSQL esté encendido y los datos DB_* del archivo .env');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    const url = `http://localhost:${env.PORT}`;
    console.log('═══════════════════════════════════════════════════════');
    console.log(`   ${env.GYM_NOMBRE} · Sistema de Gestión de Gimnasio`);
    console.log('═══════════════════════════════════════════════════════');
    console.log(`   ✓ API:            ${url}/api`);
    console.log(`   ✓ Zona horaria:   ${env.TZ} (${new Date().toLocaleString('es-CO')})`);
    const dbInfo = env.DATABASE_URL ? (() => { const u = new URL(env.DATABASE_URL); return `${u.pathname.slice(1)}@${u.hostname}:${u.port}`; })() : `${env.DB_NAME}@${env.DB_HOST}:${env.DB_PORT}`;
    console.log(`   ✓ Base de datos:  ${dbInfo}`);
    if (isProd) {
      console.log(`   📱 Kiosko:         ${url}/kiosko`);
      console.log(`   🎛  Panel:          ${url}/`);
    }
    iniciarTareas();
    console.log('═══════════════════════════════════════════════════════');
    if (isProd && env.ABRIR_NAVEGADOR) {
      abrirNavegador(`${url}/`);
      setTimeout(() => abrirNavegador(`${url}/kiosko`), 800);
    }
  });

  // Vigilancia de la conexión a la BD
  setInterval(async () => {
    if (!(await checkDatabase())) console.warn('⚠ Sin conexión a PostgreSQL, reintentando…');
  }, 60_000).unref();

  const shutdown = async () => {
    console.log('\nCerrando servidor…');
    server.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
