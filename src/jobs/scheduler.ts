/**
 * Autonomía del sistema: tareas que antes había que hacer a mano
 * (en el sistema .NET los servicios automáticos estaban deshabilitados).
 */
import cron from 'node-cron';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { addDays, diffDays, formatDMY, parseDateStr, today } from '../lib/dates.js';
import { cerrarDiasPendientes } from '../modules/caja.service.js';
import { consolidarMes } from '../modules/caja-fuerte.routes.js';

const log = (msg: string) => console.log(`[${new Date().toLocaleString('es-CO')}] ⚙ ${msg}`);

/** Vence membresías, genera notificaciones de vencimiento y stock bajo, limpia antiguas. */
export async function revisionDiaria() {
  const hoy = today();
  const inicioHoy = parseDateStr(hoy);

  const vencidas = await db
    .updateTable('membresias')
    .set({ estado: 'vencida', updatedAt: hoy })
    .where('estado', '=', 'activa')
    .where('fechaVencimiento', '<', hoy)
    .returning(['clienteId', 'fechaVencimiento'])
    .execute();
  for (const m of vencidas) {
    const c = await db.selectFrom('clientes').select(['nombre', 'apellido']).where('id', '=', m.clienteId).executeTakeFirst();
    if (!c) continue;
    await db
      .insertInto('notificaciones')
      .values({
        tipo: 'membresia_vencida',
        titulo: 'Membresía vencida',
        mensaje: `La membresía de ${c.nombre} ${c.apellido} venció el ${formatDMY(m.fechaVencimiento)}`,
        clienteId: m.clienteId,
        prioridad: 'alta',
      })
      .execute();
  }

  const limite = addDays(hoy, env.DIAS_ALERTA_VENCIMIENTO);
  const proximas = await db
    .selectFrom('membresias as m')
    .innerJoin('clientes as c', 'c.id', 'm.clienteId')
    .select(['m.clienteId', 'm.fechaVencimiento', 'c.nombre', 'c.apellido'])
    .where('m.estado', '=', 'activa')
    .where('m.fechaVencimiento', '>=', hoy)
    .where('m.fechaVencimiento', '<=', limite)
    // Sin otra membresía posterior (ya renovó)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('membresias as n')
            .select('n.id')
            .whereRef('n.clienteId', '=', 'm.clienteId')
            .whereRef('n.fechaVencimiento', '>', 'm.fechaVencimiento'),
        ),
      ),
    )
    .execute();
  let nuevas = 0;
  for (const m of proximas) {
    const ya = await db
      .selectFrom('notificaciones')
      .select('id')
      .where('clienteId', '=', m.clienteId)
      .where('tipo', '=', 'vencimiento_proximo')
      .where('fechaCreacion', '>=', inicioHoy)
      .executeTakeFirst();
    if (ya) continue;
    const dias = diffDays(hoy, m.fechaVencimiento);
    await db
      .insertInto('notificaciones')
      .values({
        tipo: 'vencimiento_proximo',
        titulo: dias <= 3 ? '🔴 Membresía por vencer' : '🟡 Membresía por vencer',
        mensaje: `La membresía de ${m.nombre} ${m.apellido} ${dias === 0 ? 'vence HOY' : `vence en ${dias} día${dias === 1 ? '' : 's'}`}`,
        clienteId: m.clienteId,
        prioridad: dias <= 3 ? 'alta' : 'normal',
      })
      .execute();
    nuevas++;
  }

  const stock = await db.selectFrom('productos').select(['nombre', 'stock']).where('activo', '=', true).where('stock', '<=', env.STOCK_MINIMO).execute();
  const yaStock = await db
    .selectFrom('notificaciones')
    .select('id')
    .where('tipo', '=', 'stock_bajo')
    .where('fechaCreacion', '>=', inicioHoy)
    .executeTakeFirst();
  if (stock.length && !yaStock) {
    await db
      .insertInto('notificaciones')
      .values({
        tipo: 'stock_bajo',
        titulo: 'Stock bajo',
        mensaje: `${stock.length} producto(s) con stock bajo: ${stock
          .slice(0, 5)
          .map((p) => `${p.nombre} (${p.stock})`)
          .join(', ')}${stock.length > 5 ? '…' : ''}`,
        clienteId: null,
        prioridad: 'normal',
      })
      .execute();
  }

  await db
    .deleteFrom('notificaciones')
    .where('leida', '=', true)
    .where('fechaCreacion', '<', parseDateStr(addDays(hoy, -60)))
    .execute();

  log(`Revisión diaria: ${vencidas.length} vencidas, ${nuevas} avisos de vencimiento, ${stock.length} productos con stock bajo`);
}

/** El día 1 de cada mes consolida el mes anterior de Caja Fuerte. */
export async function consolidacionAutomatica() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const mes = prev.getMonth() + 1;
  const anio = prev.getFullYear();
  const existe = await db.selectFrom('consolidadosMensuales').select('id').where('mes', '=', mes).where('anio', '=', anio).executeTakeFirst();
  if (existe) return;
  const n = await consolidarMes(mes, anio);
  log(`Consolidado automático de ${mes}/${anio} (${n} movimientos)`);
}

async function usuarioSistema() {
  const u = await db.selectFrom('usuarios').select('id').where('rol', '=', 'admin').where('activo', '=', true).orderBy('createdAt').executeTakeFirst();
  return u?.id;
}

const safe = (name: string, fn: () => Promise<unknown>) => async () => {
  try {
    await fn();
  } catch (err) {
    console.error(`✗ Tarea "${name}" falló:`, (err as Error).message);
  }
};

export function iniciarTareas() {
  const tz = env.TZ;
  cron.schedule(env.JOB_VENCIMIENTOS_CRON, safe('revisión diaria', revisionDiaria), { timezone: tz });
  if (env.JOB_CONSOLIDACION_AUTO) {
    cron.schedule('30 0 1 * *', safe('consolidación', consolidacionAutomatica), { timezone: tz });
  }
  if (env.JOB_CIERRE_CAJA_AUTO) {
    cron.schedule(
      env.JOB_CIERRE_CAJA_CRON,
      safe('cierre automático', async () => {
        const uid = await usuarioSistema();
        if (!uid) return;
        const r = await cerrarDiasPendientes(uid);
        log(`Cierre automático de caja: ${r.length} día(s) cerrados`);
      }),
      { timezone: tz },
    );
  }
  // Al arrancar: ponerse al día por si el equipo estuvo apagado
  setTimeout(safe('revisión inicial', revisionDiaria), 3_000);
  if (env.JOB_CONSOLIDACION_AUTO) setTimeout(safe('consolidación inicial', consolidacionAutomatica), 5_000);

  console.log(
    `   ✓ Tareas automáticas: revisión diaria (${env.JOB_VENCIMIENTOS_CRON})` +
      `${env.JOB_CONSOLIDACION_AUTO ? ', consolidación mensual' : ''}` +
      `${env.JOB_CIERRE_CAJA_AUTO ? `, cierre de caja (${env.JOB_CIERRE_CAJA_CRON})` : ''}`,
  );
}
