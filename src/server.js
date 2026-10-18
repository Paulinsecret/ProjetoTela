require('dotenv').config();

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');

const config = require('./config');
const roomManager = require('./sfu/RoomManager');
const {
  verifyRoomPassword,
  sanitizeDisplayName,
  createSessionToken,
  verifySessionToken
} = require('./security/auth');

const app = express();
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);
app.use(express.json({ limit: '64kb' }));

// Rate limit contra tentativas de força bruta na senha da sala
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.'
  }
});

// Servir arquivos estáticos do frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Informações públicas da sala para a tela de login e painel de rede
app.get('/api/info', (req, res) => {
  const roomState = roomManager.getRoomState();
  let tunnelUrl = process.env.PUBLIC_TUNNEL_URL || null;
  const tunnelFile = path.join(__dirname, '..', 'tunnel.url');
  if (!tunnelUrl && fs.existsSync(tunnelFile)) {
    try {
      tunnelUrl = fs.readFileSync(tunnelFile, 'utf8').trim() || null;
    } catch {}
  }

  res.json({
    serverName: config.serverName,
    onlineCount: roomState.members.length,
    activeStreamsCount: roomState.streams.length,
    localIps: config.getLocalIPv4Addresses(),
    announcedIp: process.env.ANNOUNCED_IP || null,
    tunnelUrl,
    iceServers: config.getIceServers(),
    rtcPortRange: `${config.mediasoup.worker.rtcMinPort}-${config.mediasoup.worker.rtcMaxPort}`
  });
});

// Autenticação com Senha Única da Sala
app.post('/api/auth', authLimiter, (req, res) => {
  const { displayName, password } = req.body || {};

  const cleanName = sanitizeDisplayName(displayName);
  if (!cleanName || cleanName.length < 2) {
    return res.status(400).json({
      error: 'Informe um apelido válido (mínimo de 2 caracteres).'
    });
  }

  if (!verifyRoomPassword(password)) {
    return res.status(401).json({
      error: 'Senha da sala incorreta.'
    });
  }

  const token = createSessionToken({ displayName: cleanName });
  const decoded = verifySessionToken(token);

  return res.json({
    token,
    peerId: decoded.peerId,
    displayName: decoded.displayName,
    serverName: config.serverName
  });
});

// Validação de token salvo (reconexão rápida ao atualizar a página)
app.get('/api/verify', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.query.token;
  const payload = verifySessionToken(token);

  if (!payload) {
    return res.status(401).json({ valid: false });
  }

  return res.json({
    valid: true,
    peerId: payload.peerId,
    displayName: payload.displayName,
    serverName: config.serverName
  });
});

// Armazenamento de telemetria e diagnóstico em tempo real (Fase 1)
const recentDiagEntries = [];
const MAX_DIAG_ENTRIES = 120;

app.post('/api/diag', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const session = verifySessionToken(token);
  if (!session) {
    return res.status(401).json({ ok: false });
  }

  const entry = {
    ts: new Date().toISOString(),
    peerId: session.peerId,
    displayName: session.displayName,
    browser: req.body?.browser || '?',
    kind: req.body?.kind || 'event',
    data: req.body?.data || {}
  };

  recentDiagEntries.push(entry);
  if (recentDiagEntries.length > MAX_DIAG_ENTRIES) {
    recentDiagEntries.shift();
  }

  if (entry.kind === 'event') {
    console.log(
      `[DIAG][${entry.displayName} · ${entry.browser}]`,
      JSON.stringify(entry.data)
    );
  }

  return res.json({ ok: true });
});

app.get('/api/diag', (req, res) => {
  res.json({
    count: recentDiagEntries.length,
    entries: recentDiagEntries.slice(-50)
  });
});

/**
 * Gera ou carrega um certificado TLS autoassinado local com todos os IPs da máquina
 * para permitir HTTPS direto (porta 3443) em LAN/VPN mesmo sem domínio público.
 */
function getOrCreateLocalCertificates() {
  const certDir = path.join(__dirname, '..', 'certs');
  const keyPath = path.join(certDir, 'server.key');
  const certPath = path.join(certDir, 'server.crt');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath, 'utf8'),
      cert: fs.readFileSync(certPath, 'utf8')
    };
  }

  const localIps = config.getLocalIPv4Addresses();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...localIps.map((ip) => ({ type: 7, ip }))
  ];

  const attrs = [{ name: 'commonName', value: 'Stage SFU Local HTTPS' }];
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: 365,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }]
  });

  try {
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(keyPath, pems.private, 'utf8');
    fs.writeFileSync(certPath, pems.cert, 'utf8');
  } catch {}

  return {
    key: pems.private,
    cert: pems.cert
  };
}

/**
 * Configura o servidor WebSocket de sinalização do Mediasoup SFU
 */
function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const session = verifySessionToken(token);

    if (!session) {
      ws.close(4001, 'Não autorizado');
      return;
    }

    const { peerId, displayName } = session;

    // Se o usuário deu F5 e tinha uma transmissão aberta na sessão anterior,
    // avisa a sala que a transmissão anterior foi encerrada antes de registrar o novo socket
    const replacedProducers = roomManager.removePeer(peerId);
    for (const closed of replacedProducers) {
      roomManager.broadcast('producerClosed', closed, peerId);
    }

    roomManager.addPeer(peerId, displayName, ws);

    // Envia estado inicial da sala e transmissões já ativas para quem acabou de entrar
    roomManager.sendToPeer(peerId, 'welcome', {
      peerId,
      displayName,
      roomState: roomManager.getRoomState(),
      existingProducers: roomManager.getAllProducersExcept(peerId)
    });

    // Atualiza lista de membros para todos na sala
    roomManager.broadcast('roomState', roomManager.getRoomState());

    ws.on('message', async (raw) => {
      if (!roomManager.isCurrentSocket(peerId, ws)) return;

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const { id, action, data } = msg;

      const reply = (responseData) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ id, ok: true, data: responseData }));
        }
      };

      const replyError = (errMessage) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ id, ok: false, error: errMessage }));
        }
      };

      try {
        switch (action) {
          case 'ping': {
            reply({ pong: Date.now() });
            break;
          }

          case 'getRouterRtpCapabilities': {
            reply(roomManager.getRouterRtpCapabilities());
            break;
          }

          case 'createWebRtcTransport': {
            const clientHost = data?.clientHost || req.headers.host?.split(':')[0] || 'localhost';
            const transportParams = await roomManager.createWebRtcTransport(peerId, clientHost);
            reply(transportParams);
            break;
          }

          case 'connectTransport': {
            const result = await roomManager.connectTransport(
              peerId,
              data.transportId,
              data.dtlsParameters
            );
            reply(result);
            break;
          }

          case 'produce': {
            const producerInfo = await roomManager.produce(peerId, {
              transportId: data.transportId,
              kind: data.kind,
              rtpParameters: data.rtpParameters,
              appData: data.appData || {}
            });

            reply({ id: producerInfo.id });

            // Notifica todos os outros participantes sobre a nova trilha de vídeo/áudio
            roomManager.broadcast(
              'newProducer',
              {
                producerId: producerInfo.id,
                peerId: producerInfo.peerId,
                displayName: producerInfo.displayName,
                kind: producerInfo.kind,
                streamId: producerInfo.streamId,
                meta: producerInfo.meta
              },
              peerId
            );

            roomManager.broadcast('roomState', roomManager.getRoomState());
            break;
          }

          case 'consume': {
            const consumerParams = await roomManager.consume(peerId, {
              transportId: data.transportId,
              producerId: data.producerId,
              rtpCapabilities: data.rtpCapabilities
            });
            reply(consumerParams);
            break;
          }

          case 'resumeConsumer': {
            const result = await roomManager.resumeConsumer(peerId, data.consumerId);
            reply(result);
            break;
          }

          case 'requestKeyFrame': {
            await roomManager.requestKeyFrame(peerId, data.consumerId);
            reply({ requested: true });
            break;
          }

          case 'stopStream': {
            const closedList = roomManager.closeAllPeerProducers(peerId);
            reply({ stopped: true, count: closedList.length });

            for (const closed of closedList) {
              roomManager.broadcast('producerClosed', closed);
            }
            roomManager.broadcast('roomState', roomManager.getRoomState());
            break;
          }

          case 'closeProducer': {
            const closed = roomManager.closeProducer(peerId, data.producerId);
            reply({ closed: Boolean(closed) });
            if (closed) {
              roomManager.broadcast('producerClosed', closed);
              roomManager.broadcast('roomState', roomManager.getRoomState());
            }
            break;
          }

          case 'announceStream': {
            const streamInfo = roomManager.setPeerActiveStream(peerId, data || {});
            reply({ announced: true, streamInfo });
            if (streamInfo) {
              roomManager.broadcast(
                'newProducer',
                {
                  producerId: `p2p-${peerId}`,
                  peerId,
                  displayName,
                  kind: 'video',
                  streamId: streamInfo.streamId,
                  meta: streamInfo.meta
                },
                peerId
              );
              roomManager.broadcast('roomState', roomManager.getRoomState());
            }
            break;
          }

          case 'p2pSignal': {
            const { targetPeerId, signalType, payload } = data || {};
            if (targetPeerId) {
              roomManager.sendToPeer(targetPeerId, 'p2pSignal', {
                fromPeerId: peerId,
                fromDisplayName: displayName,
                signalType,
                payload
              });
            }
            reply({ sent: true });
            break;
          }

          default:
            replyError(`Ação desconhecida: ${action}`);
        }
      } catch (err) {
        console.error(`[WS] Erro na ação ${action}:`, err.message);
        replyError(err.message || 'Erro interno no servidor SFU');
      }
    });

    ws.on('close', () => {
      // Se este socket já foi substituído por uma reconexão (ex: F5), ignora o fechamento atrasado!
      if (!roomManager.isCurrentSocket(peerId, ws)) {
        return;
      }

      const closedProducers = roomManager.removePeer(peerId, ws);
      for (const closed of closedProducers) {
        roomManager.broadcast('producerClosed', closed);
      }
      roomManager.broadcast('peerLeft', { peerId });
      roomManager.broadcast('roomState', roomManager.getRoomState());
    });
  });
}

function startCloudflareTunnelIfAvailable() {
  if (process.env.AUTO_TUNNEL === 'false') return;
  const tunnelFile = path.join(__dirname, '..', 'tunnel.url');
  if (process.env.REUSE_TUNNEL === 'true' && fs.existsSync(tunnelFile)) {
    try {
      const existingUrl = fs.readFileSync(tunnelFile, 'utf8').trim();
      if (existingUrl) {
        console.log(`\n========================================================================`);
        console.log(`[CLOUDFLARE TUNNEL REUTILIZADO] Link HTTPS ativo:`);
        console.log(`👉  ${existingUrl}`);
        console.log(`========================================================================\n`);
        return;
      }
    } catch {}
  }

  const binPath = path.join(
    __dirname,
    '..',
    'bin',
    process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  );
  if (!fs.existsSync(binPath)) return;

  const { spawn } = require('child_process');
  try {
    if (fs.existsSync(tunnelFile)) fs.unlinkSync(tunnelFile);
  } catch {}

  const args = process.env.CLOUDFLARE_TUNNEL_TOKEN
    ? ['tunnel', '--no-autoupdate', 'run', '--token', process.env.CLOUDFLARE_TUNNEL_TOKEN]
    : ['tunnel', '--no-autoupdate', '--url', `http://localhost:${config.port}`];

  const cf = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const parseChunk = (chunk) => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && match[0]) {
      const url = match[0];
      try {
        fs.writeFileSync(tunnelFile, url, 'utf8');
      } catch {}
      console.log(`\n========================================================================`);
      console.log(`[CLOUDFLARE TUNNEL ATIVO] Envie este link HTTPS para seus amigos:`);
      console.log(`👉  ${url}`);
      console.log(`========================================================================\n`);
    }
  };

  cf.stdout.on('data', parseChunk);
  cf.stderr.on('data', parseChunk);

  process.on('exit', () => {
    try {
      cf.kill();
    } catch {}
  });
}

async function startServer() {
  await roomManager.init();

  const httpServer = http.createServer(app);
  attachWebSocketServer(httpServer);

  httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(`[HTTP]  Servidor rodando em http://localhost:${config.port}`);
    startCloudflareTunnelIfAvailable();
  });

  try {
    const creds = getOrCreateLocalCertificates();
    const httpsServer = https.createServer(creds, app);
    attachWebSocketServer(httpsServer);

    httpsServer.listen(config.httpsPort, '0.0.0.0', () => {
      const localIps = config.getLocalIPv4Addresses();
      console.log(`[HTTPS] Servidor seguro direto em https://localhost:${config.httpsPort}`);
      for (const ip of localIps) {
        console.log(`        -> Acesso Rede/VPN (HTTPS): https://${ip}:${config.httpsPort}`);
      }
    });
  } catch (err) {
    console.warn('[HTTPS] Não foi possível iniciar listener HTTPS embutido:', err.message);
  }
}

startServer().catch((err) => {
  console.error('[Fatal] Erro ao iniciar servidor:', err);
  process.exit(1);
});
