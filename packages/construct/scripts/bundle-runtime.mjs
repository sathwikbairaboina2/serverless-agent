import { build } from 'esbuild';
import { rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../../runtime/src/handlers/index.ts');
const outdir = path.resolve(here, '../assets/runtime');
const outfile = path.join(outdir, 'index.mjs');

rmSync(outdir, { recursive: true, force: true });
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: "import { createRequire as __sa_createRequire } from 'node:module'; const require = __sa_createRequire(import.meta.url);" },
});
const mib = statSync(outfile).size / 1024 / 1024;
console.log(`bundled runtime -> ${path.relative(process.cwd(), outfile)} (${mib.toFixed(2)} MiB)`);
