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

const log = (msg) => {
  document.getElementById("log").textContent += msg + "\n";
  console.log(msg);
};

// ===== UI 控制 =====
function showInRoomUI(roomId, showQR) {
  document.getElementById("createSection").style.display = "none";
  document.getElementById("joinSection").style.display = "none";
  document.getElementById("leaveSection").style.display = "block";

  document.getElementById("roomIdDisplay").textContent = "房號: " + roomId;
  document.getElementById("qrcode").style.display = showQR ? "block" : "none";
}

function resetUI() {
  document.getElementById("createSection").style.display = "block";
  document.getElementById("joinSection").style.display = "block";
  document.getElementById("leaveSection").style.display = "none";

  document.getElementById("roomIdDisplay").textContent = "";
  document.getElementById("qrcode").style.display = "none";
  document.getElementById("qrcode").getContext("2d").clearRect(0,0,200,200);
}

// ===== 開房 =====
document.getElementById("createRoomBtn").onclick = async () => {
  currentRoomId = Math.random().toString(36).substring(2, 7);
  showInRoomUI(currentRoomId, true);

  pc = new RTCPeerConnection();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await set(ref(db, "rooms/" + currentRoomId), { offer });

  const url = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}`;
  QRCode.toCanvas(
    document.getElementById("qrcode"),
    url,
    (err) => {
      // if (err) console.error("❌ QR Code 生成失敗:", err);
      // else log("✅ QR Code 已生成: " + url);
    }
  );

  // log("建立房間: " + currentRoomId);
};

// ===== 加入房間 =====
async function joinRoom(roomId) {
  const roomRef = ref(db, "rooms/" + roomId);
  const snap = await get(roomRef);
  if (!snap.exists()) {
    alert("房間不存在");
    return;
  }

  pc = new RTCPeerConnection();
  currentRoomId = roomId;

  const offer = snap.val().offer;
  await pc.setRemoteDescription(offer);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await set(ref(db, "rooms/" + roomId + "/answer"), answer);

  showInRoomUI(roomId, false);
  log("加入房間: " + roomId);
}

document.getElementById("joinRoomBtn").onclick = async () => {
  const roomId = document.getElementById("joinRoomId").value.trim();
  if (!roomId) return alert("請輸入房號");
  joinRoom(roomId);
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

// ===== 自動加入 (URL帶room參數) =====
window.addEventListener("load", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get("room");
  if (roomParam) {
    joinRoom(roomParam);
  }
});
