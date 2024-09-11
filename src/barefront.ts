import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import cp from 'node:child_process';
// import * as util from 'node:util';

/**
 * Apply ./deploy/NAME.deploy env variables.
 */
export function readEnv(name: string) {
  fs.accessSync(`deploy/${name}.deploy`); // Make sure file exists.
  dotenv.config({ path: `deploy/${name}.deploy` });
}

export function execOpt(
  opts: { sshHost?: string; canFail?: boolean; verbose?: boolean },
  cmd: string,
  ...args: string[]
): number | null {
  let status: number | null;
  let title: string;
  if (opts.sshHost) {
    status = cp.spawnSync('ssh', [opts.sshHost, cmd, ...args], { stdio: 'inherit' }).status;
    title = 'ssh ...';
  } else {
    if (opts.verbose) {
      console.log(cmd, args.map(x => `"${x}"`).join(' '));
    }
    status = cp.spawnSync(cmd, args, { stdio: 'inherit' }).status;
    title = `${cmd} ...`;
  }

  if (!opts.canFail && status !== 0) {
    exitWithError(`Command ${title} failed with status ${status}.`);
  }

  return status;
}

// function runRemoteNoThrow(cmd) {
//   return runNoThrow('ssh', process.env.DEPLOY_SSH_HOST, cmd);
// }

// function run(cmd, ...args) {
//   const status = runNoThrow(cmd, ...args);
//   if (status !== 0) exitWithError(`Command ${cmd} failed with status ${status}.`);
//   return status;
// }

// function runNoThrow(cmd, ...args) {
//   console.log(cmd, args.map(x => `"${x}"`).join(' '));
//   return cp.spawnSync(cmd, args, { stdio: 'inherit' }).status;
// }

export function exitWithError(msg: string) {
  console.error(`ERROR: ${msg}`);
  process.exit(-1);
}
