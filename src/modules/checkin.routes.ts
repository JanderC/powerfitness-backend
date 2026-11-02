import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { addDays, diffDays, isDateStr, parseDateStr, today } from '../lib/dates.js';
import { ah, badRequest, notFound, parse, unauthorized } from '../lib/http.js';
import { sum } from '../lib/money.js';
import { actualizarEstadosVencidas } from './membresias.service.js';

/**
 * Lógica de acceso (CheckInController.CheckInByCedula del sistema .NET):
 *  - Un check-in exitoso cada HORAS_ENTRE_CHECKINS (12h por defecto)
 *  - Acceso solo con membresía activa y vigente
 *  - Informa deudas pendientes
 *  - Nuevo: membresías congeladas niegan el acceso con mensaje claro
 */
async function registrarAcceso(clienteId: string, metodo: 'cedula' | 'huella' | 'manual') {
  const cliente = await db
    .selectFrom('clientes')
    .select(['id', 'nombre', 'apellido', 'fotoBase64', 'activo'])
    .where('id', '=', clienteId)
    .executeTakeFirst();
  if (!cliente || !cliente.activo) {
    return { success: false, codigo: 'NO_ENCONTRADO', message: 'Cliente no encontrado. Acércate a recepción.' };
  }
  const nombre = `${cliente.nombre} ${cliente.apellido}`;

  const desde = new Date(Date.now() - env.HORAS_ENTRE_CHECKINS * 3_600_000);
  const reciente = await db
    .selectFrom('checkins')
    .select('fechaHora')
    .where('clienteId', '=', cliente.id)
    .where('exitoso', '=', true)
    .where('fechaHora', '>=', desde)
    .orderBy('fechaHora', 'desc')
    .executeTakeFirst();
  if (reciente) {
    const horas = (Date.now() - new Date(reciente.fechaHora).getTime()) / 3_600_000;
    return {
      success: true,
      yaHizoCheckIn: true,
      tieneAcceso: true,
      message: `¡Hola de nuevo, ${cliente.nombre}! Ya registraste tu entrada hoy.`,
      ultimoCheckIn: {
        fecha: reciente.fechaHora,
        horasTranscurridas: Math.round(horas * 10) / 10,
        horasRestantes: Math.round((env.HORAS_ENTRE_CHECKINS - horas) * 10) / 10,
      },
      cliente: { nombre, fotoBase64: cliente.fotoBase64 },
    };
  }

  await actualizarEstadosVencidas();
  const hoy = today();
  const membresias = await db
    .selectFrom('membresias as m')
    .innerJoin('planes as p', 'p.id', 'm.planId')
    .select(['m.id', 'm.estado', 'm.fechaInicio', 'm.fechaVencimiento', 'p.nombre as plan', 'p.color'])
    .where('m.clienteId', '=', cliente.id)
    .orderBy('m.fechaVencimiento', 'desc')
    .execute();
  const activa = membresias.find((m) => m.estado === 'activa' && m.fechaVencimiento >= hoy);
  const reciente2 = activa ?? membresias[0];

  const deudas = await db
    .selectFrom('deudasClientes')
    .select('saldo')
    .where('clienteId', '=', cliente.id)
    .where('estado', '=', 'pendiente')
    .execute();
  const totalDeuda = sum(deudas, (d) => d.saldo);

  let tieneAcceso = true;
  let mensaje: string;
  let diasRestantes: number | null = null;
  let diasVencidos: number | null = null;

  if (!reciente2) {
    tieneAcceso = false;
    mensaje = 'No tienes membresía registrada. Acércate a recepción.';
  } else if (!activa && reciente2.estado === 'suspendida') {
    tieneAcceso = false;
    mensaje = 'Tu membresía está congelada. Acércate a recepción para reactivarla.';
  } else if (!activa) {
    tieneAcceso = false;
    diasVencidos = Math.max(diffDays(reciente2.fechaVencimiento, hoy), 0);
    mensaje = 'Tu membresía ha vencido. Acércate a recepción para renovar.';
  } else {
    diasRestantes = diffDays(hoy, activa.fechaVencimiento);
    mensaje =
      diasRestantes === 0
        ? `¡Bienvenido, ${cliente.nombre}! Tu membresía vence HOY.`
        : diasRestantes <= 3
          ? `¡Bienvenido, ${cliente.nombre}! Tu membresía vence en ${diasRestantes} día${diasRestantes === 1 ? '' : 's'}.`
          : `¡Bienvenido, ${cliente.nombre}!`;
  }

  await db
    .insertInto('checkins')
    .values({ clienteId: cliente.id, fechaHora: new Date(), metodo, exitoso: tieneAcceso, nota: mensaje })
    .execute();

  return {
    success: true,
    tieneAcceso,
    message: mensaje,
    cliente: { nombre, fotoBase64: cliente.fotoBase64, diasRestantes },
    membresia: reciente2
      ? {
          estado: reciente2.estado,
          plan: reciente2.plan,
          color: reciente2.color,
          fechaInicio: reciente2.fechaInicio,
          fechaVencimiento: reciente2.fechaVencimiento,
          diasRestantes,
          diasVencidos,
        }
      : null,
    deuda: totalDeuda > 0 ? { montoTotal: totalDeuda, cantidad: deudas.length } : null,
  };
}

// ───────────────────── Kiosko (público, sin sesión) ─────────────────────
export const kioskoRouter = Router();

// Límite simple anti-abuso: 30 intentos por minuto por IP
const hits = new Map<string, { n: number; t: number }>();
kioskoRouter.use((req, _res, next) => {
  const ip = req.ip ?? 'x';
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > 60_000) hits.set(ip, { n: 1, t: now });
  else if (++h.n > 30) return next(badRequest('Demasiados intentos, espera un momento'));
  next();
});

kioskoRouter.get('/info', (_req, res) => res.json({ gym: env.GYM_NOMBRE }));

kioskoRouter.post(
  '/checkin-cedula',
  ah(async (req, res) => {
    const { cedula } = parse(z.object({ cedula: z.string().trim().min(3, 'Ingresa tu cédula').max(20) }), req.body);
    const c = await db.selectFrom('clientes').select('id').where('cedula', '=', cedula).executeTakeFirst();
    if (!c) return res.json({ success: false, codigo: 'NO_ENCONTRADO', message: 'Cédula no registrada. Acércate a recepción.' });
    res.json(await registrarAcceso(c.id, 'cedula'));
  }),
);

/**
 * Para el puente del lector de huellas (DigitalPersona): el puente identifica
 * la huella localmente y envía el clienteId reconocido con la cabecera x-bridge-key.
 */
kioskoRouter.post(
  '/checkin-huella',
  ah(async (req, res) => {
    if (!env.FINGERPRINT_BRIDGE_KEY || req.headers['x-bridge-key'] !== env.FINGERPRINT_BRIDGE_KEY) {
      throw unauthorized('Puente de huellas no autorizado');
    }
    const { clienteId } = parse(z.object({ clienteId: z.string().uuid() }), req.body);
    res.json(await registrarAcceso(clienteId, 'huella'));
  }),
);

/** El puente descarga las plantillas para identificar localmente. */
kioskoRouter.get(
  '/plantillas-huella',
  ah(async (req, res) => {
    if (!env.FINGERPRINT_BRIDGE_KEY || req.headers['x-bridge-key'] !== env.FINGERPRINT_BRIDGE_KEY) {
      throw unauthorized('Puente de huellas no autorizado');
    }
    const rows = await db
      .selectFrom('clientes')
      .select(['id', 'huellaTemplate', 'huellaTemplate1', 'huellaTemplate2', 'huellaTemplate3', 'huellaTemplate4', 'huellaTemplate5'])
      .where('activo', '=', true)
      .where((eb) => eb.or([eb('huellaTemplate', 'is not', null), eb('huellaTemplate1', 'is not', null)]))
      .execute();
    res.json(rows);
  }),
);

// ───────────────────── Panel (requiere sesión) ─────────────────────
export const checkinRouter = Router();

checkinRouter.post(
  '/manual',
  ah(async (req, res) => {
    const body = parse(
      z.object({ clienteId: z.string().uuid(), validarMembresia: z.boolean().default(true), nota: z.string().max(200).nullish() }),
      req.body,
    );
    if (body.validarMembresia) return res.json(await registrarAcceso(body.clienteId, 'manual'));
    const c = await db.selectFrom('clientes').select(['id', 'nombre', 'apellido']).where('id', '=', body.clienteId).executeTakeFirst();
    if (!c) throw notFound('Cliente no encontrado');
    await db
      .insertInto('checkins')
      .values({ clienteId: c.id, metodo: 'manual', exitoso: true, nota: body.nota || 'Check-in manual por administrador' })
      .execute();
    res.json({ success: true, tieneAcceso: true, message: `Check-in registrado para ${c.nombre} ${c.apellido}` });
  }),
);

checkinRouter.get(
  '/',
  ah(async (req, res) => {
    const q = parse(
      z.object({
        desde: z.string().refine(isDateStr).optional(),
        hasta: z.string().refine(isDateStr).optional(),
        clienteId: z.string().uuid().optional(),
      }),
      req.query,
    );
    const desde = parseDateStr(q.desde ?? today());
    const hasta = parseDateStr(addDays(q.hasta ?? today(), 1));
    const rows = await db
      .selectFrom('checkins as ch')
      .innerJoin('clientes as c', 'c.id', 'ch.clienteId')
      .select(['ch.id', 'ch.fechaHora', 'ch.metodo', 'ch.exitoso', 'ch.nota', 'c.id as clienteId', 'c.nombre', 'c.apellido', 'c.cedula'])
      .where('ch.fechaHora', '>=', desde)
      .where('ch.fechaHora', '<', hasta)
      .$if(!!q.clienteId, (qb) => qb.where('ch.clienteId', '=', q.clienteId!))
      .orderBy('ch.fechaHora', 'desc')
      .limit(2000)
      .execute();
    res.json({
      total: rows.length,
      exitosos: rows.filter((r) => r.exitoso).length,
      denegados: rows.filter((r) => !r.exitoso).length,
      checkIns: rows,
    });
  }),
);
