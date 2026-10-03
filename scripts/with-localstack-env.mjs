import { spawn } from 'node:child_process';

const endpoint = process.env.LOCALSTACK_ENDPOINT ?? 'http://localhost:4566';
const env = {
  ...process.env,
  AWS_ENDPOINT_URL: endpoint,
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
  AWS_DEFAULT_REGION: process.env.AWS_REGION ?? 'us-east-1',
};

const rawArgs = process.argv.slice(2);
const skipWithoutToken = rawArgs[0] === '--skip-without-token';
const requireToken = rawArgs[0] === '--require-token';
const argv = skipWithoutToken || requireToken ? rawArgs.slice(1) : rawArgs;

if (!process.env.LOCALSTACK_AUTH_TOKEN) {
  if (skipWithoutToken) {
    console.log('SKIPPED: LOCALSTACK_AUTH_TOKEN is not set; LocalStack integration tests were NOT run (see docs/adr/0009).');
    process.exit(0);
  }
  if (requireToken) {
    console.error('ERROR: pnpm local:deploy requires LOCALSTACK_AUTH_TOKEN (LocalStack 2026.03+, free Hobby plan; see docs/adr/0009).');
    process.exit(2);
  }
}

try {
  const res = await fetch(`${endpoint}/_localstack/health`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(`BLOCKER: LocalStack is not reachable at ${endpoint} (${err.message}).`);
  console.error('Start it with "pnpm local:up". LocalStack 2026.03+ requires LOCALSTACK_AUTH_TOKEN in your environment (free Hobby plan for non-commercial use). See docs/adr/0009.');
  process.exit(2);
}

const [cmd, ...args] = argv;
if (!cmd) { console.error('usage: node scripts/with-localstack-env.mjs <command> [args...]'); process.exit(64); }
const child = spawn(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 1));
