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

  // Contexto de Áudio Web para desbloquear reprodução em qualquer navegador/celular
  audioCtx: null,

  // Captura local (quando EU estou compartilhando a tela)
  localScreenStream: null,
  localExtraAudioStream: null,
  localQuality: null,
  isSharing: false,

  // Conexões WebRTC Full-ICE (STUN + IPv6 + NAT Hole-Punching)
  p2pSenders: new Map(),
  p2pReceivers: new Map(),

  // Mapa de transmissões ativas na sala: streamId -> StreamEntry
  streams: new Map(),

  featuredStreamId: null,
  layoutMode: 'stage', // 'stage' | 'mosaic'

  pingMs: null,
  pingInterval: null,
  statsInterval: null,
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
  btnDetectAudioDevices: document.getElementById('btn-detect-audio-devices'),

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
// DESBLOQUEIO UNIVERSAL DE ÁUDIO (APENAS PARA TRANSMISSÕES DOS AMIGOS)
// ============================================================================
function unlockGlobalAudioPlayback() {
  for (const entry of state.streams.values()) {
    // NUNCA desmuta a própria transmissão local (entry.isLocal) automaticamente!
    if (
      !entry.isLocal &&
      entry.videoEl &&
      !entry.userManuallyMuted &&
      entry.videoEl.muted
    ) {
      entry.videoEl.muted = false;
      entry.videoEl
        .play()
        .then(() => {
          if (entry.unlockBannerEl) {
            entry.unlockBannerEl.classList.add('hidden');
          }
          if (entry.muteBtnEl) {
            entry.muteBtnEl.textContent = 'Som Ativo';
          }
        })
        .catch(() => {
          entry.videoEl.muted = true;
        });
    }
  }
}

document.addEventListener('click', unlockGlobalAudioPlayback, { passive: true });

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

function enhanceSdpForStereoAudio(sdp) {
  if (!sdp || typeof sdp !== 'string') return sdp;

  // 1. Áudio Opus Estéreo 256kbps
  let out = sdp.replace(
    /a=fmtp:(\d+) minptime=10;useinbandfec=1/g,
    'a=fmtp:$1 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000;usedtx=0'
  );

  // 2. Desbloqueia o limite do H.264 Level 3.1 (1f = teto de 1280x720@30fps) para Level 4.2 (2a = 1920x1080@60fps)
  out = out.replace(/profile-level-id=([0-9a-fA-F]{4})1f/g, 'profile-level-id=$12a');

  // 3. Remove travas de macroblocos de 720p30 do Firefox (max-fs=3600 / max-mbps=108000)
  out = out.replace(/max-fs=\d+/g, 'max-fs=8160');
  out = out.replace(/max-mbps=\d+/g, 'max-mbps=489600');

  return out;
}

async function applyHighQualitySenderParams(pc, quality) {
  if (!pc || !quality) return;
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;

    // IMPORTANTE: Não separamos a prioridade de rede do áudio em relação ao vídeo
    // para que ambos trafeguem juntos na mesma fila e mantenham sincronia absoluta (Lip-Sync).
    if (sender.track.kind === 'video') {
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = quality.maxBitrateBps;
        params.encodings[0].maxFramerate = 60;
        params.encodings[0].scaleResolutionDownBy = 1.0;
        params.degradationPreference = 'balanced';
        await sender.setParameters(params);
      } catch {}
    }
  }
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
    state.peerId = data.peerId;
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

    if (msg.id && state.pendingRequests.has(msg.id)) {
      const { resolve, reject } = state.pendingRequests.get(msg.id);
      state.pendingRequests.delete(msg.id);
      if (msg.ok) resolve(msg.data);
      else reject(new Error(msg.error || 'Erro RPC'));
      return;
    }

    const { type, data } = msg;
    switch (type) {
      case 'welcome': {
        updateRoomStateUI(data.roomState);

        if (Array.isArray(data.existingProducers)) {
          const seenPeers = new Set();
          for (const prod of data.existingProducers) {
            if (!seenPeers.has(prod.peerId)) {
              seenPeers.add(prod.peerId);
              await requestFullIceStream(prod.peerId, prod.displayName, prod.meta);
            }
          }
        }
        break;
      }

      case 'roomState': {
        updateRoomStateUI(data);
        break;
      }

      case 'newProducer': {
        if (data.kind === 'video') {
          showToast(`${data.displayName} iniciou transmissão de tela`);
          await requestFullIceStream(data.peerId, data.displayName, data.meta);
        }
        break;
      }

      case 'p2pSignal': {
        await handleIncomingP2PSignal(data);
        break;
      }

      case 'producerClosed':
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
// MOTOR WEBRTC FULL-ICE COM SINCRONIA NATIVA DE ÁUDIO/VÍDEO (RTCP LIP-SYNC)
// ============================================================================
async function requestFullIceStream(streamerPeerId, streamerDisplayName, meta = {}) {
  if (!streamerPeerId || streamerPeerId === state.peerId) return;

  const streamId = `stream-${streamerPeerId}`;
  upsertStreamTile({
    streamId,
    peerId: streamerPeerId,
    displayName: streamerDisplayName,
    isLocal: false,
    meta: meta || {}
  });

  await sendRequest('p2pSignal', {
    targetPeerId: streamerPeerId,
    signalType: 'request-stream',
    payload: { meta }
  });
}

async function flushPendingCandidates(connObj) {
  if (!connObj || !connObj.pc || !connObj.pc.remoteDescription) return;
  while (connObj.pendingCandidates.length > 0) {
    const cand = connObj.pendingCandidates.shift();
    try {
      await connObj.pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch {}
  }
}

async function handleIncomingP2PSignal({ fromPeerId, fromDisplayName, signalType, payload }) {
  try {
    // 1. Espectador pediu nosso stream -> criamos RTCPeerConnection de envio
    if (signalType === 'request-stream') {
      if (!state.localScreenStream) return;

      if (state.p2pSenders.has(fromPeerId)) {
        try {
          state.p2pSenders.get(fromPeerId).pc.close();
        } catch {}
      }

      const pc = new RTCPeerConnection({
        iceServers: state.iceServers,
        iceCandidatePoolSize: 4
      });

      const senderObj = { pc, pendingCandidates: [] };
      state.p2pSenders.set(fromPeerId, senderObj);

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          sendRequest('p2pSignal', {
            targetPeerId: fromPeerId,
            signalType: 'ice-candidate-from-streamer',
            payload: { candidate: ev.candidate }
          }).catch(() => {});
        }
      };

      const quality = state.localQuality || getSelectedQualityConfig();
      const hasAudio = state.localScreenStream.getAudioTracks().length > 0;

      // IMPORTANTE PARA LIP-SYNC:
      // Tanto a trilha de vídeo quanto a de áudio são adicionadas vinculadas ao MESMO state.localScreenStream,
      // gerando o mesmo identificador a=msid no SDP para que o navegador sincronize áudio e vídeo!
      for (const track of state.localScreenStream.getTracks()) {
        const sender = pc.addTrack(track, state.localScreenStream);

        if (track.kind === 'video') {
          try {
            const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
            if (transceiver && transceiver.setCodecPreferences && RTCRtpSender.getCapabilities) {
              const caps = RTCRtpSender.getCapabilities('video');
              if (caps && caps.codecs) {
                const preferred = caps.codecs
                  .filter((c) => c.mimeType.toLowerCase().includes(quality.codec.toLowerCase()))
                  .sort((a, b) => {
                    const aFmtp = a.sdpFmtpLine || '';
                    const bFmtp = b.sdpFmtpLine || '';
                    const aIs31 = aFmtp.includes('1f') ? 1 : 0;
                    const bIs31 = bFmtp.includes('1f') ? 1 : 0;
                    return aIs31 - bIs31;
                  });
                const others = caps.codecs.filter(
                  (c) => !c.mimeType.toLowerCase().includes(quality.codec.toLowerCase())
                );
                if (preferred.length > 0) {
                  transceiver.setCodecPreferences([...preferred, ...others]);
                }
              }
            }
          } catch {}
        }
      }

      const offer = await pc.createOffer();
      const enhancedOffer = {
        type: offer.type,
        sdp: enhanceSdpForStereoAudio(offer.sdp)
      };
      await pc.setLocalDescription(enhancedOffer);
      await applyHighQualitySenderParams(pc, quality);

      await sendRequest('p2pSignal', {
        targetPeerId: fromPeerId,
        signalType: 'offer',
        payload: {
          sdp: pc.localDescription,
          meta: {
            resolution: quality.label,
            bitrateMbps: quality.bitrateMbps,
            codec: quality.codec,
            hasAudio
          }
        }
      });
      return;
    }

    // 2. Espectador recebeu Offer do Streamer
    if (signalType === 'offer') {
      if (state.p2pReceivers.has(fromPeerId)) {
        try {
          state.p2pReceivers.get(fromPeerId).pc.close();
        } catch {}
      }

      const pc = new RTCPeerConnection({
        iceServers: state.iceServers,
        iceCandidatePoolSize: 4
      });

      const receiverObj = { pc, pendingCandidates: [] };
      state.p2pReceivers.set(fromPeerId, receiverObj);
      const streamId = `stream-${fromPeerId}`;

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          sendRequest('p2pSignal', {
            targetPeerId: fromPeerId,
            signalType: 'ice-candidate-from-viewer',
            payload: { candidate: ev.candidate }
          }).catch(() => {});
        }
      };

      pc.ontrack = (ev) => {
        const track = ev.track;
        // Usa o MediaStream sincronizado nativo do WebRTC (ev.streams[0]) para manter o Lip-Sync exato (RtpStreamsSynchronizer)
        const nativeSyncedStream = ev.streams && ev.streams[0] ? ev.streams[0] : null;

        upsertStreamTile({
          streamId,
          peerId: fromPeerId,
          displayName: fromDisplayName,
          isLocal: false,
          remoteStream: nativeSyncedStream,
          videoTrack: track.kind === 'video' ? track : undefined,
          audioTrack: track.kind === 'audio' ? track : undefined,
          p2pPc: pc,
          meta: payload.meta || {}
        });
      };

      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      await flushPendingCandidates(receiverObj);

      const answer = await pc.createAnswer();
      const enhancedAnswer = {
        type: answer.type,
        sdp: enhanceSdpForStereoAudio(answer.sdp)
      };
      await pc.setLocalDescription(enhancedAnswer);

      await sendRequest('p2pSignal', {
        targetPeerId: fromPeerId,
        signalType: 'answer',
        payload: { sdp: pc.localDescription }
      });
      return;
    }

    // 3. Streamer recebeu Answer do Espectador
    if (signalType === 'answer') {
      const senderObj = state.p2pSenders.get(fromPeerId);
      if (senderObj && senderObj.pc) {
        const quality = state.localQuality || getSelectedQualityConfig();
        const enhancedRemote = {
          type: payload.sdp.type,
          sdp: enhanceSdpForStereoAudio(payload.sdp.sdp)
        };
        await senderObj.pc.setRemoteDescription(new RTCSessionDescription(enhancedRemote));
        await flushPendingCandidates(senderObj);
        await applyHighQualitySenderParams(senderObj.pc, quality);
      }
      return;
    }

    // 4. Candidatos ICE com fila segura
    if (signalType === 'ice-candidate-from-streamer') {
      const receiverObj = state.p2pReceivers.get(fromPeerId);
      if (receiverObj && payload.candidate) {
        if (receiverObj.pc.remoteDescription && receiverObj.pc.remoteDescription.type) {
          await receiverObj.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } else {
          receiverObj.pendingCandidates.push(payload.candidate);
        }
      }
      return;
    }

    if (signalType === 'ice-candidate-from-viewer') {
      const senderObj = state.p2pSenders.get(fromPeerId);
      if (senderObj && payload.candidate) {
        if (senderObj.pc.remoteDescription && senderObj.pc.remoteDescription.type) {
          await senderObj.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } else {
          senderObj.pendingCandidates.push(payload.candidate);
        }
      }
    }
  } catch (err) {
    console.error('[WebRTC Signal Error]:', err);
  }
}

// ============================================================================
// CAPTURA DIRETA ESTILO DISCORD (1 CLIQUE -> SELETOR NATIVO DE TELA, SEM MICROFONE)
// ============================================================================
async function startScreenShare() {
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

  // IMPORTANTE: Captura EXCLUSIVAMENTE a tela/janela/guia via getDisplayMedia.
  // NUNCA chama getUserMedia (microfone), evitando qualquer voz duplicada no Discord!
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
  } catch {
    return;
  }

  const capturedAudioCount = screenStream.getAudioTracks().length;
  if (capturedAudioCount > 0) {
    showToast('Transmissão iniciada com Áudio da Tela! (Você está Auto-Mutado para não se ouvir)');
  } else {
    showToast('Transmissão iniciada (Apenas Vídeo).');
  }

  state.localScreenStream = screenStream;
  state.isSharing = true;
  const streamId = `stream-${state.peerId}`;

  const videoTrack = screenStream.getVideoTracks()[0];
  const localAudioTrack = screenStream.getAudioTracks()[0] || null;

  if (videoTrack) {
    try {
      await videoTrack.applyConstraints({
        width: { ideal: quality.width },
        height: { ideal: quality.height },
        aspectRatio: { ideal: 16 / 9 },
        frameRate: { ideal: 60, max: 60 }
      });
    } catch {}

    try {
      videoTrack.contentHint = quality.contentHint === 'detail' ? 'detail' : '';
    } catch {}

    videoTrack.onended = () => {
      stopScreenShare();
    };
  }

  const meta = {
    resolution: quality.label,
    bitrateMbps: quality.bitrateMbps,
    codec: quality.codec,
    hasAudio: capturedAudioCount > 0
  };

  upsertStreamTile({
    streamId,
    peerId: state.peerId,
    displayName: `${state.displayName} (Você)`,
    isLocal: true,
    videoTrack,
    audioTrack: localAudioTrack,
    meta
  });

  await sendRequest('announceStream', {
    streamId,
    meta
  });

  updateShareButtonUI(true);
}

async function stopScreenShare() {
  const streamId = `stream-${state.peerId}`;
  state.isSharing = false;

  for (const senderObj of state.p2pSenders.values()) {
    try {
      senderObj.pc.close();
    } catch {}
  }
  state.p2pSenders.clear();

  if (state.localExtraAudioStream) {
    for (const t of state.localExtraAudioStream.getTracks()) {
      try {
        t.stop();
      } catch {}
    }
    state.localExtraAudioStream = null;
  }

  if (state.localScreenStream) {
    for (const track of state.localScreenStream.getTracks()) {
      try {
        track.stop();
      } catch {}
    }
    state.localScreenStream = null;
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

function handleRemoteProducerClosed({ streamId, peerId }) {
  const targetStreamId = streamId || `stream-${peerId}`;
  if (peerId && state.p2pReceivers.has(peerId)) {
    try {
      state.p2pReceivers.get(peerId).pc.close();
    } catch {}
    state.p2pReceivers.delete(peerId);
  }
  removeStreamTile(targetStreamId);
}

// ============================================================================
// REPRODUÇÃO DE VÍDEO + ÁUDIO COM TRATAMENTO DE AUTOPLAY E AUTO-MUTE LOCAL
// ============================================================================
function tryPlayRemoteVideoWithAudio(entry) {
  if (!entry || !entry.videoEl) return;

  // Quem está compartilhando a tela começa AUTO-MUTADO por padrão (userManuallyMuted = true)
  // Só reproduz o próprio áudio se a própria pessoa clicar para se desmutar!
  if (entry.isLocal) {
    entry.videoEl.muted = Boolean(entry.userManuallyMuted);
    entry.videoEl.play().catch(() => {});
    return;
  }

  if (!entry.userManuallyMuted) {
    entry.videoEl.muted = false;
  }

  entry.videoEl
    .play()
    .then(() => {
      if (entry.unlockBannerEl) {
        entry.unlockBannerEl.classList.add('hidden');
      }
    })
    .catch(() => {
      entry.videoEl.muted = true;
      entry.videoEl.play().catch(() => {});
      if (entry.unlockBannerEl && (entry.audioTrack || entry.meta?.hasAudio)) {
        entry.unlockBannerEl.classList.remove('hidden');
      }
      if (entry.muteBtnEl) {
        entry.muteBtnEl.textContent = 'Ativar Som';
      }
    });
}

function updateAudioBadgeUI(entry) {
  if (!entry || !entry.audioBadgeEl) return;
  const hasAudio = Boolean(entry.audioTrack) || Boolean(entry.meta?.hasAudio);
  if (hasAudio) {
    entry.audioBadgeEl.className = 'telemetry-pill audio-ok';
    entry.audioBadgeEl.textContent = 'SOM ATIVO';
  } else {
    entry.audioBadgeEl.className = 'telemetry-pill audio-none';
    entry.audioBadgeEl.textContent = 'SEM ÁUDIO';
  }
}

// ============================================================================
// GERENCIAMENTO DO PALCO E MOSAICO + LIP-SYNC + AUTO-MUTE DO TRANSMISSOR
// ============================================================================
function upsertStreamTile({
  streamId,
  peerId,
  displayName,
  isLocal,
  remoteStream,
  videoTrack,
  audioTrack,
  p2pPc,
  meta
}) {
  let entry = state.streams.get(streamId);

  if (!entry) {
    entry = {
      streamId,
      peerId,
      displayName,
      isLocal,
      mediaStream: remoteStream || new MediaStream(),
      videoTrack: null,
      audioTrack: null,
      p2pPc: null,
      // POR PADRÃO: Quem compartilha a tela começa AUTO-MUTADO (true) para nunca se ouvir sem querer!
      // Os espectadores começam desmutados (false) para ouvirem a transmissão.
      userManuallyMuted: Boolean(isLocal),
      meta: meta || {},
      prevBytes: 0,
      prevTimestamp: 0,
      cardEl: null,
      videoEl: null,
      unlockBannerEl: null,
      muteBtnEl: null,
      volSliderEl: null,
      resBadgeEl: null,
      bitrateBadgeEl: null,
      codecBadgeEl: null,
      audioBadgeEl: null
    };
    state.streams.set(streamId, entry);
  }

  if (meta && Object.keys(meta).length > 0) {
    entry.meta = { ...entry.meta, ...meta };
  }

  if (p2pPc) {
    entry.p2pPc = p2pPc;
  }

  if (!entry.cardEl) {
    entry.cardEl = createStreamCardDOM(entry);
    dom.streamsGrid.appendChild(entry.cardEl);
  }

  if (videoTrack) {
    entry.videoTrack = videoTrack;
  }
  if (audioTrack) {
    entry.audioTrack = audioTrack;
    entry.meta.hasAudio = true;
  }

  // PARA ESPECTADORES REMOTOS:
  // Usamos diretamente o MediaStream nativo do WebRTC (remoteStream = ev.streams[0])
  // sem zerar o srcObject, preservando o relógio RTCP Lip-Sync (áudio e vídeo 100% sincronizados)!
  if (!isLocal) {
    if (remoteStream && entry.mediaStream !== remoteStream) {
      entry.mediaStream = remoteStream;
    } else {
      if (videoTrack && !entry.mediaStream.getVideoTracks().some((t) => t.id === videoTrack.id)) {
        entry.mediaStream.addTrack(videoTrack);
      }
      if (audioTrack && !entry.mediaStream.getAudioTracks().some((t) => t.id === audioTrack.id)) {
        entry.mediaStream.addTrack(audioTrack);
      }
    }

    const attachRemote = () => {
      if (entry.videoEl) {
        if (entry.videoEl.srcObject !== entry.mediaStream) {
          entry.videoEl.srcObject = entry.mediaStream;
        }
        tryPlayRemoteVideoWithAudio(entry);
      }
    };

    attachRemote();
    if (videoTrack) videoTrack.onunmute = attachRemote;
    if (audioTrack) audioTrack.onunmute = attachRemote;
  } else {
    // PARA QUEM ESTÁ COMPARTILHANDO A TELA (isLocal === true):
    // Enquanto estiver Auto-Mutado (padrão), só colocamos o vídeo na prévia local (zero eco/retorno!).
    // Se a pessoa clicar para se desmutar, aí sim acoplamos o áudio na prévia local.
    if (videoTrack && !entry.mediaStream.getVideoTracks().some((t) => t.id === videoTrack.id)) {
      entry.mediaStream.addTrack(videoTrack);
    }
    syncLocalPreviewSelfMuteState(entry);
  }

  updateAudioBadgeUI(entry);

  if (!state.featuredStreamId || !state.streams.has(state.featuredStreamId)) {
    state.featuredStreamId = streamId;
  }

  syncWorkspaceLayout();
  return entry;
}

function syncLocalPreviewSelfMuteState(entry) {
  if (!entry || !entry.isLocal || !entry.videoEl) return;

  if (entry.userManuallyMuted) {
    // Remove qualquer trilha de áudio do reprodutor local para ser fisicamente impossível se ouvir
    for (const aTrack of entry.mediaStream.getAudioTracks()) {
      entry.mediaStream.removeTrack(aTrack);
    }
    entry.videoEl.muted = true;
  } else {
    // Usuário escolheu explicitamente se desmutar para ouvir a própria transmissão
    if (
      entry.audioTrack &&
      !entry.mediaStream.getAudioTracks().some((t) => t.id === entry.audioTrack.id)
    ) {
      entry.mediaStream.addTrack(entry.audioTrack);
    }
    entry.videoEl.muted = false;
  }

  if (entry.videoEl.srcObject !== entry.mediaStream) {
    entry.videoEl.srcObject = entry.mediaStream;
  }
  entry.videoEl.play().catch(() => {});
}

function createStreamCardDOM(entry) {
  const card = document.createElement('div');
  card.className = 'stream-card';
  card.dataset.streamId = entry.streamId;

  const video = document.createElement('video');
  video.className = 'stream-video';
  video.autoplay = true;
  video.playsInline = true;
  // Se for a própria transmissão (isLocal), inicia 100% mutado e volume 0 por padrão
  video.muted = Boolean(entry.isLocal);
  video.volume = entry.isLocal ? 0 : 1.0;
  entry.videoEl = video;

  // Banner clicável caso o navegador bloqueie Autoplay de som em transmissões de amigos
  const unlockBanner = document.createElement('button');
  unlockBanner.type = 'button';
  unlockBanner.className = 'audio-unlock-banner hidden';
  unlockBanner.textContent = '🔊 Clique aqui para Ativar o Som da Transmissão';
  unlockBanner.addEventListener('click', (e) => {
    e.stopPropagation();
    entry.userManuallyMuted = false;
    video.muted = false;
    if (video.volume === 0) video.volume = 1.0;
    unlockGlobalAudioPlayback();
    video.play().catch(() => {});
    unlockBanner.classList.add('hidden');
    if (entry.muteBtnEl) {
      entry.muteBtnEl.textContent = 'Som Ativo';
    }
  });
  entry.unlockBannerEl = unlockBanner;

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

  telemetry.append(audioBadge, resBadge, bitrateBadge, codecBadge);
  topOverlay.append(authorBadge, telemetry);

  const bottomOverlay = document.createElement('div');
  bottomOverlay.className = 'stream-overlay-bottom';

  const audioControls = document.createElement('div');
  audioControls.className = 'audio-controls';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'btn-stream-ctrl';
  muteBtn.textContent = entry.isLocal
    ? '🔇 Auto-Mutado (Clique para se ouvir)'
    : 'Som Ativo';
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
    unlockGlobalAudioPlayback();

    entry.userManuallyMuted = !entry.userManuallyMuted;

    if (entry.isLocal) {
      if (!entry.userManuallyMuted && video.volume === 0) {
        video.volume = 1.0;
        volSlider.value = '100';
      } else if (entry.userManuallyMuted) {
        volSlider.value = '0';
      }
      syncLocalPreviewSelfMuteState(entry);
      muteBtn.textContent = entry.userManuallyMuted
        ? '🔇 Auto-Mutado (Clique para se ouvir)'
        : '🔊 Ouvindo Própria Tela';
    } else {
      video.muted = entry.userManuallyMuted;
      muteBtn.textContent = video.muted ? 'Mutado' : 'Som Ativo';
      if (!video.muted) {
        if (video.volume === 0) {
          video.volume = 1.0;
          volSlider.value = '100';
        }
        unlockBanner.classList.add('hidden');
        video.play().catch(() => {});
      }
    }
  });

  volSlider.addEventListener('input', (e) => {
    e.stopPropagation();
    unlockGlobalAudioPlayback();
    const val = parseInt(e.target.value, 10) / 100;
    video.volume = val;
    entry.userManuallyMuted = val === 0;

    if (entry.isLocal) {
      syncLocalPreviewSelfMuteState(entry);
      muteBtn.textContent = entry.userManuallyMuted
        ? '🔇 Auto-Mutado (Clique para se ouvir)'
        : '🔊 Ouvindo Própria Tela';
    } else {
      video.muted = val === 0;
      muteBtn.textContent = video.muted ? 'Mutado' : 'Som Ativo';
      if (!video.muted) {
        unlockBanner.classList.add('hidden');
        video.play().catch(() => {});
      }
    }
  });

  audioControls.append(muteBtn, volSlider);

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

  card.addEventListener('click', () => {
    unlockGlobalAudioPlayback();
    if (state.layoutMode === 'stage' && state.featuredStreamId !== entry.streamId) {
      state.featuredStreamId = entry.streamId;
      syncWorkspaceLayout();
    }
  });

  card.append(video, unlockBanner, topOverlay, bottomOverlay);
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
// TELEMETRIA EM TEMPO REAL (FPS, RESOLUÇÃO, BITRATE E CODEC)
// ============================================================================
function startTelemetryLoop() {
  if (state.statsInterval) clearInterval(state.statsInterval);

  state.statsInterval = setInterval(async () => {
    for (const entry of state.streams.values()) {
      try {
        let targetPc = entry.p2pPc;
        if (entry.isLocal) {
          const firstSender = state.p2pSenders.values().next().value;
          targetPc = firstSender ? firstSender.pc : null;
        }
        if (!targetPc) continue;

        const stats = await targetPc.getStats();
        let bytes = 0;
        let timestamp = 0;
        let fps = 0;
        let width = 0;
        let height = 0;
        let codecName = '';

        stats.forEach((report) => {
          if (entry.isLocal && report.type === 'outbound-rtp' && report.kind === 'video') {
            bytes = report.bytesSent || 0;
            timestamp = report.timestamp || performance.now();
            fps = report.framesPerSecond || 0;
            width = report.frameWidth || 0;
            height = report.frameHeight || 0;
          } else if (!entry.isLocal && report.type === 'inbound-rtp' && report.kind === 'video') {
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
  }, 1500);
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
