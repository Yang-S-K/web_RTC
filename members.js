import { db, ref, set, get, remove, onValue, update } from './firebase.js';
import { peerConnections, createPeerConnection, cleanupPeer, disconnectAllPeers } from './webrtc.js';
import { showInRoomUI, updateMemberCount, updateRoomLinkUI, getRoomShareUrl, updateBrowserUrl, resetUI, log } from './ui.js';
import { initChatListener, stopChatListener, clearChatMessages, setCurrentRoom, setCurrentUser } from './chat.js';
import { stopScreenShare } from './screenShare.js';

export const currentUserId = Math.random().toString(36).substring(2, 10);
export let currentUserName = "使用者" + currentUserId.substring(0, 4);
export let currentRoomId = null;
export let currentMembers = {};
let membersListener = null;
let hostListener = null;

// 被房主踢出房間的處理
function handleKickedOut() {
  if (membersListener) {
    membersListener();
    membersListener = null;
  }
  if (hostListener) {
    hostListener();
    hostListener = null;
  }
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

// 監聽房間成員變化，自動建立或移除連線
function setupMemberConnections() {
  if (membersListener) {
    membersListener();
  }
  membersListener = onValue(ref(db, "rooms/" + currentRoomId + "/members"), async (snapshot) => {
    const members = snapshot.val();
    if (!members) return;
    if (!members[currentUserId]) {
      handleKickedOut();
      return;
    }
    currentMembers = members;
    const memberIds = Object.keys(members);
    updateMemberCount(memberIds.length);
    // 與新出現的成員建立 WebRTC 連線
    for (const memberId of memberIds) {
      if (memberId !== currentUserId && !peerConnections[memberId]) {
        const isInitiator = currentUserId < memberId;
        await createPeerConnection(memberId, isInitiator, currentRoomId, currentUserId);
      }
    }
    // 清理已離開的成員連線
    for (const peerId in peerConnections) {
      if (!members[peerId]) {
        cleanupPeer(peerId);
      }
    }
  });
}

// 顯示成員列表 (房主可轉移房主或踢人)
export function showMemberList() {
  const modal = document.getElementById("memberModal");
  const memberList = document.getElementById("memberList");
  memberList.innerHTML = "";
  get(ref(db, "rooms/" + currentRoomId)).then(snapshot => {
    const roomData = snapshot.val();
    const hostId = roomData?.hostId;
    const isCurrentUserHost = hostId === currentUserId;
    const sortedMembers = Object.entries(currentMembers).sort(([idA, dataA], [idB, dataB]) => {
      if (idA === hostId) return -1;
      if (idB === hostId) return 1;
      return dataA.joinedAt - dataB.joinedAt;
    });
    sortedMembers.forEach(([memberId, memberData]) => {
      const memberItem = document.createElement("div");
      memberItem.className = "member-item";
      const isMe = memberId === currentUserId;
      const isHost = memberId === hostId;
      const name = memberData.name || "使用者" + memberId.substring(0, 4);
      const initial = name.charAt(0).toUpperCase();
      let actionButtons = '';
      if (isCurrentUserHost && !isMe) {
        actionButtons = `
          <div class="member-actions">
            <button class="action-btn transfer-btn" data-member-id="${memberId}" data-member-name="${name}" title="轉交房主">👑</button>
            <button class="action-btn kick-btn" data-member-id="${memberId}" data-member-name="${name}" title="踢除成員">🚫</button>
          </div>
        `;
      }
      memberItem.innerHTML = `
        <div class="member-info">
          <div class="member-avatar">${initial}</div>
          <span class="member-name">${name}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          ${isHost ? '<span class="member-badge">👑 房主</span>' : ''}
          ${isMe ? '<span class="you-badge">我</span>' : ''}
          ${actionButtons}
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

// 轉移房主權限給指定成員
async function transferHost(newHostId) {
  if (!currentRoomId) return;
  try {
    const roomRef = ref(db, "rooms/" + currentRoomId);
    const snapshot = await get(roomRef);
    if (!snapshot.exists()) {
      log("❌ 房間不存在");
      return;
    }
    const roomData = snapshot.val();
    if (roomData.hostId !== currentUserId) {
      log("❌ 只有房主可以轉交房主權限");
      return;
    }
    if (!roomData.members || !roomData.members[newHostId]) {
      log("❌ 該成員不在房間內");
      return;
    }
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

// 將指定成員踢出房間
async function kickMember(memberId) {
  if (!currentRoomId) return;
  try {
    const roomRef = ref(db, "rooms/" + currentRoomId);
    const snapshot = await get(roomRef);
    if (!snapshot.exists()) {
      log("❌ 房間不存在");
      return;
    }
    const roomData = snapshot.val();
    if (roomData.hostId !== currentUserId) {
      log("❌ 只有房主可以踢除成員");
      return;
    }
    if (memberId === currentUserId) {
      log("❌ 不能踢除自己");
      return;
    }
    await remove(ref(db, `rooms/${currentRoomId}/members/${memberId}`));
    cleanupPeer(memberId);
    const memberName = roomData.members[memberId]?.name || "使用者" + memberId.substring(0, 4);
    log(`🚫 已踢除成員: ${memberName}`);
    showMemberList();
  } catch (err) {
    log("❌ 踢除成員失敗: " + err.message);
  }
}

// 關閉成員列表視窗
export function hideMemberList() {
  document.getElementById("memberModal").classList.add("hidden");
}

// 開新房間 (成為房主)
export async function createRoom() {
  currentRoomId = Math.random().toString(36).substring(2, 7);
  const roomData = {
    createdAt: Date.now(),
    hostId: currentUserId,
    members: {
      [currentUserId]: {
        joinedAt: Date.now(),
        isHost: true,
        name: currentUserName
      }
    }
  };
  await set(ref(db, "rooms/" + currentRoomId), roomData);
  setupMemberConnections();
  setCurrentRoom(currentRoomId);
  initChatListener();
  const roomUrl = getRoomShareUrl(currentRoomId);
  updateBrowserUrl(currentRoomId);
  showInRoomUI(currentRoomId);
  updateRoomLinkUI(roomUrl);
  log("🎯 你是 Host");
  log("✅ 建立房間: " + currentRoomId);
}

// 加入現有房間
export async function joinRoom(roomId) {
  const roomRef = ref(db, "rooms/" + roomId);
  const snap = await get(roomRef);
  if (!snap.exists()) {
    alert("房間不存在");
    return;
  }
  currentRoomId = roomId;
  await set(ref(db, "rooms/" + roomId + "/members/" + currentUserId), {
    joinedAt: Date.now(),
    isHost: false,
    name: currentUserName
  });
  setupMemberConnections();
  hostListener = onValue(ref(db, "rooms/" + currentRoomId + "/hostId"), (snapshot) => {
    const hostId = snapshot.val();
    if (hostId === currentUserId) {
      log("🎯 你成為新的 Host！");
    }
  });
  setCurrentRoom(currentRoomId);
  initChatListener();
  const roomUrl = getRoomShareUrl(roomId);
  updateBrowserUrl(roomId);
  showInRoomUI(roomId);
  updateRoomLinkUI(roomUrl);
  log("✅ 加入房間: " + roomId);
}

// 離開當前房間
export async function leaveRoom() {
  if (!currentRoomId) return;
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
    await remove(ref(db, "rooms/" + roomId + "/members/" + currentUserId));
    if (roomData.hostId === currentUserId) {
      const remainingMembers = Object.entries(members)
        .filter(([id]) => id !== currentUserId)
        .sort(([, a], [, b]) => a.joinedAt - b.joinedAt);
      if (remainingMembers.length > 0) {
        const newHostId = remainingMembers[0][0];
        await update(ref(db, "rooms/" + roomId), { hostId: newHostId });
        await update(ref(db, "rooms/" + roomId + "/members/" + newHostId), { isHost: true });
        log("👑 Host 已交接給: " + newHostId);
      } else {
        await remove(roomRef);
        log("🗑️ 房間已刪除（最後一人離開）");
      }
    }
  }
  log("👋 已離開房間: " + currentRoomId);
  currentRoomId = null;
  currentMembers = {};
  clearChatMessages();
  resetUI();
}

// 更新當前使用者暱稱
export async function updateCurrentUserName(newName) {
  if (!newName) {
    alert("請輸入名稱");
    return;
  }
  if (newName.length > 20) {
    alert("名稱不能超過 20 個字");
    return;
  }
  if (!currentRoomId) return;
  try {
    await update(ref(db, "rooms/" + currentRoomId + "/members/" + currentUserId), { name: newName });
    currentUserName = newName;
    document.getElementById("newNameInput").value = "";
    log("✅ 名稱已更新為: " + newName);
    showMemberList();
    setCurrentUser(currentUserId, newName);
  } catch (err) {
    log("❌ 更新名稱失敗: " + err.message);
  }
}

export function getOtherMembers(currentId, members) {
  if (!members || typeof members !== "object") {
    return []; // 傳回空陣列避免報錯
  }
  return Object.keys(members).filter(id => id !== currentId);
}

