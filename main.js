import './firebase.js';
import * as webrtc from './webrtc.js';
import * as chat from './chat.js';
import * as fileTransfer from './fileTransfer.js';
import * as screenShare from './screenShare.js';
import * as members from './members.js';
import './games.js';
import * as ui from './ui.js';

// 初始化聊天模組的使用者資訊
chat.setCurrentUser(members.currentUserId, members.currentUserName);

// 將取消檔案傳輸函式掛載到全域，供按鈕 onclick 呼叫
window.cancelFileTransfer = fileTransfer.cancelFileTransfer;

// 網頁載入時自動加入房間（若 URL 帶有房號參數）
window.addEventListener("load", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get("room");
  if (roomParam) {
    members.joinRoom(roomParam);
  }
});

// 綁定 UI 按鈕事件
document.getElementById("createRoomBtn").onclick = () => {
  members.createRoom();
};

document.getElementById("shareBtn").onclick = () => {
  if (!members.currentRoomId) return;
  const url = ui.getRoomShareUrl(members.currentRoomId);
  ui.shareRoomLink(url);
};

document.getElementById("joinRoomBtn").onclick = () => {
  const roomId = document.getElementById("joinRoomId").value.trim();
  if (!roomId) {
    alert("請輸入房號");
    return;
  }
  members.joinRoom(roomId);
};

document.getElementById("leaveRoomBtn").onclick = () => {
  members.leaveRoom();
};

document.getElementById("memberCount").onclick = () => {
  members.showMemberList();
};

document.getElementById("closeMemberModal").onclick = () => {
  members.hideMemberList();
};

document.getElementById("memberModal").onclick = (e) => {
  if (e.target.id === "memberModal") {
    members.hideMemberList();
  }
};

document.getElementById("updateNameBtn").onclick = () => {
  const newName = document.getElementById("newNameInput").value.trim();
  members.updateCurrentUserName(newName);
};

document.getElementById("newNameInput").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    document.getElementById("updateNameBtn").click();
  }
});

document.getElementById("sendBtn").onclick = () => {
  const input = document.getElementById("chatInput");
  const message = input.value.trim();
  if (!message) return;
  chat.sendMessage(message);
  input.value = "";
};

document.getElementById("startScreenBtn").onclick = () => {
  screenShare.startScreenShare();
};

document.getElementById("stopScreenBtn").onclick = () => {
  screenShare.stopScreenShare();
};

document.querySelector("#fileInput").addEventListener("change", () => {
  showMemberSelectForFile(myId, members);
});
