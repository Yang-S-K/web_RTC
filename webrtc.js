// webrtc.js
import { db, ref, set, onValue } from './firebase.js';
import { log } from './ui.js';
import { setupDataChannel, removeDataChannel } from './fileTransfer.js';

const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

export let peerConnections = {};
export let peerSignalStates = {};
export let peerSignalSubscriptions = {};

// ------------ 工具 ------------
function flushPendingCandidates(peerId) {
  const pc = peerConnections[peerId];
  const st = peerSignalStates[peerId];
  if (!pc || !st) return;
  const list = st.pendingRemoteCandidates || [];
  st.pendingRemoteCandidates = [];
  list.forEach(async (cand) => {
    try { await pc.addIceCandidate(cand); }
    catch (e) { console.error('flush candidate 失敗:', e); }
  });
}

async function applyRemoteAnswer(peerId, answer) {
  const pc = peerConnections[peerId];
  const state = peerSignalStates[peerId];
  if (!pc || !state || !answer?.sdp) return false;

  // 去重
  if (state.lastProcessedAnswerSdp === answer.sdp) return false;

  // 必須先送出本地 offer 才能吃 answer
  if (!pc.localDescription || pc.localDescription.type !== 'offer') {
    if (!state.pendingAnswer || state.pendingAnswer.sdp !== answer.sdp) {
      state.pendingAnswer = answer; // 等本地 offer 完成後再吃
    }
    return false;
  }

  await pc.setRemoteDescription(answer);
  flushPendingCandidates(peerId);
  state.lastProcessedAnswerSdp = answer.sdp;
  state.pendingAnswer = null;
  log(`✅ 已接收 ${peerId} 的回應`);
  return true;
}

async function maybeApplyPendingAnswer(peerId) {
  const st = peerSignalStates[peerId];
  if (!st || !st.pendingAnswer) return;
  try { await applyRemoteAnswer(peerId, st.pendingAnswer); }
  catch (err) { console.error('信號處理錯誤:', err); }
}

// ------------ 清理 ------------
export function cleanupPeer(peerId) {
  const pc = peerConnections[peerId];
  if (pc) {
    try { pc.close(); } catch (e) { console.error('關閉 PeerConnection 失敗:', e); }
    delete peerConnections[peerId];
  }
  const subs = peerSignalSubscriptions[peerId];
  if (subs) {
    subs.signal?.();
    subs.candidates?.();
    delete peerSignalSubscriptions[peerId];
  }
  delete peerSignalStates[peerId];
  removeDataChannel(peerId);
}

// ------------ 主要：建立連線 ------------
export async function createPeerConnection(peerId, isInitiator, roomId, localUserId) {
  const pc = new RTCPeerConnection(configuration);
  peerConnections[peerId] = pc;

  // 連線狀態 log（除錯用）
  pc.oniceconnectionstatechange = () => {
    console.log(`[ICE] ${peerId}:`, pc.iceConnectionState);
  };
  pc.onconnectionstatechange = () => {
    console.log(`[CONN] ${peerId}:`, pc.connectionState);
    log(`🔗 與 ${peerId} 的連接狀態: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
      cleanupPeer(peerId);
    }
  };

  // 每個 peer 的信令狀態
  peerSignalStates[peerId] = {
    lastProcessedOfferSdp: null,
    lastProcessedAnswerSdp: null,
    pendingAnswer: null,
    processingOffer: false,
    processingAnswer: false,
    pendingRemoteCandidates: [],       // SDP 未就緒時先排隊
    processedCandidateKeys: new Set(), // 避免重覆 add
  };

  // 清掉舊的監聽
  if (peerSignalSubscriptions[peerId]) {
    peerSignalSubscriptions[peerId].signal?.();
    peerSignalSubscriptions[peerId].candidates?.();
  }
  peerSignalSubscriptions[peerId] = {};

  // DataChannel
  if (isInitiator) {
    const channel = pc.createDataChannel("fileTransfer");
    setupDataChannel(channel, peerId);
    log(`📡 創建 DataChannel 給 ${peerId}`);
  } else {
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      setupDataChannel(channel, peerId);
      log(`📡 接收 DataChannel 從 ${peerId}`);
    };
  }

  // 我方 ICE -> 寫到 Firebase
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const key = `${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const candidateRef = ref(db, `rooms/${roomId}/signals/${localUserId}_to_${peerId}/candidates/${key}`);
      set(candidateRef, { candidate: event.candidate, ts: Date.now() })
        .catch(err => console.error('發送 ICE candidate 失敗:', err));
    }
  };

  // 對方 -> 我 的信令 (offer/answer)
  const signalRef = ref(db, `rooms/${roomId}/signals/${peerId}_to_${localUserId}`);
  peerSignalSubscriptions[peerId].signal = onValue(signalRef, async (snapshot) => {
    const signal = snapshot.val();
    if (!signal) return;

    const offer  = signal.offer;
    const answer = signal.answer;
    const state  = peerSignalStates[peerId];
    if (!state) return;

    // ---- Offer（我方要回 Answer）----
    if (offer?.sdp && state.lastProcessedOfferSdp !== offer.sdp && !state.processingOffer) {
      state.processingOffer = true;
      try {
        const needSetRemote = !pc.currentRemoteDescription || pc.currentRemoteDescription.sdp !== offer.sdp;
        if (needSetRemote) {
          await pc.setRemoteDescription(offer);
          flushPendingCandidates(peerId);
        }

        if (pc.signalingState === 'have-remote-offer') {
          const answerDesc = await pc.createAnswer();
          await pc.setLocalDescription(answerDesc);
          await set(ref(db, `rooms/${roomId}/signals/${peerId}_to_${localUserId}/answer`), answerDesc);
          log(`📡 已回應 ${peerId} 的連接請求`);
        }

        state.lastProcessedOfferSdp = offer.sdp; // 去重標記
      } catch (err) {
        console.error('處理 offer 失敗:', err, 'signalingState=', pc.signalingState);
      } finally {
        state.processingOffer = false;
      }
    }

    // ---- Answer（我方是發起者，要吃 Answer）----
    if (answer?.sdp && !state.processingAnswer) {
      state.processingAnswer = true;
      try { await applyRemoteAnswer(peerId, answer); }
      catch (err) { console.error('處理 answer 失敗:', err); }
      finally { state.processingAnswer = false; }
    }
  });

  // 對方 ICE -> 我
  const candidatesRef = ref(db, `rooms/${roomId}/signals/${peerId}_to_${localUserId}/candidates`);
  peerSignalSubscriptions[peerId].candidates = onValue(candidatesRef, (snapshot) => {
    const pcNow = peerConnections[peerId];
    const st = peerSignalStates[peerId];
    if (!pcNow || !st) return;

    const data = snapshot.val();
    if (!data) return;

    Object.entries(data).forEach(async ([key, val]) => {
      if (!val?.candidate) return;
      if (st.processedCandidateKeys.has(key)) return; // 去重
      st.processedCandidateKeys.add(key);

      const cand = new RTCIceCandidate(val.candidate);
      try {
        if (pcNow.remoteDescription) {
          await pcNow.addIceCandidate(cand);
        } else {
          st.pendingRemoteCandidates.push(cand); // 先排隊，等 SDP
        }
      } catch (err) {
        console.error('添加 ICE candidate 失敗:', err);
      }
    });
  });

  // 我是發起者：送出 Offer
  if (isInitiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await set(ref(db, `rooms/${roomId}/signals/${localUserId}_to_${peerId}`), { offer });
      await maybeApplyPendingAnswer(peerId);
      log(`📡 已發送連接請求給 ${peerId}`);
    } catch (err) {
      console.error('創建 offer 失敗:', err);
    }
  }

  return pc;
}

// 斷所有 Peer
export function disconnectAllPeers() {
  for (const id in peerConnections) cleanupPeer(id);
  peerConnections = {};
  peerSignalStates = {};
  peerSignalSubscriptions = {};
}
