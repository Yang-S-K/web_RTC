// main.js
import { db } from "./firebase.js";
import { createRoom, joinRoom, leaveRoom } from "./webrtc.js";
import { initChatListener } from "./chat.js";
import { log } from "./ui.js";

// ========== 全域變數 ==========
export let currentRoomId = null;
export let currentUserId = Math.random().toString(36).substring(2, 10);
export let currentUserName = "使用者" + currentUserId.substring(0, 4);

// ========== 按鈕事件綁定 ==========
document.getElementById("createRoomBtn").onclick = async () => {
  currentRoomId = await createRoom(currentUserId, currentUserName);
  initChatListener();
  log("🎯 你是 Host");
};

document.getElementById("joinRoomBtn").onclick = async () => {
  const roomId = document.getElementById("joinRoomId").value.trim();
  if (!roomId) return alert("請輸入房號");
  currentRoomId = await joinRoom(roomId, currentUserId, currentUserName);
  initChatListener();
};

document.getElementById("leaveRoomBtn").onclick = async () => {
  if (!currentRoomId) return;
  await leaveRoom(currentRoomId, currentUserId);
  currentRoomId = null;
};

// ========== 自動加入房間 ==========
window.addEventListener("load", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get("room");
  if (roomParam) {
    joinRoom(roomParam, currentUserId, currentUserName);
  }
});
