const { spawnSync } = require('child_process');

const builderCli = require.resolve('electron-builder/out/cli/cli.js');
const result = spawnSync(process.execPath, [builderCli, '--linux', ...process.argv.slice(2)], {
  stdio: 'inherit'
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);

if (!process.env.CI && process.platform === 'linux') {
  require('./install-local-linux.cjs');
}
