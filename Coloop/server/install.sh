#!/bin/bash
# Run from a reviewed deployment bundle as root. Does not change SSH or existing sites.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
cd -- "$(dirname -- "$0")"
: "${COLOOP_SERVER_IP:?Provide the server public IPv4}"
[[ "$COLOOP_SERVER_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
test -f relay.mjs
test -f relay.json
if [[ -e /etc/coloop/relay.json ]]; then
  echo 'Existing Coloop installation detected; use a reviewed update, not a fresh install.' >&2
  exit 2
fi
if ss -H -lnt '( sport = :80 or sport = :443 or sport = :8787 )' | grep -q .; then
  echo 'A service already uses a required port. No changes made.' >&2
  exit 2
fi
apt-get update -qq
apt-get install -y -qq nginx python3-venv curl xz-utils ca-certificates
install -d -m 755 /opt/coloop /var/www/coloop-acme
install -d -m 750 /etc/coloop
id coloop >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin coloop
chown root:coloop /etc/coloop
install -m 644 relay.mjs /opt/coloop/relay.mjs
install -m 640 -o root -g coloop relay.json /etc/coloop/relay.json

# Keep the runtime isolated from system packages; verify the official download.
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o /opt/coloop/SHASUMS256.txt
node_archive=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print $2}' /opt/coloop/SHASUMS256.txt)
[[ "$node_archive" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$ ]] || exit 2
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://nodejs.org/dist/latest-v24.x/$node_archive" -o "/opt/coloop/$node_archive"
(cd /opt/coloop; awk -v file="$node_archive" '$2 == file' SHASUMS256.txt | sha256sum -c -)
install -d -m 755 /opt/coloop/node
tar -xJf "/opt/coloop/$node_archive" -C /opt/coloop/node --strip-components=1
/opt/coloop/node/bin/node --check /opt/coloop/relay.mjs
python3 -m venv /opt/coloop/certbot
/opt/coloop/certbot/bin/pip -q install 'certbot>=5.4,<6'

cat >/etc/systemd/system/coloop-relay.service <<'UNIT'
[Unit]
Description=Coloop application message service
After=network-online.target
Wants=network-online.target
[Service]
User=coloop
Group=coloop
WorkingDirectory=/opt/coloop
ExecStart=/opt/coloop/node/bin/node /opt/coloop/relay.mjs
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
PrivateDevices=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
MemoryMax=192M
TasksMax=64
LimitNOFILE=1024
[Install]
WantedBy=multi-user.target
UNIT

# Only the ACME challenge is served on plain HTTP; application messages require TLS.
cat >/etc/nginx/sites-available/coloop <<NGINX
server {
    listen 80;
    server_name $COLOOP_SERVER_IP;
    access_log off;
    location ^~ /.well-known/acme-challenge/ { root /var/www/coloop-acme; }
    location / { return 404; }
}
NGINX
ln -s /etc/nginx/sites-available/coloop /etc/nginx/sites-enabled/coloop
nginx -t
systemctl enable --now nginx
systemctl reload nginx

# This step accepts the CA subscriber agreement; obtain explicit approval before running.
/opt/coloop/certbot/bin/certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
  --preferred-profile shortlived --webroot --webroot-path /var/www/coloop-acme \
  --cert-name coloop-ip --ip-address "$COLOOP_SERVER_IP"

cat >>/etc/nginx/sites-available/coloop <<NGINX
server {
    listen 443 ssl;
    server_name $COLOOP_SERVER_IP;
    ssl_certificate /etc/letsencrypt/live/coloop-ip/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/coloop-ip/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    server_tokens off;
    client_max_body_size 400k;
    client_body_timeout 8s;
    access_log off;
    add_header X-Content-Type-Options nosniff always;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Connection "";
        proxy_read_timeout 45s;
        proxy_send_timeout 10s;
    }
}
NGINX
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat >/etc/letsencrypt/renewal-hooks/deploy/coloop-nginx <<'HOOK'
#!/bin/sh
nginx -t && systemctl reload nginx
HOOK
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/coloop-nginx
cat >/etc/systemd/system/coloop-cert-renew.service <<'UNIT'
[Unit]
Description=Renew Coloop public IP TLS certificate
[Service]
Type=oneshot
ExecStart=/opt/coloop/certbot/bin/certbot renew --quiet
UNIT
cat >/etc/systemd/system/coloop-cert-renew.timer <<'UNIT'
[Unit]
Description=Check Coloop TLS renewal twice daily
[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=900
Persistent=true
[Install]
WantedBy=timers.target
UNIT
nginx -t
systemctl daemon-reload
systemctl enable --now coloop-relay coloop-cert-renew.timer
systemctl reload nginx
status=000
for attempt in {1..20}; do
  status=$(curl --max-time 5 --silent --show-error --output /dev/null --write-out '%{http_code}' https://"$COLOOP_SERVER_IP"/healthz || true)
  [[ "$status" == 401 ]] && break
  sleep 0.5
done
test "$status" = 401
printf '\nDEPLOYMENT_READY\n'
systemctl is-active coloop-relay nginx coloop-cert-renew.timer
