import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Some filesystems keep the esbuild binary without the executable bit.
// Copy it aside so Vite can still transform modules.
const candidates = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
].map((platform) => join(root, 'node_modules/@esbuild', platform, 'bin', platform.startsWith('win32') ? 'esbuild.exe' : 'esbuild'));

for (const bin of candidates) {
  try {
    accessSync(bin);
  } catch {
    continue;
  }
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    const dest = join('/tmp', 'usti-esbuild');
    copyFileSync(bin, dest);
    chmodSync(dest, 0o755);
    process.env.ESBUILD_BINARY_PATH = dest;
  }
  break;
}

const child = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
