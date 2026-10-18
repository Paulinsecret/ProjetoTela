const os = require('os');
const net = require('net');
const dns = require('dns').promises;

/**
 * Descobre todos os IPs IPv4 locais da máquina/container (LAN, VPN Tailscale/Radmin, etc.)
 */
function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const ips = new Set();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address) {
        ips.add(iface.address);
      }
    }
  }
  return Array.from(ips);
}

/**
 * Resolve um hostname (ex: meuservidor.duckdns.org) ou valida um IP
 * para ser usado com segurança no announcedIp do Mediasoup C++.
 */
async function resolveToIPv4(hostOrIp) {
  if (!hostOrIp || typeof hostOrIp !== 'string') return null;
  const clean = hostOrIp.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!clean || clean === 'localhost') return '127.0.0.1';

  // Domínios de túnel HTTP da Cloudflare apontam para o proxy HTTP da Cloudflare,
  // portanto não devem ser resolvidos como IP de mídia UDP local do Mediasoup.
  if (clean.endsWith('.trycloudflare.com') || clean.endsWith('.cfargotunnel.com')) {
    return null;
  }

  if (net.isIPv4(clean)) {
    return clean;
  }

  try {
    const result = await dns.lookup(clean, { family: 4 });
    return result && result.address ? result.address : null;
  } catch {
    return null;
  }
}

/**
 * Constrói dinamicamente a lista de candidatos ICE (listenIps) para suportar
 * simultaneamente conexões via Localhost, LAN, VPN (Tailscale/Radmin) e Internet (DuckDNS/Port Forward).
 */
async function resolveListenIps(clientHost) {
  const announcedCandidates = new Set();

  // 1. Se o usuário configurou ANNOUNCED_IP no .env (IP Público, DuckDNS ou IP da VPN/Host)
  if (process.env.ANNOUNCED_IP) {
    const parts = process.env.ANNOUNCED_IP.split(',').map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      const resolved = await resolveToIPv4(part);
      if (resolved) announcedCandidates.add(resolved);
    }
  }

  // 2. Host/IP exato que o navegador do amigo usou para abrir o site
  if (clientHost) {
    const resolvedClientHost = await resolveToIPv4(clientHost);
    if (resolvedClientHost) {
      announcedCandidates.add(resolvedClientHost);
    }
  }

  // 3. IPs das placas de rede locais / VPNs detectadas
  for (const localIp of getLocalIPv4Addresses()) {
    announcedCandidates.add(localIp);
  }

  // 4. Loopback local sempre disponível para quem abre no próprio PC servidor
  announcedCandidates.add('127.0.0.1');

  return Array.from(announcedCandidates).map((announcedIp) => ({
    ip: '0.0.0.0',
    announcedIp
  }));
}

/**
 * Lista de servidores ICE (STUN Cloudflare/Google + TURN de fallback para furar CGNAT no Cloudflare Tunnel)
 */
function getIceServers() {
  const iceServers = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ];

  if (process.env.TURN_URL) {
    const turnConfig = { urls: process.env.TURN_URL };
    if (process.env.TURN_USERNAME) turnConfig.username = process.env.TURN_USERNAME;
    if (process.env.TURN_PASSWORD) turnConfig.credential = process.env.TURN_PASSWORD;
    iceServers.push(turnConfig);
  }

  return iceServers;
}

const config = {
  serverName: process.env.SERVER_NAME || 'STAGE // 1080p60',
  port: parseInt(process.env.PORT || '3000', 10),
  httpsPort: parseInt(process.env.HTTPS_PORT || '3443', 10),

  mediasoup: {
    worker: {
      rtcMinPort: parseInt(process.env.RTC_MIN_PORT || '40000', 10),
      rtcMaxPort: parseInt(process.env.RTC_MAX_PORT || '40050', 10),
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
    },

    router: {
      mediaCodecs: [
        // Áudio Opus Estéreo de Alta Fidelidade (Jogos/Sistema sem abafamento de voz)
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          parameters: {
            stereo: 1,
            'sprop-stereo': 1,
            maxaveragebitrate: 256000,
            useinbandfec: 1,
            usedtx: 0
          }
        },
        // H.264 acelerado por GPU (NVENC / AMD AMF / Intel QuickSync) - Perfil Constrained Baseline
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 6000,
            'x-google-min-bitrate': 3500,
            'x-google-max-bitrate': 20000
          }
        },
        // H.264 Main/High Profile para 1080p60 de alta nitidez
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '4d0032',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 6000,
            'x-google-min-bitrate': 3500,
            'x-google-max-bitrate': 20000
          }
        },
        // VP9 para altíssima qualidade visual por megabit
        {
          kind: 'video',
          mimeType: 'video/VP9',
          clockRate: 90000,
          parameters: {
            'profile-id': 0,
            'x-google-start-bitrate': 6000,
            'x-google-min-bitrate': 3500,
            'x-google-max-bitrate': 20000
          }
        },
        // VP8 fallback universal de alta taxa de bits
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {
            'x-google-start-bitrate': 6000,
            'x-google-min-bitrate': 3500,
            'x-google-max-bitrate': 20000
          }
        }
      ]
    },

    webRtcTransport: {
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 15000000, // 15 Mbps iniciais por transporte
      maxIncomingBitrate: 25000000 // Suporta até 25 Mbps por stream de entrada
    }
  },

  resolveListenIps,
  getLocalIPv4Addresses,
  getIceServers
};

module.exports = config;
