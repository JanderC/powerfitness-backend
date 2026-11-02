import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { forbidden, unauthorized } from '../lib/http.js';

export interface AuthUser {
  id: string;
  email: string;
  nombre: string;
  rol: 'admin' | 'staff';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) return next(unauthorized('Debes iniciar sesión'));
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthUser & jwt.JwtPayload;
    req.user = { id: payload.id, email: payload.email, nombre: payload.nombre, rol: payload.rol };
    next();
  } catch {
    next(unauthorized('Sesión inválida o expirada'));
  }
}

export const requireRole =
  (...roles: AuthUser['rol'][]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.rol)) return next(forbidden());
    next();
  };

/** Id del usuario autenticado (antes el sistema usaba el "primer usuario activo"). */
export const userId = (req: Request): string => {
  if (!req.user) throw unauthorized();
  return req.user.id;
};
