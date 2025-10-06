import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, remove, onValue, update, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyAg9yuhB3c5s4JqQ_sW7iTVAr3faI3pdd8",
  authDomain: "web-rtc-1f615.firebaseapp.com",
  databaseURL: "https://web-rtc-1f615-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "web-rtc-1f615",
  storageBucket: "web-rtc-1f615.appspot.com",
  messagingSenderId: "369978320587",
  appId: "1:369978320587:web:8f1bf80a69c19e21051f4e"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const storage = getStorage(app);

let pc;
let currentRoomId = null;
let currentUserId = Math.random().toString(36).substring(2, 10);
let currentUserName = "使用者" + currentUserId.substring(0, 4);
let peerConnections = {};
let membersListener = null;
let hostListener = null;
let currentMembers = {};
let messagesListener = null;

const log = (msg) => {
  const logEl = document.getElementById("log");
  logEl.textContent = msg;
  console.log(msg);
};

// ===== UI 控制 =====
function showInRoomUI(roomId) {
  document.getElementById("createSection").style.display = "none";
  document.getElementById("joinSection").style.display = "none";
  document.getElementById("roomInfo").classList.remove("hidden");
  document.getElementById("mainContent").classList.remove("hidden");
  document.getElementById("roomIdDisplay").textContent = "房號: " + roomId;
  document.getElementById("qrSection").style.display = "flex";
}

function updateMemberCount(count) {
  const memberCountEl = document.getElementById("memberCount");
  memberCountEl.textContent = `👥 ${count} 人`;
}

function updateRoomLinkUI(url) {
  const canvas = document.getElementById("qrcode");
  
  if (url && window.QRCode && typeof QRCode.toCanvas === "function") {
    QRCode.toCanvas(canvas, url, (err) => {
      if (err) log("❌ QR Code 生成失敗");
    });
  }
}

function resetUI() {
  document.getElementById("createSection").style.display = "block";
  document.getElementById("joinSection").style.display = "block";
  document.getElementById("roomInfo").classList.add("hidden");
  document.getElementById("mainContent").classList.add("hidden");
  document.getElementById("qrSection").style.display = "none";
  document.getElementById("roomIdDisplay").textContent = "";
  
  const canvas = document.getElementById("qrcode");
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// ===== 處理被踢出房間 =====
function handleKickedOut() {
  if (membersListener) {
    membersListener();
    membersListener = null;
  }
  if (hostListener) {
    hostListener();
    hostListener = null;
  }
  if (messagesListener) {
    messagesListener();
    messagesListener = null;
  }

  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};

  if (screenStream) {
    stopScreenShare();
  }

  const roomId = currentRoomId;
  currentRoomId = null;
  currentMembers = {};
  
  clearChatMessages();
  resetUI();
  
  log("🚫 您已被移出房間: " + roomId);
  alert("您已被移出房間");
}

// ===== 成員列表功能 =====
function showMemberList() {
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
            <button class="action-btn transfer-btn" data-member-id="${memberId}" data-member-name="${name}" title="轉交房主">
              👑
            </button>
            <button class="action-btn kick-btn" data-member-id="${memberId}" data-member-name="${name}" title="踢除成員">
              🚫
            </button>
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
    
    await update(ref(db, `rooms/${currentRoomId}/members/${currentUserId}`), {
      isHost: false
    });
    
    await update(ref(db, `rooms/${currentRoomId}/members/${newHostId}`), {
      isHost: true
    });
    
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
    
    if (peerConnections[memberId]) {
      peerConnections[memberId].close();
      delete peerConnections[memberId];
    }
    
    const memberName = roomData.members[memberId]?.name || "使用者" + memberId.substring(0, 4);
    log(`🚫 已踢除成員: ${memberName}`);
    
    showMemberList();
  } catch (err) {
    log("❌ 踢除成員失敗: " + err.message);
  }
}

function hideMemberList() {
  document.getElementById("memberModal").classList.add("hidden");
}

document.getElementById("memberCount").onclick = () => {
  showMemberList();
};

document.getElementById("closeMemberModal").onclick = () => {
  hideMemberList();
};

document.getElementById("memberModal").onclick = (e) => {
  if (e.target.id === "memberModal") {
    hideMemberList();
  }
};

document.getElementById("updateNameBtn").onclick = async () => {
  const newName = document.getElementById("newNameInput").value.trim();
  
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
    await update(ref(db, "rooms/" + currentRoomId + "/members/" + currentUserId), {
      name: newName
    });
    
    currentUserName = newName;
    document.getElementById("newNameInput").value = "";
    log("✅ 名稱已更新為: " + newName);
    
    showMemberList();
  } catch (err) {
    log("❌ 更新名稱失敗: " + err.message);
  }
};

document.getElementById("newNameInput").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    document.getElementById("updateNameBtn").click();
  }
});

// ===== 開房 =====
document.getElementById("createRoomBtn").onclick = async () => {
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

  let lastMemberCount = 1;
  membersListener = onValue(ref(db, "rooms/" + currentRoomId + "/members"), (snapshot) => {
    const members = snapshot.val();
    if (members) {
      if (!members[currentUserId]) {
        log("🚫 您已被踢出房間");
        handleKickedOut();
        return;
      }
      
      currentMembers = members;
      const memberCount = Object.keys(members).length;
      updateMemberCount(memberCount);
      
      if (memberCount !== lastMemberCount) {
        log(`👥 當前人數: ${memberCount} (${memberCount <= 5 ? 'Mesh模式' : 'SFU模式'})`);
        lastMemberCount = memberCount;
      }
    } else {
      log("🗑️ 房間已被刪除");
      handleKickedOut();
    }
  });

  const url = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}`;
  
  showInRoomUI(currentRoomId);
  updateRoomLinkUI(url);
  
  initChatListener();

  log("🎯 你是 Host");
  log("✅ 建立房間: " + currentRoomId);
};

// ===== 分享房間 =====
document.getElementById("shareBtn").onclick = async () => {
  if (!currentRoomId) return;
  
  const url = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}`;
  
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'WebRTC 房間邀請',
        text: '點擊連結加入房間',
        url: url
      });
      log("✅ 分享成功");
    } catch (err) {
      if (err.name !== 'AbortError') {
        log("❌ 分享失敗");
      }
    }
  } else {
    try {
      await navigator.clipboard.writeText(url);
      log("✅ 連結已複製到剪貼簿");
    } catch (err) {
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      log("✅ 連結已複製");
    }
  }
};

// ===== 加入房間 =====
async function joinRoom(roomId) {
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

  let lastMemberCount = 0;
  membersListener = onValue(ref(db, "rooms/" + currentRoomId + "/members"), (snapshot) => {
    const members = snapshot.val();
    if (members) {
      if (!members[currentUserId]) {
        log("🚫 您已被踢出房間");
        handleKickedOut();
        return;
      }
      
      currentMembers = members;
      const memberCount = Object.keys(members).length;
      updateMemberCount(memberCount);
      
      if (memberCount !== lastMemberCount) {
        log(`👥 當前人數: ${memberCount} (${memberCount <= 5 ? 'Mesh模式' : 'SFU模式'})`);
        lastMemberCount = memberCount;
      }
    } else {
      log("🗑️ 房間已被刪除");
      handleKickedOut();
    }
  });

  let lastHostId = null;
  hostListener = onValue(ref(db, "rooms/" + currentRoomId + "/hostId"), (snapshot) => {
    const hostId = snapshot.val();
    if (hostId && hostId !== lastHostId) {
      if (hostId === currentUserId) {
        log("🎯 你成為新的 Host！");
      }
      lastHostId = hostId;
    }
  });

  const url = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
  
  showInRoomUI(roomId);
  updateRoomLinkUI(url);
  
  initChatListener();
  
  log("✅ 加入房間: " + roomId);
}

document.getElementById("joinRoomBtn").onclick = async () => {
  const roomId = document.getElementById("joinRoomId").value.trim();
  if (!roomId) return alert("請輸入房號");
  joinRoom(roomId);
};

// ===== 離開房間 =====
document.getElementById("leaveRoomBtn").onclick = async () => {
  if (!currentRoomId) return;

  if (membersListener) membersListener();
  if (hostListener) hostListener();
  if (messagesListener) messagesListener();
  membersListener = null;
  hostListener = null;
  messagesListener = null;

  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};

  const roomRef = ref(db, "rooms/" + currentRoomId);
  const snap = await get(roomRef);
  
  if (snap.exists()) {
    const roomData = snap.val();
    const members = roomData.members || {};
    
    await remove(ref(db, "rooms/" + currentRoomId + "/members/" + currentUserId));

    if (roomData.hostId === currentUserId) {
      const remainingMembers = Object.entries(members)
        .filter(([id]) => id !== currentUserId)
        .sort(([, a], [, b]) => a.joinedAt - b.joinedAt);

      if (remainingMembers.length > 0) {
        const newHostId = remainingMembers[0][0];
        await update(ref(db, "rooms/" + currentRoomId), { hostId: newHostId });
        await update(ref(db, "rooms/" + currentRoomId + "/members/" + newHostId), { isHost: true });
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
};

// ===== 自動加入 =====
window.addEventListener("load", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get("room");
  if (roomParam) {
    joinRoom(roomParam);
  }
});

// ===== 聊天功能 =====
function clearChatMessages() {
  const chatMessages = document.getElementById("chatMessages");
  chatMessages.innerHTML = `
    <div class="message received">
      <div class="message-sender">系統</div>
      <div>歡迎來到聊天室！</div>
    </div>
  `;
}

function initChatListener() {
  if (!currentRoomId) return;
  
  clearChatMessages();
  
  const messagesRef = ref(db, "rooms/" + currentRoomId + "/messages");
  messagesListener = onValue(messagesRef, (snapshot) => {
    const messages = snapshot.val();
    
    if (messages) {
      const chatMessages = document.getElementById("chatMessages");
      chatMessages.innerHTML = `
        <div class="message received">
          <div class="message-sender">系統</div>
          <div>歡迎來到聊天室！</div>
        </div>
      `;
      
      const sortedMessages = Object.entries(messages).sort(([, a], [, b]) => a.timestamp - b.timestamp);
      
      sortedMessages.forEach(([messageId, messageData]) => {
        displayMessage(messageData);
      });
    }
  });
}

function displayMessage(messageData) {
  const chatMessages = document.getElementById("chatMessages");
  const messageDiv = document.createElement("div");
  
  const isMe = messageData.userId === currentUserId;
  messageDiv.className = isMe ? "message sent" : "message received";
  
  const senderName = isMe ? "我" : (messageData.userName || "使用者");
  
  if (messageData.type === 'image') {
    messageDiv.innerHTML = `
      <div class="message-sender">${senderName}</div>
      <img src="${messageData.imageUrl}" class="message-image" alt="圖片" onclick="window.open('${messageData.imageUrl}', '_blank')">
    `;
  } else {
    messageDiv.innerHTML = `
      <div class="message-sender">${senderName}</div>
      <div>${escapeHtml(messageData.text)}</div>
    `;
  }
  
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function sendMessage(text) {
  if (!currentRoomId || !text.trim()) return;
  
  const messageData = {
    userId: currentUserId,
    userName: currentUserName,
    text: text.trim(),
    type: 'text',
    timestamp: Date.now()
  };
  
  try {
    const newMessageRef = ref(db, "rooms/" + currentRoomId + "/messages/" + currentUserId + "_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7));
    await set(newMessageRef, messageData);
    log("💬 訊息已發送");
  } catch (err) {
    log("❌ 發送訊息失敗: " + err.message);
  }
}

async function sendImage(file) {
  if (!currentRoomId || !file) return;
  
  if (!file.type.startsWith('image/')) {
    log("❌ 只能傳送圖片檔案");
    return;
  }
  
  if (file.size > 5 * 1024 * 1024) {
    log("❌ 圖片大小不能超過 5MB");
    alert("圖片大小不能超過 5MB");
    return;
  }
  
  try {
    log("📤 正在上傳圖片...");
    
    const fileName = `${currentRoomId}/${currentUserId}_${Date.now()}_${file.name}`;
    const imageRef = storageRef(storage, `chat-images/${fileName}`);
    await uploadBytes(imageRef, file);
    
    const imageUrl = await getDownloadURL(imageRef);
    
    const messageData = {
      userId: currentUserId,
      userName: currentUserName,
      type: 'image',
      imageUrl: imageUrl,
      timestamp: Date.now()
    };
    
    const newMessageRef = ref(db, "rooms/" + currentRoomId + "/messages/" + currentUserId + "_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7));
    await set(newMessageRef, messageData);
    
    log("✅ 圖片已發送");
  } catch (err) {
    log("❌ 上傳圖片失敗: " + err.message);
    alert("上傳圖片失敗，請稍後再試");
  }
}

document.getElementById("sendBtn").onclick = () => {
  const input = document.getElementById("chatInput");
  const message = input.value.trim();
  if (!message) return;
  
  sendMessage(message);
  input.value = "";
};

document.getElementById("imageBtn").onclick = () => {
  document.getElementById("imageInput").click();
};

document.getElementById("imageInput").onchange = (e) => {
  const file = e.target.files[0];
  if (file) {
    sendImage(file);
  }
  e.target.value = "";
};

// ===== 螢幕分享功能 =====
let screenStream = null;

document.getElementById("startScreenBtn").onclick = async () => {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ 
      video: true,
      audio: false 
    });
    
    const video = document.getElementById("screenVideo");
    video.srcObject = screenStream;
    video.style.display = "block";
    
    document.getElementById("videoPlaceholder").style.display = "none";
    document.getElementById("startScreenBtn").classList.add("hidden");
    document.getElementById("stopScreenBtn").classList.remove("hidden");
    
    log("🎬 開始分享螢幕");
    
    screenStream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
    };
  } catch (err) {
    log("❌ 無法分享螢幕: " + err.message);
  }
};

document.getElementById("stopScreenBtn").onclick = () => {
  stopScreenShare();
};

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  
  const video = document.getElementById("screenVideo");
  video.srcObject = null;
  video.style.display = "none";
  
  document.getElementById("videoPlaceholder").style.display = "block";
  document.getElementById("startScreenBtn").classList.remove("hidden");
  document.getElementById("stopScreenBtn").classList.add("hidden");
  
  log("⏹️ 停止分享螢幕");
}

// ===== 遊戲選擇 =====
document.querySelectorAll('.game-card').forEach(card => {
  card.addEventListener('click', () => {
    const game = card.dataset.game;
    const gameName = card.querySelector('.game-title').textContent;
    log(`🎮 選擇遊戲: ${gameName}`);
    alert(`即將開始 ${gameName}！\n(遊戲功能開發中...)`);
  });
});
