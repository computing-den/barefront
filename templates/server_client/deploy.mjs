import * as util from 'node:util';
import * as barefront from 'barefront';
import packageJSON from './package.json' assert { type: 'json' };

let OPTIONS;
let BUILD_TIME = new Date().toISOString();

function main() {
  readArgs();
  barefront.readEnv(OPTIONS.deployName);

  if (OPTIONS['init-server']) {
    initServer();
  } else if (OPTIONS['clean-server']) {
    cleanServer();
  } else {
    deploy();
  }
}

function readArgs() {
  const { values, positionals } = util.parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      'init-server': { type: 'boolean' },
      'clean-server': { type: 'boolean' },
    },
  });

  OPTIONS = { ...values, deployName: positionals[0] };

  if (!OPTIONS.deployName) {
    barefront.exitWithError('Usage: npm run deploy [--init-server | --clean-server] DEPLOY_NAME');
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

        # The following are required by express.js.
        # See https://expressjs.com/en/guide/behind-proxies.html
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
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

function cleanServer() {
  const { DEPLOY_SERVICE } = process.env;

  runRemote(`
# Exit if any command fails.
set -e
set -x

# Disable, stop, and delete the systemd service.
if [ -f "/etc/systemd/system/${DEPLOY_SERVICE}.service" ]; then
  systemctl disable --now ${DEPLOY_SERVICE}
  rm -f "/etc/systemd/system/${DEPLOY_SERVICE}.service"
fi

# Delete nginx config and reload.
if [ -f "/etc/nginx/sites-available/${DEPLOY_SERVICE}.conf" ]; then
  rm -f "/etc/nginx/sites-available/${DEPLOY_SERVICE}.conf"
  rm -f "/etc/nginx/sites-enabled/${DEPLOY_SERVICE}.conf"
  nginx -s reload
fi
`);
}

function deploy() {
  const { DEPLOY_SSH_HOST, DEPLOY_BUILD_PATH, DEPLOY_PATH, DEPLOY_SERVICE } = process.env;
  const DEPLOY_BACKUP_PATH = `${DEPLOY_PATH}-backup-${BUILD_TIME}`;
  const packName = `${packageJSON.name}-${packageJSON.version}.tgz`;

  // Remove old dist/package
  run('rm', '-rf', 'dist/package');

  // npm pack
  run('npm', 'pack', '--pack-destination', 'dist');

  // Extract to dist/package so we can modify it
  run('tar', 'xf', `dist/${packName}`, '--directory=dist');

  // Add .env
  run('cp', `deploy/${OPTIONS.deployName}.deploy`, 'dist/package/.env');

  // Repackage
  run('tar', 'caf', `dist/${packName}`, '--directory=dist', 'package'); // relative to dist

  // Upload.
  runRemote(`rm -rf '${DEPLOY_BUILD_PATH}'`);
  run('rsync', '-r', `dist/${packName}`, `${DEPLOY_SSH_HOST}:${DEPLOY_BUILD_PATH}/`);

  // Deploy.
  runRemote(`

# Exit if any command fails.
set -e
set -x

# Decompress archive.
# The --strip-components=1 removes the package/ prefix
cd '${DEPLOY_BUILD_PATH}'
tar --strip-components=1 -xzf ${packName}
mkdir -p private

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

function run(cmd, ...args) {
  return barefront.execOpt({ verbose: true }, cmd, ...args);
}

function runRemote(cmd, ...args) {
  return barefront.execOpt({ sshHost: process.env.DEPLOY_SSH_HOST }, cmd, ...args);
}

main();
