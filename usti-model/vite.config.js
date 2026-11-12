import { defineConfig } from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');

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

const types = {
  '.geojson': 'application/geo+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jgw': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function dataMiddleware(req, res, next) {
  const raw = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = path.normalize(raw).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '');
  const file = path.resolve(dataDir, rel);
  if (file !== dataDir && !file.startsWith(dataDir + path.sep)) return next();
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return next();
    const ext = path.extname(file).toLowerCase();
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
}

function serveData() {
  return {
    name: 'serve-usti-data',
    configureServer(server) {
      server.middlewares.use('/data', dataMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/data', dataMiddleware);
    },
  };
}

export default defineConfig({
  plugins: [serveData()],
  cacheDir: cacheDir(),
  server: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true },
});
