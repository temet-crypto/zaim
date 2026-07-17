#!/bin/bash
# ═══════════════════════════════════════════════════════════
# ZAIM — Server Setup Script
# Runs on the EC2 instance after file upload
# Installs Docker, builds the app, starts containers
# ═══════════════════════════════════════════════════════════

set -euo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[ZAIM]${NC} $1"; }

cd ~/zaim

# ── Install Docker ────────────────────────────────────────
if ! command -v docker &> /dev/null; then
    log "📦 Installing Docker..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq ca-certificates curl gnupg lsb-release

    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
        $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update -qq
    sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    sudo usermod -aG docker ubuntu
    log "Docker installed ✓"
else
    log "Docker already installed ✓"
fi

# ── Install Node.js (for building) ───────────────────────
if ! command -v node &> /dev/null; then
    log "📦 Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
    log "Node.js $(node -v) installed ✓"
else
    log "Node.js $(node -v) already installed ✓"
fi

# ── Create necessary directories ──────────────────────────
mkdir -p certbot/conf certbot/www envoy zcash

# ── Move setup files if they were uploaded flat ───────────
[ -f ~/zaim/envoy.yaml ] && mv ~/zaim/envoy.yaml ~/zaim/envoy/ 2>/dev/null || true
[ -f ~/zaim/zcash.conf ] && mv ~/zaim/zcash.conf ~/zaim/zcash/ 2>/dev/null || true

# ── Build the App ─────────────────────────────────────────
log "🔨 Installing dependencies..."
npm ci --prefer-offline 2>/dev/null || npm install

log "🔨 Building ZAIM..."
npm run build

log "Build complete ✓ ($(du -sh dist/ | cut -f1))"

# ── Start with Docker (Lite mode) ────────────────────────
# Lite mode = just the web app, uses ChainSafe public lightwalletd
# Full mode (docker-compose.yml) includes zcashd + lightwalletd + envoy
log "🐳 Starting ZAIM (lite mode)..."

# Use docker compose (v2 plugin syntax)
sudo docker compose -f docker-compose.lite.yml down 2>/dev/null || true
sudo docker compose -f docker-compose.lite.yml up -d --build

# ── Verify ────────────────────────────────────────────────
sleep 3
if curl -s -o /dev/null -w "%{http_code}" http://localhost | grep -q "200"; then
    log "✅ ZAIM is running!"
else
    warn "App may still be starting. Check: sudo docker compose -f docker-compose.lite.yml logs"
fi

# ── Create helper scripts ─────────────────────────────────

# SSL setup script
cat > ~/zaim/setup-ssl.sh << 'SSL'
#!/bin/bash
DOMAIN=$1
if [ -z "$DOMAIN" ]; then
    echo "Usage: ./setup-ssl.sh yourdomain.com"
    exit 1
fi

echo "Setting up SSL for ${DOMAIN}..."

# Stop nginx temporarily for standalone cert
sudo docker compose -f docker-compose.lite.yml stop zaim-web

# Get certificate
sudo docker run --rm -p 80:80 \
    -v $(pwd)/certbot/conf:/etc/letsencrypt \
    -v $(pwd)/certbot/www:/var/www/certbot \
    certbot/certbot certonly --standalone \
    --email admin@${DOMAIN} --agree-tos --no-eff-email \
    -d ${DOMAIN}

# Create SSL nginx config
cat > nginx/zaim-ssl.conf << NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};
    root /usr/share/nginx/html;
    index index.html;

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # CRITICAL: SharedArrayBuffer headers for WASM
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;

    # Security
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=63072000" always;

    types { application/wasm wasm; }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/wasm;
}
NGINX

# Restart with SSL config
sudo docker compose -f docker-compose.lite.yml up -d --build
echo "✅ SSL configured for https://${DOMAIN}"
SSL
chmod +x ~/zaim/setup-ssl.sh

# Status script
cat > ~/zaim/status.sh << 'STATUS'
#!/bin/bash
echo "═══ ZAIM Status ═══"
sudo docker compose -f docker-compose.lite.yml ps
echo ""
echo "═══ Logs (last 20) ═══"
sudo docker compose -f docker-compose.lite.yml logs --tail=20
STATUS
chmod +x ~/zaim/status.sh

# Redeploy script (for code updates)
cat > ~/zaim/redeploy.sh << 'REDEPLOY'
#!/bin/bash
echo "🔄 Rebuilding ZAIM..."
cd ~/zaim
npm install
npm run build
sudo docker compose -f docker-compose.lite.yml up -d --build
echo "✅ Redeployed!"
REDEPLOY
chmod +x ~/zaim/redeploy.sh

log "Helper scripts created: setup-ssl.sh, status.sh, redeploy.sh"
echo ""
log "═══════════════════════════════════════════════════════"
log "  ZAIM server setup complete!"
log "═══════════════════════════════════════════════════════"
