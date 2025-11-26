#!/bin/bash
set -e

echo "🔧 Setting up VPS for deployment..."

# Configuration
DEPLOY_PATH="${DEPLOY_PATH:-/opt/chat-app}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"

echo "📁 Creating deployment directory..."
sudo mkdir -p "$DEPLOY_PATH"
sudo chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_PATH"

echo "📦 Installing dependencies..."
# Update package lists
sudo apt-get update

# Install Docker if not already installed
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker "$DEPLOY_USER"
    rm get-docker.sh
else
    echo "Docker already installed"
fi

# Install Docker Compose if not already installed
if ! docker compose version &> /dev/null; then
    echo "Docker Compose plugin not found, installing..."
    sudo apt-get install -y docker-compose-plugin
else
    echo "Docker Compose already installed"
fi

# Install Git if not already installed
if ! command -v git &> /dev/null; then
    echo "Installing Git..."
    sudo apt-get install -y git
else
    echo "Git already installed"
fi

echo "🔐 Setting up deployment directory..."
cd "$DEPLOY_PATH"

# Clone repositories if they don't exist
if [ ! -d "chat-microservices" ]; then
    echo "Cloning backend repository..."
    git clone https://github.com/christiantroyandrada/chat-user-microservice.git chat-microservices
else
    echo "Backend repository already exists"
fi

if [ ! -d "chat-microservices-frontend" ]; then
    echo "Cloning frontend repository..."
    git clone https://github.com/christiantroyandrada/chat-microservices-frontend.git chat-microservices-frontend
else
    echo "Frontend repository already exists"
fi

echo "✅ VPS setup completed!"
echo ""
echo "📝 Next steps:"
echo "1. Copy your app_secrets file to: $DEPLOY_PATH/chat-microservices/docker-secrets/"
echo "2. Set up GitHub Actions secrets (SSH_HOST, SSH_USER, SSH_PRIVATE_KEY)"
echo "3. Push to main branch to trigger deployment"
