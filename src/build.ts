import * as u from './util.js';

const SERVER_DIST_FILE_PATH = 'dist/server/index.js';
const CLIENT_JS_SRC_FILE_PATH = 'src/client/index.tsx';
const CLIENT_CSS_SRC_FILE_PATH = 'src/client/style.css';

export async function runDev() {
  // NOTE npm/npx commands are run for the template project's package.

  // Clean prev builds.
  await new u.Command('rm', ['-rf', './dist', 'tsconfig.tsbuildinfo'], { name: 'clean', color: 'fgYellow' }).run();

  // Run typescript.
  const tsCmd = new u.Command('npx', ['tsc', '--build', '--watch', '--pretty', '--preserveWatchOutput'], {
    name: 'ts',
    color: 'fgGreen',
    onExit: tsExited,
  });
  tsCmd.run();

  // Run esbuild.
  const bundleCmd = new u.Command(
    'npx',
    [
      'esbuild',
      CLIENT_JS_SRC_FILE_PATH,
      CLIENT_CSS_SRC_FILE_PATH,
      '--watch',
      '--bundle',
      '--minify',
      '--sourcemap',
      '--format=esm',
      '--outdir=dist/bundles',
    ],
    {
      name: 'bundle',
      color: 'fgBlue',
      onExit: bundleExited,
    },
  );
  bundleCmd.run();

  // Run server.
  const serverCmd = new u.Command('node', ['--enable-source-maps', '--watch', SERVER_DIST_FILE_PATH], {
    name: 'server',
    color: 'fgMagenta',
    onExit: serverExited,
  });
  console.error(serverCmd.tagger.get() + ` waiting for ${SERVER_DIST_FILE_PATH} ...`);
  await u.waitUntilFileAccessible(SERVER_DIST_FILE_PATH);
  serverCmd.run();

  // Handle process exit.
  function tsExited(code?: number) {
    process.exit(code);
  }
  function bundleExited(code?: number) {
    process.exit(code);
  }
  async function serverExited(code?: number) {
    await u.timeout(1000);
    serverCmd.run();
  }
}

export async function build() {
  throw new Error('TODO');
}

export async function clean() {
  throw new Error('TODO');
}

// function killAllAndExit(code?: number) {
//   for (const p of procs) {
//     if (p.connected) p.kill();
//   }
//   process.exit(code);
// }
