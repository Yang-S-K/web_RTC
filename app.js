import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, remove } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
  databaseURL: "https://web-rtc-1f615-default-rtdb.asia-southeast1.firebasedatabase.app"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

let pc;
let currentRoomId = null;

const log = (msg) => document.getElementById("log").textContent += msg + "\n";

// ===== UI 控制 =====
function showInRoomUI(roomId) {
  document.getElementById("createSection").style.display = "none";
  document.getElementById("joinSection").style.display = "none";
  document.getElementById("leaveSection").style.display = "block";
  document.getElementById("roomIdDisplay").textContent = "房號: " + roomId;
}
function resetUI() {
  document.getElementById("createSection").style.display = "block";
  document.getElementById("joinSection").style.display = "block";
  document.getElementById("leaveSection").style.display = "none";
  document.getElementById("roomIdDisplay").textContent = "";
  document.getElementById("qrcode").innerHTML = "";
}

// ===== 開房 =====
document.getElementById("createRoomBtn").onclick = async () => {
  currentRoomId = Math.random().toString(36).substring(2, 7);
  showInRoomUI(currentRoomId);

  pc = new RTCPeerConnection();

  // 建立 Offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await set(ref(db, "rooms/" + currentRoomId), { offer });

  // 產生 QR Code
  QRCode.toCanvas(document.getElementById("qrcode"),
    window.location.href + "?room=" + currentRoomId);

  log("建立房間: " + currentRoomId);
};

// ===== 加入房間 =====
document.getElementById("joinRoomBtn").onclick = async () => {
  const roomId = document.getElementById("joinRoomId").value;
  if (!roomId) return alert("請輸入房號");

  const roomRef = ref(db, "rooms/" + roomId);
  const snap = await get(roomRef);
  if (!snap.exists()) return alert("房間不存在");

  pc = new RTCPeerConnection();
  currentRoomId = roomId;

  const offer = snap.val().offer;
  await pc.setRemoteDescription(offer);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await set(ref(db, "rooms/" + roomId + "/answer"), answer);

  showInRoomUI(roomId);
  log("加入房間: " + roomId);
};

// ===== 離開房間 =====
document.getElementById("leaveRoomBtn").onclick = async () => {
  if (pc) {
    pc.close();
    pc = null;
  }

  if (currentRoomId) {
    // ⚠️ 開房的人可以選擇刪掉房間資料
    await remove(ref(db, "rooms/" + currentRoomId));
    log("已離開房間: " + currentRoomId);
    currentRoomId = null;
  }

  resetUI();
};
