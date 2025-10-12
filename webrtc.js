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
  // 1) 一定用這個 configuration（含 Xirsys）
  const pc = new RTCPeerConnection(configuration);
  peerConnections[peerId] = pc;

  // 狀態容器
  const st = peerSignalStates[peerId] = {
    lastProcessedOfferSdp: null,
    lastProcessedAnswerSdp: null,
    pendingRemoteCandidates: [],
    processedCandidateKeys: new Set(),
    gotAnyLocalCandidate: false,
  };

  // Debug：看現在真的塞了哪些伺服器
  try { console.log('[ICE SERVERS IN USE]', pc.getConfiguration().iceServers); } catch {}

  pc.addEventListener('icegatheringstatechange', () => {
    console.log(`[GATHER ${peerId}]`, pc.iceGatheringState);
    if (pc.iceGatheringState === 'complete' && !st.gotAnyLocalCandidate) {
      console.warn('⚠️ 本地沒有取得任何 ICE 候選（含 relay）。Xirsys 可能沒生效、帳密錯、或 configuration 沒被套用。');
    }
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    console.log(`[ICE ${peerId}]`, pc.iceConnectionState);
  });
  pc.addEventListener('connectionstatechange', () => {
    console.log(`[CONN ${peerId}]`, pc.connectionState);
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      cleanupPeer?.(peerId);
    }
  });

  // 發起方建立 DataChannel；回應方監聽
  if (isInitiator) {
    const ch = pc.createDataChannel('fileTransfer');
    setupDataChannel(ch, peerId);
    log(`📡 創建 DataChannel 給 ${peerId}`);
  } else {
    pc.ondatachannel = (e) => {
      setupDataChannel(e.channel, peerId);
      log(`📡 接收 DataChannel 從 ${peerId}`);
    };
  }

  // 本地 ICE → 寫到我_to_對方；同時印出候選型別（要看到 relay）
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    st.gotAnyLocalCandidate = true;
    const candStr = e.candidate.candidate || '';
    const typ = /typ\s(\w+)/.exec(candStr)?.[1];
    console.log(`[CAND-LOCAL ${peerId}]`, typ, candStr);

    const key = `${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    set(
      ref(db, `rooms/${roomId}/signals/${localUserId}_to_${peerId}/candidates/${key}`),
      { candidate: e.candidate, ts: Date.now() }
    ).catch(err => console.error('發送 ICE candidate 失敗:', err));
  };

  // 對方 ICE（對方_to_我）→ 加入本地；若還沒設遠端 SDP 就先暫存
  peerSignalSubscriptions[peerId] = peerSignalSubscriptions[peerId] || {};
  peerSignalSubscriptions[peerId].candidates?.(); // 取消舊監聽
  peerSignalSubscriptions[peerId].candidates = onValue(
    ref(db, `rooms/${roomId}/signals/${peerId}_to_${localUserId}/candidates`),
    async (snap) => {
      const data = snap.val();
      if (!data) return;
      for (const [key, val] of Object.entries(data)) {
        if (!val?.candidate || st.processedCandidateKeys.has(key)) continue;
        st.processedCandidateKeys.add(key);
        const cand = new RTCIceCandidate(val.candidate);
        try {
          if (pc.remoteDescription) await pc.addIceCandidate(cand);
          else st.pendingRemoteCandidates.push(cand);
        } catch (err) {
          console.error('添加 ICE candidate 失敗:', err);
        }
      }
    }
  );

  // 信令路徑：發起方監聽 A_to_B；回應方監聽 B_to_A
  const initiatorPath = `${localUserId}_to_${peerId}`;
  const responderPath = `${peerId}_to_${localUserId}`;
  const path = isInitiator ? initiatorPath : responderPath;

  peerSignalSubscriptions[peerId].signal?.(); // 取消舊監聽
  peerSignalSubscriptions[peerId].signal = onValue(
    ref(db, `rooms/${roomId}/signals/${path}`),
    async (snapshot) => {
      const signal = snapshot.val();
      if (!signal) return;

      const offer  = signal.offer;
      const answer = signal.answer;

      // 回應方：收到 offer → 設遠端 → 產生 answer → 寫回同一路徑的 /answer
      if (!isInitiator && offer?.sdp && st.lastProcessedOfferSdp !== offer.sdp) {
        try {
          await pc.setRemoteDescription(offer);
          // flush 暫存候選
          for (const c of st.pendingRemoteCandidates.splice(0)) {
            await pc.addIceCandidate(c);
          }

          if (pc.signalingState === 'have-remote-offer') {
            const ans = await pc.createAnswer();
            await pc.setLocalDescription(ans);
            await set(ref(db, `rooms/${roomId}/signals/${path}/answer`), ans);
            log(`📡 已回應 ${peerId} 的連接請求`);
          }
          st.lastProcessedOfferSdp = offer.sdp;
        } catch (err) {
          console.error('處理 offer 失敗:', err, 'state=', pc.signalingState);
        }
      }

      // 發起方：等對方把 answer 寫回「同一路徑」
      if (isInitiator && answer?.sdp && st.lastProcessedAnswerSdp !== answer.sdp) {
        try {
          await applyRemoteAnswer(peerId, answer); // 內部請記得 flush 暫存候選；若沒有就仿上面加
          st.lastProcessedAnswerSdp = answer.sdp;
          log(`✅ 已接受 ${peerId} 的回應`);
        } catch (err) {
          console.error('處理 answer 失敗:', err);
        }
      }
    }
  );

  // 發起方：送出 offer（寫到 A_to_B）
  if (isInitiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await set(ref(db, `rooms/${roomId}/signals/${initiatorPath}`), { offer });
      log(`📡 已發送連接請求給 ${peerId}`);
    } catch (err) {
      console.error('創建/送出 offer 失敗:', err);
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
