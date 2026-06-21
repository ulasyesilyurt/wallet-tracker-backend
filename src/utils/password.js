import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = await scrypt(password, salt, PASSWORD_KEY_LENGTH);

  return `${salt}:${Buffer.from(derivedKey).toString('hex')}`;
}

export async function verifyPassword(password, passwordHash) {
  if (typeof passwordHash !== 'string' || !passwordHash.includes(':')) {
    return false;
  }

  const [salt, storedKeyHex] = passwordHash.split(':');

  if (!salt || !storedKeyHex) {
    return false;
  }

  const derivedKey = await scrypt(password, salt, PASSWORD_KEY_LENGTH);
  const storedKey = Buffer.from(storedKeyHex, 'hex');
  const candidateKey = Buffer.from(derivedKey);

  if (storedKey.length !== candidateKey.length) {
    return false;
  }

  return timingSafeEqual(storedKey, candidateKey);
}
