import { db, ref, set, onValue, serverTimestamp } from './firebase.js';
import { log } from './ui.js';

let currentUserId = "";
let currentUserName = "";
let currentRoomId = null;
let messagesListener = null;

// 設定目前使用者的 ID 和名稱
export function setCurrentUser(userId, userName) {
  currentUserId = userId;
  currentUserName = userName;
}

// 設定目前所在房間 ID
export function setCurrentRoom(roomId) {
  currentRoomId = roomId;
}

// 清空聊天訊息列表並顯示歡迎訊息
export function clearChatMessages() {
  const chatMessages = document.getElementById("chatMessages");
  chatMessages.innerHTML = `
    <div class="message received">
      <div class="message-sender">系統</div>
      <div>歡迎來到聊天室！</div>
    </div>
  `;
}

// 初始化聊天室監聽，載入歷史訊息
export function initChatListener() {
  if (!currentRoomId) return;
  clearChatMessages();
  const messagesRef = ref(db, "rooms/" + currentRoomId + "/messages");
  messagesListener = onValue(messagesRef, (snapshot) => {
    const messages = snapshot.val();
    if (messages) {
      const chatMessages = document.getElementById("chatMessages");
      chatMessages.innerHTML = `
        <div class="message received">
          <div class="message-sender">系統</div>
          <div>歡迎來到聊天室！</div>
        </div>
      `;
      const sortedMessages = Object.entries(messages).sort(([, a], [, b]) => a.timestamp - b.timestamp);
      sortedMessages.forEach(([messageId, messageData]) => {
        displayMessage(messageData);
      });
    }
  });
}

// 將單筆訊息顯示在聊天區
function displayMessage(messageData) {
  const chatMessages = document.getElementById("chatMessages");
  const messageDiv = document.createElement("div");
  const isMe = messageData.userId === currentUserId;
  messageDiv.className = isMe ? "message sent" : "message received";
  const senderName = isMe ? "我" : (messageData.userName || "使用者");
  messageDiv.innerHTML = `
    <div class="message-sender">${senderName}</div>
    <div>${escapeHtml(messageData.text)}</div>
  `;
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// 轉義 HTML，防止 XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 傳送聊天訊息至資料庫
export async function sendMessage(text) {
  if (!currentRoomId || !text.trim()) return;
  const messageData = {
    userId: currentUserId,
    userName: currentUserName,
    text: text.trim(),
    timestamp: serverTimestamp()
  };
  try {
    const messageKey = `${currentUserId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await set(ref(db, "rooms/" + currentRoomId + "/messages/" + messageKey), messageData);
    log("💬 訊息已發送");
  } catch (err) {
    log("❌ 發送訊息失敗: " + err.message);
  }
}

// 停止聊天室監聽
export function stopChatListener() {
  if (messagesListener) {
    messagesListener();
    messagesListener = null;
  }
}
