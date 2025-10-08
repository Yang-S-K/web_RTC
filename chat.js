// js/chat.js
import { db } from "./firebase.js";
import {
  ref, set, serverTimestamp, push, onChildAdded, off
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

import { getCurrentRoomId, getCurrentUserId, getCurrentUserName } from "./webrtc.js";

let messagesListener = null;

// ===== 顯示訊息 =====
export function displayMessage(msg) {
  const chatMessages = document.getElementById("chatMessages");
  const div = document.createElement("div");
  div.classList.add("chat-message");
  div.textContent = `${msg.senderName}: ${msg.text}`;
  chatMessages.appendChild(div);

  // ===== 自動滾動邏輯 =====
  const isAtBottom =
    chatMessages.scrollHeight - chatMessages.scrollTop <= chatMessages.clientHeight + 10;

  if (isAtBottom) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}


// ===== 清空訊息 =====
export function clearChatMessages() {
  const chat = document.getElementById("chatMessages");
  if (chat) {
    chat.innerHTML = `
      <div class="message received">
        <div class="message-sender">系統</div>
        <div>歡迎來到聊天室！</div>
      </div>`;
  }
  if (messagesListener) {
    off(messagesListener); // 停止監聽
    messagesListener = null;
  }
}

// ===== 初始化聊天室監聽 =====
export function initChatListener() {
  const roomId = getCurrentRoomId();
  if (!roomId) return;

  // 清除舊監聽
  if (messagesListener) {
    off(messagesListener);
    messagesListener = null;
  }

  const messagesRef = ref(db, `rooms/${roomId}/messages`);
  messagesListener = messagesRef;

  onChildAdded(messagesRef, (snapshot) => {
    const msg = snapshot.val();
    if (!msg) return;
    displayMessage(msg.senderName, msg.text, msg.senderId === getCurrentUserId());
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

  // displayMessage(getCurrentUserName(), text, true);
}
