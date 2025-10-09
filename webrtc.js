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

// 關閉並清理指定的 PeerConnection
export function cleanupPeer(peerId) {
  const pc = peerConnections[peerId];
  if (pc) {
    try {
      pc.close();
    } catch (err) {
      console.error('關閉 PeerConnection 失敗:', err);
    }
    delete peerConnections[peerId];
  }
  const subscriptions = peerSignalSubscriptions[peerId];
  if (subscriptions) {
    subscriptions.signal?.();
    subscriptions.candidates?.();
    delete peerSignalSubscriptions[peerId];
  }
  if (peerSignalStates[peerId]) {
    delete peerSignalStates[peerId];
  }
  // 清理對應的 DataChannel
  removeDataChannel(peerId);
}

// 套用遠端回應 (Answer) 至本地 PeerConnection
async function applyRemoteAnswer(peerId, answer) {
  const pc = peerConnections[peerId];
  const state = peerSignalStates[peerId];
  if (!pc || !state || !answer?.sdp) {
    return false;
  }
  if (state.lastProcessedAnswerSdp === answer.sdp) {
    return false;
  }
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

// 嘗試將暫存的 Answer 套用至 PeerConnection
async function maybeApplyPendingAnswer(peerId) {
  const state = peerSignalStates[peerId];
  if (!state || !state.pendingAnswer) return;
  try {
    await applyRemoteAnswer(peerId, state.pendingAnswer);
  } catch (err) {
    console.error('信號處理錯誤:', err);
  }
}

// 建立新的 PeerConnection 並視情況發送或接收 Offer
export async function createPeerConnection(peerId, isInitiator, roomId, localUserId) {
  const pc = new RTCPeerConnection(configuration);
  peerConnections[peerId] = pc;
  peerSignalStates[peerId] = {
    lastProcessedOfferSdp: null,
    lastProcessedAnswerSdp: null,
    pendingAnswer: null
  };
  // 確保清除舊的信號監聽
  if (peerSignalSubscriptions[peerId]) {
    peerSignalSubscriptions[peerId].signal?.();
    peerSignalSubscriptions[peerId].candidates?.();
  }
  peerSignalSubscriptions[peerId] = {};

  // 建立或接收 DataChannel
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

  // 處理 ICE 候選訊息
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const candidateRef = ref(db, `rooms/${roomId}/signals/${localUserId}_to_${peerId}/candidates/${Date.now()}`);
      set(candidateRef, {
        candidate: event.candidate,
        timestamp: Date.now()
      }).catch(err => console.error('發送 ICE candidate 失敗:', err));
    }
  };

  // 監控連接狀態變化
  pc.onconnectionstatechange = () => {
    log(`🔗 與 ${peerId} 的連接狀態: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanupPeer(peerId);
    }
  };

  // 監聽遠端信令 (Offer/Answer)
  const signalRef = ref(db, `rooms/${roomId}/signals/${peerId}_to_${localUserId}`);
  peerSignalSubscriptions[peerId].signal = onValue(signalRef, async (snapshot) => {
    const signal = snapshot.val();
    if (!signal) return;
    const offer = signal.offer;
    const answer = signal.answer;
    const state = peerSignalStates[peerId];
    if (!state) return;
    try {
      if (offer?.sdp && state.lastProcessedOfferSdp !== offer.sdp) {
        await pc.setRemoteDescription(offer);
        state.lastProcessedOfferSdp = offer.sdp;
        const answerDesc = await pc.createAnswer();
        await pc.setLocalDescription(answerDesc);
        await set(ref(db, `rooms/${roomId}/signals/${peerId}_to_${localUserId}/answer`), answerDesc);
        log(`📡 已回應 ${peerId} 的連接請求`);
      } else if (answer?.sdp) {
        await applyRemoteAnswer(peerId, answer);
      }
    } catch (err) {
      console.error('信號處理錯誤:', err);
    }
  });

  // 監聽 ICE Candidate 訊息
  const candidatesRef = ref(db, `rooms/${roomId}/signals/${peerId}_to_${localUserId}/candidates`);
  peerSignalSubscriptions[peerId].candidates = onValue(candidatesRef, (snapshot) => {
    const candidates = snapshot.val();
    if (candidates) {
      Object.values(candidates).forEach(async (data) => {
        try {
          if (data.candidate && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          }
        } catch (err) {
          console.error('添加 ICE candidate 失敗:', err);
        }
      });
    }
  });

  // 如果為發起者，創建 Offer 並送出
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

// 中斷所有 Peer 連線並清理資源
export function disconnectAllPeers() {
  for (const peerId in peerConnections) {
    cleanupPeer(peerId);
  }
  peerConnections = {};
  peerSignalStates = {};
  peerSignalSubscriptions = {};
}
