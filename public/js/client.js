// ============================================================================
// ESTADO GLOBAL DO CLIENTE
// ============================================================================

// Identificador único desta aba/carregamento de página. Garante que duas abas
// (ou um F5) nunca compartilhem o mesmo peerId no servidor.
const TAB_ID = Math.random().toString(36).slice(2, 10);

const state = {
  token: localStorage.getItem('stage_sfu_token') || null,
  peerId: null,
  displayName: localStorage.getItem('stage_sfu_name') || '',
  serverName: 'STAGE // 1080p60',
  ws: null,
  wsReqId: 0,
  pendingRequests: new Map(),

  // Captura local (quando EU estou compartilhando a tela)
  localScreenStream: null,
  localQuality: null,
  isSharing: false,

  // Quem transmite: viewerPeerId -> { pc, sessionId, viewerName, pendingCandidates, prevSample }
  p2pSenders: new Map(),
  // Quem assiste: streamerPeerId -> { pc|null, sessionId, pendingCandidates, requestedAt, ... }
  p2pReceivers: new Map(),

  // Mapa de transmissões ativas na sala: streamId -> StreamEntry
  streams: new Map(),

  featuredStreamId: null,
  layoutMode: 'stage', // 'stage' | 'mosaic'

  // Processa mensagens de sinalização uma de cada vez (evita corridas entre offer/answer/ICE)
  signalQueue: Promise.resolve(),

  pingMs: null,
  pingInterval: null,
  statsInterval: null,
  diagInterval: null,
  localIps: [],
  tunnelUrl: null,
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

const isFirefoxBrowser =
  typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '');

const BROWSER_NAME = (() => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Outro';
})();

// Parâmetros do watchdog (verificação a cada 2 s)
const STATS_INTERVAL_MS = 2000;
const VIDEO_STALL_CHECKS = 6; // 12 s sem quadros de vídeo decodificados
const AUDIO_STALL_CHECKS = 6; // 12 s sem pacotes de áudio (quando deveria haver)
const OFFER_TIMEOUT_MS = 12000;
const ICE_TIMEOUT_MS = 20000;
const DISCONNECTED_GRACE_MS = 8000;

// ============================================================================
// ELEMENTOS DO DOM
// ============================================================================
const dom = {
  loginScreen: document.getElementById('login-screen'),
  loginServerName: document.getElementById('login-server-name'),
  loginOnlineCount: document.getElementById('login-online-count'),
  loginStreamCount: document.getElementById('login-stream-count'),
  loginForm: document.getElementById('login-form'),
  inputDisplayName: document.getElementById('input-display-name'),
  inputRoomPassword: document.getElementById('input-room-password'),
  loginError: document.getElementById('login-error'),
  btnLogin: document.getElementById('btn-login'),

  appScreen: document.getElementById('app-screen'),
  wsStatusDot: document.getElementById('ws-status-dot'),
  topbarServerName: document.getElementById('topbar-server-name'),
  pingValue: document.getElementById('ping-value'),

  btnToggleMembers: document.getElementById('btn-toggle-members'),
  membersCountLabel: document.getElementById('members-count-label'),
  membersPopover: document.getElementById('members-popover'),
  popoverMembersCount: document.getElementById('popover-members-count'),
  membersList: document.getElementById('members-list'),

  btnModeStage: document.getElementById('btn-mode-stage'),
  btnModeMosaic: document.getElementById('btn-mode-mosaic'),

  btnToggleQuality: document.getElementById('btn-toggle-quality'),
  qualitySummaryLabel: document.getElementById('quality-summary-label'),
  qualityPopover: document.getElementById('quality-popover'),
  selectResolution: document.getElementById('select-resolution'),
  selectBitrate: document.getElementById('select-bitrate'),
  selectCodec: document.getElementById('select-codec'),
  selectContentHint: document.getElementById('select-content-hint'),
  selectAudioSource: document.getElementById('select-audio-source'),

  btnNetworkInfo: document.getElementById('btn-network-info'),
  networkModal: document.getElementById('network-modal'),
  btnCloseNetworkModal: document.getElementById('btn-close-network-modal'),
  currentUrlCode: document.getElementById('current-url-code'),
  btnCopyUrl: document.getElementById('btn-copy-url'),
  networkIpsList: document.getElementById('network-ips-list'),

  btnShareScreen: document.getElementById('btn-share-screen'),
  btnShareLabel: document.getElementById('btn-share-label'),
  btnEmptyShare: document.getElementById('btn-empty-share'),
  btnLogout: document.getElementById('btn-logout'),

  emptyStage: document.getElementById('empty-stage'),
  emptyMembersPills: document.getElementById('empty-members-pills'),
  streamsWorkspace: document.getElementById('streams-workspace'),
  streamsGrid: document.getElementById('streams-grid'),

  toastContainer: document.getElementById('toast-container')
};

// ============================================================================
// UTILITÁRIOS E NOTIFICAÇÕES
// ============================================================================
function showToast(message, durationMs = 4000) {
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.textContent = message;
  dom.toastContainer.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, durationMs);
}

function newSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function localStreamId() {
  return `stream-${state.peerId}`;
}

// ============================================================================
// DIAGNÓSTICO: EVENTOS E RELATÓRIOS ENVIADOS AO SERVIDOR (logs/diag.log)
// ============================================================================
function postDiag(body) {
  if (!state.token) return;
  try {
    fetch('/api/diag', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.token}`
      },
      body: JSON.stringify({
        peerId: state.peerId,
        browser: BROWSER_NAME,
        ...body
      }),
      keepalive: true
    }).catch(() => {});
  } catch {}
}

function logDiagEvent(type, details = {}) {
  const ev = { type, ...details };
  console.info('[DIAG]', ev);
  postDiag({ kind: 'event', data: ev });
}

// ============================================================================
// ÁUDIO: DESBLOQUEIO DE AUTOPLAY (APENAS PARA TRANSMISSÕES DOS AMIGOS)
// ============================================================================
// O vídeo fica SEMPRE mudo (autoplay sempre permitido). O som de cada transmissão
// toca num <audio> separado; se o navegador bloquear, só o áudio espera um clique.
function unlockGlobalAudioPlayback() {
  for (const entry of state.streams.values()) {
    if (entry.isLocal || entry.userManuallyMuted || !entry.audioEl) continue;
    if (!entry.audioEl.srcObject) continue;
    if (!entry.audioEl.paused && !entry.audioEl.muted && !entry.audioBlocked) continue;
    playRemoteAudio(entry);
  }
}

document.addEventListener('click', unlockGlobalAudioPlayback, { passive: true });
document.addEventListener('keydown', unlockGlobalAudioPlayback, { passive: true });

function playRemoteAudio(entry) {
  if (!entry || entry.isLocal || !entry.audioEl || !entry.audioEl.srcObject) return;
  entry.audioEl.muted = Boolean(entry.userManuallyMuted);
  if (entry.userManuallyMuted) {
    refreshAudioUI(entry);
    return;
  }
  entry.audioEl
    .play()
    .then(() => {
      entry.audioBlocked = false;
      refreshAudioUI(entry);
    })
    .catch((err) => {
      // AbortError = a fonte foi trocada no meio do play(); não é bloqueio
      if (err && err.name === 'AbortError') return;
      if (!entry.audioBlocked) {
        logDiagEvent('audio-blocked', { from: entry.displayName, error: err && err.name });
      }
      entry.audioBlocked = true;
      refreshAudioUI(entry);
    });
}

// ============================================================================
// QUALIDADE, SDP E PARÂMETROS DE ENVIO
// ============================================================================
function updateQualitySummaryPill() {
  const res = dom.selectResolution.value;
  const bitrate = dom.selectBitrate.value;
  const codec = dom.selectCodec.value;
  dom.qualitySummaryLabel.textContent = `${res} · ${bitrate}M · ${codec}`;
}

function getSelectedQualityConfig() {
  const resVal = dom.selectResolution.value;
  let width = 1920;
  let height = 1080;
  if (resVal === '1440p60') {
    width = 2560;
    height = 1440;
  } else if (resVal === '720p60') {
    width = 1280;
    height = 720;
  }

  const bitrateMbps = parseInt(dom.selectBitrate.value || '6', 10);
  const codec = dom.selectCodec.value || 'H264';
  const contentHint = dom.selectContentHint.value || 'motion';
  const audioSource = dom.selectAudioSource ? dom.selectAudioSource.value : 'auto';

  return {
    label: resVal,
    width,
    height,
    fps: 60,
    bitrateMbps,
    maxBitrateBps: bitrateMbps * 1000000,
    codec,
    contentHint,
    audioSource
  };
}

// Apenas áudio Opus estéreo de alta qualidade. Nenhuma edição de vídeo no SDP:
// cada navegador negocia somente o que o seu decodificador realmente suporta.
function enhanceSdpForStereoAudio(sdp) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  return sdp.replace(
    /a=fmtp:(\d+) minptime=10;useinbandfec=1(?!;stereo)/g,
    'a=fmtp:$1 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000;usedtx=0'
  );
}

function applyVideoCodecPreference(transceiver, codecName) {
  try {
    if (!transceiver || !transceiver.setCodecPreferences || !window.RTCRtpReceiver) return;
    const caps = RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video');
    if (!caps || !caps.codecs) return;
    const target = `video/${codecName}`.toLowerCase();
    const preferred = caps.codecs.filter((c) => c.mimeType.toLowerCase() === target);
    if (preferred.length === 0) return;
    const others = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== target);
    transceiver.setCodecPreferences([...preferred, ...others]);
  } catch {}
}

function computePerViewerBitrateBps(quality) {
  const baseBps = (quality && quality.maxBitrateBps) || 6000000;
  const count = Math.max(1, state.p2pSenders.size);
  // Escalonamento automático para salas de até ~5 pessoas (evita saturar upload/GPU no P2P):
  // 1 espectador: até 100% (ex: 6 Mbps) | 2: até 5 Mbps | 3: até 4 Mbps | 4+: até 3.2 Mbps
  let capBps = baseBps;
  if (count === 2) capBps = Math.min(baseBps, 5000000);
  else if (count === 3) capBps = Math.min(baseBps, 4000000);
  else if (count >= 4) capBps = Math.min(baseBps, 3200000);
  return capBps;
}

async function applyHighQualitySenderParams(pc, quality) {
  if (!pc || !quality) return;
  const targetBitrateBps = computePerViewerBitrateBps(quality);
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = targetBitrateBps;
      params.encodings[0].maxFramerate = 60;
      params.encodings[0].scaleResolutionDownBy = 1.0;
      params.degradationPreference = 'maintain-framerate';
      await sender.setParameters(params);
    } catch {}
  }
}

function rebalanceAllSenders() {
  if (!state.isSharing) return;
  const quality = state.localQuality || getSelectedQualityConfig();
  for (const senderObj of state.p2pSenders.values()) {
    if (senderObj && senderObj.pc) {
      applyHighQualitySenderParams(senderObj.pc, quality).catch(() => {});
    }
  }
}

function buildLocalMeta() {
  const quality = state.localQuality || getSelectedQualityConfig();
  return {
    resolution: quality.label,
    bitrateMbps: quality.bitrateMbps,
    codec: quality.codec,
    hasAudio: Boolean(state.localScreenStream && state.localScreenStream.getAudioTracks().length > 0)
  };
}

// ============================================================================
// INICIALIZAÇÃO E AUTENTICAÇÃO
// ============================================================================
async function fetchServerInfo() {
  try {
    const res = await fetch('/api/info');
    if (!res.ok) return;
    const info = await res.json();
    state.serverName = info.serverName || 'STAGE // 1080p60';
    state.localIps = info.localIps || [];
    state.tunnelUrl = info.tunnelUrl || null;
    if (Array.isArray(info.iceServers) && info.iceServers.length > 0) {
      state.iceServers = info.iceServers;
    }

    dom.loginServerName.textContent = state.serverName;
    dom.topbarServerName.textContent = state.serverName;
    dom.loginOnlineCount.textContent = `${info.onlineCount || 0} conectados`;
    dom.loginStreamCount.textContent = `${info.activeStreamsCount || 0} ativas`;
    renderNetworkModalInfo();
  } catch {}
}

function renderNetworkModalInfo() {
  dom.currentUrlCode.textContent = state.tunnelUrl || window.location.origin;
  dom.networkIpsList.innerHTML = '';

  if (state.tunnelUrl) {
    const cfRow = document.createElement('div');
    cfRow.style.color = '#10b981';
    cfRow.style.fontWeight = '600';
    cfRow.textContent = `Cloudflare Tunnel (HTTPS Público): ${state.tunnelUrl}`;
    dom.networkIpsList.appendChild(cfRow);
  }

  for (const ip of state.localIps || []) {
    const row = document.createElement('div');
    row.textContent = `Rede Local / VPN: https://${ip}:3443`;
    dom.networkIpsList.appendChild(row);
  }
}

async function tryAutoLogin() {
  if (state.displayName) {
    dom.inputDisplayName.value = state.displayName;
  }

  await fetchServerInfo();

  if (!state.token) return;

  try {
    const res = await fetch('/api/verify', {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!res.ok) {
      localStorage.removeItem('stage_sfu_token');
      state.token = null;
      return;
    }

    const data = await res.json();
    state.displayName = data.displayName;
    enterAppScreen();
  } catch {}
}

dom.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  unlockGlobalAudioPlayback();
  dom.loginError.classList.add('hidden');
  dom.btnLogin.disabled = true;

  const displayName = dom.inputDisplayName.value.trim();
  const password = dom.inputRoomPassword.value;

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, password })
    });

    const data = await res.json();
    if (!res.ok) {
      dom.loginError.textContent = data.error || 'Falha na autenticação.';
      dom.loginError.classList.remove('hidden');
      dom.btnLogin.disabled = false;
      return;
    }

    state.token = data.token;
    state.displayName = data.displayName;
    localStorage.setItem('stage_sfu_token', state.token);
    localStorage.setItem('stage_sfu_name', state.displayName);

    dom.inputRoomPassword.value = '';
    enterAppScreen();
  } catch {
    dom.loginError.textContent = 'Erro de conexão com o servidor.';
    dom.loginError.classList.remove('hidden');
  } finally {
    dom.btnLogin.disabled = false;
  }
});

function enterAppScreen() {
  dom.loginScreen.classList.add('hidden');
  dom.appScreen.classList.remove('hidden');
  connectWebSocket();
}

function logout() {
  stopScreenShare();
  for (const streamerId of [...state.p2pReceivers.keys()]) {
    closeReceiver(streamerId);
  }
  for (const streamId of [...state.streams.keys()]) {
    removeStreamTile(streamId);
  }
  const ws = state.ws;
  state.ws = null;
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  localStorage.removeItem('stage_sfu_token');
  state.token = null;
  dom.appScreen.classList.add('hidden');
  dom.loginScreen.classList.remove('hidden');
  fetchServerInfo();
}

// ============================================================================
// WEBSOCKET & SINALIZAÇÃO RPC COM O SERVIDOR
// ============================================================================
function sendRequest(action, data = {}) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('WebSocket desconectado.'));
    }

    const id = ++state.wsReqId;
    state.pendingRequests.set(id, { resolve, reject });
    state.ws.send(JSON.stringify({ id, action, data }));

    setTimeout(() => {
      if (state.pendingRequests.has(id)) {
        state.pendingRequests.delete(id);
        reject(new Error(`Timeout na ação ${action}`));
      }
    }, 10000);
  });
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(
    state.token
  )}&tab=${TAB_ID}`;

  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    if (state.ws !== ws) return;
    dom.wsStatusDot.className = 'status-dot status-online';
    startPingLoop();
    startTelemetryLoop();
    startDiagReporting();
  };

  ws.onmessage = (event) => {
    if (state.ws !== ws) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.id && state.pendingRequests.has(msg.id)) {
      const { resolve, reject } = state.pendingRequests.get(msg.id);
      state.pendingRequests.delete(msg.id);
      if (msg.ok) resolve(msg.data);
      else reject(new Error(msg.error || 'Erro RPC'));
      return;
    }

    const { type, data } = msg;
    switch (type) {
      case 'welcome':
        handleWelcome(data);
        break;

      case 'roomState':
        updateRoomStateUI(data);
        break;

      case 'newProducer':
        if (data && data.kind === 'video' && data.peerId !== state.peerId) {
          if (!state.p2pReceivers.has(data.peerId)) {
            showToast(`${data.displayName} iniciou transmissão de tela`);
          }
          requestFullIceStream(data.peerId, data.displayName, data.meta, {
            force: true,
            reason: 'announce'
          });
        }
        break;

      case 'p2pSignal':
        enqueueSignal(data);
        break;

      case 'producerClosed':
      case 'consumerClosed':
        handleRemoteProducerClosed(data || {});
        break;

      case 'peerLeft':
        handlePeerLeft(data || {});
        break;
    }
  };

  ws.onclose = (ev) => {
    if (state.ws !== ws) return;
    dom.wsStatusDot.className = 'status-dot status-offline';
    if (ev.code === 4001) {
      logout();
      return;
    }
    setTimeout(() => {
      if (state.token && state.ws === ws) connectWebSocket();
    }, 2500);
  };
}

async function handleWelcome(data) {
  if (!data) return;
  if (data.peerId) state.peerId = data.peerId;
  updateRoomStateUI(data.roomState);

  // Se eu estava transmitindo e o WebSocket caiu, reanuncio a transmissão automaticamente
  if (state.isSharing && state.localScreenStream) {
    sendRequest('announceStream', { streamId: localStreamId(), meta: buildLocalMeta() }).catch(
      () => {}
    );
    logDiagEvent('reannounce-after-reconnect', { viewers: state.p2pSenders.size });
  }

  const producers = Array.isArray(data.existingProducers) ? data.existingProducers : [];
  const activePeers = new Set(producers.map((p) => p.peerId));

  // Remove transmissões que acabaram enquanto eu estava desconectado
  for (const streamerId of [...state.p2pReceivers.keys()]) {
    if (!activePeers.has(streamerId)) {
      closeReceiver(streamerId);
      removeStreamTile(`stream-${streamerId}`);
    }
  }

  const seen = new Set();
  for (const prod of producers) {
    if (prod.peerId === state.peerId || seen.has(prod.peerId)) continue;
    seen.add(prod.peerId);
    requestFullIceStream(prod.peerId, prod.displayName, prod.meta, { reason: 'welcome' });
  }
}

function startPingLoop() {
  if (state.pingInterval) clearInterval(state.pingInterval);
  const measure = async () => {
    const t0 = performance.now();
    try {
      await sendRequest('ping');
      const rtt = Math.round(performance.now() - t0);
      state.pingMs = rtt;
      dom.pingValue.textContent = `${rtt} ms`;
    } catch {}
  };
  measure();
  state.pingInterval = setInterval(measure, 3000);
}

// ============================================================================
// MOTOR WEBRTC P2P COM SESSÕES (sessionId em toda mensagem de sinalização)
// ============================================================================
// Cada pedido de transmissão gera um sessionId novo. Offer, answer e candidatos ICE
// carregam esse ID; mensagens de sessões antigas são descartadas. Isso impede que
// uma conexão nova receba a answer/candidatos de uma conexão anterior.

function isCurrentSender(viewerId, sessionId) {
  const s = state.p2pSenders.get(viewerId);
  return Boolean(s && s.sessionId === sessionId);
}

function isCurrentReceiver(streamerId, sessionId) {
  const r = state.p2pReceivers.get(streamerId);
  return Boolean(r && r.sessionId === sessionId);
}

function closeSender(viewerId) {
  const s = state.p2pSenders.get(viewerId);
  if (!s) return;
  state.p2pSenders.delete(viewerId);
  if (s.pc) {
    s.pc.onicecandidate = null;
    s.pc.onconnectionstatechange = null;
    try {
      s.pc.close();
    } catch {}
  }
  rebalanceAllSenders();
}

function closeReceiver(streamerId) {
  const r = state.p2pReceivers.get(streamerId);
  if (!r) return;
  state.p2pReceivers.delete(streamerId);
  if (r.pc) {
    r.pc.ontrack = null;
    r.pc.onicecandidate = null;
    r.pc.onconnectionstatechange = null;
    try {
      r.pc.close();
    } catch {}
  }
}

function enqueueSignal(data) {
  state.signalQueue = state.signalQueue
    .then(() => handleIncomingP2PSignal(data))
    .catch((err) => {
      console.error('[WebRTC Signal Error]:', err);
      logDiagEvent('signal-error', {
        signalType: data && data.signalType,
        error: String((err && err.message) || err)
      });
    });
}

async function flushPendingCandidates(connObj) {
  if (!connObj || !connObj.pc || !connObj.pc.remoteDescription) return;
  while (connObj.pendingCandidates.length > 0) {
    const cand = connObj.pendingCandidates.shift();
    try {
      await connObj.pc.addIceCandidate(cand);
    } catch {}
  }
}

async function addOrQueueCandidate(connObj, payload) {
  if (!connObj || !payload || connObj.sessionId !== payload.sessionId || !payload.candidate) return;
  if (connObj.pc && connObj.pc.remoteDescription && connObj.pc.remoteDescription.type) {
    try {
      await connObj.pc.addIceCandidate(payload.candidate);
    } catch {}
  } else {
    // Candidato chegou antes da offer/answer: guarda na fila desta sessão
    connObj.pendingCandidates.push(payload.candidate);
  }
}

// --- ESPECTADOR: pede a transmissão de alguém -------------------------------
async function requestFullIceStream(streamerPeerId, streamerDisplayName, meta = {}, opts = {}) {
  if (!streamerPeerId || streamerPeerId === state.peerId) return;
  const { force = false, reason = 'announce' } = opts;

  const existing = state.p2pReceivers.get(streamerPeerId);
  if (existing && !force) {
    const connState = existing.pc ? existing.pc.connectionState : 'waiting-offer';
    const age = Date.now() - existing.requestedAt;
    // Já conectado ou negociação recente em andamento: não duplica
    if (connState === 'connected') return;
    if (['new', 'connecting', 'waiting-offer'].includes(connState) && age < OFFER_TIMEOUT_MS) return;
  }

  const recoveries = opts.recoveries != null ? opts.recoveries : existing ? existing.recoveries : 0;
  const lastRecoveryAt =
    opts.lastRecoveryAt != null ? opts.lastRecoveryAt : existing ? existing.lastRecoveryAt : 0;

  if (existing) closeReceiver(streamerPeerId);

  const sessionId = newSessionId();
  state.p2pReceivers.set(streamerPeerId, {
    pc: null,
    sessionId,
    pendingCandidates: [],
    requestedAt: Date.now(),
    prevSample: null,
    videoStallChecks: 0,
    audioStallChecks: 0,
    healthyChecks: 0,
    disconnectedSince: 0,
    recoveries,
    lastRecoveryAt
  });

  const entry = upsertStreamTile({
    streamId: `stream-${streamerPeerId}`,
    peerId: streamerPeerId,
    displayName: streamerDisplayName,
    isLocal: false,
    meta: meta || {}
  });
  setTileStatus(entry, recoveries > 0 ? 'Reconectando…' : 'Conectando…');

  logDiagEvent('request-stream', { streamer: streamerDisplayName, sessionId, reason });

  try {
    await sendRequest('p2pSignal', {
      targetPeerId: streamerPeerId,
      signalType: 'request-stream',
      payload: { sessionId, meta }
    });
  } catch (err) {
    logDiagEvent('request-send-failed', { streamer: streamerDisplayName, error: String(err.message) });
  }
}

// --- Roteador de sinalização ------------------------------------------------
async function handleIncomingP2PSignal({ fromPeerId, fromDisplayName, signalType, payload }) {
  if (!fromPeerId || !signalType) return;

  switch (signalType) {
    case 'request-stream':
      await handleStreamRequest(fromPeerId, fromDisplayName, payload || {});
      return;

    case 'offer':
      await handleOffer(fromPeerId, fromDisplayName, payload || {});
      return;

    case 'answer':
      await handleAnswer(fromPeerId, payload || {});
      return;

    case 'ice-candidate-from-streamer':
      await addOrQueueCandidate(state.p2pReceivers.get(fromPeerId), payload);
      return;

    case 'ice-candidate-from-viewer':
      await addOrQueueCandidate(state.p2pSenders.get(fromPeerId), payload);
      return;

    case 'stream-unavailable': {
      if (payload && isCurrentReceiver(fromPeerId, payload.sessionId)) {
        closeReceiver(fromPeerId);
        removeStreamTile(`stream-${fromPeerId}`);
      }
      return;
    }
  }
}

// --- QUEM TRANSMITE: recebeu pedido de um espectador ------------------------
async function handleStreamRequest(fromPeerId, fromDisplayName, payload) {
  const sessionId = payload.sessionId;
  if (!sessionId) return;

  if (!state.isSharing || !state.localScreenStream) {
    sendRequest('p2pSignal', {
      targetPeerId: fromPeerId,
      signalType: 'stream-unavailable',
      payload: { sessionId }
    }).catch(() => {});
    return;
  }

  closeSender(fromPeerId);

  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  const senderObj = {
    pc,
    sessionId,
    viewerName: fromDisplayName,
    pendingCandidates: [],
    createdAt: Date.now(),
    prevSample: null
  };
  state.p2pSenders.set(fromPeerId, senderObj);

  pc.onicecandidate = (ev) => {
    if (!ev.candidate || !isCurrentSender(fromPeerId, sessionId)) return;
    sendRequest('p2pSignal', {
      targetPeerId: fromPeerId,
      signalType: 'ice-candidate-from-streamer',
      payload: { sessionId, candidate: ev.candidate }
    }).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (!isCurrentSender(fromPeerId, sessionId)) return;
    const st = pc.connectionState;
    logDiagEvent('sender-state', { viewer: fromDisplayName, state: st, sessionId });
    if (st === 'connected') {
      rebalanceAllSenders();
    } else if (st === 'failed' || st === 'closed') {
      closeSender(fromPeerId);
    }
  };

  const quality = state.localQuality || getSelectedQualityConfig();

  // Áudio e vídeo vinculados ao MESMO MediaStream (mesmo a=msid) -> o receptor sincroniza os dois
  for (const track of state.localScreenStream.getTracks()) {
    const sender = pc.addTrack(track, state.localScreenStream);
    if (track.kind === 'video') {
      applyVideoCodecPreference(
        pc.getTransceivers().find((t) => t.sender === sender),
        quality.codec
      );
    }
  }

  const offer = await pc.createOffer();
  if (!isCurrentSender(fromPeerId, sessionId)) return;
  await pc.setLocalDescription({ type: 'offer', sdp: enhanceSdpForStereoAudio(offer.sdp) });
  rebalanceAllSenders();
  if (!isCurrentSender(fromPeerId, sessionId)) return;

  await sendRequest('p2pSignal', {
    targetPeerId: fromPeerId,
    signalType: 'offer',
    payload: {
      sessionId,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      meta: buildLocalMeta()
    }
  });
}

// --- ESPECTADOR: recebeu a offer -------------------------------------------
async function handleOffer(fromPeerId, fromDisplayName, payload) {
  const r = state.p2pReceivers.get(fromPeerId);
  if (!r || r.sessionId !== payload.sessionId) {
    logDiagEvent('stale-offer-ignored', { from: fromDisplayName });
    return;
  }
  if (r.pc) return; // offer duplicada da mesma sessão

  const sessionId = r.sessionId;
  const streamId = `stream-${fromPeerId}`;
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  r.pc = pc;

  pc.onicecandidate = (ev) => {
    if (!ev.candidate || !isCurrentReceiver(fromPeerId, sessionId)) return;
    sendRequest('p2pSignal', {
      targetPeerId: fromPeerId,
      signalType: 'ice-candidate-from-viewer',
      payload: { sessionId, candidate: ev.candidate }
    }).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (!isCurrentReceiver(fromPeerId, sessionId)) return;
    const st = pc.connectionState;
    logDiagEvent('receiver-state', { streamer: fromDisplayName, state: st, sessionId });
    const entry = state.streams.get(streamId);
    if (st === 'connected') {
      if (entry) setTileStatus(entry, 'Aguardando imagem…');
    } else if (st === 'failed') {
      scheduleRecovery(fromPeerId, 'pc-failed');
    }
  };

  pc.ontrack = (ev) => {
    if (!isCurrentReceiver(fromPeerId, sessionId)) return;
    const track = ev.track;
    const remoteStream = ev.streams && ev.streams[0] ? ev.streams[0] : null;
    upsertStreamTile({
      streamId,
      peerId: fromPeerId,
      displayName: fromDisplayName,
      isLocal: false,
      remoteStream,
      videoTrack: track.kind === 'video' ? track : undefined,
      audioTrack: track.kind === 'audio' ? track : undefined,
      meta: payload.meta || {}
    });
  };

  await pc.setRemoteDescription(payload.sdp);
  await flushPendingCandidates(r);

  const answer = await pc.createAnswer();
  if (!isCurrentReceiver(fromPeerId, sessionId)) return;
  await pc.setLocalDescription({ type: 'answer', sdp: enhanceSdpForStereoAudio(answer.sdp) });
  if (!isCurrentReceiver(fromPeerId, sessionId)) return;

  await sendRequest('p2pSignal', {
    targetPeerId: fromPeerId,
    signalType: 'answer',
    payload: {
      sessionId,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
    }
  });
}

// --- QUEM TRANSMITE: recebeu a answer --------------------------------------
async function handleAnswer(fromPeerId, payload) {
  const s = state.p2pSenders.get(fromPeerId);
  if (!s || s.sessionId !== payload.sessionId) {
    logDiagEvent('stale-answer-ignored', { from: fromPeerId });
    return;
  }
  if (s.pc.signalingState !== 'have-local-offer') return;

  await s.pc.setRemoteDescription(payload.sdp);
  await flushPendingCandidates(s);
  rebalanceAllSenders();
}

// --- Recuperação automática (espectador) -----------------------------------
function scheduleRecovery(streamerPeerId, reason, details = {}) {
  const entry = state.streams.get(`stream-${streamerPeerId}`);
  if (!entry) return;
  const r = state.p2pReceivers.get(streamerPeerId);
  const now = Date.now();
  const attempts = r ? r.recoveries : 0;
  const lastAt = r ? r.lastRecoveryAt : 0;
  // Espera crescente entre tentativas: 4 s, 8 s, 16 s, depois 30 s
  const backoff = Math.min(30000, 4000 * Math.pow(2, Math.min(attempts, 3)));
  if (now - lastAt < backoff) return;

  logDiagEvent('recover', {
    streamer: entry.displayName,
    reason,
    attempt: attempts + 1,
    ...details
  });

  requestFullIceStream(streamerPeerId, entry.displayName, entry.meta, {
    force: true,
    reason,
    recoveries: attempts + 1,
    lastRecoveryAt: now
  });
}

function handleRemoteProducerClosed({ streamId, peerId }) {
  // Se o servidor anunciar o fim da MINHA transmissão (ex.: oscilação do WebSocket)
  // enquanto ainda estou transmitindo, ignoro: o reanúncio no welcome restaura tudo.
  if (peerId && peerId === state.peerId && state.isSharing) return;

  const targetStreamId = streamId || `stream-${peerId}`;
  if (peerId) closeReceiver(peerId);
  removeStreamTile(targetStreamId);
}

function handlePeerLeft({ peerId }) {
  if (!peerId || peerId === state.peerId) return;
  closeSender(peerId);
  if (state.p2pReceivers.has(peerId)) {
    closeReceiver(peerId);
    removeStreamTile(`stream-${peerId}`);
  }
}

// ============================================================================
// CAPTURA DIRETA ESTILO DISCORD (1 CLIQUE -> SELETOR NATIVO, SEM MICROFONE)
// ============================================================================
function buildMissingAudioMessage(surface) {
  if (isFirefoxBrowser) {
    return 'O Firefox não envia o áudio da tela. Para transmitir com som, use o Edge ou o Chrome.';
  }
  if (surface === 'window') {
    return 'Janelas não enviam áudio. Escolha "Guia" ou "Tela inteira" e marque "Compartilhar áudio".';
  }
  return 'O áudio não foi incluído. Escolha de novo e marque a opção "Compartilhar áudio".';
}

async function startScreenShare() {
  if (state.isSharing) return;
  unlockGlobalAudioPlayback();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    showToast(
      'O navegador exige conexão segura (HTTPS ou localhost) para compartilhar a tela.',
      6000
    );
    dom.networkModal.classList.remove('hidden');
    return;
  }

  const quality = getSelectedQualityConfig();
  state.localQuality = quality;
  const wantAudio = quality.audioSource !== 'none';

  if (wantAudio && !isFirefoxBrowser) {
    showToast('Para enviar som: escolha "Guia" ou "Tela inteira" e marque "Compartilhar áudio".', 6000);
  }

  // Captura EXCLUSIVAMENTE a tela/janela/guia. NUNCA usa microfone (sem voz duplicada no Discord).
  let screenStream;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: quality.width },
        height: { ideal: quality.height },
        aspectRatio: { ideal: 16 / 9 },
        frameRate: { ideal: 60, max: 60 },
        cursor: 'always'
      },
      audio: wantAudio
        ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        : false,
      systemAudio: 'include',
      windowAudio: 'system',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude'
    });
  } catch (err) {
    if (!err || err.name !== 'NotAllowedError') {
      showToast(`Não foi possível capturar a tela (${(err && err.name) || 'erro'}).`, 6000);
      logDiagEvent('capture-error', { error: err && err.name, message: err && err.message });
    }
    return;
  }

  const videoTrack = screenStream.getVideoTracks()[0];
  const localAudioTrack = screenStream.getAudioTracks()[0] || null;
  if (!videoTrack) {
    screenStream.getTracks().forEach((t) => t.stop());
    showToast('Nenhuma imagem foi capturada.');
    return;
  }

  try {
    await videoTrack.applyConstraints({
      width: { ideal: quality.width },
      height: { ideal: quality.height },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: 60, max: 60 }
    });
  } catch {}

  try {
    videoTrack.contentHint = quality.contentHint === 'detail' ? 'detail' : 'motion';
  } catch {}

  videoTrack.onended = () => {
    if (state.localScreenStream === screenStream) stopScreenShare();
  };

  state.localScreenStream = screenStream;
  state.isSharing = true;

  const settings = (videoTrack.getSettings && videoTrack.getSettings()) || {};
  const surface = settings.displaySurface || 'desconhecido';
  const captureWarning = wantAudio && !localAudioTrack ? buildMissingAudioMessage(surface) : null;
  if (captureWarning) {
    logDiagEvent('no-audio-captured', { surface });
  }

  const meta = buildLocalMeta();
  const entry = upsertStreamTile({
    streamId: localStreamId(),
    peerId: state.peerId,
    displayName: `${state.displayName} (Você)`,
    isLocal: true,
    videoTrack,
    audioTrack: localAudioTrack,
    meta
  });
  entry.captureWarning = captureWarning;
  refreshAudioUI(entry);

  showToast(
    localAudioTrack
      ? 'Transmissão iniciada com áudio da tela. Você está auto-mutado para não se ouvir.'
      : 'Transmissão iniciada sem áudio.'
  );

  logDiagEvent('share-started', {
    surface,
    hasAudio: Boolean(localAudioTrack),
    width: settings.width,
    height: settings.height,
    fps: settings.frameRate,
    quality: quality.label,
    bitrateMbps: quality.bitrateMbps,
    codec: quality.codec
  });

  updateShareButtonUI(true);

  try {
    await sendRequest('announceStream', { streamId: localStreamId(), meta });
  } catch (err) {
    logDiagEvent('announce-failed', { error: String(err.message) });
  }
}

async function stopScreenShare() {
  const wasSharing = state.isSharing || Boolean(state.localScreenStream);
  state.isSharing = false;

  for (const viewerId of [...state.p2pSenders.keys()]) {
    closeSender(viewerId);
  }

  if (state.localScreenStream) {
    for (const track of state.localScreenStream.getTracks()) {
      try {
        track.stop();
      } catch {}
    }
    state.localScreenStream = null;
  }

  removeStreamTile(localStreamId());
  updateShareButtonUI(false);

  if (wasSharing && state.ws && state.ws.readyState === WebSocket.OPEN) {
    try {
      await sendRequest('stopStream');
    } catch {}
  }
}

// Usado pelo botão "Escolher de novo" do aviso de áudio (precisa do clique do usuário)
function restartScreenShare() {
  stopScreenShare();
  startScreenShare();
}

function updateShareButtonUI(isSharing) {
  if (isSharing) {
    dom.btnShareScreen.className = 'btn btn-danger';
    dom.btnShareLabel.textContent = 'Encerrar Transmissão';
  } else {
    dom.btnShareScreen.className = 'btn btn-primary';
    dom.btnShareLabel.textContent = 'Compartilhar Tela';
  }
}

// ============================================================================
// PALCO / MOSAICO: CARDS DE TRANSMISSÃO (vídeo mudo + <audio> separado)
// ============================================================================
function upsertStreamTile({
  streamId,
  peerId,
  displayName,
  isLocal,
  remoteStream,
  videoTrack,
  audioTrack,
  meta
}) {
  let entry = state.streams.get(streamId);

  if (!entry) {
    entry = {
      streamId,
      peerId,
      displayName,
      isLocal,
      mediaStream: null,
      videoTrack: null,
      audioTrack: null,
      // Quem transmite começa AUTO-MUTADO (nunca se ouve sem querer). Espectadores começam com som.
      userManuallyMuted: Boolean(isLocal),
      audioBlocked: false,
      captureWarning: null,
      meta: meta || {},
      diagInfo: null,
      diagViewers: [],
      cardEl: null,
      videoEl: null,
      audioEl: null,
      statusEl: null,
      unlockBannerEl: null,
      muteBtnEl: null,
      volSliderEl: null,
      resBadgeEl: null,
      bitrateBadgeEl: null,
      codecBadgeEl: null,
      audioBadgeEl: null,
      diagEl: null,
      warningEl: null,
      warningTextEl: null
    };
    state.streams.set(streamId, entry);
  }

  if (meta && Object.keys(meta).length > 0) {
    entry.meta = { ...entry.meta, ...meta };
  }

  if (!entry.cardEl) {
    entry.cardEl = createStreamCardDOM(entry);
    dom.streamsGrid.appendChild(entry.cardEl);
  }

  if (isLocal) {
    if (videoTrack) entry.videoTrack = videoTrack;
    if (audioTrack !== undefined) entry.audioTrack = audioTrack || null;

    // Prévia local: apenas a imagem (o áudio só entra se a pessoa se desmutar)
    if (
      entry.videoTrack &&
      (!entry.mediaStream || !entry.mediaStream.getVideoTracks().includes(entry.videoTrack))
    ) {
      entry.mediaStream = new MediaStream([entry.videoTrack]);
      entry.videoEl.srcObject = entry.mediaStream;
      entry.videoEl.play().catch(() => {});
    }
    syncLocalPreviewAudio(entry);
  } else {
    if (remoteStream && entry.mediaStream !== remoteStream) {
      // Nova sessão WebRTC: troca a fonte UMA única vez (nunca reatribui a mesma fonte)
      entry.mediaStream = remoteStream;
      entry.videoTrack = null;
      entry.audioTrack = null;
      entry.audioBlocked = false;
      entry.videoEl.srcObject = remoteStream;
      entry.audioEl.srcObject = remoteStream;
      entry.videoEl.play().catch(() => {});
    } else if (!remoteStream && (videoTrack || audioTrack)) {
      // Fallback (navegador sem ev.streams): monta o MediaStream manualmente
      if (!entry.mediaStream) {
        entry.mediaStream = new MediaStream();
        entry.videoEl.srcObject = entry.mediaStream;
        entry.audioEl.srcObject = entry.mediaStream;
      }
      const t = videoTrack || audioTrack;
      if (!entry.mediaStream.getTracks().includes(t)) entry.mediaStream.addTrack(t);
      entry.videoEl.play().catch(() => {});
    }

    if (videoTrack) {
      entry.videoTrack = videoTrack;
      videoTrack.onunmute = () => {
        if (entry.videoEl) entry.videoEl.play().catch(() => {});
      };
    }
    if (audioTrack) {
      entry.audioTrack = audioTrack;
      entry.meta.hasAudio = true;
      audioTrack.onunmute = () => {
        playRemoteAudio(entry);
      };
      playRemoteAudio(entry);
    }
  }

  refreshAudioUI(entry);

  if (!state.featuredStreamId || !state.streams.has(state.featuredStreamId)) {
    state.featuredStreamId = streamId;
  }

  syncWorkspaceLayout();
  return entry;
}

function syncLocalPreviewAudio(entry) {
  if (!entry || !entry.isLocal || !entry.audioEl) return;
  if (entry.userManuallyMuted || !entry.audioTrack) {
    // Fisicamente impossível se ouvir: o <audio> local fica sem fonte
    entry.audioEl.pause();
    entry.audioEl.srcObject = null;
  } else {
    if (!entry.audioEl.srcObject) {
      entry.audioEl.srcObject = new MediaStream([entry.audioTrack]);
    }
    entry.audioEl.muted = false;
    entry.audioEl.play().catch(() => {});
  }
}

function refreshAudioUI(entry) {
  if (!entry) return;
  const hasAudio = entry.isLocal
    ? Boolean(entry.audioTrack)
    : Boolean(entry.audioTrack) || Boolean(entry.meta && entry.meta.hasAudio);

  if (entry.audioBadgeEl) {
    let cls = 'audio-ok';
    let txt = 'SOM ATIVO';
    if (entry.isLocal) {
      if (hasAudio) {
        txt = 'ENVIANDO ÁUDIO';
      } else {
        cls = 'audio-none';
        txt = 'SEM ÁUDIO';
      }
    } else if (!hasAudio) {
      cls = 'audio-none';
      txt = 'SEM ÁUDIO';
    } else if (entry.audioBlocked) {
      cls = 'audio-none';
      txt = 'SOM BLOQUEADO';
    } else if (entry.userManuallyMuted) {
      cls = 'audio-none';
      txt = 'MUTADO';
    }
    entry.audioBadgeEl.className = `telemetry-pill ${cls}`;
    entry.audioBadgeEl.textContent = txt;
  }

  if (entry.unlockBannerEl) {
    const showBanner =
      !entry.isLocal && hasAudio && entry.audioBlocked && !entry.userManuallyMuted;
    entry.unlockBannerEl.classList.toggle('hidden', !showBanner);
  }

  if (entry.muteBtnEl) {
    if (entry.isLocal) {
      entry.muteBtnEl.textContent = entry.userManuallyMuted
        ? '🔇 Auto-Mutado (Clique para se ouvir)'
        : '🔊 Ouvindo Própria Tela';
    } else if (entry.userManuallyMuted) {
      entry.muteBtnEl.textContent = 'Mutado';
    } else {
      entry.muteBtnEl.textContent = entry.audioBlocked ? 'Ativar Som' : 'Som Ativo';
    }
  }

  if (entry.warningEl) {
    const showWarning = Boolean(entry.isLocal && entry.captureWarning);
    entry.warningEl.classList.toggle('hidden', !showWarning);
    if (showWarning && entry.warningTextEl) {
      entry.warningTextEl.textContent = entry.captureWarning;
    }
  }
}

function setTileStatus(entry, text) {
  if (!entry || !entry.statusEl) return;
  if (text) {
    entry.statusEl.textContent = text;
    entry.statusEl.classList.remove('hidden');
  } else {
    entry.statusEl.classList.add('hidden');
  }
}

function createStreamCardDOM(entry) {
  const card = document.createElement('div');
  card.className = 'stream-card';
  card.dataset.streamId = entry.streamId;

  // Vídeo SEMPRE mudo: o autoplay de vídeo mudo nunca é bloqueado pelos navegadores
  const video = document.createElement('video');
  video.className = 'stream-video';
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  entry.videoEl = video;

  // Áudio em elemento separado: se travar ou for bloqueado, a imagem continua
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.volume = 1.0;
  entry.audioEl = audio;

  video.addEventListener('resize', () => {
    if (video.videoWidth > 0) setTileStatus(entry, null);
  });

  const statusEl = document.createElement('div');
  statusEl.className = 'stream-status hidden';
  entry.statusEl = statusEl;

  // Banner clicável caso o navegador bloqueie o som da transmissão de um amigo
  const unlockBanner = document.createElement('button');
  unlockBanner.type = 'button';
  unlockBanner.className = 'audio-unlock-banner hidden';
  unlockBanner.textContent = '🔊 Clique aqui para Ativar o Som da Transmissão';
  unlockBanner.addEventListener('click', (e) => {
    e.stopPropagation();
    entry.userManuallyMuted = false;
    if (audio.volume === 0) audio.volume = 1.0;
    playRemoteAudio(entry);
    unlockGlobalAudioPlayback();
  });
  entry.unlockBannerEl = unlockBanner;

  // Aviso fixo para quem transmite quando o áudio não foi capturado
  const warning = document.createElement('div');
  warning.className = 'capture-warning hidden';
  const warningText = document.createElement('span');
  const warningBtn = document.createElement('button');
  warningBtn.type = 'button';
  warningBtn.className = 'btn-stream-ctrl';
  warningBtn.textContent = 'Escolher de novo';
  warningBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    restartScreenShare();
  });
  warning.append(warningText, warningBtn);
  entry.warningEl = warning;
  entry.warningTextEl = warningText;

  const topOverlay = document.createElement('div');
  topOverlay.className = 'stream-overlay-top';

  const authorBadge = document.createElement('div');
  authorBadge.className = 'stream-author-badge';
  authorBadge.innerHTML = `
    <span class="live-dot"></span>
    <span class="stream-author-name"></span>
  `;
  authorBadge.querySelector('.stream-author-name').textContent = entry.displayName;

  const telemetry = document.createElement('div');
  telemetry.className = 'stream-telemetry';

  const audioBadge = document.createElement('span');
  audioBadge.className = 'telemetry-pill audio-ok';
  audioBadge.textContent = 'SOM ATIVO';
  entry.audioBadgeEl = audioBadge;

  const resBadge = document.createElement('span');
  resBadge.className = 'telemetry-pill';
  resBadge.textContent = (entry.meta && entry.meta.resolution) || '1080p60';
  entry.resBadgeEl = resBadge;

  const bitrateBadge = document.createElement('span');
  bitrateBadge.className = 'telemetry-pill';
  bitrateBadge.textContent =
    entry.meta && entry.meta.bitrateMbps ? `${entry.meta.bitrateMbps} Mbps` : '-- Mbps';
  entry.bitrateBadgeEl = bitrateBadge;

  const codecBadge = document.createElement('span');
  codecBadge.className = 'telemetry-pill';
  codecBadge.textContent = (entry.meta && entry.meta.codec) || 'H264';
  entry.codecBadgeEl = codecBadge;

  telemetry.append(audioBadge, resBadge, bitrateBadge, codecBadge);
  topOverlay.append(authorBadge, telemetry);

  const diagPanel = document.createElement('pre');
  diagPanel.className = 'diag-panel hidden';
  diagPanel.addEventListener('click', (e) => e.stopPropagation());
  entry.diagEl = diagPanel;

  const bottomOverlay = document.createElement('div');
  bottomOverlay.className = 'stream-overlay-bottom';

  const audioControls = document.createElement('div');
  audioControls.className = 'audio-controls';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'btn-stream-ctrl';
  entry.muteBtnEl = muteBtn;

  const volSlider = document.createElement('input');
  volSlider.type = 'range';
  volSlider.className = 'volume-slider';
  volSlider.min = '0';
  volSlider.max = '100';
  volSlider.value = entry.isLocal ? '0' : '100';
  entry.volSliderEl = volSlider;

  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    entry.userManuallyMuted = !entry.userManuallyMuted;

    if (!entry.userManuallyMuted && (audio.volume === 0 || volSlider.value === '0')) {
      audio.volume = 1.0;
      volSlider.value = '100';
    } else if (entry.userManuallyMuted && entry.isLocal) {
      volSlider.value = '0';
    }

    if (entry.isLocal) {
      syncLocalPreviewAudio(entry);
    } else {
      audio.muted = entry.userManuallyMuted;
      if (!entry.userManuallyMuted) playRemoteAudio(entry);
    }
    refreshAudioUI(entry);
  });

  volSlider.addEventListener('input', (e) => {
    e.stopPropagation();
    const val = parseInt(e.target.value, 10) / 100;
    audio.volume = val;
    entry.userManuallyMuted = val === 0;

    if (entry.isLocal) {
      syncLocalPreviewAudio(entry);
    } else {
      audio.muted = entry.userManuallyMuted;
      if (!entry.userManuallyMuted) playRemoteAudio(entry);
    }
    refreshAudioUI(entry);
  });

  audioControls.append(muteBtn, volSlider);

  const actionsRight = document.createElement('div');
  actionsRight.className = 'stream-actions-right';

  const btnDiag = document.createElement('button');
  btnDiag.type = 'button';
  btnDiag.className = 'btn-stream-ctrl';
  btnDiag.textContent = 'ⓘ Diagnóstico';
  btnDiag.addEventListener('click', (e) => {
    e.stopPropagation();
    diagPanel.classList.toggle('hidden');
    renderDiag(entry);
  });

  const btnFeature = document.createElement('button');
  btnFeature.type = 'button';
  btnFeature.className = 'btn-stream-ctrl';
  btnFeature.textContent = 'Destacar no Palco';
  btnFeature.addEventListener('click', (e) => {
    e.stopPropagation();
    state.featuredStreamId = entry.streamId;
    setLayoutMode('stage');
  });

  const btnPip = document.createElement('button');
  btnPip.type = 'button';
  btnPip.className = 'btn-stream-ctrl';
  btnPip.textContent = 'PiP';
  btnPip.title = 'Picture-in-Picture';
  btnPip.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (video.requestPictureInPicture) {
        await video.requestPictureInPicture();
      }
    } catch {}
  });

  const btnFullscreen = document.createElement('button');
  btnFullscreen.type = 'button';
  btnFullscreen.className = 'btn-stream-ctrl';
  btnFullscreen.textContent = 'Tela Cheia';
  btnFullscreen.addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (card.requestFullscreen) {
      card.requestFullscreen().catch(() => {});
    }
  });

  actionsRight.append(btnDiag, btnFeature, btnPip, btnFullscreen);
  bottomOverlay.append(audioControls, actionsRight);

  card.addEventListener('click', () => {
    unlockGlobalAudioPlayback();
    if (state.layoutMode === 'stage' && state.featuredStreamId !== entry.streamId) {
      state.featuredStreamId = entry.streamId;
      syncWorkspaceLayout();
    }
  });

  card.append(video, audio, statusEl, unlockBanner, warning, topOverlay, diagPanel, bottomOverlay);
  return card;
}

function removeStreamTile(streamId) {
  const entry = state.streams.get(streamId);
  if (!entry) return;

  try {
    if (entry.audioEl) {
      entry.audioEl.pause();
      entry.audioEl.srcObject = null;
    }
    if (entry.videoEl) {
      entry.videoEl.srcObject = null;
    }
  } catch {}

  if (entry.cardEl) {
    entry.cardEl.remove();
  }
  state.streams.delete(streamId);

  if (state.featuredStreamId === streamId) {
    const firstRemaining = state.streams.keys().next().value || null;
    state.featuredStreamId = firstRemaining;
  }

  syncWorkspaceLayout();
}

function setLayoutMode(mode) {
  state.layoutMode = mode;
  dom.btnModeStage.classList.toggle('active', mode === 'stage');
  dom.btnModeMosaic.classList.toggle('active', mode === 'mosaic');
  dom.streamsWorkspace.classList.toggle('mode-stage', mode === 'stage');
  dom.streamsWorkspace.classList.toggle('mode-mosaic', mode === 'mosaic');
  syncWorkspaceLayout();
}

function syncWorkspaceLayout() {
  const count = state.streams.size;
  dom.streamsGrid.dataset.count = String(count);

  if (count === 0) {
    dom.emptyStage.classList.remove('hidden');
    dom.streamsWorkspace.classList.add('hidden');
    return;
  }

  dom.emptyStage.classList.add('hidden');
  dom.streamsWorkspace.classList.remove('hidden');

  if (!state.featuredStreamId || !state.streams.has(state.featuredStreamId)) {
    state.featuredStreamId = state.streams.keys().next().value;
  }

  for (const [id, entry] of state.streams.entries()) {
    if (entry.cardEl) {
      entry.cardEl.classList.toggle('is-featured', id === state.featuredStreamId);
    }
  }
}

// ============================================================================
// TELEMETRIA + WATCHDOG + DIAGNÓSTICO (a cada 2 s)
// ============================================================================
function indexStats(stats) {
  const byId = new Map();
  stats.forEach((r) => byId.set(r.id, r));
  return byId;
}

function findSelectedPair(byId) {
  for (const r of byId.values()) {
    if (r.type === 'transport' && r.selectedCandidatePairId) {
      return byId.get(r.selectedCandidatePairId) || null;
    }
  }
  for (const r of byId.values()) {
    if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') {
      return r;
    }
  }
  return null;
}

function describeRoute(byId, pair) {
  if (!pair) return '';
  const local = byId.get(pair.localCandidateId);
  const remote = byId.get(pair.remoteCandidateId);
  return `${(local && local.candidateType) || '?'} → ${(remote && remote.candidateType) || '?'}`;
}

function avgJitterMs(rtp) {
  if (!rtp || !rtp.jitterBufferEmittedCount) return null;
  return Math.round((rtp.jitterBufferDelay / rtp.jitterBufferEmittedCount) * 1000);
}

async function sampleReceiver(entry, r, now) {
  const byId = indexStats(await r.pc.getStats());
  let v = null;
  let a = null;
  for (const rep of byId.values()) {
    if (rep.type === 'inbound-rtp' && rep.kind === 'video') v = rep;
    else if (rep.type === 'inbound-rtp' && rep.kind === 'audio') a = rep;
  }
  const pair = findSelectedPair(byId);
  const codecRep = v && v.codecId ? byId.get(v.codecId) : null;

  const sample = {
    t: now,
    vBytes: (v && v.bytesReceived) || 0,
    vFrames: (v && v.framesDecoded) || 0,
    aBytes: (a && a.bytesReceived) || 0
  };
  const prev = r.prevSample;
  r.prevSample = sample;
  const dt = prev ? (now - prev.t) / 1000 : 0;

  return {
    prev,
    info: {
      conexao: r.pc.connectionState,
      ice: r.pc.iceConnectionState,
      rota: describeRoute(byId, pair),
      rttMs: pair && pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : null,
      videoQuadrosNoPeriodo: prev ? sample.vFrames - prev.vFrames : null,
      videoFps: prev && dt > 0 ? Math.round((sample.vFrames - prev.vFrames) / dt) : null,
      videoKbps: prev && dt > 0 ? Math.round(((sample.vBytes - prev.vBytes) * 8) / dt / 1000) : null,
      audioKbps: prev && dt > 0 ? Math.round(((sample.aBytes - prev.aBytes) * 8) / dt / 1000) : null,
      largura: (v && v.frameWidth) || 0,
      altura: (v && v.frameHeight) || 0,
      codec: codecRep && codecRep.mimeType ? codecRep.mimeType.split('/')[1] : '',
      decoder: (v && v.decoderImplementation) || '',
      quadrosDescartados: (v && v.framesDropped) || 0,
      congelamentos: (v && v.freezeCount) || 0,
      bufferVideoMs: avgJitterMs(v),
      bufferAudioMs: avgJitterMs(a),
      trilhaVideo: Boolean(entry.videoTrack),
      trilhaAudio: Boolean(entry.audioTrack),
      playerAudio: !entry.audioEl
        ? '-'
        : entry.audioBlocked
          ? 'bloqueado (precisa de clique)'
          : entry.userManuallyMuted
            ? 'mutado pelo usuário'
            : entry.audioEl.paused
              ? 'pausado'
              : 'tocando'
    }
  };
}

async function sampleSender(senderObj, now) {
  const byId = indexStats(await senderObj.pc.getStats());
  let v = null;
  let a = null;
  for (const rep of byId.values()) {
    if (rep.type === 'outbound-rtp' && rep.kind === 'video') {
      if (!v || (rep.bytesSent || 0) > (v.bytesSent || 0)) v = rep;
    } else if (rep.type === 'outbound-rtp' && rep.kind === 'audio') {
      a = rep;
    }
  }
  const pair = findSelectedPair(byId);
  const codecRep = v && v.codecId ? byId.get(v.codecId) : null;

  const sample = {
    t: now,
    vBytes: (v && v.bytesSent) || 0,
    aBytes: (a && a.bytesSent) || 0
  };
  const prev = senderObj.prevSample;
  senderObj.prevSample = sample;
  const dt = prev ? (now - prev.t) / 1000 : 0;

  return {
    espectador: senderObj.viewerName,
    conexao: senderObj.pc.connectionState,
    rota: describeRoute(byId, pair),
    rttMs: pair && pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : null,
    uploadDisponivelKbps:
      pair && pair.availableOutgoingBitrate ? Math.round(pair.availableOutgoingBitrate / 1000) : null,
    videoFps: v && v.framesPerSecond != null ? Math.round(v.framesPerSecond) : null,
    largura: (v && v.frameWidth) || 0,
    altura: (v && v.frameHeight) || 0,
    videoKbps: prev && dt > 0 ? Math.round(((sample.vBytes - prev.vBytes) * 8) / dt / 1000) : null,
    audioKbps: prev && dt > 0 ? Math.round(((sample.aBytes - prev.aBytes) * 8) / dt / 1000) : null,
    limitadoPor: (v && v.qualityLimitationReason) || '',
    encoder: (v && v.encoderImplementation) || '',
    encoderHardware: v && v.powerEfficientEncoder != null ? Boolean(v.powerEfficientEncoder) : null,
    codec: codecRep && codecRep.mimeType ? codecRep.mimeType.split('/')[1] : ''
  };
}

function runWatchdog(streamerId, r, entry, info, prev, now) {
  const conn = info.conexao;

  if (conn === 'failed') {
    scheduleRecovery(streamerId, 'pc-failed');
    return;
  }
  if (conn === 'disconnected') {
    if (!r.disconnectedSince) r.disconnectedSince = now;
    if (now - r.disconnectedSince > DISCONNECTED_GRACE_MS) {
      scheduleRecovery(streamerId, 'pc-disconnected');
    }
    return;
  }
  r.disconnectedSince = 0;

  if (conn !== 'connected') {
    if (now - r.requestedAt > ICE_TIMEOUT_MS) scheduleRecovery(streamerId, 'ice-timeout');
    return;
  }
  if (!prev) return;

  const videoFlowing = info.videoQuadrosNoPeriodo > 0;
  const expectsAudio = Boolean(entry.audioTrack) || Boolean(entry.meta && entry.meta.hasAudio);
  const audioFlowing = info.audioKbps > 0;

  if (videoFlowing) {
    r.videoStallChecks = 0;
    setTileStatus(entry, null);
  } else {
    r.videoStallChecks += 1;
    if (r.videoStallChecks >= 2) setTileStatus(entry, 'Aguardando imagem…');
  }

  if (!expectsAudio || audioFlowing) r.audioStallChecks = 0;
  else r.audioStallChecks += 1;

  if (videoFlowing && (!expectsAudio || audioFlowing)) {
    r.healthyChecks += 1;
    if (r.healthyChecks >= 15) r.recoveries = 0; // 30 s saudável zera o contador de tentativas
  } else {
    r.healthyChecks = 0;
  }

  if (r.videoStallChecks >= VIDEO_STALL_CHECKS) {
    // Chegam bytes mas nenhum quadro decodifica = falha do decodificador (tela preta)
    const reason = info.videoKbps > 0 ? 'video-decode-stall' : 'video-no-data';
    scheduleRecovery(streamerId, reason, { videoKbps: info.videoKbps, audioKbps: info.audioKbps });
  } else if (r.audioStallChecks >= AUDIO_STALL_CHECKS) {
    scheduleRecovery(streamerId, 'audio-no-data', { videoKbps: info.videoKbps });
  }
}

function updateRemoteBadges(entry, info) {
  if (info.largura && info.altura && entry.resBadgeEl) {
    const fps = info.videoFps != null ? info.videoFps : 0;
    entry.resBadgeEl.textContent = `${info.largura}×${info.altura} · ${fps} FPS`;
  }
  if (info.videoKbps != null && entry.bitrateBadgeEl) {
    entry.bitrateBadgeEl.textContent = `${(info.videoKbps / 1000).toFixed(1)} Mbps`;
  }
  if (info.codec && entry.codecBadgeEl) {
    entry.codecBadgeEl.textContent = info.codec.toUpperCase();
  }
}

function updateLocalBadges(entry, viewers) {
  const settings =
    entry.videoTrack && entry.videoTrack.getSettings ? entry.videoTrack.getSettings() : {};
  const first = viewers.find((v) => v.largura && v.altura);
  if (entry.resBadgeEl) {
    if (first) {
      entry.resBadgeEl.textContent = `${first.largura}×${first.altura} · ${first.videoFps || 0} FPS`;
    } else if (settings.width && settings.height) {
      entry.resBadgeEl.textContent = `${settings.width}×${settings.height} · ${Math.round(
        settings.frameRate || 0
      )} FPS`;
    }
  }
  if (entry.bitrateBadgeEl) {
    entry.bitrateBadgeEl.textContent =
      viewers.length === 1 ? '1 assistindo' : `${viewers.length} assistindo`;
  }
  const codec = viewers.find((v) => v.codec);
  if (codec && entry.codecBadgeEl) {
    entry.codecBadgeEl.textContent = codec.codec.toUpperCase();
  }
}

function buildDiagText(entry) {
  const lines = [];
  if (entry.isLocal) {
    const settings =
      entry.videoTrack && entry.videoTrack.getSettings ? entry.videoTrack.getSettings() : {};
    lines.push('TRANSMITINDO');
    lines.push(
      `captura: ${settings.width || '?'}×${settings.height || '?'} @ ${Math.round(
        settings.frameRate || 0
      )} fps · superfície: ${settings.displaySurface || '?'}`
    );
    lines.push(`áudio capturado: ${entry.audioTrack ? 'sim' : 'NÃO'}`);
    lines.push(`navegador: ${BROWSER_NAME}`);
    lines.push('');
    if (!entry.diagViewers || entry.diagViewers.length === 0) {
      lines.push('Nenhum espectador conectado ainda.');
    }
    for (const v of entry.diagViewers || []) {
      lines.push(`▸ ${v.espectador}`);
      lines.push(`  conexão: ${v.conexao} · rota: ${v.rota || '-'} · rtt: ${v.rttMs ?? '-'} ms`);
      lines.push(
        `  vídeo: ${v.largura}×${v.altura} @ ${v.videoFps ?? '-'} fps · ${v.videoKbps ?? '-'} kbps`
      );
      lines.push(`  áudio: ${v.audioKbps ?? '-'} kbps`);
      lines.push(
        `  encoder: ${v.encoder || '-'}${v.encoderHardware === true ? ' (hardware)' : v.encoderHardware === false ? ' (software)' : ''} · ${v.codec || '-'}`
      );
      lines.push(
        `  limitado por: ${v.limitadoPor || '-'} · upload disponível: ${v.uploadDisponivelKbps ?? '-'} kbps`
      );
    }
  } else {
    const i = entry.diagInfo;
    lines.push(`ASSISTINDO ${entry.displayName}`);
    lines.push(`navegador: ${BROWSER_NAME}`);
    if (!i) {
      lines.push('Coletando dados…');
    } else if (i.conexao === 'aguardando-offer') {
      lines.push(`aguardando resposta de quem transmite (${Math.round(i.esperaMs / 1000)} s)`);
    } else {
      lines.push(`conexão: ${i.conexao} · ice: ${i.ice} · rota: ${i.rota || '-'} · rtt: ${i.rttMs ?? '-'} ms`);
      lines.push(`trilhas recebidas: vídeo=${i.trilhaVideo ? 'sim' : 'NÃO'} · áudio=${i.trilhaAudio ? 'sim' : 'NÃO'}`);
      lines.push(
        `vídeo: ${i.largura}×${i.altura} @ ${i.videoFps ?? '-'} fps · ${i.videoKbps ?? '-'} kbps · ${i.codec || '-'} (${i.decoder || '-'})`
      );
      lines.push(
        `buffer vídeo: ${i.bufferVideoMs ?? '-'} ms · descartados: ${i.quadrosDescartados} · congelamentos: ${i.congelamentos}`
      );
      lines.push(`áudio: ${i.audioKbps ?? '-'} kbps · buffer: ${i.bufferAudioMs ?? '-'} ms`);
      lines.push(`player de áudio: ${i.playerAudio}`);
    }
    const r = state.p2pReceivers.get(entry.peerId);
    if (r) lines.push(`tentativas de recuperação: ${r.recoveries}`);
  }
  return lines.join('\n');
}

function renderDiag(entry) {
  if (!entry || !entry.diagEl || entry.diagEl.classList.contains('hidden')) return;
  entry.diagEl.textContent = buildDiagText(entry);
}

let telemetryBusy = false;

async function runTelemetryTick() {
  if (telemetryBusy) return;
  telemetryBusy = true;
  try {
    const now = Date.now();

    // Transmissões que estou assistindo
    for (const [streamerId, r] of [...state.p2pReceivers.entries()]) {
      const entry = state.streams.get(`stream-${streamerId}`);
      if (!entry) continue;

      if (!r.pc) {
        entry.diagInfo = { conexao: 'aguardando-offer', esperaMs: now - r.requestedAt };
        renderDiag(entry);
        if (now - r.requestedAt > OFFER_TIMEOUT_MS) scheduleRecovery(streamerId, 'no-offer');
        continue;
      }

      let result = null;
      try {
        result = await sampleReceiver(entry, r, now);
      } catch {}
      if (!result || !isCurrentReceiver(streamerId, r.sessionId)) continue;

      entry.diagInfo = result.info;
      updateRemoteBadges(entry, result.info);
      runWatchdog(streamerId, r, entry, result.info, result.prev, now);
      renderDiag(entry);
    }

    // Minha transmissão (uma linha por espectador)
    const local = state.streams.get(localStreamId());
    if (local && state.isSharing) {
      const viewers = [];
      for (const senderObj of [...state.p2pSenders.values()]) {
        try {
          viewers.push(await sampleSender(senderObj, now));
        } catch {}
      }
      local.diagViewers = viewers;
      updateLocalBadges(local, viewers);
      renderDiag(local);
    }
  } finally {
    telemetryBusy = false;
  }
}

function startTelemetryLoop() {
  if (state.statsInterval) clearInterval(state.statsInterval);
  state.statsInterval = setInterval(runTelemetryTick, STATS_INTERVAL_MS);
}

// Envia um retrato do estado ao servidor a cada 10 s (somente se houver transmissões)
function startDiagReporting() {
  if (state.diagInterval) clearInterval(state.diagInterval);
  state.diagInterval = setInterval(() => {
    const assistindo = [];
    for (const entry of state.streams.values()) {
      if (!entry.isLocal && entry.diagInfo) {
        assistindo.push({ de: entry.displayName, ...entry.diagInfo });
      }
    }
    const local = state.streams.get(localStreamId());
    const transmitindo = local && state.isSharing ? local.diagViewers || [] : [];
    if (assistindo.length === 0 && transmitindo.length === 0) return;
    postDiag({ kind: 'snapshot', data: { assistindo, transmitindo } });
  }, 10000);
}

// ============================================================================
// ATUALIZAÇÃO DA LISTA DE PARTICIPANTES NA SALA
// ============================================================================
function updateRoomStateUI(roomState) {
  if (!roomState) return;

  if (roomState.serverName) {
    state.serverName = roomState.serverName;
    dom.topbarServerName.textContent = roomState.serverName;
  }

  const members = roomState.members || [];
  dom.membersCountLabel.textContent =
    members.length === 1 ? '1 na sala' : `${members.length} na sala`;
  dom.popoverMembersCount.textContent = String(members.length);

  dom.membersList.innerHTML = '';
  dom.emptyMembersPills.innerHTML = '';

  for (const member of members) {
    const isMe = member.peerId === state.peerId;
    const li = document.createElement('li');
    li.className = 'member-item';

    const info = document.createElement('div');
    info.className = 'member-info';
    const dot = document.createElement('span');
    dot.className = 'status-dot status-online';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = isMe ? `${member.displayName} (Você)` : member.displayName;
    info.append(dot, nameSpan);

    const statusBadge = document.createElement('span');
    if (member.isStreaming) {
      statusBadge.className = 'live-tag';
      statusBadge.textContent = 'AO VIVO';
    } else {
      statusBadge.className = 'viewer-tag';
      statusBadge.textContent = 'Assistindo';
    }

    li.append(info, statusBadge);
    dom.membersList.appendChild(li);

    const pill = document.createElement('div');
    pill.className = 'member-pill';
    pill.innerHTML = `<span class="status-dot status-online"></span><span></span>`;
    pill.querySelector('span:last-child').textContent = isMe
      ? `${member.displayName} (Você)`
      : member.displayName;
    dom.emptyMembersPills.appendChild(pill);
  }
}

// ============================================================================
// EVENTOS DE INTERFACE E INTERAÇÃO
// ============================================================================
function handleShareAction() {
  if (state.isSharing) {
    stopScreenShare();
  } else {
    startScreenShare();
  }
}

dom.btnShareScreen.addEventListener('click', handleShareAction);
dom.btnEmptyShare.addEventListener('click', handleShareAction);
dom.btnLogout.addEventListener('click', logout);

dom.btnModeStage.addEventListener('click', () => setLayoutMode('stage'));
dom.btnModeMosaic.addEventListener('click', () => setLayoutMode('mosaic'));

dom.btnToggleMembers.addEventListener('click', (e) => {
  e.stopPropagation();
  dom.qualityPopover.classList.add('hidden');
  dom.membersPopover.classList.toggle('hidden');
});

dom.btnToggleQuality.addEventListener('click', (e) => {
  e.stopPropagation();
  dom.membersPopover.classList.add('hidden');
  dom.qualityPopover.classList.toggle('hidden');
});

[dom.selectResolution, dom.selectBitrate, dom.selectCodec, dom.selectContentHint].forEach((sel) => {
  sel.addEventListener('change', updateQualitySummaryPill);
});

dom.btnNetworkInfo.addEventListener('click', () => {
  fetchServerInfo();
  dom.networkModal.classList.remove('hidden');
});

dom.btnCloseNetworkModal.addEventListener('click', () => {
  dom.networkModal.classList.add('hidden');
});

dom.btnCopyUrl.addEventListener('click', () => {
  navigator.clipboard.writeText(dom.currentUrlCode.textContent).then(() => {
    showToast('Link copiado para a área de transferência!');
  });
});

document.addEventListener('click', (e) => {
  if (!dom.membersPopover.contains(e.target) && e.target !== dom.btnToggleMembers) {
    dom.membersPopover.classList.add('hidden');
  }
  if (!dom.qualityPopover.contains(e.target) && e.target !== dom.btnToggleQuality) {
    dom.qualityPopover.classList.add('hidden');
  }
});

updateQualitySummaryPill();
tryAutoLogin();
