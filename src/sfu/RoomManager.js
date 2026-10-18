const mediasoup = require('mediasoup');
const config = require('../config');

class RoomManager {
  constructor() {
    this.worker = null;
    this.router = null;
    /** @type {Map<string, { id: string, displayName: string, joinedAt: number, ws: any, transports: Map<string, any>, producers: Map<string, any>, consumers: Map<string, any> }>} */
    this.peers = new Map();
  }

  async init() {
    this.worker = await mediasoup.createWorker({
      logLevel: config.mediasoup.worker.logLevel,
      logTags: config.mediasoup.worker.logTags,
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort
    });

    this.worker.on('died', () => {
      console.error('[Mediasoup] Worker C++ encerrou inesperadamente! Reiniciando em 2s...');
      setTimeout(() => {
        this.init().catch((err) => console.error('[Mediasoup] Falha ao reiniciar worker:', err));
      }, 2000);
    });

    this.router = await this.worker.createRouter({
      mediaCodecs: config.mediasoup.router.mediaCodecs
    });

    console.log(
      `[Mediasoup] SFU Worker (PID ${this.worker.pid}) iniciado | Portas RTC: ${config.mediasoup.worker.rtcMinPort}-${config.mediasoup.worker.rtcMaxPort}`
    );
  }

  getRouterRtpCapabilities() {
    if (!this.router) {
      throw new Error('Router Mediasoup ainda não inicializado.');
    }
    return this.router.rtpCapabilities;
  }

  addPeer(peerId, displayName, ws) {
    // Se já existir uma conexão antiga do mesmo peerId, limpa antes
    if (this.peers.has(peerId)) {
      this.removePeer(peerId);
    }

    const peer = {
      id: peerId,
      displayName,
      joinedAt: Date.now(),
      ws,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map()
    };

    this.peers.set(peerId, peer);
    return peer;
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return [];

    const closedProducerIds = [];
    for (const [producerId, producer] of peer.producers.entries()) {
      closedProducerIds.push({
        producerId,
        peerId: peer.id,
        streamId: producer.appData?.streamId || peer.id
      });
      try {
        producer.close();
      } catch {}
    }

    for (const consumer of peer.consumers.values()) {
      try {
        consumer.close();
      } catch {}
    }

    for (const transport of peer.transports.values()) {
      try {
        transport.close();
      } catch {}
    }

    this.peers.delete(peerId);
    return closedProducerIds;
  }

  getRoomState() {
    const members = [];
    const activeStreamsMap = new Map();

    for (const peer of this.peers.values()) {
      let isStreaming = false;

      for (const producer of peer.producers.values()) {
        if (!producer.closed) {
          isStreaming = true;
          const streamId = producer.appData?.streamId || `stream-${peer.id}`;
          if (!activeStreamsMap.has(streamId)) {
            activeStreamsMap.set(streamId, {
              streamId,
              peerId: peer.id,
              displayName: peer.displayName,
              hasVideo: false,
              hasAudio: false,
              meta: producer.appData?.meta || {},
              producers: []
            });
          }
          const entry = activeStreamsMap.get(streamId);
          if (producer.kind === 'video') entry.hasVideo = true;
          if (producer.kind === 'audio') entry.hasAudio = true;
          if (producer.appData?.meta && Object.keys(producer.appData.meta).length > 0) {
            entry.meta = { ...entry.meta, ...producer.appData.meta };
          }
          entry.producers.push({
            producerId: producer.id,
            kind: producer.kind,
            peerId: peer.id,
            displayName: peer.displayName,
            streamId
          });
        }
      }

      members.push({
        peerId: peer.id,
        displayName: peer.displayName,
        isStreaming,
        joinedAt: peer.joinedAt
      });
    }

    return {
      serverName: config.serverName,
      members,
      streams: Array.from(activeStreamsMap.values())
    };
  }

  getAllProducersExcept(excludePeerId = null) {
    const list = [];
    for (const peer of this.peers.values()) {
      if (excludePeerId && peer.id === excludePeerId) continue;
      for (const producer of peer.producers.values()) {
        if (!producer.closed) {
          list.push({
            producerId: producer.id,
            peerId: peer.id,
            displayName: peer.displayName,
            kind: producer.kind,
            streamId: producer.appData?.streamId || `stream-${peer.id}`,
            meta: producer.appData?.meta || {}
          });
        }
      }
    }
    return list;
  }

  async createWebRtcTransport(peerId, clientHost) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer não encontrado na sala.');

    const listenIps = await config.resolveListenIps(clientHost);

    const transport = await this.router.createWebRtcTransport({
      listenIps,
      enableUdp: config.mediasoup.webRtcTransport.enableUdp,
      enableTcp: config.mediasoup.webRtcTransport.enableTcp,
      preferUdp: config.mediasoup.webRtcTransport.preferUdp,
      initialAvailableOutgoingBitrate:
        config.mediasoup.webRtcTransport.initialAvailableOutgoingBitrate
    });

    if (config.mediasoup.webRtcTransport.maxIncomingBitrate) {
      try {
        await transport.setMaxIncomingBitrate(
          config.mediasoup.webRtcTransport.maxIncomingBitrate
        );
      } catch {}
    }

    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') {
        transport.close();
      }
    });

    transport.on('close', () => {
      peer.transports.delete(transport.id);
    });

    peer.transports.set(transport.id, transport);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      iceServers: config.getIceServers()
    };
  }

  async connectTransport(peerId, transportId, dtlsParameters) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer não encontrado.');

    const transport = peer.transports.get(transportId);
    if (!transport) throw new Error('Transporte WebRTC não encontrado.');

    await transport.connect({ dtlsParameters });
    return { connected: true };
  }

  async produce(peerId, { transportId, kind, rtpParameters, appData }) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer não encontrado.');

    const transport = peer.transports.get(transportId);
    if (!transport) throw new Error('Transporte de envio não encontrado.');

    const streamId = appData?.streamId || `stream-${peer.id}`;
    const enrichedAppData = {
      ...appData,
      peerId: peer.id,
      displayName: peer.displayName,
      streamId
    };

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: enrichedAppData
    });

    producer.on('transportclose', () => {
      producer.close();
      peer.producers.delete(producer.id);
    });

    peer.producers.set(producer.id, producer);

    return {
      id: producer.id,
      kind: producer.kind,
      streamId,
      peerId: peer.id,
      displayName: peer.displayName,
      meta: enrichedAppData.meta || {}
    };
  }

  closeProducer(peerId, producerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;

    const producer = peer.producers.get(producerId);
    if (!producer) return null;

    const streamId = producer.appData?.streamId || `stream-${peer.id}`;
    try {
      producer.close();
    } catch {}
    peer.producers.delete(producerId);

    return {
      producerId,
      peerId: peer.id,
      streamId
    };
  }

  closeAllPeerProducers(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return [];

    const closed = [];
    for (const [producerId, producer] of peer.producers.entries()) {
      const streamId = producer.appData?.streamId || `stream-${peer.id}`;
      try {
        producer.close();
      } catch {}
      peer.producers.delete(producerId);
      closed.push({ producerId, peerId: peer.id, streamId });
    }
    return closed;
  }

  findProducerById(producerId) {
    for (const peer of this.peers.values()) {
      if (peer.producers.has(producerId)) {
        return {
          producer: peer.producers.get(producerId),
          ownerPeer: peer
        };
      }
    }
    return null;
  }

  async consume(peerId, { transportId, producerId, rtpCapabilities }) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer não encontrado.');

    const transport = peer.transports.get(transportId);
    if (!transport) throw new Error('Transporte de recepção não encontrado.');

    const found = this.findProducerById(producerId);
    if (!found) throw new Error('Transmissão (Producer) não encontrada.');

    const { producer, ownerPeer } = found;

    if (!this.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      throw new Error('Navegador incompatível com os codecs desta transmissão.');
    }

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true, // Sempre inicia pausado e retoma após o cliente montar a track
      appData: {
        peerId: ownerPeer.id,
        displayName: ownerPeer.displayName,
        streamId: producer.appData?.streamId || `stream-${ownerPeer.id}`
      }
    });

    consumer.on('transportclose', () => {
      peer.consumers.delete(consumer.id);
    });

    consumer.on('producerclose', () => {
      peer.consumers.delete(consumer.id);
      this.sendToPeer(peer.id, 'consumerClosed', {
        consumerId: consumer.id,
        producerId: producer.id,
        peerId: ownerPeer.id,
        streamId: producer.appData?.streamId || `stream-${ownerPeer.id}`
      });
    });

    peer.consumers.set(consumer.id, consumer);

    return {
      id: consumer.id,
      producerId: producer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      peerId: ownerPeer.id,
      displayName: ownerPeer.displayName,
      streamId: producer.appData?.streamId || `stream-${ownerPeer.id}`,
      meta: producer.appData?.meta || {}
    };
  }

  async resumeConsumer(peerId, consumerId) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer não encontrado.');

    const consumer = peer.consumers.get(consumerId);
    if (!consumer) throw new Error('Consumer não encontrado.');

    await consumer.resume();
    if (consumer.kind === 'video') {
      try {
        await consumer.requestKeyFrame();
      } catch {}
    }
    return { resumed: true };
  }

  async requestKeyFrame(peerId, consumerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const consumer = peer.consumers.get(consumerId);
    if (consumer && consumer.kind === 'video') {
      try {
        await consumer.requestKeyFrame();
      } catch {}
    }
  }

  sendToPeer(peerId, type, data) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.ws || peer.ws.readyState !== 1) return;
    try {
      peer.ws.send(JSON.stringify({ type, data }));
    } catch {}
  }

  broadcast(type, data, excludePeerId = null) {
    const payload = JSON.stringify({ type, data });
    for (const peer of this.peers.values()) {
      if (excludePeerId && peer.id === excludePeerId) continue;
      if (peer.ws && peer.ws.readyState === 1) {
        try {
          peer.ws.send(payload);
        } catch {}
      }
    }
  }
}

module.exports = new RoomManager();
