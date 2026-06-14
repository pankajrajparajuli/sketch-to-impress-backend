/**
 * Returns the JWT signing secret from the environment.
 *
 * In development/test it falls back to a known dev value so local dev works
 * without extra setup. In production the application refuses to start if the
 * secret is missing or is the placeholder (enforced in main.ts bootstrap guard).
 */
export function getJwtSecret(): string {
  return process.env.JWT_SECRET ?? 'dev_secret';
}
