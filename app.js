import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, remove, onValue, update } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

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

let pc;
let currentRoomId = null;
let currentUserId = Math.random().toString(36).substring(2, 10);
let peerConnections = {};
let membersListener = null;
let hostListener = null;

const log = (msg) => {
  const logEl = document.getElementById("log");
  logEl.textContent = msg;
  console.log(msg);
};

// ===== UI 控制 =====
function showInRoomUI(roomId, showQR) {
  document.getElementById("createSection").style.display = "none";
  document.getElementById("joinSection").style.display = "none";
  document.getElementById("leaveSection").style.display = "block";
  document.getElementById("roomIdDisplay").textContent = "房號: " + roomId;
  
  // 根據參數決定是否顯示 QR Code
  const canvas = document.getElementById("qrcode");
  canvas.style.display = showQR ? "block" : "none";
}

function setShareButton(url) {
  const shareBtn = document.getElementById("shareBtn");
  if (url) {
    shareBtn.style.display = "inline-block";
    shareBtn.onclick = () => shareRoom(url);
  } else {
    shareBtn.style.display = "none";
    shareBtn.onclick = null;
  }
}

function updateRoomLinkUI(url, showQRCode) {
  const canvas = document.getElementById("qrcode");
  if (!canvas) {
    setShareButton(url);
    return;
  }

  if (showQRCode && url) {
    if (window.QRCode && typeof QRCode.toCanvas === "function") {
      canvas.style.display = "block";
      QRCode.toCanvas(canvas, url, (err) => {
        if (err) log("❌ QR Code 生成失敗");
      });
    } else {
      canvas.style.display = "none";
      log("⚠️ QR Code 套件尚未載入，無法生成 QR Code");
    }
  } else {
    canvas.style.display = "none";
    const context = canvas.getContext("2d");
    if (context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  setShareButton(url);
}

function resetUI() {
  document.getElementById("createSection").style.display = "block";
  document.getElementById("joinSection").style.display = "block";
  document.getElementById("leaveSection").style.display = "none";
  document.getElementById("roomIdDisplay").textContent = "";
  
  const canvas = document.getElementById("qrcode");
  canvas.style.display = "none";
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
  
  updateRoomLinkUI(null, false);
}

// ===== 開房 (修正版) =====
document.getElementById("createRoomBtn").onclick = async () => {
  currentRoomId = Math.random().toString(36).substring(2, 7);
  
  // 新的資料結構：包含 members 和 hostId
  const roomData = {
    createdAt: Date.now(),
    hostId: currentUserId,
    members: {
      [currentUserId]: {
        joinedAt: Date.now(),
        isHost: true
      }
    }
  };

  await set(ref(db, "rooms/" + currentRoomId), roomData);

  // 監聽房間成員變化
  let lastMemberCount = 1;
  membersListener = onValue(ref(db, "rooms/" + currentRoomId + "/members"), (snapshot) => {
    const members = snapshot.val();
    if (members) {
      const memberCount = Object.keys(members).length;
      if (memberCount !== lastMemberCount) {
        log(`👥 當前人數: ${memberCount} (${memberCount <= 5 ? 'Mesh模式' : 'SFU模式'})`);
        lastMemberCount = memberCount;
      }
    }
  });

  const url = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}`;
  
  // 更新 UI (只呼叫一次)
  showInRoomUI(currentRoomId, true);
  
  // 生成 QR Code 和設置分享按鈕
  updateRoomLinkUI(url, true);

  log("🎯 你是 Host");
  log("✅ 建立房間: " + currentRoomId);
};

// ===== 分享房間 =====
async function shareRoom(url) {
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
}

// ===== 加入房間 (修正版) =====
async function joinRoom(roomId) {
  const roomRef = ref(db, "rooms/" + roomId);
  const snap = await get(roomRef);
  
  if (!snap.exists()) {
    alert("房間不存在");
    return;
  }

  currentRoomId = roomId;

  // 加入成員列表
  await set(ref(db, "rooms/" + roomId + "/members/" + currentUserId), {
    joinedAt: Date.now(),
    isHost: false
  });

  // 監聽房間成員變化
  let lastMemberCount = 0;
  membersListener = onValue(ref(db, "rooms/" + currentRoomId + "/members"), (snapshot) => {
    const members = snapshot.val();
    if (members) {
      const memberCount = Object.keys(members).length;
      if (memberCount !== lastMemberCount) {
        log(`👥 當前人數: ${memberCount} (${memberCount <= 5 ? 'Mesh模式' : 'SFU模式'})`);
        lastMemberCount = memberCount;
      }
    }
  });

  // 監聽 Host 變化（用於 Host 交接）
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
  
  // 更新 UI (只呼叫一次)
  showInRoomUI(roomId, true);
  
  // 生成 QR Code 和設置分享按鈕
  updateRoomLinkUI(url, true);
  
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

  // 移除監聽器
  if (membersListener) membersListener();
  if (hostListener) hostListener();
  membersListener = null;
  hostListener = null;

  // 關閉所有 PeerConnection
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};

  const roomRef = ref(db, "rooms/" + currentRoomId);
  const snap = await get(roomRef);
  
  if (snap.exists()) {
    const roomData = snap.val();
    const members = roomData.members || {};
    
    // 移除自己
    await remove(ref(db, "rooms/" + currentRoomId + "/members/" + currentUserId));

    // 如果是 Host 且房間還有其他人，交接 Host
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
