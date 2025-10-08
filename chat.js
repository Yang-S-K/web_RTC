// js/chat.js
import { db } from "./firebase.js";
import {
  ref, set, onValue, serverTimestamp, push,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

import { getCurrentRoomId, getCurrentUserId, getCurrentUserName } from "./webrtc.js";

let messagesListener = null;

// ===== 顯示訊息 =====
export function displayMessage(sender, text, isLocal = false) {
  const chat = document.getElementById("chatMessages");
  if (!chat) return;

  const msgDiv = document.createElement("div");
  msgDiv.className = "message " + (isLocal ? "sent" : "received");
  msgDiv.innerHTML = `
    <div class="message-sender">${sender}</div>
    <div>${text}</div>
  `;

  chat.appendChild(msgDiv);
  chat.scrollTop = chat.scrollHeight;
}

// ===== 清空訊息（重新進房或被踢出時用）=====
export function clearChatMessages() {
  const chat = document.getElementById("chatMessages");
  if (chat) {
    chat.innerHTML = `
      <div class="message received">
        <div class="message-sender">系統</div>
        <div>歡迎來到聊天室！</div>
      </div>`;
  }
}

// ===== 初始化聊天室監聽 =====
export function initChatListener() {
  const roomId = getCurrentRoomId();
  if (!roomId) return;

  if (messagesListener) messagesListener();

  messagesListener = onValue(ref(db, `rooms/${roomId}/messages`), (snapshot) => {
    const messages = snapshot.val();
    if (!messages) return;

    const chat = document.getElementById("chatMessages");
    if (!chat) return;

    chat.innerHTML = ""; // 先清空
    Object.values(messages).forEach((msg) => {
      displayMessage(msg.senderName, msg.text, msg.senderId === getCurrentUserId());
    });
  });
}

// ===== 發送訊息 =====
export async function sendMessage(text) {
  const roomId = getCurrentRoomId();
  if (!roomId || !text.trim()) return;

  const msgRef = push(ref(db, `rooms/${roomId}/messages`));
  await set(msgRef, {
    senderId: getCurrentUserId(),
    senderName: getCurrentUserName(),
    text: text,
    timestamp: serverTimestamp(),
  });

  displayMessage(getCurrentUserName(), text, true);
}
