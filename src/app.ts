import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { checkDatabase } from './db/index.js';
import { errorHandler, notFound } from './lib/http.js';
import { requireAuth, requireRole } from './middleware/auth.js';
import { authRouter } from './modules/auth.routes.js';
import { cajaFuerteRouter } from './modules/caja-fuerte.routes.js';
import { cajaRouter } from './modules/caja.routes.js';
import { checkinRouter, kioskoRouter } from './modules/checkin.routes.js';
import { clientesRouter } from './modules/clientes.routes.js';
import { dashboardRouter, notificacionesRouter, reportesRouter } from './modules/dashboard.routes.js';
import { deudasRouter } from './modules/deudas.routes.js';
import { empleadosRouter } from './modules/empleados.routes.js';
import { membresiasRouter } from './modules/membresias.routes.js';
import { planesRouter } from './modules/planes.routes.js';
import { productosRouter, ventasRouter } from './modules/productos.routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.resolve(here, '../../frontend/dist');

export function createApp() {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(compression());
  // CORS_ORIGIN: orígenes del frontend separados por coma (ej. http://localhost:5173,https://powerfitness.up.railway.app)
  // Se normaliza a solo el origen: "https://x.vercel.app/login/" → "https://x.vercel.app"
  const origins = env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      try {
        return new URL(o).origin;
      } catch {
        return o.replace(/\/+$/, '');
      }
    });
  app.use(cors({ origin: origins }));
  // Fotos de clientes/productos en base64
  app.use(express.json({ limit: '8mb' }));

  const api = Router();
  api.get('/health', async (_req, res) => {
    res.json({ ok: true, db: await checkDatabase(), gym: env.GYM_NOMBRE, hora: new Date().toLocaleString('es-CO') });
  });

  // Públicos
  api.use('/auth', authRouter);
  api.use('/kiosko', kioskoRouter);

  // Con sesión
  api.use(requireAuth);
  api.use('/dashboard', dashboardRouter);
  api.use('/clientes', clientesRouter);
  api.use('/planes', planesRouter);
  api.use('/membresias', membresiasRouter);
  api.use('/checkins', checkinRouter);
  api.use('/productos', productosRouter);
  api.use('/ventas', ventasRouter);
  api.use('/deudas', deudasRouter);
  api.use('/caja', cajaRouter);
  api.use('/caja-fuerte', cajaFuerteRouter);
  api.use('/empleados', requireRole('admin'), empleadosRouter);
  api.use('/reportes', reportesRouter);
  api.use('/notificaciones', notificacionesRouter);
  api.use((_req, _res, next) => next(notFound('Ruta de API no encontrada')));

  app.use('/api', api);

  // En producción el backend también sirve la aplicación web compilada
  if (fs.existsSync(FRONTEND_DIST)) {
    app.use(express.static(FRONTEND_DIST, { maxAge: '7d', index: false }));
    app.get('*', (_req, res) => res.sendFile(path.join(FRONTEND_DIST, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
