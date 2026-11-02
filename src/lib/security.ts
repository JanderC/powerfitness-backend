import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);

/**
 * Igual que AuthService.VerifyPassword del sistema .NET: acepta hashes BCrypt
 * y, por compatibilidad con los datos antiguos, contraseñas guardadas en texto plano.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!plain || !stored) return false;
  if (stored.startsWith('$2')) return bcrypt.compare(plain, stored);
  const a = Buffer.from(plain);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const isLegacyPlain = (stored: string) => !stored.startsWith('$2');

/** Hash de la contraseña de Caja Fuerte: SHA256 en base64 (idéntico al sistema .NET). */
export const sha256Base64 = (plain: string) => crypto.createHash('sha256').update(plain, 'utf8').digest('base64');
