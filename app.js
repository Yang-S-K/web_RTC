import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, remove } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

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

const log = (msg) => document.getElementById("log").textContent += msg + "\n";

// ===== UI 控制 =====
function showInRoomUI(roomId) {
  document.getElementById("createSection").style.display = "none";
  document.getElementById("joinSection").style.display = "none";
  document.getElementById("leaveSection").style.display = "block";

  document.getElementById("roomIdDisplay").textContent = "房號: " + roomId;
  document.getElementById("qrcode").style.display = "block"; 
}

function resetUI() {
  document.getElementById("createSection").style.display = "block";
  document.getElementById("joinSection").style.display = "block";
  document.getElementById("leaveSection").style.display = "none";

  document.getElementById("roomIdDisplay").textContent = "";
  document.getElementById("qrcode").innerHTML = "";
  document.getElementById("qrcode").style.display = "none";
}

// ===== 開房 =====
document.getElementById("createRoomBtn").onclick = async () => {
  currentRoomId = Math.random().toString(36).substring(2, 7);
  showInRoomUI(currentRoomId);

  pc = new RTCPeerConnection();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await set(ref(db, "rooms/" + currentRoomId), { offer });

  // ✅ 檢查 currentRoomId 是否存在
  if (currentRoomId) {
    QRCode.toCanvas(
      document.getElementById("qrcode"),
      `${window.location.origin}${window.location.pathname}?room=${currentRoomId}`
    );
  } else {
    log("❌ 房號生成失敗，無法產生 QR Code");
  }

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
    await remove(ref(db, "rooms/" + currentRoomId));
    log("已離開房間: " + currentRoomId);
    currentRoomId = null;
  }

  resetUI();
};
