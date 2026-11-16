import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Explicit opt-in legacy configuration. Never serialize process.env or API keys.
const localEnv = resolve(root, '.env');
if (existsSync(localEnv)) process.loadEnvFile(localEnv);
export const legacy = process.env.KKOK_LEGACY_ROOT ? resolve(process.env.KKOK_LEGACY_ROOT) : null;
if (legacy && existsSync(resolve(legacy, '.env.local'))) process.loadEnvFile(resolve(legacy, '.env.local'));
const localRequire = createRequire(resolve(root, 'package.json'));
export function dependency(name) {
  try { return localRequire(name); }
  catch (e) { if (!legacy || e.code !== 'MODULE_NOT_FOUND') throw e; return createRequire(resolve(legacy, 'package.json'))(name); }
}
export const sharp = dependency('sharp');
export const z = dependency('zod').z;
export const dataDir = resolve(process.env.CUE_DATA_DIR || resolve(root, 'private-data'));
export const pythonPath = (kind) => process.env[`${kind.toUpperCase()}_PYTHON`] || (legacy ? resolve(legacy, `private-data/${kind}-venv`, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') : 'python');
export const cachePath = kind => resolve(process.env[`${kind.toUpperCase()}_CACHE_PATH`] || resolve(dataDir, `${kind}-models`));
