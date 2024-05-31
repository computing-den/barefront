import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import cp from 'node:child_process';
import * as util from 'node:util';

let OPTIONS;
let BUILD_TIME = new Date().toISOString();

function main() {
  readArgs();
  readEnv();

  if (OPTIONS['init-server']) {
    initServer();
  } else {
    deploy();
  }
}

function initServer() {
  const { DEPLOY_PATH, DEPLOY_SERVICE, DEPLOY_SERVER_NAME, PORT } = process.env;

  // Create systemd service file and enable it
  runRemote(`
# Exit if any command fails.
set -e
set -x

# If service file doesn't exist, create it
if [ -f "/etc/systemd/system/${DEPLOY_SERVICE}.service" ]; then
  echo "Service file already exists at /etc/systemd/system/${DEPLOY_SERVICE}.service"
else
  cat << 'EOF' >/etc/systemd/system/${DEPLOY_SERVICE}.service
[Service]
ExecStart=node --enable-source-maps dist/server/index.js
Restart=always
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=${DEPLOY_SERVICE}
User=www-data
Group=www-data
WorkingDirectory=${DEPLOY_PATH}

[Install]
WantedBy=multi-user.target
EOF
  echo "Created systemd service file at /etc/systemd/system/${DEPLOY_SERVICE}.service"
fi

# Enable
systemctl enable ${DEPLOY_SERVICE}
echo "Enabled the ${DEPLOY_SERVICE} service"


# If nginx config file doesn't exist, create it
if [ -f "/etc/nginx/sites-available/${DEPLOY_SERVICE}.conf" ]; then
  echo "Nginx config file already exists at /etc/nginx/sites-available/${DEPLOY_SERVICE}.conf"
else
  cat << 'EOF' >/etc/nginx/sites-available/${DEPLOY_SERVICE}.conf
server {
    server_name  ${DEPLOY_SERVER_NAME};
    gzip  on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_types *;
    client_max_body_size 20m;
    proxy_connect_timeout       30;
    proxy_send_timeout          30;
    proxy_read_timeout          30;
    send_timeout                30;

    listen       80;
    listen  [::]:80;

    # Try the static files first before passing the request to the node server.
    location / {
        try_files ${DEPLOY_PATH}/dist/public$uri ${DEPLOY_PATH}/public$uri @proxy_to_server;
    }

    # Proxy to the node server.
    location @proxy_to_server {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
EOF

  ln -s /etc/nginx/sites-available/${DEPLOY_SERVICE}.conf /etc/nginx/sites-enabled/${DEPLOY_SERVICE}.conf

  # Try the nginx config
  nginx -t

  # Reload nginx if everything is ok
  nginx -s reload

  # install certbot
  apt-get install -y certbot python3-certbot-nginx

  # Set up SSL using LetsEncrypt
  certbot --nginx -d ${DEPLOY_SERVER_NAME}

fi


# Reload nginx
nginx -s reload

`);
}

function deploy() {
  const { DEPLOY_SSH_HOST, DEPLOY_BUILD_PATH, DEPLOY_PATH, DEPLOY_SERVICE } = process.env;
  const DEPLOY_BACKUP_PATH = `${DEPLOY_PATH}-backup-${BUILD_TIME}`;

  // Make archive.
  run('rm', '-rf', 'dist/deploy/');
  run('git', 'checkout-index', '-a', '-f', '--prefix=dist/deploy/');
  run('mkdir', '-p', 'dist/deploy/private');
  run('cp', `deploy/${OPTIONS.deployName}.deploy`, 'dist/deploy/.env');
  run('tar', 'caf', 'dist/deploy.tar.gz', '--directory=dist/deploy', '.'); // relative to dist/deploy

  // Upload.
  runRemote(`rm -rf '${DEPLOY_BUILD_PATH}'`);
  run('rsync', '-r', 'dist/deploy.tar.gz', `${DEPLOY_SSH_HOST}:${DEPLOY_BUILD_PATH}/`);

  // Deploy.
  runRemote(`

# Exit if any command fails.
set -e
set -x

# Decompress archive.
cd '${DEPLOY_BUILD_PATH}'
tar xf deploy.tar.gz

# Install and build.
npm install
chown -R www-data:www-data .
npm run build
chown -R www-data:www-data .

# Stop service if running
systemctl stop ${DEPLOY_SERVICE} || true

# Copy the old private directory.
if [ -d '${DEPLOY_PATH}/private' ]; then
  rsync -a '${DEPLOY_PATH}/private/' '${DEPLOY_BUILD_PATH}/private/'
fi

# Make a backup of the old deploy.
if [ -d '${DEPLOY_PATH}' ]; then
  mv '${DEPLOY_PATH}' '${DEPLOY_BACKUP_PATH}'
fi

mv '${DEPLOY_BUILD_PATH}' '${DEPLOY_PATH}'

systemctl start ${DEPLOY_SERVICE}

`);
}

function runRemote(cmd) {
  return run('ssh', process.env.DEPLOY_SSH_HOST, cmd);
}

function runRemoteNoThrow(cmd) {
  return runNoThrow('ssh', process.env.DEPLOY_SSH_HOST, cmd);
}

function run(cmd, ...args) {
  const status = runNoThrow(cmd, ...args);
  if (status !== 0) exitWithError(`Command ${cmd} failed with status ${status}.`);
  return status;
}

function runNoThrow(cmd, ...args) {
  console.log(cmd, args.map(x => `"${x}"`).join(' '));
  return cp.spawnSync(cmd, args, { stdio: 'inherit' }).status;
}

function exitWithError(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(-1);
}

// Apply ./deploy/NAME.deploy env variables.
function readEnv() {
  fs.accessSync(`deploy/${OPTIONS.deployName}.deploy`); // Make sure file exists.
  dotenv.config({ path: `deploy/${OPTIONS.deployName}.deploy` });
}

function readArgs() {
  const { values, positionals } = util.parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      'init-server': { type: 'boolean' },
    },
  });

  OPTIONS = { ...values, deployName: positionals[0] };

  if (!OPTIONS.deployName) {
    exitWithError('Usage: npm run deploy [--init-sever] DEPLOY_NAME');
  }
}

main();
