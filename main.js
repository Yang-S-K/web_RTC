// main.js
import './firebase.js';
import * as webrtc from './webrtc.js';
import * as chat from './chat.js';
import * as fileTransfer from './fileTransfer.js';
import * as screenShare from './screenShare.js';
import * as members from './members.js';
import './games.js';
import * as ui from './ui.js';

// 初始：讓聊天模組知道目前使用者
chat.setCurrentUser(members.currentUserId, members.currentUserName);

// 讓舊的 onclick 寫法也能用（向後相容）
window.cancelFileTransfer = fileTransfer.cancelFileTransfer;
window.showMemberSelectForFile = fileTransfer.showMemberSelectForFile;

// 自動加入 (?room=)
window.addEventListener("load", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get("room");
  if (roomParam) {
    members.joinRoom(roomParam);
  }
});

// UI 綁定
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
  if (!roomId) { alert("請輸入房號"); return; }
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
