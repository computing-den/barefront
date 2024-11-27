import util from 'node:util';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import _ from 'lodash';
import { Command, timeout, waitUntilFileAccessible, canAccessPath } from './util.js';

type TemplateVars = {
  name: string;
};

type PackageFile = {
  name: string;
  version: string;
  barefront?: {
    library?: boolean;
  };
};

const SERVER_DIST_FILE_PATH = 'dist/server/index.js';

const curFilename = fileURLToPath(import.meta.url);
const templatesDirPath = path.resolve(curFilename, '../../templates');

export class Remote {
  constructor(public name: string, public env: Record<string, string>) {}
  static async fromDeployFile(name: string): Promise<Remote> {
    if (!name) {
      const files = await fs.promises.readdir('deploy');
      if (files.length === 0) {
        exitWithError('did not find any deployment files in deploy/ directory');
      } else if (files.length === 1) {
        name = files[0];
      } else {
        exitWithError(`pick one of deployment files: \n${files.map(x => `    ${x}`)}`);
      }
    }

    return new Remote(name, readEnv(name));
  }
  run(cmd: string, ...args: string[]): number | null {
    return execOpt({ sshHost: this.env.DEPLOY_SSH_HOST }, cmd, ...args);
  }
}

export async function create(name: string, opts?: { library?: boolean; dev?: boolean }) {
  if (!name) exitWithError('missing project name.');
  if (name.includes('/') || name.includes('\\')) exitWithError('project name must not include / or \\.');
  if (await canAccessPath(name)) exitWithError(`${name} already exists.`);

  let srcPath: string;
  if (opts?.library) {
    srcPath = path.resolve(templatesDirPath, 'library');
  } else {
    srcPath = path.resolve(templatesDirPath, 'server_client');
  }
  await copyFiles(srcPath, name);
  await expandFiles(name, { name });
  await installPackages(name, { dev: opts?.dev });
  await initGit(name);

  console.log(`Done.`);
}

export async function runDev() {
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

export async function build() {
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

export async function clean() {
  // Clean prev builds.
  await new Command('rm', ['-rf', './dist', 'tsconfig.tsbuildinfo'], { name: 'clean', color: 'fgYellow' }).run();
}

export async function pack(deployName: string): Promise<string> {
  const remote = await Remote.fromDeployFile(deployName);

  // Run command helper function.
  const run = (cmd: string, ...args: string[]) => execOpt({ verbose: true }, cmd, ...args);

  // Read package.json.
  const packageFile = await readPackageFile();

  const packName = `${packageFile.name}-${packageFile.version}.tgz`;

  // Remove old dist/package
  run('rm', '-rf', 'dist/package');

  // npm pack
  run('npm', 'pack', '--pack-destination', 'dist');

  // Extract to dist/package so we can modify it
  run('tar', 'xf', `dist/${packName}`, '--directory=dist');

  // Add .env file.
  const runtimeEnv = _.pickBy(remote.env, (v: string, k: string) => isEnvVarForRuntime(k));
  const runtimeEnvStr = _.map(runtimeEnv, (v: string, k: string) => k + '=' + v).join('\n');
  fs.writeFileSync(`dist/package/.env`, runtimeEnvStr);

  // Repackage
  run('tar', 'caf', `dist/${packName}`, '--directory=dist', 'package'); // relative to dist

  return packName;
}

export async function initServer(deployName: string) {
  const remote = await Remote.fromDeployFile(deployName);
  initSystemd(remote);
  initNginx(remote);
  initLogRotate(remote);
}

export async function cleanServer(deployName: string) {
  const remote = await Remote.fromDeployFile(deployName);
  cleanSystemd(remote);
  cleanNginx(remote);
  cleanLogRotate(remote);
}

export async function deploy(deployName: string) {
  const packName = await pack(deployName);
  const remote = await Remote.fromDeployFile(deployName);
  const { env } = remote;

  // Clean remote build path.
  remote.run(`rm -rf '${env.DEPLOY_BUILD_PATH}'`);

  // Copy package to remote.
  execOpt({ verbose: true }, 'rsync', '-r', `dist/${packName}`, `${env.DEPLOY_SSH_HOST}:${env.DEPLOY_BUILD_PATH}/`);

  // Remote.
  remote.run(`

# Exit if any command fails.
set -e
set -x

# Decompress archive.
# The --strip-components=1 removes the package/ prefix
cd '${env.DEPLOY_BUILD_PATH}'
tar --strip-components=1 -xzf ${packName}
mkdir -p private

# Install and build.
npm install
chown -R www-data:www-data .
npm run build
chown -R www-data:www-data .

# Stop service if running
systemctl stop ${env.DEPLOY_SERVICE} || true

# Copy the old private directory.
if [ -d '${env.DEPLOY_PATH}/private' ]; then
  rsync -a '${env.DEPLOY_PATH}/private/' '${env.DEPLOY_BUILD_PATH}/private/'
fi

# Make a backup of the old deploy.
if [ -d '${env.DEPLOY_PATH}' ]; then
  mv '${env.DEPLOY_PATH}' '${env.DEPLOY_PATH}-backup-${new Date().toISOString()}'
fi

mv '${env.DEPLOY_BUILD_PATH}' '${env.DEPLOY_PATH}'

systemctl start ${env.DEPLOY_SERVICE}

`);
}

export async function initSystemd(remote: Remote) {
  const { env } = remote;

  remote.run(`
# Exit if any command fails.
set -e
set -x

# If service file doesn't exist, create it
if [ -f "/etc/systemd/system/${env.DEPLOY_SERVICE}.service" ]; then
  echo "Service file already exists at /etc/systemd/system/${env.DEPLOY_SERVICE}.service"
else
  cat << 'EOF' >/etc/systemd/system/${env.DEPLOY_SERVICE}.service
${getServiceFile(env)}
EOF
  echo "Created systemd service file at /etc/systemd/system/${env.DEPLOY_SERVICE}.service"
fi

# Enable
systemctl enable ${env.DEPLOY_SERVICE}
echo "Enabled the ${env.DEPLOY_SERVICE} service"

`);
}

export async function cleanSystemd(remote: Remote) {
  const { env } = remote;

  remote.run(`
# Exit if any command fails.
set -e
set -x

# Disable, stop, and delete the systemd service.
if [ -f "/etc/systemd/system/${env.DEPLOY_SERVICE}.service" ]; then
  systemctl disable --now ${env.DEPLOY_SERVICE}
  rm -f "/etc/systemd/system/${env.DEPLOY_SERVICE}.service"
fi

`);
}

export async function initNginx(remote: Remote) {
  const { env } = remote;

  remote.run(`
# Exit if any command fails.
set -e
set -x

# If nginx config file doesn't exist, create it
if [ -f "/etc/nginx/sites-available/${env.DEPLOY_SERVICE}.conf" ]; then
  echo "Nginx config file already exists at /etc/nginx/sites-available/${env.DEPLOY_SERVICE}.conf"
else
  cat << 'EOF' >/etc/nginx/sites-available/${env.DEPLOY_SERVICE}.conf
${getNginxConfig(env)}
EOF

  ln -s /etc/nginx/sites-available/${env.DEPLOY_SERVICE}.conf /etc/nginx/sites-enabled/${env.DEPLOY_SERVICE}.conf

  # Try the nginx config
  nginx -t

  # Reload nginx if everything is ok
  nginx -s reload

  # install certbot
  apt-get install -y certbot python3-certbot-nginx

  # Set up SSL using LetsEncrypt
  certbot --nginx -d ${env.DEPLOY_SERVER_NAME}

fi


# Reload nginx
nginx -s reload

`);
}

export async function cleanNginx(remote: Remote) {
  const { env } = remote;

  remote.run(`
# Exit if any command fails.
set -e
set -x

# Delete nginx config and reload.
if [ -f "/etc/nginx/sites-available/${env.DEPLOY_SERVICE}.conf" ]; then
  rm -f "/etc/nginx/sites-available/${env.DEPLOY_SERVICE}.conf"
  rm -f "/etc/nginx/sites-enabled/${env.DEPLOY_SERVICE}.conf"
  nginx -s reload
fi

`);
}

export async function initLogRotate(remote: Remote) {
  const { env } = remote;

  remote.run(`
# Exit if any command fails.
set -e
set -x

# Make sure log directory exists.
mkdir -p /var/log/${env.DEPLOY_SERVICE}


# If log rotate file doesn't exist, create it
if [ -f "/etc/logrotate.d/${env.DEPLOY_SERVICE}" ]; then
  echo "Log rotate file already exists at /etc/logrotate.d/${env.DEPLOY_SERVICE}"
else
  cat << 'EOF' >"/etc/logrotate.d/${env.DEPLOY_SERVICE}"
${getLogRotateFile(env)}
EOF

fi

`);
}

export async function cleanLogRotate(remote: Remote) {
  const { env } = remote;

  remote.run(`
# Exit if any command fails.
set -e
set -x

# Delete nginx config and reload.
if [ -f "/etc/logrotate.d/${env.DEPLOY_SERVICE}" ]; then
  rm -f "/etc/logrotate.d/${env.DEPLOY_SERVICE}"
fi

`);
}

function isEnvVarForRuntime(key: string) {
  return !key.startsWith('DEPLOY_');
}

async function readPackageFile(): Promise<PackageFile> {
  return JSON.parse(await fs.promises.readFile('package.json', 'utf8'));
}

async function copyFiles(srcPath: string, dirPath: string) {
  console.log(`Copying files to ${path.resolve(dirPath)} ...`);
  await fs.promises.cp(srcPath, dirPath, { recursive: true });
}

async function installPackages(dirPath: string, opts?: { dev?: boolean }) {
  if (opts?.dev) {
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

function getNginxConfig(env: Record<string, string>): string {
  // The / at the beginning makes it relative to root.
  const servePaths = _.compact(_.split(env.DEPLOY_NGINX_SERVE_REL_PATHS, ':').map(x => x.trim()))
    .map(x => (x.startsWith('/') ? x : `/${x}`))
    .map(x => `${x}$uri`);

  return `
server {
    server_name  ${env.DEPLOY_SERVER_NAME};
    gzip  on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_types *;
    client_max_body_size 20m;
    proxy_connect_timeout       30;
    proxy_send_timeout          30;
    proxy_read_timeout          30;
    send_timeout                30;
    root ${env.DEPLOY_PATH};

    listen       80;
    listen  [::]:80;

    # Try the static files first before passing the request to the node server.
    location / {
        try_files ${servePaths} @proxy_to_server;
    }

    # Proxy to the node server.
    location @proxy_to_server {
        proxy_pass http://127.0.0.1:${env.PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # The following are required by express.js.
        # See https://expressjs.com/en/guide/behind-proxies.html
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
}

function getServiceFile(env: Record<string, string>): string {
  return `
[Service]
ExecStart=node --enable-source-maps dist/server/index.js
Restart=always
StandardOutput=append:/var/log/${env.DEPLOY_SERVICE}/server.log
StandardError=append:/var/log/${env.DEPLOY_SERVICE}/server.log
User=www-data
Group=www-data
WorkingDirectory=${env.DEPLOY_PATH}

[Install]
WantedBy=multi-user.target
`;
}

function getLogRotateFile(env: Record<string, string>): string {
  return `
/var/log/${env.DEPLOY_SERVICE}/server.log {
    daily
    missingok
    rotate 90
    compress
    delaycompress
    notifempty
    create 0640 root adm
    copytruncate
}
`;
}

/**
 * Read ./deploy/NAME.deploy env variables.
 */
export function readEnv(name: string): Record<string, string> {
  let env = {};
  fs.accessSync(`deploy/${name}`); // Make sure file exists.
  dotenv.config({ path: `deploy/${name}`, processEnv: env });
  return env;
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
