// webrtc.js
import { db, ref, set, onValue } from './firebase.js';
import { log } from './ui.js';
import { setupDataChannel, removeDataChannel } from './fileTransfer.js';

const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

export let peerConnections = {};
export let peerSignalStates = {};
export let peerSignalSubscriptions = {};

// 關閉並清理指定 Peer
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
  if (peerSignalStates[peerId]) delete peerSignalStates[peerId];
  removeDataChannel(peerId);
}

// 將遠端 answer 套用到本地
async function applyRemoteAnswer(peerId, answer) {
  const pc = peerConnections[peerId];
  const state = peerSignalStates[peerId];
  if (!pc || !state || !answer?.sdp) return false;

  if (state.lastProcessedAnswerSdp === answer.sdp) return false; // 去重

  // 只有在已經 setLocalDescription(offer) 後才吃 answer
  if (!pc.localDescription || pc.localDescription.type !== 'offer') {
    if (!state.pendingAnswer || state.pendingAnswer.sdp !== answer.sdp) {
      state.pendingAnswer = answer;
    }
    return false;
  }

  await pc.setRemoteDescription(answer);
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

// 建立 PeerConnection（唯一入口）
export async function createPeerConnection(peerId, isInitiator, roomId, localUserId) {
  const pc = new RTCPeerConnection(configuration);
  peerConnections[peerId] = pc;

  // ⚠️ 這段只能放在函式內，否則會出現 peerId 未定義
  peerSignalStates[peerId] = {
    lastProcessedOfferSdp: null,
    lastProcessedAnswerSdp: null,
    pendingAnswer: null,
    processingOffer: false,
    processingAnswer: false,
  };

  // 清掉舊的監聽
  if (peerSignalSubscriptions[peerId]) {
    peerSignalSubscriptions[peerId].signal?.();
    peerSignalSubscriptions[peerId].candidates?.();
  }
  peerSignalSubscriptions[peerId] = {};

  // 建立 / 接收 DataChannel
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

  // 發送 ICE
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const candidateRef = ref(
        db,
        `rooms/${roomId}/signals/${localUserId}_to_${peerId}/candidates/${Date.now()}`
      );
      set(candidateRef, { candidate: event.candidate, timestamp: Date.now() })
        .catch(err => console.error('發送 ICE candidate 失敗:', err));
    }
  };

  // 連線狀態
  pc.onconnectionstatechange = () => {
    log(`🔗 與 ${peerId} 的連接狀態: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
      cleanupPeer(peerId);
    }
  };

  // 監聽對方 -> 我 的信令（offer/answer）
  const signalRef = ref(db, `rooms/${roomId}/signals/${peerId}_to_${localUserId}`);
  peerSignalSubscriptions[peerId].signal = onValue(signalRef, async (snapshot) => {
    const signal = snapshot.val();
    if (!signal) return;

    const offer  = signal.offer;
    const answer = signal.answer;
    const state  = peerSignalStates[peerId];
    if (!state) return;

    // ---- Offer Handling（我方要回 Answer）----
    if (offer?.sdp && state.lastProcessedOfferSdp !== offer.sdp && !state.processingOffer) {
      state.processingOffer = true;
      try {
        const needSetRemote = !pc.currentRemoteDescription || pc.currentRemoteDescription.sdp !== offer.sdp;
        if (needSetRemote) {
          await pc.setRemoteDescription(offer);
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

    // ---- Answer Handling（我方是發起者，要吃 Answer）----
    if (answer?.sdp && !state.processingAnswer) {
      state.processingAnswer = true;
      try { await applyRemoteAnswer(peerId, answer); }
      catch (err) { console.error('處理 answer 失敗:', err); }
      finally { state.processingAnswer = false; }
    }
  });

  // 監聽對方的 ICE
  const candidatesRef = ref(db, `rooms/${roomId}/signals/${peerId}_to_${localUserId}/candidates`);
  peerSignalSubscriptions[peerId].candidates = onValue(candidatesRef, (snapshot) => {
    const candidates = snapshot.val();
    if (!candidates) return;
    Object.values(candidates).forEach(async (data) => {
      try {
        if (data.candidate && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
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
