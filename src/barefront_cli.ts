#!/usr/bin/env node

import util from 'node:util';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import cp from 'node:child_process';
import { exitWithError, Command, canAccessPath, waitUntilFileAccessible, timeout } from './util.js';
import ownPackageJSON from '../package.json' assert { type: 'json' };

type TemplateVars = {
  name: string;
};

type PackageFile = {
  barefront?: {
    library?: boolean;
  };
};

const SERVER_DIST_FILE_PATH = 'dist/server/index.js';

const curFilename = fileURLToPath(import.meta.url);
const templatesDirPath = path.resolve(curFilename, '../../templates');

// const fgGreen = '\x1b[32m';
// const reset = '\x1b[0m';

const argsConfig: util.ParseArgsConfig = {
  options: {
    linkToBarefront: { type: 'boolean' },
    library: { type: 'boolean' },
    version: { type: 'boolean' },
    // deployName: { type: 'string' },
  },
  allowPositionals: true,
};

const args = util.parseArgs(argsConfig);

if (args.values.version) {
  console.log(`Barefront v${ownPackageJSON.version}`);
  process.exit(0);
}

if (!args.positionals.length) {
  exitWithError('missing command.');
}

const command = args.positionals[0];

switch (command) {
  case 'create': {
    create();
    break;
  }
  case 'build': {
    await build();
    break;
  }
  case 'dev': {
    await runDev();
    break;
  }
  case 'clean': {
    await clean();
    break;
  }
  // case 'deploy': {
  //   await deploy(args.values as any);
  //   break;
  // }
  default: {
    exitWithError(`unknown command ${command}.`);
  }
}

async function create() {
  const name = args.positionals[1];
  if (!name) exitWithError('missing project name.');
  if (name.includes('/') || name.includes('\\')) exitWithError('project name must not include / or \\.');
  if (await canAccessPath(name)) exitWithError(`${name} already exists.`);

  let srcPath: string;
  if (args.values.library) {
    srcPath = path.resolve(templatesDirPath, 'library');
  } else {
    srcPath = path.resolve(templatesDirPath, 'server_client');
  }
  await copyFiles(srcPath, name);
  await expandFiles(name, { name });
  await installPackages(name);
  await initGit(name);

  console.log(`Done.`);
}

async function runDev() {
  // NOTE npm/npx commands are run for the template project's package.

  // Read package.json
  const packageFile = await readPackageFile();

  // Clean prev builds.
  await clean();

  // Run typescript.
  const tsCmd = new Command('npx', ['tsc', '--build', '--watch', '--pretty', '--preserveWatchOutput'], {
    name: 'ts',
    color: 'fgGreen',
    onExit: tsExited,
  });
  tsCmd.run();

  if (!packageFile.barefront?.library) {
    // Run esbuild.
    const esbuildCmd = new Command('node', ['esbuild.config.mjs', '--watch'], {
      name: 'esbuild',
      color: 'fgBlue',
      onExit: esbuildExited,
    });
    esbuildCmd.run();

    // Run server.
    const serverCmd = new Command(
      'node',
      ['--enable-source-maps', '--watch', '--inspect=9230', SERVER_DIST_FILE_PATH],
      {
        name: 'server',
        color: 'fgMagenta',
        onExit: serverExited,
      },
    );
    console.error(serverCmd.tagger.get() + ` waiting for ${SERVER_DIST_FILE_PATH} ...`);
    await waitUntilFileAccessible(SERVER_DIST_FILE_PATH);
    serverCmd.run();

    function esbuildExited(code?: number) {
      process.exit(code);
    }
    async function serverExited(_code?: number) {
      await timeout(1000);
      serverCmd.run();
    }
  }

  // Handle process exit.
  function tsExited(code?: number) {
    process.exit(code);
  }
}

async function build() {
  // NOTE npm/npx commands are run for the template project's package.

  // Clean prev builds.
  await clean();

  // Read package.json
  const packageFile = await readPackageFile();

  // Run typescript.
  const tsCmd = new Command('npx', ['tsc', '--build', '--pretty', '--preserveWatchOutput'], {
    name: 'ts',
    color: 'fgGreen',
    onExit: tsExited,
  });
  tsCmd.run();

  if (!packageFile.barefront?.library) {
    // Run esbuild.
    const esbuildCmd = new Command('node', ['esbuild.config.mjs'], {
      name: 'esbuild',
      color: 'fgBlue',
      onExit: esbuildExited,
    });
    esbuildCmd.run();

    function esbuildExited(code?: number) {
      if (code !== 0) process.exit(code);
    }
  }

  // Handle process exit.
  function tsExited(code?: number) {
    if (code !== 0) process.exit(code);
  }
}

async function clean() {
  // Clean prev builds.
  await new Command('rm', ['-rf', './dist', 'tsconfig.tsbuildinfo'], { name: 'clean', color: 'fgYellow' }).run();
}

async function readPackageFile(): Promise<PackageFile> {
  return JSON.parse(await fs.promises.readFile('package.json', 'utf8'));
}

async function copyFiles(srcPath: string, dirPath: string) {
  console.log(`Copying files to ${path.resolve(dirPath)} ...`);
  await fs.promises.cp(srcPath, dirPath, { recursive: true });
}

async function installPackages(dirPath: string) {
  console.log(`Installing packages ...`);
  cp.execSync('npm install', { cwd: path.resolve(dirPath), stdio: 'inherit' });
  if (args.values.linkToBarefront) {
    console.log('linking barefront ...');
    cp.execSync('npm link barefront', { cwd: path.resolve(dirPath), stdio: 'inherit' });
  }
}

async function initGit(dirPath: string) {
  console.log('Initializing git ...');
  cp.execSync('git init', { cwd: path.resolve(dirPath), stdio: 'inherit' });
}

async function expandFiles(dirPath: string, vars: TemplateVars) {
  console.log(`Expanding templates ...`);
  const filePaths = await fs.promises.readdir(dirPath, { recursive: true });
  // console.log('filePaths: ', filePaths);
  for (const filePath of filePaths) {
    await expandFile(path.join(dirPath, filePath), vars);
  }
}

async function expandFile(templatePath: string, vars: TemplateVars) {
  const filePath = stripTemplateExtension(templatePath);
  if (!filePath) return;
  // console.log(`Expanding file ${templatePath} -> ${filePath}`);

  const template = await fs.promises.readFile(templatePath, 'utf8');
  const expanded = expandTemplateContent(template, vars);
  await fs.promises.writeFile(filePath, expanded, 'utf8');
  await fs.promises.rm(templatePath);
}

function expandTemplateContent(template: string, vars: TemplateVars): string {
  return template.replace(/\\%|\%{([a-zA-Z_][a-zA-Z0-9_]*)}/g, (match, key) => {
    if (match === '\\%') return '%';
    if (!(key in vars)) throw new Error(`Unknown template variable "${key}"`);
    return (vars as any)[key];
  });
}

function stripTemplateExtension(filePath: string): string | undefined {
  if (/\.template\b/.test(filePath)) {
    return filePath.replace(/\.template\b/, '');
  }
}
