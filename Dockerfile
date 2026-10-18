FROM node:20-bookworm-slim

# Dependências para o worker C++ do Mediasoup (caso precise compilar além do binário pré-compilado)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install && (cd node_modules/mediasoup && node npm-scripts.mjs postinstall)

COPY . .

# Gera o bundle do cliente WebRTC (public/dist/bundle.js)
RUN npm run build:client

EXPOSE 3000 3443
EXPOSE 40000-40050/udp
EXPOSE 40000-40050/tcp

CMD ["npm", "start"]
