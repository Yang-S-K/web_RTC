// js/webrtc.js
// 保留你原始行為：WebRTC 連線/訊號交換/DataChannel、成員監聽、開/加/離房、踢人、轉交房主
// 依賴：firebase.js 輸出的 db，以及瀏覽器原生 WebRTC API
// 可選依賴（若存在就會使用）：log, showInRoomUI, updateRoomLinkUI, updateMemberCount, resetUI, clearChatMessages, initChatListener, stopScreenShare

import { db } from "./firebase.js";
import {
  ref, set, get, remove, onValue, update,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { log, showInRoomUI, resetUI, updateMemberCount, updateRoomLinkUI } from "./ui.js";

// ===== 工具：UI hooks（若頁面已有自訂函式就用，否則 fallback） =====
const ui = {
  log: (msg) => {
    if (typeof window.log === "function") return window.log(msg);
    console.log(msg);
    const el = document.getElementById("log");
    if (el) el.textContent = msg;
  },
  showInRoomUI: (roomId) => {
    if (typeof window.showInRoomUI === "function") return window.showInRoomUI(roomId);
    // fallback：盡量模擬原本 UI
    const createSection = document.getElementById("createSection");
    const joinSection = document.getElementById("joinSection");
    const roomInfo = document.getElementById("roomInfo");
    const mainContent = document.getElementById("mainContent");
    const roomIdDisplay = document.getElementById("roomIdDisplay");
    const qrSection = document.getElementById("qrSection");
    if (createSection) createSection.style.display = "none";
    if (joinSection) joinSection.style.display = "none";
    if (roomInfo) roomInfo.classList.remove("hidden");
    if (mainContent) mainContent.classList.remove("hidden");
    if (roomIdDisplay) roomIdDisplay.textContent = "房號: " + roomId;
    if (qrSection) qrSection.style.display = "flex";
  },
  updateMemberCount: (n) => {
    if (typeof window.updateMemberCount === "function") return window.updateMemberCount(n);
    const el = document.getElementById("memberCount");
    if (el) el.textContent = `👥 ${n} 人`;
  },
  updateRoomLinkUI: (url) => {
    if (typeof window.updateRoomLinkUI === "function") return window.updateRoomLinkUI(url);
    // 若沒 QR 產生器，就忽略
  },
  resetUI: () => {
    if (typeof window.resetUI === "function") return window.resetUI();
    // fallback：盡量還原
    const createSection = document.getElementById("createSection");
    const joinSection = document.getElementById("joinSection");
    const roomInfo = document.getElementById("roomInfo");
    const mainContent = document.getElementById("mainContent");
    const qrSection = document.getElementById("qrSection");
    const roomIdDisplay = document.getElementById("roomIdDisplay");
    if (createSection) createSection.style.display = "block";
    if (joinSection) joinSection.style.display = "block";
    if (roomInfo) roomInfo.classList.add("hidden");
    if (mainContent) mainContent.classList.add("hidden");
    if (qrSection) qrSection.style.display = "none";
    if (roomIdDisplay) roomIdDisplay.textContent = "";
  },
  clearChatMessages: () => {
    if (typeof window.clearChatMessages === "function") return window.clearChatMessages();
    const chat = document.getElementById("chatMessages");
    if (chat) {
      chat.innerHTML = `
        <div class="message received">
          <div class="message-sender">系統</div>
          <div>歡迎來到聊天室！</div>
        </div>`;
    }
  },
  initChatListener: () => {
    if (typeof window.initChatListener === "function") return window.initChatListener();
    // 未拆到 chat.js 前允許略過
  },
  stopScreenShare: () => {
    if (typeof window.stopScreenShare === "function") return window.stopScreenShare();
    // 未拆到 screenShare.js 前允許略過
  },
  updateBrowserUrl: (roomId, publicBase = "https://yang-s-k.github.io/web_RTC/") => {
    // 與你原本一致：站內用公開網址，否則用本地 query 參數
    const publicUrl = new URL(publicBase);
    publicUrl.searchParams.set("room", roomId);
    if (window.location.origin === publicUrl.origin) {
      const newPath = publicUrl.pathname + publicUrl.search;
      history.replaceState(null, "", newPath);
    } else {
      history.replaceState(null, "", `${window.location.pathname}?room=${roomId}`);
    }
  },
  getRoomShareUrl: (roomId, publicBase = "https://yang-s-k.github.io/web_RTC/") => {
    const u = new URL(publicBase);
    u.searchParams.set("room", roomId);
    return u.toString();
  },
};

// ===== 專案狀態 =====
export let currentRoomId = null;
export let currentUserId = Math.random().toString(36).substring(2, 10);
export let currentUserName = "使用者" + currentUserId.substring(0, 4);

export let peerConnections = {};
export let dataChannels = {};
export let currentMembers = {};

let membersListener = null;
let hostListener = null;

let screenStream = null; // 先保留欄位，stopScreenShare 會用
let messagesListener = null; // 交給 chat.js 時會搬走
let peerSignalStates = {};
let peerSignalSubscriptions = {};

const PUBLIC_BASE_URL = "https://yang-s-k.github.io/web_RTC/";

// ===== WebRTC 配置 =====
const configuration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ===== 對外 getters / setters（讓其他模組可用）=====
export const getCurrentRoomId = () => currentRoomId;
export const getCurrentUserId = () => currentUserId;
export const getCurrentUserName = () => currentUserName;
export const getCurrentMembers = () => ({ ...currentMembers });
export const getPeerConnections = () => peerConnections;
export const getDataChannels = () => dataChannels;

export function setUserName(newName) {
  currentUserName = newName;
}

// ===== 清理 Peer =====
export function cleanupPeer(peerId) {
  const pc = peerConnections[peerId];
  if (pc) {
    try { pc.close(); } catch {}
    delete peerConnections[peerId];
  }
  if (dataChannels[peerId]) delete dataChannels[peerId];

  const subs = peerSignalSubscriptions[peerId];
  if (subs) {
    if (typeof subs.signal === "function") subs.signal();
    if (typeof subs.candidates === "function") subs.candidates();
    delete peerSignalSubscriptions[peerId];
  }
  if (peerSignalStates[peerId]) delete peerSignalStates[peerId];
}

// ===== 信令：回答處理 =====
async function applyRemoteAnswer(peerId, answer) {
  const pc = peerConnections[peerId];
  const state = peerSignalStates[peerId];
  if (!pc || !state || !answer?.sdp) return false;

  if (state.lastProcessedAnswerSdp === answer.sdp) return false;

  if (!pc.localDescription || pc.localDescription.type !== "offer") {
    if (!state.pendingAnswer || state.pendingAnswer.sdp !== answer.sdp) {
      state.pendingAnswer = answer;
    }
    return false;
  }

  await pc.setRemoteDescription(answer);
  state.lastProcessedAnswerSdp = answer.sdp;
  state.pendingAnswer = null;
  ui.log(`✅ 已接收 ${peerId} 的回應`);
  return true;
}

async function maybeApplyPendingAnswer(peerId) {
  const state = peerSignalStates[peerId];
  if (!state || !state.pendingAnswer) return;
  try {
    await applyRemoteAnswer(peerId, state.pendingAnswer);
  } catch (err) {
    console.error("信號處理錯誤:", err);
  }
}

// ===== DataChannel 設置 =====
function setupDataChannel(channel, peerId) {
  channel.binaryType = "arraybuffer";
  channel.onopen = () => ui.log(`✅ DataChannel 已連接: ${peerId}`);
  channel.onclose = () => ui.log(`❌ DataChannel 已關閉: ${peerId}`);
  channel.onerror = (e) => ui.log(`❌ DataChannel 錯誤: ${e}`);

  channel.onmessage = (event) => {
    // 交給檔案傳輸或其他模組處理
    if (typeof window.handleDataChannelMessage === "function") {
      window.handleDataChannelMessage(event.data, peerId);
    } else {
      // 若尚未拆到 fileTransfer.js，先不處理
      // console.debug("DataChannel message:", event.data);
    }
  };
}

// ===== 建立 PeerConnection =====
export async function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(configuration);
  peerConnections[peerId] = pc;
  peerSignalStates[peerId] = {
    lastProcessedOfferSdp: null,
    lastProcessedAnswerSdp: null,
    pendingAnswer: null,
  };

  if (peerSignalSubscriptions[peerId]) {
    peerSignalSubscriptions[peerId].signal?.();
    peerSignalSubscriptions[peerId].candidates?.();
  }
  peerSignalSubscriptions[peerId] = {};

  // DataChannel
  if (isInitiator) {
    const channel = pc.createDataChannel("fileTransfer");
    setupDataChannel(channel, peerId);
    dataChannels[peerId] = channel;
    ui.log(`📡 創建 DataChannel 給 ${peerId}`);
  } else {
    pc.ondatachannel = (e) => {
      const channel = e.channel;
      setupDataChannel(channel, peerId);
      dataChannels[peerId] = channel;
      ui.log(`📡 接收 DataChannel 從 ${peerId}`);
    };
  }

  // ICE
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const candidateRef = ref(
        db,
        `rooms/${currentRoomId}/signals/${currentUserId}_to_${peerId}/candidates/${Date.now()}`
      );
      set(candidateRef, {
        candidate: event.candidate,
        timestamp: Date.now(),
      }).catch((err) => console.error("發送 ICE candidate 失敗:", err));
    }
  };

  // 狀態
  pc.onconnectionstatechange = () => {
    ui.log(`🔗 與 ${peerId} 的連接狀態: ${pc.connectionState}`);
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      cleanupPeer(peerId);
    }
  };

  // 監聽對方信令
  const signalRef = ref(db, `rooms/${currentRoomId}/signals/${peerId}_to_${currentUserId}`);
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
        await set(ref(db, `rooms/${currentRoomId}/signals/${peerId}_to_${currentUserId}/answer`), answerDesc);
        ui.log(`📡 已回應 ${peerId} 的連接請求`);
      } else if (answer?.sdp) {
        await applyRemoteAnswer(peerId, answer);
      }
    } catch (err) {
      console.error("信號處理錯誤:", err);
    }
  });

  // 監聽對方 ICE candidates
  const candidatesRef = ref(db, `rooms/${currentRoomId}/signals/${peerId}_to_${currentUserId}/candidates`);
  peerSignalSubscriptions[peerId].candidates = onValue(candidatesRef, async (snapshot) => {
    const candidates = snapshot.val();
    if (!candidates) return;
    for (const v of Object.values(candidates)) {
      try {
        if (v.candidate && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(v.candidate));
        }
      } catch (err) {
        console.error("添加 ICE candidate 失敗:", err);
      }
    }
  });

  // 發起者：發 offer
  if (isInitiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await set(ref(db, `rooms/${currentRoomId}/signals/${currentUserId}_to_${peerId}`), { offer });
      await maybeApplyPendingAnswer(peerId);
      ui.log(`📡 已發送連接請求給 ${peerId}`);
    } catch (err) {
      console.error("創建 offer 失敗:", err);
    }
  }

  return pc;
}

// ===== 成員監聽與連線建立 =====
export function setupMemberConnections() {
  if (membersListener) membersListener();

  membersListener = onValue(ref(db, `rooms/${currentRoomId}/members`), async (snapshot) => {
    const members = snapshot.val();
    if (!members) return;

    // 被踢出
    if (!members[currentUserId]) {
      handleKickedOut();
      return;
    }

    currentMembers = members;
    const ids = Object.keys(members);
    ui.updateMemberCount(ids.length);

    // 新人：建立連線
    for (const id of ids) {
      if (id !== currentUserId && !peerConnections[id]) {
        const isInitiator = currentUserId < id;
        await createPeerConnection(id, isInitiator);
      }
    }

    // 離開者：清理
    for (const pid in peerConnections) {
      if (!members[pid]) cleanupPeer(pid);
    }
  });
}

// ===== 被踢出房間 =====
function handleKickedOut() {
  if (membersListener) { membersListener(); membersListener = null; }
  if (hostListener) { hostListener(); hostListener = null; }
  if (messagesListener) { messagesListener(); messagesListener = null; }

  Object.keys(peerConnections).forEach(cleanupPeer);
  peerConnections = {};
  dataChannels = {};
  peerSignalSubscriptions = {};
  peerSignalStates = {};

  if (screenStream) {
    ui.stopScreenShare();
    screenStream = null;
  }

  const roomId = currentRoomId;
  currentRoomId = null;
  currentMembers = {};

  ui.clearChatMessages();
  ui.resetUI();

  ui.log("🚫 您已被移出房間: " + roomId);
  alert("您已被移出房間");
}

// ===== 建房 =====
export async function createRoom() {
  console.log("👉 createRoom 被呼叫了");
  currentRoomId = Math.random().toString(36).substring(2, 7);

  const roomData = {
    createdAt: Date.now(),
    hostId: currentUserId,
    members: {
      [currentUserId]: {
        joinedAt: Date.now(),
        isHost: true,
        name: currentUserName,
      },
    },
  };

  await set(ref(db, `rooms/${currentRoomId}`), roomData);

  setupMemberConnections();

  const roomUrl = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}`;
  console.log("👉 呼叫 updateRoomLinkUI:", roomUrl);
  updateRoomLinkUI(roomUrl);

  ui.showInRoomUI(currentRoomId);
  ui.initChatListener();

  ui.updateBrowserUrl(currentRoomId);

  ui.log("🎯 你是 Host");
  ui.log("✅ 建立房間: " + currentRoomId);

  // 監看 hostId 變化
  hostListener = onValue(ref(db, `rooms/${currentRoomId}/hostId`), (snap) => {
    const hostId = snap.val();
    if (hostId === currentUserId) ui.log("🎯 你成為新的 Host！");
  });

  return currentRoomId;
}

// ===== 加入房間 =====
export async function joinRoom(roomId) {
  const roomRef = ref(db, `rooms/${roomId}`);
  const snap = await get(roomRef);
  if (!snap.exists()) {
    alert("房間不存在");
    return null;
  }

  currentRoomId = roomId;

  await set(ref(db, `rooms/${roomId}/members/${currentUserId}`), {
    joinedAt: Date.now(),
    isHost: false,
    name: currentUserName,
  });

  setupMemberConnections();

  const roomUrl = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}`;
  console.log("👉 呼叫 updateRoomLinkUI:", roomUrl);
  updateRoomLinkUI(roomUrl);

  ui.showInRoomUI(roomId);
  ui.initChatListener();

  ui.updateBrowserUrl(currentRoomId);

  ui.log("✅ 加入房間: " + roomId);

  // 監看 hostId 變化
  hostListener = onValue(ref(db, `rooms/${currentRoomId}/hostId`), (snapshot) => {
    const hostId = snapshot.val();
    if (hostId === currentUserId) ui.log("🎯 你成為新的 Host！");
  });

  return currentRoomId;
}

// ===== 離開房間 =====
export async function leaveRoom() {
  if (!currentRoomId) return;

  if (membersListener) membersListener();
  if (hostListener) hostListener();
  if (messagesListener) messagesListener();
  membersListener = hostListener = messagesListener = null;

  Object.keys(peerConnections).forEach(cleanupPeer);
  peerConnections = {};
  dataChannels = {};
  peerSignalSubscriptions = {};
  peerSignalStates = {};

  const roomRef = ref(db, `rooms/${currentRoomId}`);
  const snap = await get(roomRef);

  if (snap.exists()) {
    const roomData = snap.val();
    const members = roomData.members || {};

    await remove(ref(db, `rooms/${currentRoomId}/members/${currentUserId}`));

    if (roomData.hostId === currentUserId) {
      const remaining = Object.entries(members)
        .filter(([id]) => id !== currentUserId)
        .sort(([, a], [, b]) => a.joinedAt - b.joinedAt);

      if (remaining.length > 0) {
        const newHostId = remaining[0][0];
        await update(ref(db, `rooms/${currentRoomId}`), { hostId: newHostId });
        await update(ref(db, `rooms/${currentRoomId}/members/${newHostId}`), { isHost: true });
        ui.log("👑 Host 已交接給: " + newHostId);
      } else {
        await remove(roomRef);
        ui.log("🗑️ 房間已刪除（最後一人離開）");
      }
    }
  }

  ui.log("👋 已離開房間: " + currentRoomId);
  currentRoomId = null;
  currentMembers = {};
  ui.clearChatMessages();
  ui.resetUI();
}

// ===== 分享房間（供 main.js 綁定按鈕時可用）=====
export async function shareRoomLink() {
  if (!currentRoomId) return;
  const url = ui.getRoomShareUrl(currentRoomId, PUBLIC_BASE_URL);

  if (navigator.share) {
    try {
      await navigator.share({
        title: "WebRTC 房間邀請",
        text: "點擊連結加入房間",
        url,
      });
      ui.log("✅ 分享成功");
    } catch (err) {
      if (err?.name !== "AbortError") ui.log("❌ 分享失敗");
    }
  } else {
    try {
      await navigator.clipboard.writeText(url);
      ui.log("✅ 連結已複製到剪貼簿");
    } catch {
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      ui.log("✅ 連結已複製");
    }
  }
}

// ===== 成員操作：轉交房主 / 踢人 =====
export async function transferHost(newHostId) {
  if (!currentRoomId) return;

  try {
    const roomRef = ref(db, `rooms/${currentRoomId}`);
    const snapshot = await get(roomRef);
    if (!snapshot.exists()) return ui.log("❌ 房間不存在");

    const roomData = snapshot.val();
    if (roomData.hostId !== currentUserId) return ui.log("❌ 只有房主可以轉交房主權限");
    if (!roomData.members || !roomData.members[newHostId]) return ui.log("❌ 該成員不在房間內");

    await update(roomRef, { hostId: newHostId });
    await update(ref(db, `rooms/${currentRoomId}/members/${currentUserId}`), { isHost: false });
    await update(ref(db, `rooms/${currentRoomId}/members/${newHostId}`), { isHost: true });

    const newHostName =
      roomData.members[newHostId].name || "使用者" + newHostId.substring(0, 4);
    ui.log(`👑 已將房主轉交給: ${newHostName}`);
  } catch (err) {
    ui.log("❌ 轉交房主失敗: " + err.message);
  }
}

export async function kickMember(memberId) {
  if (!currentRoomId) return;

  try {
    const roomRef = ref(db, `rooms/${currentRoomId}`);
    const snapshot = await get(roomRef);
    if (!snapshot.exists()) return ui.log("❌ 房間不存在");

    const roomData = snapshot.val();
    if (roomData.hostId !== currentUserId) return ui.log("❌ 只有房主可以踢除成員");
    if (memberId === currentUserId) return ui.log("❌ 不能踢除自己");

    await remove(ref(db, `rooms/${currentRoomId}/members/${memberId}`));
    cleanupPeer(memberId);

    const memberName = roomData.members[memberId]?.name || "使用者" + memberId.substring(0, 4);
    ui.log(`🚫 已踢除成員: ${memberName}`);
  } catch (err) {
    ui.log("❌ 踢除成員失敗: " + err.message);
  }
}
