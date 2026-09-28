import { spawnSync } from 'node:child_process';

// Single source of truth for release validation.
// Keep this compatibility entry point because older docs/workflows referenced
// `node release_audit.mjs`, but delegate to the maintained `npm run check`
// pipeline so version/security/regression checks cannot drift apart.
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['run', 'check'], {
  stdio: 'inherit',
  env: process.env,
  shell: false,
});

if (result.error) {
  console.error('ITTR release audit could not start:', result.error.message);
  process.exit(1);
}

process.exit(Number.isInteger(result.status) ? result.status : 1);
