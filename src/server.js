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
  res.json({
    serverName: config.serverName,
    onlineCount: roomState.members.length,
    activeStreamsCount: roomState.streams.length,
    localIps: config.getLocalIPv4Addresses(),
    announcedIp: process.env.ANNOUNCED_IP || null,
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

          default:
            replyError(`Ação desconhecida: ${action}`);
        }
      } catch (err) {
        console.error(`[WS] Erro na ação ${action}:`, err.message);
        replyError(err.message || 'Erro interno no servidor SFU');
      }
    });

    ws.on('close', () => {
      const closedProducers = roomManager.removePeer(peerId);
      for (const closed of closedProducers) {
        roomManager.broadcast('producerClosed', closed);
      }
      roomManager.broadcast('roomState', roomManager.getRoomState());
    });
  });
}

async function startServer() {
  await roomManager.init();

  const httpServer = http.createServer(app);
  attachWebSocketServer(httpServer);

  httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(`[HTTP]  Servidor rodando em http://localhost:${config.port}`);
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
