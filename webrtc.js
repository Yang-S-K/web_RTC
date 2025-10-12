// webrtc.js
import { db, ref, set, onValue } from './firebase.js';
import { log } from './ui.js';
import { setupDataChannel, removeDataChannel } from './fileTransfer.js';

const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:global.turn.xirsys.net:3478?transport=udp',
        'turn:global.turn.xirsys.net:3478?transport=tcp',
        'turns:global.turn.xirsys.net:5349?transport=tcp'
      ],
      username: 'P51tjcByQ-Dj5C6V_qqVwxNnVUDcxIoyMGt0RRac90JmlNUeTrVMw1nJUsYejeL7AAAAAGjqisR5c2tqYW54dmk=', 
      credential: '5acd5a72-a6c2-11f0-97a4-0242ac120004' 
    }
  ],
  iceTransportPolicy: 'relay'
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

// ICE Restart：卡住太久或 failed 時，由 initiator 端重新送 offer
async function maybeIceRestart(peerId, roomId, localUserId) {
  const pc = peerConnections[peerId];
  const st = peerSignalStates[peerId];
  if (!pc || !st) return;

  if (st.restarting) return;
  st.restarting = true;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    await set(ref(db, `rooms/${roomId}/signals/${localUserId}_to_${peerId}`), { offer });
    log(`🔁 重新啟動 ICE 並送出 offer 給 ${peerId}`);
  } catch (e) {
    console.error('ICE Restart 失敗:', e);
  } finally {
    setTimeout(() => { st.restarting = false; }, 5000);
  }
}

// 供其他模組查詢
export function isPeerConnected(peerId) {
  const pc = peerConnections[peerId];
  if (!pc) return false;
  return pc.connectionState === 'connected'
      || pc.iceConnectionState === 'connected'
      || pc.iceConnectionState === 'completed';
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

export async function createPeerConnection(peerId, isInitiator, roomId, localUserId) {
  // 1) 建立連線物件
  const pc = new RTCPeerConnection(configuration);
  peerConnections[peerId] = pc;

  // 2) 狀態容器（每個 peer 一份）
  const st = peerSignalStates[peerId] = {
    lastProcessedOfferSdp: null,
    lastProcessedAnswerSdp: null,
    pendingAnswer: null,
    processingOffer: false,
    processingAnswer: false,
    pendingRemoteCandidates: [],
    processedCandidateKeys: new Set(),
    restarting: false,
    checkingTimer: null,
  };

  // 3) 偵錯/狀態變化
  pc.addEventListener('icegatheringstatechange', () => {
    console.log(`[GATHER ${peerId}]`, pc.iceGatheringState);
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    console.log(`[ICE ${peerId}]`, pc.iceConnectionState);
  });
  pc.addEventListener('connectionstatechange', () => {
    console.log(`[CONN ${peerId}]`, pc.connectionState);
    log(`🔗 與 ${peerId} 的連接狀態: ${pc.connectionState}`);
    if (pc.connectionState === 'connected' && st.checkingTimer) {
      clearTimeout(st.checkingTimer);
      st.checkingTimer = null;
    }
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      cleanupPeer?.(peerId);
    }
  });

  // 4) DataChannel：發起方建立；回應方監聽
  if (isInitiator) {
    const channel = pc.createDataChannel('fileTransfer');
    setupDataChannel(channel, peerId);
    log(`📡 創建 DataChannel 給 ${peerId}`);
  } else {
    pc.ondatachannel = (evt) => {
      setupDataChannel(evt.channel, peerId);
      log(`📡 接收 DataChannel 從 ${peerId}`);
    };
  }

  // 5) 本地 ICE 候選 → 寫到「我到對方」的節點
  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    const key = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const candRef = ref(db, `rooms/${roomId}/signals/${localUserId}_to_${peerId}/candidates/${key}`);
    const candStr = event.candidate.candidate || '';
    const typ = /typ\s(\w+)/.exec(candStr)?.[1];
    console.log(`[CAND-LOCAL ${peerId}]`, typ, candStr);
    set(candRef, { candidate: event.candidate, ts: Date.now() })
      .catch(err => console.error('發送 ICE candidate 失敗:', err));
  };

  // 6) 對方 ICE 候選（「對方到我」）→ 加到本地
  const remoteCandRef = ref(db, `rooms/${roomId}/signals/${peerId}_to_${localUserId}/candidates`);
  peerSignalSubscriptions[peerId]?.candidates?.(); // 取消舊監聽
  peerSignalSubscriptions[peerId] = peerSignalSubscriptions[peerId] || {};
  peerSignalSubscriptions[peerId].candidates = onValue(remoteCandRef, (snap) => {
    const data = snap.val();
    if (!data) return;

    Object.entries(data).forEach(async ([key, val]) => {
      if (!val?.candidate || st.processedCandidateKeys.has(key)) return;
      st.processedCandidateKeys.add(key);

      const cand = new RTCIceCandidate(val.candidate);
      try {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(cand);
        } else {
          st.pendingRemoteCandidates.push(cand); // 等待 SDP 完成再 flush
        }
      } catch (e) {
        console.error('添加 ICE candidate 失敗:', e);
      }
    });
  });

  // 7) 信令監聽路徑（關鍵修正）
  // 發起方要監聽「我_to_對方」(A_to_B)；回應方監聽「對方_to_我」(B_to_A)
  const initiatorPath = `${localUserId}_to_${peerId}`;
  const responderPath = `${peerId}_to_${localUserId}`;
  const path = isInitiator ? initiatorPath : responderPath;

  const signalRef = ref(db, `rooms/${roomId}/signals/${path}`);
  peerSignalSubscriptions[peerId].signal?.(); // 取消舊監聽
  peerSignalSubscriptions[peerId].signal = onValue(signalRef, async (snapshot) => {
    const signal = snapshot.val();
    if (!signal) return;

    const offer = signal.offer;
    const answer = signal.answer;

    // 我是回應方：收到 offer → 設遠端 → 回寫 answer（寫回同一路徑 /answer）
    if (!isInitiator && offer?.sdp && st.lastProcessedOfferSdp !== offer.sdp && !st.processingOffer) {
      st.processingOffer = true;
      try {
        await pc.setRemoteDescription(offer);
        flushPendingCandidates(peerId);

        if (pc.signalingState === 'have-remote-offer') {
          const answerDesc = await pc.createAnswer();
          await pc.setLocalDescription(answerDesc);
          await set(ref(db, `rooms/${roomId}/signals/${path}/answer`), answerDesc);
          log(`📡 已回應 ${peerId} 的連接請求`);
        }

        st.lastProcessedOfferSdp = offer.sdp;
      } catch (err) {
        console.error('處理 offer 失敗:', err, 'state=', pc.signalingState);
      } finally {
        st.processingOffer = false;
      }
    }

    // 我是發起方：在同一路徑上等待對方把 answer 寫回來
    if (isInitiator && answer?.sdp && !st.processingAnswer) {
      st.processingAnswer = true;
      try {
        await applyRemoteAnswer(peerId, answer);
      } catch (err) {
        console.error('處理 answer 失敗:', err);
      } finally {
        st.processingAnswer = false;
      }
    }
  });

  // 8) 發起方送 offer（寫到 initiatorPath）
  if (isInitiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await set(ref(db, `rooms/${roomId}/signals/${initiatorPath}`), { offer });
      log(`📡 已發送連接請求給 ${peerId}`);

      // 若一直卡在 checking，8 秒後嘗試 ICE restart（有這個輔助函式就會觸發）
      st.checkingTimer = setTimeout(() => {
        if (!isPeerConnected?.(peerId)) {
          maybeIceRestart?.(peerId, roomId, localUserId);
        }
      }, 8000);
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
