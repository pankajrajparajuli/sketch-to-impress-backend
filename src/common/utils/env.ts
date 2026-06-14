export function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Environment variable ${key} is required but not set.`);
  }
  return value;
}
