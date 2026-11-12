import { defineConfig } from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function cacheDir() {
  const probe = path.join(root, 'node_modules', '.vite-probe');
  try {
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, 'f'), 'x');
    fs.renameSync(probe, `${probe}-b`);
    fs.rmSync(`${probe}-b`, { recursive: true, force: true });
    return path.join(root, 'node_modules', '.vite');
  } catch {
    return path.join(os.tmpdir(), 'usti-model-vite');
  }
}

export default defineConfig({
  cacheDir: cacheDir(),
  server: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true },
});
