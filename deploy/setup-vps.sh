#!/bin/bash
# NanoClaw VPS Setup Script
# Run as root on a fresh Ubuntu 22.04+ Contabo VPS
#
# Usage: curl -sSL https://raw.githubusercontent.com/qwibitai/nanoclaw/main/deploy/setup-vps.sh | sudo bash
# Or:    sudo bash deploy/setup-vps.sh

set -euo pipefail

echo "======================================="
echo "  NanoClaw VPS Setup"
echo "======================================="

# --- 1. Create service user ---
echo "[1/8] Creating nanoclaw service user..."
if ! id nanoclaw &>/dev/null; then
  useradd -m -s /bin/bash -G docker nanoclaw 2>/dev/null || useradd -m -s /bin/bash nanoclaw
fi

# --- 2. Security hardening ---
echo "[2/8] Hardening SSH..."
SSHD_CONFIG="/etc/ssh/sshd_config"
# Disable password authentication (ensure SSH keys are set up FIRST)
if grep -q "^PasswordAuthentication" "$SSHD_CONFIG"; then
  sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
else
  echo "PasswordAuthentication no" >> "$SSHD_CONFIG"
fi

if grep -q "^PermitRootLogin" "$SSHD_CONFIG"; then
  sed -i 's/^PermitRootLogin.*/PermitRootLogin prohibit-password/' "$SSHD_CONFIG"
else
  echo "PermitRootLogin prohibit-password" >> "$SSHD_CONFIG"
fi

systemctl restart sshd

echo "[2/8] Configuring UFW firewall..."
apt-get update -qq
apt-get install -y -qq ufw fail2ban unattended-upgrades > /dev/null

ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (for future webhooks)
ufw allow 443/tcp   # HTTPS
ufw --force enable

echo "[2/8] Enabling fail2ban..."
systemctl enable --now fail2ban

echo "[2/8] Enabling unattended upgrades..."
dpkg-reconfigure -plow unattended-upgrades 2>/dev/null || true

# --- 3. Swap file ---
echo "[3/8] Adding 2GB swap file..."
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "Swap enabled: 2GB"
else
  echo "Swap already exists, skipping"
fi

# --- 4. Install Docker ---
echo "[4/8] Installing Docker Engine..."
if ! command -v docker &>/dev/null; then
  apt-get install -y -qq ca-certificates curl gnupg > /dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin > /dev/null
  usermod -aG docker nanoclaw
  echo "Docker installed"
else
  echo "Docker already installed"
  usermod -aG docker nanoclaw 2>/dev/null || true
fi

# --- 5. Install Node.js 22 LTS ---
echo "[5/8] Installing Node.js 22 LTS..."
if ! command -v node &>/dev/null || ! node -v | grep -q "v22"; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null
  echo "Node.js $(node -v) installed"
else
  echo "Node.js $(node -v) already installed"
fi

# --- 6. Install Claude Code CLI ---
echo "[6/8] Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code > /dev/null 2>&1
echo "Claude Code CLI installed"

# --- 7. Clone and set up NanoClaw ---
echo "[7/8] Setting up NanoClaw..."
NANOCLAW_DIR="/home/nanoclaw/nanoclaw"
if [ ! -d "$NANOCLAW_DIR" ]; then
  sudo -u nanoclaw git clone https://github.com/qwibitai/nanoclaw.git "$NANOCLAW_DIR"
fi

cd "$NANOCLAW_DIR"
sudo -u nanoclaw npm install

# Create .env template if it doesn't exist
if [ ! -f "$NANOCLAW_DIR/.env" ]; then
  cat > "$NANOCLAW_DIR/.env" << 'ENVEOF'
# NanoClaw Configuration
# =====================

# Required: Anthropic API key (from console.anthropic.com)
ANTHROPIC_API_KEY=sk-ant-XXXXX

# Assistant name (used as WhatsApp trigger: @Andy)
ASSISTANT_NAME=Andy

# SMTP Configuration for Email Outreach
SMTP_HOST=smtp.yourdomain.com
SMTP_PORT=587
SMTP_USER=outreach@yourdomain.com
SMTP_PASS=your-smtp-password
SMTP_FROM=Your Name <outreach@yourdomain.com>

# X/Twitter API (Free tier: 1,500 posts/month)
# X_API_KEY=
# X_API_SECRET=
# X_ACCESS_TOKEN=
# X_ACCESS_SECRET=

# Facebook Page (Graph API v19.0)
# FB_PAGE_ID=
# FB_PAGE_ACCESS_TOKEN=

# LinkedIn (API v2)
# LINKEDIN_ACCESS_TOKEN=
# LINKEDIN_PERSON_URN=urn:li:person:XXXXX

# Optional: timezone for scheduled tasks (default: system timezone)
# TZ=America/New_York
ENVEOF
  chown nanoclaw:nanoclaw "$NANOCLAW_DIR/.env"
  chmod 600 "$NANOCLAW_DIR/.env"
  echo ".env template created at $NANOCLAW_DIR/.env"
fi

# Build the agent container
echo "[7/8] Building agent container..."
sudo -u nanoclaw bash -c "cd $NANOCLAW_DIR && bash container/build.sh" || echo "Container build will need to be run after Docker group takes effect (re-login)"

# --- 8. Install systemd service ---
echo "[8/8] Installing systemd service..."
cp "$NANOCLAW_DIR/deploy/nanoclaw.service" /etc/systemd/system/nanoclaw.service
systemctl daemon-reload
systemctl enable nanoclaw

echo ""
echo "======================================="
echo "  Setup Complete!"
echo "======================================="
echo ""
echo "Next steps:"
echo "  1. Edit /home/nanoclaw/nanoclaw/.env with your API keys"
echo "  2. Log in as nanoclaw user: su - nanoclaw"
echo "  3. Run Claude Code setup: cd ~/nanoclaw && claude /setup"
echo "  4. Scan the WhatsApp QR code"
echo "  5. Start the service: sudo systemctl start nanoclaw"
echo "  6. Check logs: sudo journalctl -u nanoclaw -f"
echo ""
echo "Important: You may need to log out and back in for Docker group to take effect."
echo ""
