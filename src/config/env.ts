import 'dotenv/config';
import { z } from 'zod';

// La zona horaria debe fijarse antes de crear cualquier Date: las columnas
// "timestamp without time zone" guardan hora local de Colombia, igual que el sistema .NET.
process.env.TZ = process.env.TZ || 'America/Bogota';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TZ: z.string().default('America/Bogota'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Si existe (Railway, Render…) tiene prioridad sobre DB_HOST/DB_PORT/…
  DATABASE_URL: z.string().optional(),
  DB_SSL: bool,
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default('power_fitness'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default(''),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  FINGERPRINT_BRIDGE_KEY: z.string().default(''),

  ADMIN_NOMBRE: z.string().default('Administrador'),
  ADMIN_EMAIL: z.string().email().default('admin@powerfitness.com'),
  ADMIN_PASSWORD: z.string().default('Admin123*'),
  CAJA_FUERTE_PASSWORD: z.string().default('123456'),

  GYM_NOMBRE: z.string().default('POWER FITNESS'),
  DIAS_ALERTA_VENCIMIENTO: z.coerce.number().default(7),
  STOCK_MINIMO: z.coerce.number().default(10),
  HORAS_ENTRE_CHECKINS: z.coerce.number().default(12),

  JOB_VENCIMIENTOS_CRON: z.string().default('5 0 * * *'),
  JOB_CONSOLIDACION_AUTO: bool,
  JOB_CIERRE_CAJA_AUTO: bool,
  JOB_CIERRE_CAJA_CRON: z.string().default('55 23 * * *'),
  ABRIR_NAVEGADOR: bool,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Configuración inválida en .env:');
  for (const issue of parsed.error.issues) console.error(`   • ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
