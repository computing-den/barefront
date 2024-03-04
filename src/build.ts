import * as u from './util.js';
import fs from 'node:fs';
import path from 'node:path';

const SERVER_DIST_FILE_PATH = 'dist/server/index.js';

export async function runDev() {
  // NOTE npm/npx commands are run for the template project's package.

  // Clean prev builds.
  await clean();

  // Run typescript.
  const tsCmd = new u.Command('npx', ['tsc', '--build', '--watch', '--pretty', '--preserveWatchOutput'], {
    name: 'ts',
    color: 'fgGreen',
    onExit: tsExited,
  });
  tsCmd.run();

  // Run esbuild.
  const esbuildCmd = new u.Command('node', ['esbuild.config.mjs', '--watch'], {
    name: 'esbuild',
    color: 'fgBlue',
    onExit: esbuildExited,
  });
  esbuildCmd.run();

  // Run server.
  const serverCmd = new u.Command(
    'node',
    ['--enable-source-maps', '--watch', '--inspect=9230', SERVER_DIST_FILE_PATH],
    {
      name: 'server',
      color: 'fgMagenta',
      onExit: serverExited,
    },
  );
  console.error(serverCmd.tagger.get() + ` waiting for ${SERVER_DIST_FILE_PATH} ...`);
  await u.waitUntilFileAccessible(SERVER_DIST_FILE_PATH);
  serverCmd.run();

  // Handle process exit.
  function tsExited(code?: number) {
    process.exit(code);
  }
  function esbuildExited(code?: number) {
    process.exit(code);
  }
  async function serverExited(code?: number) {
    await u.timeout(1000);
    serverCmd.run();
  }
}

export async function build() {
  // NOTE npm/npx commands are run for the template project's package.

  // Clean prev builds.
  await clean();

  // Run typescript.
  const tsCmd = new u.Command('npx', ['tsc', '--build', '--pretty', '--preserveWatchOutput'], {
    name: 'ts',
    color: 'fgGreen',
    onExit: tsExited,
  });
  tsCmd.run();

  // Run esbuild.
  const esbuildCmd = new u.Command('node', ['esbuild.config.mjs'], {
    name: 'esbuild',
    color: 'fgBlue',
    onExit: esbuildExited,
  });
  esbuildCmd.run();

  // Handle process exit.
  function tsExited(code?: number) {
    if (code !== 0) process.exit(code);
  }
  function esbuildExited(code?: number) {
    if (code !== 0) process.exit(code);
  }
}

export async function clean() {
  // Clean prev builds.
  await new u.Command('rm', ['-rf', './dist', 'tsconfig.tsbuildinfo'], { name: 'clean', color: 'fgYellow' }).run();
}
