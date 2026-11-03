import { Router, type NextFunction, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import type { MovimientoCajaFuerte } from '../db/types.js';
import { addDays, isDateStr, nombreMes, parseDateStr, startOfMonth, toDateStr } from '../lib/dates.js';
import { ah, badRequest, notFound, parse, unauthorized } from '../lib/http.js';
import { cop, r2, sum, totalesMovimientos } from '../lib/money.js';
import { sha256Base64 } from '../lib/security.js';
import { userId } from '../middleware/auth.js';
import { ajustarBalance, balancePublico, obtenerCajaFuerte, registrarMovimientoCaja } from './caja.service.js';

export const cajaFuerteRouter = Router();

const ORIGEN_LABEL: Record<string, string> = {
  cierre_caja: 'Cierre de Caja',
  retiro_manual: 'Retiro Manual',
  transferencia_a_caja: 'Transferencia a Caja Diaria',
  transferencia_desde_caja: 'Transferencia desde Caja Diaria',
  ingreso_manual: 'Ingreso Manual',
  otros: 'Otro',
};

async function obtenerConfig() {
  let c = await db.selectFrom('configuracionCajaFuerte').selectAll().executeTakeFirst();
  if (!c) {
    c = await db
      .insertInto('configuracionCajaFuerte')
      .values({ passwordHash: sha256Base64(env.CAJA_FUERTE_PASSWORD), requiereCambioPassword: true })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  return c;
}

// ───────── Acceso con contraseña ─────────
// Antes la contraseña solo se validaba en el navegador y la API quedaba abierta.
// Ahora verificar-password entrega un token de 4 horas que exigen todos los endpoints.
cajaFuerteRouter.post(
  '/verificar-password',
  ah(async (req, res) => {
    const { password } = parse(z.object({ password: z.string().min(1, 'Ingresa la contraseña') }), req.body);
    const c = await obtenerConfig();
    if (sha256Base64(password) !== c.passwordHash) return res.json({ success: false, message: 'Contraseña incorrecta' });
    const cfToken = jwt.sign({ scope: 'caja_fuerte', uid: req.user!.id }, env.JWT_SECRET, { expiresIn: '4h' });
    res.json({ success: true, cfToken, requiereCambio: c.requiereCambioPassword });
  }),
);

function requireCfToken(req: Request, _res: Response, next: NextFunction) {
  const t = req.headers['x-cf-token'];
  try {
    const p = jwt.verify(String(t ?? ''), env.JWT_SECRET) as { scope?: string; uid?: string };
    if (p.scope !== 'caja_fuerte' || p.uid !== req.user?.id) throw new Error();
    next();
  } catch {
    next(unauthorized('Acceso a Caja Fuerte expirado. Ingresa la contraseña nuevamente.'));
  }
}
cajaFuerteRouter.use(requireCfToken);

cajaFuerteRouter.post(
  '/cambiar-password',
  ah(async (req, res) => {
    const b = parse(
      z.object({ passwordActual: z.string().min(1), passwordNueva: z.string().min(4, 'Mínimo 4 caracteres') }),
      req.body,
    );
    const c = await obtenerConfig();
    if (sha256Base64(b.passwordActual) !== c.passwordHash) return res.json({ success: false, message: 'Contraseña actual incorrecta' });
    await db
      .updateTable('configuracionCajaFuerte')
      .set({ passwordHash: sha256Base64(b.passwordNueva), requiereCambioPassword: false })
      .where('id', '=', c.id)
      .execute();
    res.json({ success: true, message: 'Contraseña cambiada exitosamente' });
  }),
);

// ───────── Balances ─────────
cajaFuerteRouter.get(
  '/balances',
  ah(async (_req, res) => {
    const cf = await obtenerCajaFuerte();
    const ahora = new Date();
    const movsMes = await db
      .selectFrom('movimientosCajaFuerte')
      .selectAll()
      .where('fecha', '>=', startOfMonth(ahora.getFullYear(), ahora.getMonth() + 1))
      .execute();
    const t = totalesMovimientos(movsMes);
    res.json({
      ...balancePublico(cf),
      ultimaActualizacion: cf.ultimaActualizacion,
      mes: {
        nombre: `${nombreMes(ahora.getMonth() + 1)} ${ahora.getFullYear()}`,
        ingresos: t.totalIngresos,
        egresos: t.totalEgresos,
        balance: t.balance,
        efectivo: t.efectivo,
        transferencia: t.transferencia,
      },
    });
  }),
);

/** Saldo acumulado después de cada movimiento (desde el primer registro histórico). */
function saldosAcumulados(todos: MovimientoCajaFuerte[]) {
  const orden = [...todos].sort(
    (a, b) => +new Date(a.fecha) - +new Date(b.fecha) || +new Date(a.createdAt) - +new Date(b.createdAt),
  );
  const mapa = new Map<string, { efectivo: number; transferencia: number; total: number }>();
  let ef = 0;
  let tr = 0;
  for (const m of orden) {
    const s = m.tipo === 'ingreso' ? 1 : -1;
    if (m.metodoPago === 'efectivo') ef = r2(ef + s * m.monto);
    else tr = r2(tr + s * m.monto);
    mapa.set(m.id, { efectivo: ef, transferencia: tr, total: r2(ef + tr) });
  }
  return mapa;
}

cajaFuerteRouter.get(
  '/movimientos',
  ah(async (req, res) => {
    const q = parse(
      z.object({
        vista: z.enum(['diario', 'semanal', 'mensual', 'rango']).default('mensual'),
        fecha: z.string().refine(isDateStr).optional(),
        desde: z.string().refine(isDateStr).optional(),
        hasta: z.string().refine(isDateStr).optional(),
        tipo: z.enum(['ingreso', 'egreso']).optional(),
        metodoPago: z.enum(['efectivo', 'transferencia']).optional(),
      }),
      req.query,
    );
    const base = q.fecha ? q.fecha.slice(0, 10) : toDateStr(new Date());
    let desde: string;
    let hasta: string; // exclusivo
    if (q.desde && q.hasta) {
      desde = q.desde.slice(0, 10);
      hasta = addDays(q.hasta.slice(0, 10), 1);
    } else if (q.vista === 'diario') {
      desde = base;
      hasta = addDays(base, 1);
    } else if (q.vista === 'semanal') {
      const dow = (parseDateStr(base).getDay() + 6) % 7; // lunes = 0
      desde = addDays(base, -dow);
      hasta = addDays(desde, 7);
    } else {
      desde = `${base.slice(0, 7)}-01`;
      const d = parseDateStr(desde);
      hasta = toDateStr(new Date(d.getFullYear(), d.getMonth() + 1, 1));
    }

    const todos = await db.selectFrom('movimientosCajaFuerte').selectAll().execute();
    const saldos = saldosAcumulados(todos);
    let movs = todos.filter((m) => {
      const f = toDateStr(new Date(m.fecha));
      return f >= desde && f < hasta;
    });
    if (q.tipo) movs = movs.filter((m) => m.tipo === q.tipo);
    if (q.metodoPago) movs = movs.filter((m) => m.metodoPago === q.metodoPago);
    movs.sort((a, b) => +new Date(b.fecha) - +new Date(a.fecha) || +new Date(b.createdAt) - +new Date(a.createdAt));

    const proyectar = (m: MovimientoCajaFuerte) => ({
      ...m,
      origenLabel: ORIGEN_LABEL[m.origen] ?? m.origen,
      saldoDespues: saldos.get(m.id),
    });

    const porDia = new Map<string, MovimientoCajaFuerte[]>();
    for (const m of movs) {
      const k = toDateStr(new Date(m.fecha));
      porDia.set(k, [...(porDia.get(k) ?? []), m]);
    }

    res.json({
      periodo: { desde, hasta: addDays(hasta, -1) },
      movimientos: movs.map(proyectar),
      movimientosPorDia: [...porDia.entries()].map(([fecha, ms]) => ({
        fecha,
        ...totalesMovimientos(ms),
        cantidad: ms.length,
        saldoAlFinalDia: saldos.get(ms[0].id),
        movimientos: ms.map(proyectar),
      })),
      totales: totalesMovimientos(movs),
    });
  }),
);

const movSchema = z.object({
  metodoPago: z.enum(['efectivo', 'transferencia']),
  monto: z.coerce.number().positive('El monto debe ser mayor a 0'),
  descripcion: z.string().trim().min(1, 'Describe el movimiento').max(500),
  categoria: z.string().trim().max(50).nullish(),
});

cajaFuerteRouter.post(
  '/egreso',
  ah(async (req, res) => {
    const b = parse(movSchema, req.body);
    const uid = userId(req);
    const cf = await db.transaction().execute(async (trx) => {
      const actual = await obtenerCajaFuerte(trx);
      const disponible = b.metodoPago === 'efectivo' ? actual.balanceEfectivo : actual.balanceTransferencias;
      if (disponible < b.monto) throw badRequest(`Saldo insuficiente en ${b.metodoPago}. Disponible: ${cop(disponible)}`);
      await trx
        .insertInto('movimientosCajaFuerte')
        .values({ ...b, categoria: b.categoria ?? null, tipo: 'egreso', origen: 'retiro_manual', usuarioId: uid, cierreCajaId: null, movimientoCajaId: null, fecha: new Date() })
        .execute();
      return ajustarBalance(trx, b.metodoPago, -b.monto);
    });
    res.json({ success: true, message: 'Egreso registrado', balanceActual: balancePublico(cf) });
  }),
);

cajaFuerteRouter.post(
  '/ingreso',
  ah(async (req, res) => {
    const b = parse(movSchema, req.body);
    const uid = userId(req);
    const cf = await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('movimientosCajaFuerte')
        .values({ ...b, categoria: b.categoria ?? null, tipo: 'ingreso', origen: 'ingreso_manual', usuarioId: uid, cierreCajaId: null, movimientoCajaId: null, fecha: new Date() })
        .execute();
      return ajustarBalance(trx, b.metodoPago, b.monto);
    });
    res.json({ success: true, message: 'Ingreso registrado', balanceActual: balancePublico(cf) });
  }),
);

/** Saca efectivo de la caja fuerte hacia la caja diaria (vínculo bidireccional de movimientos). */
cajaFuerteRouter.post(
  '/transferir-a-caja',
  ah(async (req, res) => {
    const b = parse(
      z.object({ monto: z.coerce.number().positive('El monto debe ser mayor a 0'), descripcion: z.string().trim().max(300).nullish() }),
      req.body,
    );
    const uid = userId(req);
    const cf = await db.transaction().execute(async (trx) => {
      const actual = await obtenerCajaFuerte(trx);
      if (actual.balanceEfectivo < b.monto) throw badRequest(`Saldo insuficiente en efectivo. Disponible: ${cop(actual.balanceEfectivo)}`);
      const desc = b.descripcion ? `Transferencia desde Caja Fuerte: ${b.descripcion}` : 'Transferencia desde Caja Fuerte';
      const movCaja = await registrarMovimientoCaja(trx, {
        tipo: 'ingreso',
        categoria: 'transferencia_cajafuerte',
        metodoPago: 'efectivo',
        monto: b.monto,
        descripcion: desc,
        referenciaId: null,
        usuarioId: uid,
      });
      const movCF = await trx
        .insertInto('movimientosCajaFuerte')
        .values({
          tipo: 'egreso',
          origen: 'transferencia_a_caja',
          metodoPago: 'efectivo',
          monto: b.monto,
          descripcion: desc,
          categoria: null,
          cierreCajaId: null,
          movimientoCajaId: movCaja.id,
          usuarioId: uid,
          fecha: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.updateTable('movimientosCaja').set({ movimientoCajaFuerteId: movCF.id }).where('id', '=', movCaja.id).execute();
      return ajustarBalance(trx, 'efectivo', -b.monto);
    });
    res.json({ success: true, message: `${cop(b.monto)} transferidos a Caja Diaria`, balanceActual: balancePublico(cf) });
  }),
);

cajaFuerteRouter.delete(
  '/movimientos/:id',
  ah(async (req, res) => {
    const motivo = parse(z.object({ motivo: z.string().trim().max(300).nullish() }), req.body ?? {}).motivo || 'Sin motivo especificado';
    const uid = userId(req);
    const cf = await db.transaction().execute(async (trx) => {
      const m = await trx.selectFrom('movimientosCajaFuerte').selectAll().where('id', '=', req.params.id).executeTakeFirst();
      if (!m) throw notFound('Movimiento no encontrado');
      if (m.origen === 'cierre_caja') {
        throw badRequest('No se pueden eliminar movimientos de cierre de caja. Para corregir, realice un ajuste manual.');
      }
      if (m.origen === 'transferencia_a_caja' && m.movimientoCajaId) {
        const espejo = await trx.selectFrom('movimientosCaja').selectAll().where('id', '=', m.movimientoCajaId).executeTakeFirst();
        if (espejo) {
          if (espejo.cerrado) {
            throw badRequest('El dinero transferido ya se incluyó en un cierre de Caja Diaria; no se puede eliminar.');
          }
          await trx
            .insertInto('movimientosEliminados')
            .values({
              movimientoOriginalId: espejo.id,
              moduloOrigen: 'caja_diaria',
              tipo: espejo.tipo,
              origen: 'caja_diaria [espejo eliminado desde caja-fuerte]',
              metodoPago: espejo.metodoPago || 'efectivo',
              monto: espejo.monto,
              descripcion: espejo.descripcion || '',
              categoria: espejo.categoria,
              fechaOriginal: espejo.fecha,
              fechaEliminacion: new Date(),
              usuarioEliminacion: uid,
              motivoEliminacion: `Eliminado automáticamente al borrar transferencia CF→Caja. Motivo: ${motivo}`,
            })
            .execute();
          await trx.updateTable('movimientosCajaFuerte').set({ movimientoCajaId: null }).where('id', '=', m.id).execute();
          await trx.deleteFrom('movimientosCaja').where('id', '=', espejo.id).execute();
        }
      }
      await trx
        .insertInto('movimientosEliminados')
        .values({
          movimientoOriginalId: m.id,
          moduloOrigen: 'caja_fuerte',
          tipo: m.tipo,
          origen: m.origen,
          metodoPago: m.metodoPago,
          monto: m.monto,
          descripcion: m.descripcion || '',
          categoria: m.categoria,
          fechaOriginal: m.fecha,
          fechaEliminacion: new Date(),
          usuarioEliminacion: uid,
          motivoEliminacion: motivo,
        })
        .execute();
      await trx.deleteFrom('movimientosCajaFuerte').where('id', '=', m.id).execute();
      return ajustarBalance(trx, m.metodoPago, m.tipo === 'ingreso' ? -m.monto : m.monto);
    });
    res.json({ success: true, message: 'Movimiento eliminado', balanceActual: balancePublico(cf) });
  }),
);

cajaFuerteRouter.get(
  '/eliminados',
  ah(async (_req, res) => {
    const rows = await db
      .selectFrom('movimientosEliminados as e')
      .leftJoin('usuarios as u', 'u.id', 'e.usuarioEliminacion')
      .selectAll('e')
      .select('u.nombre as usuarioNombre')
      .orderBy('e.fechaEliminacion', 'desc')
      .limit(300)
      .execute();
    res.json(rows);
  }),
);

// ───────── Consolidados mensuales ─────────
export async function calcularMes(mes: number, anio: number) {
  const movs = await db
    .selectFrom('movimientosCajaFuerte')
    .selectAll()
    .where('fecha', '>=', startOfMonth(anio, mes))
    .where('fecha', '<', new Date(anio, mes, 1))
    .execute();
  const t = totalesMovimientos(movs);
  const desglose = new Map<string, { origen: string; origenLabel: string; tipo: string; metodoPago: string; total: number; cantidad: number }>();
  for (const m of movs) {
    const k = `${m.origen}|${m.tipo}|${m.metodoPago}`;
    const d = desglose.get(k) ?? { origen: m.origen, origenLabel: ORIGEN_LABEL[m.origen] ?? m.origen, tipo: m.tipo, metodoPago: m.metodoPago, total: 0, cantidad: 0 };
    d.total = r2(d.total + m.monto);
    d.cantidad++;
    desglose.set(k, d);
  }
  return { movs, t, desglose: [...desglose.values()] };
}

export async function consolidarMes(mes: number, anio: number, recalcular = false) {
  const { movs, t } = await calcularMes(mes, anio);
  const values = {
    totalIngresosEfectivo: t.efectivo.ingresos,
    totalEgresosEfectivo: t.efectivo.egresos,
    totalIngresosTransferencia: t.transferencia.ingresos,
    totalEgresosTransferencia: t.transferencia.egresos,
    balanceFinalEfectivo: t.efectivo.balance,
    balanceFinalTransferencia: t.transferencia.balance,
    fechaConsolidacion: new Date(),
  };
  const existe = await db.selectFrom('consolidadosMensuales').select('id').where('mes', '=', mes).where('anio', '=', anio).executeTakeFirst();
  if (existe && !recalcular) throw badRequest(`Ya existe un consolidado para ${nombreMes(mes)} ${anio}. Usa "Recalcular".`);
  if (existe) await db.updateTable('consolidadosMensuales').set(values).where('id', '=', existe.id).execute();
  else await db.insertInto('consolidadosMensuales').values({ mes, anio, ...values }).execute();
  return movs.length;
}

const mesAnio = z.object({ mes: z.coerce.number().int().min(1).max(12), anio: z.coerce.number().int().min(2000).max(2100) });

cajaFuerteRouter.get(
  '/consolidados',
  ah(async (_req, res) => {
    const rows = await db.selectFrom('consolidadosMensuales').selectAll().orderBy('anio', 'desc').orderBy('mes', 'desc').execute();
    res.json(
      rows.map((c) => ({
        ...c,
        periodo: `${nombreMes(c.mes)} ${c.anio}`,
        totalIngresos: r2(c.totalIngresosEfectivo + c.totalIngresosTransferencia),
        totalEgresos: r2(c.totalEgresosEfectivo + c.totalEgresosTransferencia),
        balance: r2(c.balanceFinalEfectivo + c.balanceFinalTransferencia),
      })),
    );
  }),
);

cajaFuerteRouter.get(
  '/consolidados/preview',
  ah(async (req, res) => {
    const now = new Date();
    const { mes, anio } = parse(mesAnio, { mes: req.query.mes ?? now.getMonth() + 1, anio: req.query.anio ?? now.getFullYear() });
    const { t, desglose, movs } = await calcularMes(mes, anio);
    const existe = await db.selectFrom('consolidadosMensuales').select('id').where('mes', '=', mes).where('anio', '=', anio).executeTakeFirst();
    res.json({ mes, anio, periodo: `${nombreMes(mes)} ${anio}`, yaConsolidado: !!existe, cantidad: movs.length, ...t, desglose });
  }),
);

cajaFuerteRouter.post(
  '/consolidar-mes',
  ah(async (req, res) => {
    const { mes, anio, recalcular } = parse(mesAnio.extend({ recalcular: z.boolean().default(false) }), req.body);
    const now = new Date();
    if (anio === now.getFullYear() && mes === now.getMonth() + 1) throw badRequest('No se puede consolidar el mes en curso.');
    const n = await consolidarMes(mes, anio, recalcular);
    res.json({ success: true, message: `${nombreMes(mes)} ${anio} consolidado (${n} movimientos)` });
  }),
);

/** Resumen del mes combinando Caja Fuerte y ventas de Caja Diaria. */
cajaFuerteRouter.get(
  '/resumen-mes',
  ah(async (req, res) => {
    const now = new Date();
    const { mes, anio } = parse(mesAnio, { mes: req.query.mes ?? now.getMonth() + 1, anio: req.query.anio ?? now.getFullYear() });
    const { t, desglose } = await calcularMes(mes, anio);
    const movsCD = await db
      .selectFrom('movimientosCaja')
      .selectAll()
      .where('fecha', '>=', startOfMonth(anio, mes))
      .where('fecha', '<', new Date(anio, mes, 1))
      .orderBy('fecha')
      .execute();
    const porDia = new Map<string, typeof movsCD>();
    for (const m of movsCD) {
      const k = toDateStr(new Date(m.fecha));
      porDia.set(k, [...(porDia.get(k) ?? []), m]);
    }
    res.json({
      mes,
      anio,
      periodo: `${nombreMes(mes)} ${anio}`,
      cajaFuerte: { ...t, desglose },
      cajaDiaria: totalesMovimientos(movsCD),
      dias: [...porDia.entries()].map(([fecha, ms]) => ({ fecha, ...totalesMovimientos(ms), cantidad: ms.length, cerrado: ms.every((m) => m.cerrado) })),
      yaConsolidado: !!(await db.selectFrom('consolidadosMensuales').select('id').where('mes', '=', mes).where('anio', '=', anio).executeTakeFirst()),
    });
  }),
);

/** Exportación CSV de los movimientos de Caja Diaria del mes (abre directo en Excel). */
cajaFuerteRouter.get(
  '/exportar-mes.csv',
  ah(async (req, res) => {
    const now = new Date();
    const { mes, anio } = parse(mesAnio, { mes: req.query.mes ?? now.getMonth() + 1, anio: req.query.anio ?? now.getFullYear() });
    const movs = await db
      .selectFrom('movimientosCaja')
      .selectAll()
      .where('fecha', '>=', startOfMonth(anio, mes))
      .where('fecha', '<', new Date(anio, mes, 1))
      .orderBy('fecha')
      .execute();
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Fecha', 'Hora', 'Tipo', 'Categoría', 'Método', 'Descripción', 'Monto', 'Cerrado'].join(';'),
      ...movs.map((m) => {
        const f = new Date(m.fecha);
        return [
          toDateStr(f),
          f.toTimeString().slice(0, 5),
          m.tipo,
          m.categoria,
          m.metodoPago,
          esc(m.descripcion),
          String(m.tipo === 'ingreso' ? m.monto : -m.monto).replace('.', ','),
          m.cerrado ? 'Sí' : 'No',
        ].join(';');
      }),
      '',
      `Total ingresos;;;;;;${String(sum(movs.filter((m) => m.tipo === 'ingreso'), (m) => m.monto)).replace('.', ',')}`,
      `Total egresos;;;;;;${String(sum(movs.filter((m) => m.tipo === 'egreso'), (m) => m.monto)).replace('.', ',')}`,
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="caja-${anio}-${String(mes).padStart(2, '0')}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  }),
);

/** Detecta y corrige diferencias entre el balance guardado y la suma de movimientos. */
cajaFuerteRouter.get(
  '/diagnostico',
  ah(async (_req, res) => {
    const cf = await obtenerCajaFuerte();
    const t = totalesMovimientos(await db.selectFrom('movimientosCajaFuerte').selectAll().execute());
    const recalculado = { efectivo: t.efectivo.balance, transferencias: t.transferencia.balance, total: t.balance };
    res.json({
      guardado: balancePublico(cf),
      recalculado,
      inconsistencia: cf.balanceEfectivo !== recalculado.efectivo || cf.balanceTransferencias !== recalculado.transferencias,
    });
  }),
);

cajaFuerteRouter.post(
  '/sincronizar-balance',
  ah(async (_req, res) => {
    const cf = await obtenerCajaFuerte();
    const t = totalesMovimientos(await db.selectFrom('movimientosCajaFuerte').selectAll().execute());
    const nuevo = await db
      .updateTable('cajaFuerte')
      .set({
        balanceEfectivo: t.efectivo.balance,
        balanceTransferencias: t.transferencia.balance,
        balanceTotal: t.balance,
        ultimaActualizacion: new Date(),
      })
      .where('id', '=', cf.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json({ success: true, anterior: balancePublico(cf), nuevo: balancePublico(nuevo), message: 'Balance sincronizado' });
  }),
);
