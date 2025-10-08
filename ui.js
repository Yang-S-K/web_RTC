// js/ui.js
// ✅ UI 控制（log、房間資訊、QRCode、成員數）

// ===== 日誌 =====
export function log(msg) {
  console.log(msg);
  const el = document.getElementById("log");
  if (el) {
    el.textContent += "\n" + msg;
    el.scrollTop = el.scrollHeight;
  }
}

// ===== 房間內 UI =====
export function showInRoomUI(roomId) {
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
}

// ===== 離開房間時重置 UI =====
export function resetUI() {
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
}

// ===== 更新成員數 =====
export function updateMemberCount(n) {
  const el = document.getElementById("memberCount");
  if (el) el.textContent = `👥 ${n} 人`;
}

// ===== 更新房間連結與 QRCode =====
export function updateRoomLinkUI(roomUrl) {
  const qrCanvas = document.getElementById("qrcode");
  if (!qrCanvas || typeof QRCode === "undefined") return;

  QRCode.toCanvas(qrCanvas, roomUrl, (err) => {
    if (err) console.error("生成 QRCode 失敗:", err);
  });
}

