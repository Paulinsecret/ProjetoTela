import * as mediasoupClient from 'mediasoup-client';

// ============================================================================
// ESTADO GLOBAL DO CLIENTE
// ============================================================================
const state = {
  token: localStorage.getItem('stage_sfu_token') || null,
  peerId: null,
  displayName: localStorage.getItem('stage_sfu_name') || '',
  serverName: 'STAGE // 1080p60',
  ws: null,
  wsReqId: 0,
  pendingRequests: new Map(),

  device: null,
  sendTransport: null,
  recvTransport: null,

  // Produtores locais (quando EU estou compartilhando tela)
  localScreenStream: null,
  localVideoProducer: null,
  localAudioProducer: null,

  // Mapa de transmissões ativas na sala: streamId -> StreamEntry
  // StreamEntry: { streamId, peerId, displayName, isLocal, mediaStream, videoTrack, audioTrack, videoConsumer, audioConsumer, meta, prevBytes, prevTimestamp, cardEl }
  streams: new Map(),

  // Qual stream está em destaque no Modo Palco
  featuredStreamId: null,
  layoutMode: 'stage', // 'stage' | 'mosaic'

  pingMs: null,
  pingInterval: null,
  statsInterval: null,
  localIps: []
};

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
function showToast(message, durationMs = 3500) {
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.textContent = message;
  dom.toastContainer.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, durationMs);
}

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

  const bitrateMbps = parseInt(dom.selectBitrate.value || '12', 10);
  const codec = dom.selectCodec.value || 'H264';
  const contentHint = dom.selectContentHint.value || 'motion';

  return {
    label: resVal,
    width,
    height,
    fps: 60,
    bitrateMbps,
    maxBitrateBps: bitrateMbps * 1000000,
    codec,
    contentHint
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

    dom.loginServerName.textContent = state.serverName;
    dom.topbarServerName.textContent = state.serverName;
    dom.loginOnlineCount.textContent = `${info.onlineCount || 0} conectados`;
    dom.loginStreamCount.textContent = `${info.activeStreamsCount || 0} ativas`;
    renderNetworkModalInfo();
  } catch {}
}

function renderNetworkModalInfo() {
  dom.currentUrlCode.textContent = window.location.origin;
  dom.networkIpsList.innerHTML = '';

  if (!state.localIps || state.localIps.length === 0) {
    dom.networkIpsList.textContent = 'Nenhum IP de rede adicional detectado.';
    return;
  }

  for (const ip of state.localIps) {
    const row = document.createElement('div');
    row.textContent = `https://${ip}:8443  (ou https://${ip}:3443)`;
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
    state.peerId = data.peerId;
    state.displayName = data.displayName;
    enterAppScreen();
  } catch {}
}

dom.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
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
    state.peerId = data.peerId;
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
  if (state.ws) {
    try {
      state.ws.close();
    } catch {}
  }
  localStorage.removeItem('stage_sfu_token');
  state.token = null;
  dom.appScreen.classList.add('hidden');
  dom.loginScreen.classList.remove('hidden');
  fetchServerInfo();
}

// ============================================================================
// WEBSOCKET & SINALIZAÇÃO RPC COM O SERVIDOR MEDIASOUP
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
  const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(state.token)}`;

  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    dom.wsStatusDot.className = 'status-dot status-online';
    startPingLoop();
    startTelemetryLoop();
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // Resposta a uma chamada RPC (sendRequest)
    if (msg.id && state.pendingRequests.has(msg.id)) {
      const { resolve, reject } = state.pendingRequests.get(msg.id);
      state.pendingRequests.delete(msg.id);
      if (msg.ok) resolve(msg.data);
      else reject(new Error(msg.error || 'Erro RPC'));
      return;
    }

    // Eventos enviados pelo servidor
    const { type, data } = msg;
    switch (type) {
      case 'welcome': {
        updateRoomStateUI(data.roomState);
        await initMediasoupDevice();

        // Consome todas as transmissões que já estavam ativas na sala
        if (Array.isArray(data.existingProducers)) {
          for (const prod of data.existingProducers) {
            await consumeRemoteProducer(prod);
          }
        }
        break;
      }

      case 'roomState': {
        updateRoomStateUI(data);
        break;
      }

      case 'newProducer': {
        showToast(`${data.displayName} iniciou transmissão` + (data.kind === 'video' ? ' de tela' : ''));
        await consumeRemoteProducer(data);
        break;
      }

      case 'producerClosed': {
        handleRemoteProducerClosed(data);
        break;
      }

      case 'consumerClosed': {
        handleRemoteProducerClosed(data);
        break;
      }
    }
  };

  ws.onclose = (ev) => {
    dom.wsStatusDot.className = 'status-dot status-offline';
    if (ev.code === 4001) {
      logout();
      return;
    }
    // Reconecta automaticamente se cair
    setTimeout(() => {
      if (state.token) connectWebSocket();
    }, 2500);
  };
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
// INICIALIZAÇÃO DO MEDIASOUP DEVICE E TRANSPORTES WEBRTC
// ============================================================================
async function initMediasoupDevice() {
  const routerRtpCapabilities = await sendRequest('getRouterRtpCapabilities');
  const device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities });
  state.device = device;
}

async function ensureSendTransport() {
  if (state.sendTransport && !state.sendTransport.closed) {
    return state.sendTransport;
  }

  const params = await sendRequest('createWebRtcTransport', {
    clientHost: window.location.hostname
  });

  const transport = state.device.createSendTransport({
    id: params.id,
    iceParameters: params.iceParameters,
    iceCandidates: params.iceCandidates,
    dtlsParameters: params.dtlsParameters,
    iceServers: params.iceServers
  });

  transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    try {
      await sendRequest('connectTransport', {
        transportId: transport.id,
        dtlsParameters
      });
      callback();
    } catch (err) {
      errback(err);
    }
  });

  transport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
    try {
      const { id } = await sendRequest('produce', {
        transportId: transport.id,
        kind,
        rtpParameters,
        appData
      });
      callback({ id });
    } catch (err) {
      errback(err);
    }
  });

  state.sendTransport = transport;
  return transport;
}

async function ensureRecvTransport() {
  if (state.recvTransport && !state.recvTransport.closed) {
    return state.recvTransport;
  }

  const params = await sendRequest('createWebRtcTransport', {
    clientHost: window.location.hostname
  });

  const transport = state.device.createRecvTransport({
    id: params.id,
    iceParameters: params.iceParameters,
    iceCandidates: params.iceCandidates,
    dtlsParameters: params.dtlsParameters,
    iceServers: params.iceServers
  });

  transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    try {
      await sendRequest('connectTransport', {
        transportId: transport.id,
        dtlsParameters
      });
      callback();
    } catch (err) {
      errback(err);
    }
  });

  state.recvTransport = transport;
  return transport;
}

// ============================================================================
// CAPTURA E TRANSMISSÃO DE TELA / JOGO EM 1080P 60FPS + ÁUDIO ESTÉREO
// ============================================================================
async function startScreenShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    showToast(
      'O navegador exige conexão segura (HTTPS ou localhost) para compartilhar a tela.',
      6000
    );
    dom.networkModal.classList.remove('hidden');
    return;
  }

  const quality = getSelectedQualityConfig();

  let screenStream;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: quality.width, max: quality.width },
        height: { ideal: quality.height, max: quality.height },
        frameRate: { ideal: 60, max: 60 },
        cursor: 'always'
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
        sampleSize: 16
      },
      systemAudio: 'include',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude'
    });
  } catch {
    return; // Usuário cancelou a janela de seleção
  }

  state.localScreenStream = screenStream;
  const streamId = `stream-${state.peerId}`;
  const sendTransport = await ensureSendTransport();

  const videoTrack = screenStream.getVideoTracks()[0];
  if (videoTrack) {
    // Crucial para manter 60 FPS constantes em jogos sem o navegador derrubar quadros
    try {
      videoTrack.contentHint = quality.contentHint;
    } catch {}

    videoTrack.onended = () => {
      stopScreenShare();
    };

    // Seleciona o codec preferido (H264 NVENC/AMF, VP9 ou VP8)
    const desiredMime = `video/${quality.codec}`;
    const selectedCodec = state.device.rtpCapabilities.codecs.find(
      (c) => c.mimeType.toLowerCase() === desiredMime.toLowerCase()
    );

    const produceOptions = {
      track: videoTrack,
      encodings: [
        {
          maxBitrate: quality.maxBitrateBps,
          maxFramerate: 60,
          priority: 'high',
          networkPriority: 'high'
        }
      ],
      codecOptions: {
        videoGoogleStartBitrate: 6000,
        videoGoogleMinBitrate: Math.floor(quality.bitrateMbps * 500),
        videoGoogleMaxBitrate: quality.bitrateMbps * 1000
      },
      appData: {
        streamId,
        meta: {
          resolution: quality.label,
          bitrateMbps: quality.bitrateMbps,
          codec: quality.codec
        }
      }
    };

    if (selectedCodec) {
      produceOptions.codec = selectedCodec;
    }

    state.localVideoProducer = await sendTransport.produce(produceOptions);
  }

  // Captura de áudio estéreo de alta fidelidade (Jogo / Sistema)
  const audioTrack = screenStream.getAudioTracks()[0];
  if (audioTrack) {
    state.localAudioProducer = await sendTransport.produce({
      track: audioTrack,
      codecOptions: {
        opusStereo: true,
        opusFec: true,
        opusDtx: false,
        opusMaxAverageBitrate: 256000
      },
      appData: {
        streamId,
        meta: {
          resolution: quality.label,
          bitrateMbps: quality.bitrateMbps,
          codec: quality.codec
        }
      }
    });
  }

  // Renderiza o preview local na grade/palco (áudio local mutado para não dar eco no próprio PC)
  upsertStreamTile({
    streamId,
    peerId: state.peerId,
    displayName: `${state.displayName} (Você)`,
    isLocal: true,
    videoTrack,
    audioTrack: null,
    meta: {
      resolution: quality.label,
      bitrateMbps: quality.bitrateMbps,
      codec: quality.codec
    }
  });

  updateShareButtonUI(true);
  showToast('Transmissão iniciada em alta definição!');
}

async function stopScreenShare() {
  const streamId = `stream-${state.peerId}`;

  if (state.localScreenStream) {
    for (const track of state.localScreenStream.getTracks()) {
      try {
        track.stop();
      } catch {}
    }
    state.localScreenStream = null;
  }

  if (state.localVideoProducer) {
    try {
      state.localVideoProducer.close();
    } catch {}
    state.localVideoProducer = null;
  }

  if (state.localAudioProducer) {
    try {
      state.localAudioProducer.close();
    } catch {}
    state.localAudioProducer = null;
  }

  removeStreamTile(streamId);
  updateShareButtonUI(false);

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try {
      await sendRequest('stopStream');
    } catch {}
  }
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
// RECEPÇÃO DE MÚLTIPLAS TRANSMISSÕES DOS AMIGOS (CONSUMERS)
// ============================================================================
async function consumeRemoteProducer(producerInfo) {
  if (!state.device) return;
  const recvTransport = await ensureRecvTransport();

  const consumerParams = await sendRequest('consume', {
    transportId: recvTransport.id,
    producerId: producerInfo.producerId,
    rtpCapabilities: state.device.rtpCapabilities
  });

  const consumer = await recvTransport.consume({
    id: consumerParams.id,
    producerId: consumerParams.producerId,
    kind: consumerParams.kind,
    rtpParameters: consumerParams.rtpParameters
  });

  const streamId = consumerParams.streamId || `stream-${consumerParams.peerId}`;

  upsertStreamTile({
    streamId,
    peerId: consumerParams.peerId,
    displayName: consumerParams.displayName,
    isLocal: false,
    videoTrack: consumer.kind === 'video' ? consumer.track : undefined,
    audioTrack: consumer.kind === 'audio' ? consumer.track : undefined,
    videoConsumer: consumer.kind === 'video' ? consumer : undefined,
    audioConsumer: consumer.kind === 'audio' ? consumer : undefined,
    meta: consumerParams.meta || producerInfo.meta || {}
  });

  await sendRequest('resumeConsumer', { consumerId: consumer.id });
}

function handleRemoteProducerClosed({ producerId, streamId, peerId }) {
  const targetStreamId = streamId || `stream-${peerId}`;
  const entry = state.streams.get(targetStreamId);
  if (!entry) return;

  if (entry.videoConsumer && entry.videoConsumer.producerId === producerId) {
    try {
      entry.videoConsumer.close();
    } catch {}
    entry.videoConsumer = null;
    entry.videoTrack = null;
  }

  if (entry.audioConsumer && entry.audioConsumer.producerId === producerId) {
    try {
      entry.audioConsumer.close();
    } catch {}
    entry.audioConsumer = null;
    entry.audioTrack = null;
  }

  if (!entry.videoTrack && !entry.audioTrack) {
    removeStreamTile(targetStreamId);
  }
}

// ============================================================================
// GERENCIAMENTO DO PALCO E MOSAICO DE VÍDEOS + VOLUME INDIVIDUAL
// ============================================================================
function upsertStreamTile({
  streamId,
  peerId,
  displayName,
  isLocal,
  videoTrack,
  audioTrack,
  videoConsumer,
  audioConsumer,
  meta
}) {
  let entry = state.streams.get(streamId);

  if (!entry) {
    entry = {
      streamId,
      peerId,
      displayName,
      isLocal,
      mediaStream: new MediaStream(),
      audioStream: new MediaStream(),
      videoTrack: null,
      audioTrack: null,
      videoConsumer: null,
      audioConsumer: null,
      meta: meta || {},
      prevBytes: 0,
      prevTimestamp: 0,
      cardEl: null,
      videoEl: null,
      audioEl: null,
      resBadgeEl: null,
      bitrateBadgeEl: null,
      codecBadgeEl: null
    };
    state.streams.set(streamId, entry);
  }

  if (meta && Object.keys(meta).length > 0) {
    entry.meta = { ...entry.meta, ...meta };
  }

  if (videoTrack) {
    for (const old of entry.mediaStream.getVideoTracks()) {
      entry.mediaStream.removeTrack(old);
    }
    entry.mediaStream.addTrack(videoTrack);
    entry.videoTrack = videoTrack;
  }

  if (videoConsumer) {
    entry.videoConsumer = videoConsumer;
  }

  if (audioTrack && !isLocal) {
    for (const old of entry.audioStream.getAudioTracks()) {
      entry.audioStream.removeTrack(old);
    }
    entry.audioStream.addTrack(audioTrack);
    entry.audioTrack = audioTrack;
  }

  if (audioConsumer) {
    entry.audioConsumer = audioConsumer;
  }

  if (!entry.cardEl) {
    entry.cardEl = createStreamCardDOM(entry);
    dom.streamsGrid.appendChild(entry.cardEl);
  }

  if (entry.videoEl && entry.videoEl.srcObject !== entry.mediaStream) {
    entry.videoEl.srcObject = entry.mediaStream;
    entry.videoEl.play().catch(() => {});
  }

  if (entry.audioEl && entry.audioTrack && !isLocal) {
    entry.audioEl.srcObject = entry.audioStream;
    entry.audioEl.play().catch(() => {});
  }

  if (!state.featuredStreamId || !state.streams.has(state.featuredStreamId)) {
    state.featuredStreamId = streamId;
  }

  syncWorkspaceLayout();
}

function createStreamCardDOM(entry) {
  const card = document.createElement('div');
  card.className = 'stream-card';
  card.dataset.streamId = entry.streamId;

  const video = document.createElement('video');
  video.className = 'stream-video';
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true; // O áudio roda no elemento <audio> dedicado com controle individual
  entry.videoEl = video;

  const audio = document.createElement('audio');
  audio.autoplay = true;
  entry.audioEl = audio;

  // Barra superior: Nome do Amigo + Indicadores de FPS / Resolução / Bitrate / Codec
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

  const resBadge = document.createElement('span');
  resBadge.className = 'telemetry-pill';
  resBadge.textContent = entry.meta?.resolution || '1080p60';
  entry.resBadgeEl = resBadge;

  const bitrateBadge = document.createElement('span');
  bitrateBadge.className = 'telemetry-pill';
  bitrateBadge.textContent = entry.meta?.bitrateMbps ? `${entry.meta.bitrateMbps} Mbps` : '-- Mbps';
  entry.bitrateBadgeEl = bitrateBadge;

  const codecBadge = document.createElement('span');
  codecBadge.className = 'telemetry-pill';
  codecBadge.textContent = entry.meta?.codec || 'H264';
  entry.codecBadgeEl = codecBadge;

  telemetry.append(resBadge, bitrateBadge, codecBadge);
  topOverlay.append(authorBadge, telemetry);

  // Barra inferior: Volume Individual + Botão Destacar no Palco + PiP + Tela Cheia
  const bottomOverlay = document.createElement('div');
  bottomOverlay.className = 'stream-overlay-bottom';

  const audioControls = document.createElement('div');
  audioControls.className = 'audio-controls';

  if (entry.isLocal) {
    const selfLabel = document.createElement('span');
    selfLabel.className = 'mono-label';
    selfLabel.style.color = '#a1a1aa';
    selfLabel.textContent = 'Sua transmissão (Áudio local silenciado)';
    audioControls.appendChild(selfLabel);
  } else {
    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'btn-stream-ctrl';
    muteBtn.textContent = 'Som Ativo';

    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.className = 'volume-slider';
    volSlider.min = '0';
    volSlider.max = '100';
    volSlider.value = '100';

    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      audio.muted = !audio.muted;
      muteBtn.textContent = audio.muted ? 'Mutado' : 'Som Ativo';
      if (!audio.muted) audio.play().catch(() => {});
    });

    volSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      const val = parseInt(e.target.value, 10) / 100;
      audio.volume = val;
      audio.muted = val === 0;
      muteBtn.textContent = audio.muted ? 'Mutado' : 'Som Ativo';
      if (!audio.muted) audio.play().catch(() => {});
    });

    audioControls.append(muteBtn, volSlider);
  }

  const actionsRight = document.createElement('div');
  actionsRight.className = 'stream-actions-right';

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

  actionsRight.append(btnFeature, btnPip, btnFullscreen);
  bottomOverlay.append(audioControls, actionsRight);

  // Clicar num card secundário no Modo Palco traz ele para o destaque principal
  card.addEventListener('click', () => {
    if (state.layoutMode === 'stage' && state.featuredStreamId !== entry.streamId) {
      state.featuredStreamId = entry.streamId;
      syncWorkspaceLayout();
    }
  });

  card.append(video, audio, topOverlay, bottomOverlay);
  return card;
}

function removeStreamTile(streamId) {
  const entry = state.streams.get(streamId);
  if (!entry) return;

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
// TELEMETRIA WEBRTC EM TEMPO REAL (FPS, RESOLUÇÃO, BITRATE E CODEC)
// ============================================================================
function startTelemetryLoop() {
  if (state.statsInterval) clearInterval(state.statsInterval);

  state.statsInterval = setInterval(async () => {
    for (const entry of state.streams.values()) {
      try {
        const targetRtcObj = entry.isLocal ? state.localVideoProducer : entry.videoConsumer;
        if (!targetRtcObj || targetRtcObj.closed) continue;

        const stats = await targetRtcObj.getStats();
        let bytes = 0;
        let timestamp = 0;
        let fps = 0;
        let width = 0;
        let height = 0;
        let codecName = '';

        stats.forEach((report) => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            bytes = report.bytesSent || 0;
            timestamp = report.timestamp || performance.now();
            fps = report.framesPerSecond || 0;
            width = report.frameWidth || 0;
            height = report.frameHeight || 0;
          } else if (report.type === 'inbound-rtp' && report.kind === 'video') {
            bytes = report.bytesReceived || 0;
            timestamp = report.timestamp || performance.now();
            fps = report.framesPerSecond || 0;
            width = report.frameWidth || 0;
            height = report.frameHeight || 0;
          } else if (report.type === 'codec' && report.mimeType && report.mimeType.startsWith('video/')) {
            codecName = report.mimeType.split('/')[1].toUpperCase();
          }
        });

        if (entry.prevTimestamp > 0 && timestamp > entry.prevTimestamp) {
          const deltaBytes = bytes - entry.prevBytes;
          const deltaSec = (timestamp - entry.prevTimestamp) / 1000;
          if (deltaSec > 0 && deltaBytes >= 0) {
            const mbps = ((deltaBytes * 8) / (deltaSec * 1000000)).toFixed(1);
            if (entry.bitrateBadgeEl) {
              entry.bitrateBadgeEl.textContent = `${mbps} Mbps`;
            }
          }
        }

        entry.prevBytes = bytes;
        entry.prevTimestamp = timestamp;

        if (width && height && entry.resBadgeEl) {
          const fpsLabel = fps ? `${Math.round(fps)} FPS` : '60 FPS';
          entry.resBadgeEl.textContent = `${width}×${height} · ${fpsLabel}`;
        }

        if (codecName && entry.codecBadgeEl) {
          entry.codecBadgeEl.textContent = codecName;
        }
      } catch {}
    }
  }, 1200);
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

  // Atualiza popover do topo
  dom.membersList.innerHTML = '';
  // Atualiza pílulas do estado vazio
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

    // Pílula na tela inicial quando não há live
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
  if (state.localVideoProducer) {
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
  navigator.clipboard.writeText(window.location.origin).then(() => {
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

// Inicializa na abertura da página
updateQualitySummaryPill();
tryAutoLogin();
