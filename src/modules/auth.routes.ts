import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { ah, badRequest, notFound, parse, unauthorized } from '../lib/http.js';
import { hashPassword, isLegacyPlain, verifyPassword } from '../lib/security.js';
import { requireAuth, requireRole, signToken } from '../middleware/auth.js';

export const authRouter = Router();

const publicUser = (u: { id: string; nombre: string; email: string; rol: 'admin' | 'staff'; telefono: string | null; activo: boolean }) => ({
  id: u.id,
  nombre: u.nombre,
  email: u.email,
  rol: u.rol,
  telefono: u.telefono,
  activo: u.activo,
});

authRouter.post(
  '/login',
  ah(async (req, res) => {
    const { email, password } = parse(
      z.object({ email: z.string().trim().min(1, 'Email requerido'), password: z.string().min(1, 'Contraseña requerida') }),
      req.body,
    );
    const user = await db
      .selectFrom('usuarios')
      .selectAll()
      .where((eb) => eb(eb.fn('lower', ['email']), '=', email.toLowerCase()))
      .executeTakeFirst();
    if (!user || !user.activo || !(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized('Email o contraseña incorrectos');
    }
    // Migración silenciosa: contraseñas en texto plano del sistema anterior → bcrypt
    if (isLegacyPlain(user.passwordHash)) {
      await db
        .updateTable('usuarios')
        .set({ passwordHash: await hashPassword(password), updatedAt: new Date() })
        .where('id', '=', user.id)
        .execute();
    }
    const token = signToken({ id: user.id, email: user.email, nombre: user.nombre, rol: user.rol });
    res.json({ success: true, token, usuario: publicUser(user) });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const user = await db.selectFrom('usuarios').selectAll().where('id', '=', req.user!.id).executeTakeFirst();
    if (!user || !user.activo) throw unauthorized('Usuario no encontrado o inactivo');
    res.json({ success: true, usuario: publicUser(user) });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  ah(async (req, res) => {
    const body = parse(
      z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(6, 'Mínimo 6 caracteres') }),
      req.body,
    );
    const user = await db.selectFrom('usuarios').selectAll().where('id', '=', req.user!.id).executeTakeFirstOrThrow();
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) throw badRequest('Contraseña actual incorrecta');
    await db
      .updateTable('usuarios')
      .set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() })
      .where('id', '=', user.id)
      .execute();
    res.json({ success: true, message: 'Contraseña actualizada exitosamente' });
  }),
);

// ─────────── Gestión de usuarios (solo admin) ───────────
const userSchema = z.object({
  nombre: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(150),
  password: z.string().min(6, 'Mínimo 6 caracteres').optional(),
  rol: z.enum(['admin', 'staff']).default('staff'),
  telefono: z.string().trim().max(20).nullish(),
  activo: z.boolean().optional(),
});

authRouter.get(
  '/users',
  requireAuth,
  requireRole('admin'),
  ah(async (_req, res) => {
    const usuarios = await db
      .selectFrom('usuarios')
      .select(['id', 'nombre', 'email', 'rol', 'telefono', 'activo', 'createdAt'])
      .orderBy('createdAt')
      .execute();
    res.json({ success: true, usuarios });
  }),
);

authRouter.post(
  '/users',
  requireAuth,
  requireRole('admin'),
  ah(async (req, res) => {
    const body = parse(userSchema.extend({ password: z.string().min(6, 'Mínimo 6 caracteres') }), req.body);
    const exists = await db
      .selectFrom('usuarios')
      .select('id')
      .where((eb) => eb(eb.fn('lower', ['email']), '=', body.email.toLowerCase()))
      .executeTakeFirst();
    if (exists) throw badRequest('El email ya está registrado');
    const usuario = await db
      .insertInto('usuarios')
      .values({
        nombre: body.nombre,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        rol: body.rol,
        telefono: body.telefono ?? null,
        activo: true,
      })
      .returning(['id', 'nombre', 'email', 'rol', 'telefono', 'activo'])
      .executeTakeFirstOrThrow();
    res.status(201).json({ success: true, message: 'Usuario registrado exitosamente', usuario });
  }),
);

authRouter.put(
  '/users/:id',
  requireAuth,
  requireRole('admin'),
  ah(async (req, res) => {
    const body = parse(userSchema.partial(), req.body);
    const user = await db.selectFrom('usuarios').select('id').where('id', '=', req.params.id).executeTakeFirst();
    if (!user) throw notFound('Usuario no encontrado');
    if (req.params.id === req.user!.id && (body.activo === false || body.rol === 'staff')) {
      throw badRequest('No puedes desactivarte ni quitarte el rol de administrador');
    }
    await db
      .updateTable('usuarios')
      .set({
        ...(body.nombre !== undefined && { nombre: body.nombre }),
        ...(body.email !== undefined && { email: body.email }),
        ...(body.rol !== undefined && { rol: body.rol }),
        ...(body.telefono !== undefined && { telefono: body.telefono ?? null }),
        ...(body.activo !== undefined && { activo: body.activo }),
        ...(body.password && { passwordHash: await hashPassword(body.password) }),
        updatedAt: new Date(),
      })
      .where('id', '=', req.params.id)
      .execute();
    res.json({ success: true, message: 'Usuario actualizado' });
  }),
);
