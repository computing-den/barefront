#!/usr/bin/env node

import util from 'node:util';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import cp from 'node:child_process';
import * as buildApi from './build.js';
import * as u from './util.js';

type TemplateVars = {
  name: string;
};

const curFilename = fileURLToPath(import.meta.url);
const templateDirPath = path.resolve(curFilename, '../../template');

// const fgGreen = '\x1b[32m';
// const reset = '\x1b[0m';

const argsConfig: util.ParseArgsConfig = {
  options: {
    linkToBarefront: { type: 'boolean' },
  },
  allowPositionals: true,
};

const args = util.parseArgs(argsConfig);

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
    await buildApi.build();
    break;
  }
  case 'dev': {
    await buildApi.runDev();
    break;
  }
  case 'clean': {
    await buildApi.clean();
    break;
  }
  default: {
    exitWithError(`unknown command ${command}.`);
  }
}

async function create() {
  const name = args.positionals[1];
  if (!name) exitWithError('missing project name.');
  if (name.includes('/') || name.includes('\\')) exitWithError('project name must not include / or \\.');
  if (await u.canAccessPath(name)) exitWithError(`${name} already exists.`);

  await copyFiles(name);
  await expandFiles(name, { name });
  await installPackages(name);
  await initGit(name);

  console.log(`Done.`);
}

async function copyFiles(dirPath: string) {
  console.log(`Copying files to ${path.resolve(dirPath)} ...`);
  await fs.promises.cp(templateDirPath, dirPath, { recursive: true });
}

async function installPackages(dirPath: string) {
  if (args.values.linkToBarefront) {
    console.log('linking barefront ...');
    cp.execSync('npm link barefront', { cwd: path.resolve(dirPath), stdio: 'inherit' });
  }
  console.log(`Installing packages ...`);
  cp.execSync('npm install', { cwd: path.resolve(dirPath), stdio: 'inherit' });
}

async function initGit(dirPath: string) {
  console.log('Initializing git ...');
  cp.execSync('git init', { cwd: path.resolve(dirPath), stdio: 'inherit' });
}

function exitWithError(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(-1);
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
  return template.replace(/\\\$|\${(\w+)}/g, (match, key) => {
    if (match === '\\$') return '$';
    if (!(key in vars)) throw new Error(`Unknown template variable "${key}"`);
    return (vars as any)[key];
  });
}

function stripTemplateExtension(filePath: string): string | undefined {
  if (/\.template\b/.test(filePath)) {
    return filePath.replace(/\.template\b/, '');
  }
}
