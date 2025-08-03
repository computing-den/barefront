#!/usr/bin/env node

import util from 'node:util';
import * as barefront from './barefront.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const ownDirname = dirname(fileURLToPath(import.meta.url));
const ownPackageJSON = JSON.parse(readFileSync(resolve(ownDirname, '../package.json'), 'utf8'));

// const fgGreen = '\x1b[32m';
// const reset = '\x1b[0m';

const argsConfig: util.ParseArgsConfig = {
  options: {
    dev: { type: 'boolean' },
    library: { type: 'boolean' },
    version: { type: 'boolean' },
    // deployName: { type: 'string' },
  },
  allowPositionals: true,
};

const cliArgs = util.parseArgs(argsConfig);

if (cliArgs.values.version) {
  console.log(`Barefront v${ownPackageJSON.version}`);
  process.exit(0);
}

if (!cliArgs.positionals.length) {
  barefront.exitWithError('missing command.');
}

const command = cliArgs.positionals[0];

switch (command) {
  case 'create': {
    barefront.create(cliArgs.positionals[1], {
      library: Boolean(cliArgs.values.library),
      dev: Boolean(cliArgs.values.dev),
    });
    break;
  }
  case 'build': {
    await barefront.build();
    break;
  }
  case 'dev': {
    await barefront.runDev();
    break;
  }
  case 'clean': {
    await barefront.clean();
    break;
  }
  case 'pack': {
    await barefront.pack(cliArgs.positionals[1]);
    break;
  }
  case 'init-server': {
    await barefront.initServer(cliArgs.positionals[1]);
    break;
  }
  case 'clean-server': {
    await barefront.cleanServer(cliArgs.positionals[1]);
    break;
  }
  case 'deploy': {
    await barefront.deploy(cliArgs.positionals[1]);
    break;
  }
  // case 'deploy': {
  //   await deploy(cliArgs.values as any);
  //   break;
  // }
  default: {
    barefront.exitWithError(`unknown command ${command}.`);
  }
}
