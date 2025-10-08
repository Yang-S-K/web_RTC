// main.js
import { db } from "./firebase.js";
import { createRoom, joinRoom, leaveRoom, shareRoomLink } from "./webrtc.js";
import { initChatListener, sendMessage, clearChatMessages } from "./chat.js";
import { log } from "./ui.js";

// ========== 全域變數 ==========
export let currentRoomId = null;
export let currentUserId = Math.random().toString(36).substring(2, 10);
export let currentUserName = "使用者" + currentUserId.substring(0, 4);

// 建立房間
document.getElementById("createRoomBtn").onclick = () => { createRoom(); };

// 加入房間
document.getElementById("joinRoomBtn").onclick = () => {
  const roomId = document.getElementById("joinRoomId").value.trim();
  if (!roomId) return alert("請輸入房號");
  joinRoom(roomId);
};

// 離開房間
document.getElementById("leaveRoomBtn").onclick = () => { leaveRoom(); };

// 分享房間
document.getElementById("shareBtn").onclick = () => { shareRoomLink(); };

// ========== 自動加入房間 ==========
window.addEventListener("load", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get("room");
  if (roomParam) {
    joinRoom(roomParam, currentUserId, currentUserName);
  }
});

document.getElementById("sendBtn").onclick = () => {
  const input = document.getElementById("chatInput");
  const text = input.value;
  sendMessage(text);
  input.value = "";
};
