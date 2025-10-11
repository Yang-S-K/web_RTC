// members.js
import { db, ref, set, get, remove, onValue, update } from './firebase.js';
import { peerConnections, createPeerConnection, cleanupPeer, disconnectAllPeers } from './webrtc.js';
import { showInRoomUI, updateMemberCount, updateRoomLinkUI, getRoomShareUrl, updateBrowserUrl, resetUI, log } from './ui.js';
import { setRoomParamInUrl, rememberLastRoomId, fillJoinInputWithLastRoom } from './ui.js';
import { initChatListener, stopChatListener, clearChatMessages, setCurrentRoom, setCurrentUser } from './chat.js';
import { stopScreenShare } from './screenShare.js';

export const currentUserId = Math.random().toString(36).substring(2, 10);
export let currentUserName = "使用者" + currentUserId.substring(0, 4);
export let currentRoomId = null;
export let currentMembers = {};

let membersListener = null;
let hostListener = null;

// ---- 內部：被踢出處理 ----
function handleKickedOut() {
  if (membersListener) { membersListener(); membersListener = null; }
  if (hostListener) { hostListener(); hostListener = null; }
  stopChatListener();
  disconnectAllPeers();
  stopScreenShare();

  const roomId = currentRoomId;
  currentRoomId = null;
  currentMembers = {};

  clearChatMessages();
  resetUI();
  log("🚫 您已被移出房間: " + roomId);
  alert("您已被移出房間");
}

// ---- 內部：監聽成員變化 / 建立與清理連線 ----
function setupMemberConnections() {
  if (membersListener) membersListener();

  membersListener = onValue(ref(db, "rooms/" + currentRoomId + "/members"), async (snapshot) => {
    const members = snapshot.val();
    if (!members) return;

    // 被移出
    if (!members[currentUserId]) {
      handleKickedOut();
      return;
    }

    currentMembers = members;
    const memberIds = Object.keys(members);
    updateMemberCount(memberIds.length);

    // 與新成員建立 P2P
    for (const memberId of memberIds) {
      if (memberId !== currentUserId && !peerConnections[memberId]) {
        const isInitiator = currentUserId < memberId;
        await createPeerConnection(memberId, isInitiator, currentRoomId, currentUserId);
      }
    }

    // 清理離開的 Peer
    for (const peerId in peerConnections) {
      if (!members[peerId]) {
        cleanupPeer(peerId);
      }
    }
  });
}

// ---- 成員清單 Modal ----
export function showMemberList() {
  const modal = document.getElementById("memberModal");
  const memberList = document.getElementById("memberList");
  memberList.innerHTML = "";

  get(ref(db, "rooms/" + currentRoomId)).then(snapshot => {
    const roomData = snapshot.val();
    const hostId = roomData?.hostId;
    const isCurrentUserHost = hostId === currentUserId;

    const sorted = Object.entries(currentMembers).sort(([idA, a], [idB, b]) => {
      if (idA === hostId) return -1;
      if (idB === hostId) return 1;
      return a.joinedAt - b.joinedAt;
    });

    sorted.forEach(([memberId, memberData]) => {
      const memberItem = document.createElement("div");
      memberItem.className = "member-item";

      const isMe = memberId === currentUserId;
      const isHost = memberId === hostId;
      const name = memberData.name || "使用者" + memberId.substring(0, 4);
      const initial = name.charAt(0).toUpperCase();

      let actionBtns = '';
      if (isCurrentUserHost && !isMe) {
        actionBtns = `
          <div class="member-actions">
            <button class="action-btn transfer-btn" data-member-id="${memberId}" data-member-name="${name}" title="轉交房主">👑</button>
            <button class="action-btn kick-btn" data-member-id="${memberId}" data-member-name="${name}" title="踢除成員">🚫</button>
          </div>`;
      }

      memberItem.innerHTML = `
        <div class="member-info">
          <div class="member-avatar">${initial}</div>
          <span class="member-name">${name}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          ${isHost ? '<span class="member-badge">👑 房主</span>' : ''}
          ${isMe ? '<span class="you-badge">我</span>' : ''}
          ${actionBtns}
        </div>
      `;
      memberList.appendChild(memberItem);
    });

    document.querySelectorAll('.transfer-btn').forEach(btn => {
      btn.onclick = async () => {
        const memberId = btn.dataset.memberId;
        const memberName = btn.dataset.memberName;
        if (confirm(`確定要將房主轉交給 ${memberName} 嗎？`)) {
          await transferHost(memberId);
        }
      };
    });

    document.querySelectorAll('.kick-btn').forEach(btn => {
      btn.onclick = async () => {
        const memberId = btn.dataset.memberId;
        const memberName = btn.dataset.memberName;
        if (confirm(`確定要踢除 ${memberName} 嗎？`)) {
          await kickMember(memberId);
        }
      };
    });
  });

  modal.classList.remove("hidden");
}

export function hideMemberList() {
  document.getElementById("memberModal").classList.add("hidden");
}

// ---- 房主轉移 / 踢人 ----
async function transferHost(newHostId) {
  if (!currentRoomId) return;
  try {
    const roomRef = ref(db, "rooms/" + currentRoomId);
    const snapshot = await get(roomRef);
    if (!snapshot.exists()) { log("❌ 房間不存在"); return; }
    const roomData = snapshot.val();

    if (roomData.hostId !== currentUserId) { log("❌ 只有房主可以轉交房主權限"); return; }
    if (!roomData.members || !roomData.members[newHostId]) { log("❌ 該成員不在房間內"); return; }

    await update(roomRef, { hostId: newHostId });
    await update(ref(db, `rooms/${currentRoomId}/members/${currentUserId}`), { isHost: false });
    await update(ref(db, `rooms/${currentRoomId}/members/${newHostId}`), { isHost: true });

    const newHostName = roomData.members[newHostId].name || "使用者" + newHostId.substring(0, 4);
    log(`👑 已將房主轉交給: ${newHostName}`);
    showMemberList();
  } catch (err) {
    log("❌ 轉交房主失敗: " + err.message);
  }
}

async function kickMember(memberId) {
  if (!currentRoomId) return;
  try {
    const roomRef = ref(db, "rooms/" + currentRoomId);
    const snapshot = await get(roomRef);
    if (!snapshot.exists()) { log("❌ 房間不存在"); return; }

    const roomData = snapshot.val();
    if (roomData.hostId !== currentUserId) { log("❌ 只有房主可以踢除成員"); return; }
    if (memberId === currentUserId) { log("❌ 不能踢除自己"); return; }

    await remove(ref(db, `rooms/${currentRoomId}/members/${memberId}`));
    cleanupPeer(memberId);

    const memberName = roomData.members[memberId]?.name || "使用者" + memberId.substring(0, 4);
    log(`🚫 已踢除成員: ${memberName}`);
    showMemberList();
  } catch (err) {
    log("❌ 踢除成員失敗: " + err.message);
  }
}

// ---- 建立/加入/離開 ----
export async function createRoom() {
  currentRoomId = Math.random().toString(36).substring(2, 7);
  const roomData = {
    createdAt: Date.now(),
    hostId: currentUserId,
    members: {
      [currentUserId]: { joinedAt: Date.now(), isHost: true, name: currentUserName }
    }
  };
  await set(ref(db, "rooms/" + currentRoomId), roomData);
  setupMemberConnections();

  setCurrentUser(currentUserId, currentUserName);
  setCurrentRoom(currentRoomId);
  initChatListener();

  const roomUrl = getRoomShareUrl(currentRoomId);
  updateBrowserUrl(currentRoomId);
  showInRoomUI(currentRoomId);
  updateRoomLinkUI(roomUrl);

  log("🎯 你是 Host");
  log("✅ 建立房間: " + currentRoomId);
  rememberLastRoomId(currentRoomId);
  setRoomParamInUrl(currentRoomId);
}

export async function joinRoom(roomId) {
  const roomRef = ref(db, "rooms/" + roomId);
  const snap = await get(roomRef);
  if (!snap.exists()) { alert("房間不存在"); return; }

  currentRoomId = roomId;
  await set(ref(db, `rooms/${roomId}/members/${currentUserId}`), {
    joinedAt: Date.now(), isHost: false, name: currentUserName
  });

  setupMemberConnections();

  hostListener = onValue(ref(db, "rooms/" + currentRoomId + "/hostId"), (snapshot) => {
    const hostId = snapshot.val();
    if (hostId === currentUserId) log("🎯 你成為新的 Host！");
  });

  setCurrentUser(currentUserId, currentUserName);
  setCurrentRoom(currentRoomId);
  initChatListener();

  const roomUrl = getRoomShareUrl(roomId);
  updateBrowserUrl(roomId);
  showInRoomUI(roomId);
  updateRoomLinkUI(roomUrl);

  log("✅ 加入房間: " + roomId);
  rememberLastRoomId(currentRoomId);
  setRoomParamInUrl(currentRoomId);
}

export async function leaveRoom() {
  if (!currentRoomId) return;
  const lastId = currentRoomId;
  if (membersListener) { membersListener(); membersListener = null; }
  if (hostListener) { hostListener(); hostListener = null; }

  stopChatListener();
  disconnectAllPeers();

  const roomId = currentRoomId;
  const roomRef = ref(db, "rooms/" + roomId);
  const snap = await get(roomRef);

  if (snap.exists()) {
    const roomData = snap.val();
    const members = roomData.members || {};

    await remove(ref(db, `rooms/${roomId}/members/${currentUserId}`));

    if (roomData.hostId === currentUserId) {
      const remaining = Object.entries(members)
        .filter(([id]) => id !== currentUserId)
        .sort(([, a], [, b]) => a.joinedAt - b.joinedAt);

      if (remaining.length > 0) {
        const newHostId = remaining[0][0];
        await update(ref(db, "rooms/" + roomId), { hostId: newHostId });
        await update(ref(db, `rooms/${roomId}/members/${newHostId}`), { isHost: true });
        log("👑 Host 已交接給: " + newHostId);
      } else {
        await remove(roomRef);
        log("🗑️ 房間已刪除（最後一人離開）");
      }
    }
  }

  log("👋 已離開房間: " + currentRoomId);
  setRoomParamInUrl(null);
  rememberLastRoomId(lastId);
  fillJoinInputWithLastRoom();

  clearChatMessages();
  resetUI();
}

// ---- 更新名稱 ----
export async function updateCurrentUserName(newName) {
  if (!newName) { alert("請輸入名稱"); return; }
  if (newName.length > 20) { alert("名稱不能超過 20 個字"); return; }
  if (!currentRoomId) return;

  try {
    await update(ref(db, `rooms/${currentRoomId}/members/${currentUserId}`), { name: newName });
    currentUserName = newName;
    document.getElementById("newNameInput").value = "";
    log("✅ 名稱已更新為: " + newName);
    setCurrentUser(currentUserId, newName);
    showMemberList();
  } catch (err) {
    log("❌ 更新名稱失敗: " + err.message);
  }
}
