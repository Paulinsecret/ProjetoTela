# Stage SFU — Compartilhamento de Tela Local (1080p 60fps)

Aplicação auto-hospedada (self-hosted) de compartilhamento de tela e jogos em **1080p a 60 FPS** com baixíssima latência e áudio estéreo de alta fidelidade, construída com **Node.js**, **Mediasoup (WebRTC SFU em C++)** e **Docker**.

---

## Principais Recursos

- **Motor WebRTC SFU (Mediasoup C++):** Quem transmite codifica o vídeo apenas 1 vez; o servidor SFU distribui os pacotes RTP/SRTP para todos os amigos na sala sem recodificar e com uso mínimo de CPU.
- **Qualidade 1080p @ 60 FPS (e até 1440p60):**
  - Seletor de Bitrate: **8 Mbps**, **12 Mbps**, **15 Mbps** ou **20 Mbps**.
  - Seletor de Codec: **H.264 (NVENC / AMD AMF / QuickSync)**, **VP9** ou **VP8**.
  - Otimização `contentHint = 'motion'` para manter 60 FPS cravados em jogos sem queda de quadros.
- **Áudio Estéreo de Jogos (Opus 256 kbps):** Sem supressão de ruído ou cancelamento de eco que abafam o som do jogo.
- **Múltiplas Telas Simultâneas (Palco + Mosaico):**
  - Qualquer amigo conectado na sala pode clicar em **Compartilhar Tela** simultaneamente.
  - Alterne entre **Modo Palco** (1 transmissão principal em destaque + miniaturas laterais) e **Modo Mosaico** (grade lado a lado para assistir várias lives juntas).
  - Controle de volume e Mute **individual** para cada transmissão.
- **Telemetria em Tempo Real:** Exibição ao vivo de Resolução, FPS, Bitrate (Mbps), Codec ativo e Ping (ms).
- **Segurança:** Acesso protegido por senha única da sala (`ROOM_PASSWORD`), comparação resistente a Timing Attack, tokens de sessão HMAC assinados e proteção contra força bruta (`express-rate-limit`).

---

## Como Rodar com Docker (Recomendado)

1. Certifique-se de que o **Docker Desktop** está aberto e rodando.
2. Personalize a senha da sua sala no arquivo `.env` (ex: `ROOM_PASSWORD="minha-senha-secreta"`).
3. Suba os containers:
   ```bash
   docker compose up -d --build
   ```
4. Acesse no seu navegador:
   - **No próprio PC servidor:** `http://localhost:3000` ou `https://localhost:3443` (ou via Caddy em `https://localhost:8443`)

---

## Como Conectar Seus Amigos (3 Modos 100% Gratuitos via `.env`)

Os navegadores exigem **HTTPS** para liberar captura de tela e áudio WebRTC fora do `localhost`. A arquitetura híbrida já suporta os 3 cenários sem alterar código:

### Modo 1: Via VPN de Jogos (Tailscale / Radmin VPN / ZeroTier) — *Mais Fácil e Fura CGNAT*
1. Conecte você e seus amigos na mesma rede Tailscale ou Radmin VPN.
2. Coloque o seu IP da VPN no `.env`:
   ```env
   ANNOUNCED_IP="SEU_IP_DA_VPN"
   ```
3. Seus amigos abrem no navegador: `https://SEU_IP_DA_VPN:3443` (ou `:8443`).
   *(Ao usar certificado local autoassinado na primeira vez, basta clicar em "Avançado -> Continuar").*

### Modo 2: Via Domínio Gratuito (DuckDNS) + Port Forwarding no Roteador — *Sem VPN pros Amigos*
1. Crie um domínio gratuito em [duckdns.org](https://www.duckdns.org) apontando para seu IP Público.
2. No seu roteador, redirecione (Port Forward) para o IP local do seu PC:
   - Portas TCP/UDP `40000` até `40050` (Vídeo/Áudio WebRTC)
   - Porta TCP `443` (redirecionada para `8443` do Caddy ou altere `8443:443` para `443:443` no `docker-compose.yml`)
3. No `.env`, preencha:
   ```env
   ANNOUNCED_IP="seudominio.duckdns.org"
   CADDY_DOMAIN="seudominio.duckdns.org"
   ```
4. Reinicie com `docker compose up -d`: o Caddy gerará um certificado HTTPS oficial (Let's Encrypt) automaticamente!

### Modo 3: Túnel HTTPS Gratuito (Cloudflare Tunnel / Tailscale Funnel / Playit.gg)
1. Aponte seu túnel HTTPS para `http://localhost:3000`.
2. Para o tráfego de mídia WebRTC, informe o endereço público do seu roteador/túnel em `ANNOUNCED_IP` no `.env` (ou adicione um servidor TURN gratuito nas variáveis `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD`).

---

## Etapas de Desenvolvimento Concluídas

- [x] **Etapa 1:** Estrutura base do projeto, dependências (`package.json`), `.gitignore` e variáveis de ambiente (`.env.example`)
- [x] **Etapa 2:** Camada de Segurança (`src/security/auth.js`) + Configuração do Mediasoup SFU (`src/config.js`)
- [x] **Etapa 3:** Gerenciador de Sala e Múltiplas Transmissões (`src/sfu/RoomManager.js` + `src/server.js`)
- [x] **Etapa 4:** Interface Web Minimalista (`public/index.html`, `public/css/styles.css`, `public/js/client.js`)
- [x] **Etapa 5:** Containerização com Docker (`Dockerfile`, `docker-compose.yml` e `Caddyfile`)
