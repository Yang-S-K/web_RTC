import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, remove, onValue, update, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

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

let currentRoomId = null;
let currentUserId = Math.random().toString(36).substring(2, 10);
let currentUserName = "使用者" + currentUserId.substring(0, 4);
let peerConnections = {};
let dataChannels = {};
let membersListener = null;
let hostListener = null;
let currentMembers = {};
let messagesListener = null;
let screenStream = null;

// 檔案傳輸相關
let fileTransfers = {}; // { transferId: { file, chunks, received, ... } }
const CHUNK_SIZE = 16384; // 16KB chunks

const log = (msg) => {
  const logEl = document.getElementById("log");
  logEl.textContent = msg;
  console.log(msg);
};

// ===== WebRTC 配置 =====
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ===== UI 控制 =====
function showInRoomUI(roomId) {
  document.getElementById("createSection").style.display = "none";
  document.getElementById("joinSection").style.display = "none";
  document.getElementById("roomInfo").classList.remove("hidden");
  document.getElementById("mainContent").classList.remove("hidden");
  document.getElementById("roomIdDisplay").textContent = "房號: " + roomId;
  document.getElementById("qrSection").style.display = "flex";
}

function updateMemberCount(count) {
  const memberCountEl = document.getElementById("memberCount");
  memberCountEl.textContent = `👥 ${count} 人`;
}

function updateRoomLinkUI(url) {
  const canvas = document.getElementById("qrcode");
  
  if (url && window.QRCode && typeof QRCode.toCanvas === "function") {
    QRCode.toCanvas(canvas, url, (err) => {
      if (err) log("❌ QR Code 生成失敗");
    });
  }
}

function resetUI() {
  document.getElementById("createSection").style.display = "block";
  document.getElementById("joinSection").style.display = "block";
  document.getElementById("roomInfo").classList.add("hidden");
  document.getElementById("mainContent").classList.add("hidden");
  document.getElementById("qrSection").style.display = "none";
  document.getElementById("roomIdDisplay").textContent = "";
  
  const canvas = document.getElementById("qrcode");
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// ===== 處理被踢出房間 =====
function handleKickedOut() {
  if (membersListener) {
    membersListener();
    membersListener = null;
  }
  if (hostListener) {
    hostListener();
    hostListener = null;
  }
  if (messagesListener) {
    messagesListener();
    messagesListener = null;
  }

  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  dataChannels = {};

  if (screenStream) {
    stopScreenShare();
  }

  const roomId = currentRoomId;
  currentRoomId = null;
  currentMembers = {};
  
  clearChatMessages();
  resetUI();
  
  log("🚫 您已被移出房間: " + roomId);
  alert("您已被移出房間");
}

// ===== WebRTC 連接管理 =====
async function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(configuration);
  peerConnections[peerId] = pc;

  // 創建 DataChannel
  if (isInitiator) {
    const channel = pc.createDataChannel("fileTransfer");
    setupDataChannel(channel, peerId);
    dataChannels[peerId] = channel;
    log(`📡 創建 DataChannel 給 ${peerId}`);
  } else {
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      setupDataChannel(channel, peerId);
      dataChannels[peerId] = channel;
      log(`📡 接收 DataChannel 從 ${peerId}`);
    };
  }

  // ICE 候選 - 已修正：移除 .toJSON()
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const candidateRef = ref(db, `rooms/${currentRoomId}/signals/${currentUserId}_to_${peerId}/candidates/${Date.now()}`);
      set(candidateRef, {
        candidate: event.candidate,
        timestamp: Date.now()
      }).catch(err => console.error('發送 ICE candidate 失敗:', err));
    }
  };

  // 連接狀態監控
  pc.onconnectionstatechange = () => {
    log(`🔗 與 ${peerId} 的連接狀態: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      pc.close();
      delete peerConnections[peerId];
      delete dataChannels[peerId];
    }
  };

  // 監聽來自對方的信號
  const signalRef = ref(db, `rooms/${currentRoomId}/signals/${peerId}_to_${currentUserId}`);
  onValue(signalRef, async (snapshot) => {
    const signal = snapshot.val();
    if (!signal) return;

    try {
      if (signal && signal.type === 'offer' && (!pc.currentRemoteDescription || pc.signalingState === 'stable')) {
        await pc.setRemoteDescription(signal);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        // 已修正：移除 .toJSON()
        await set(ref(db, `rooms/${currentRoomId}/signals/${currentUserId}_to_${peerId}/answer`), answer);
        log(`📡 已回應 ${peerId} 的連接請求`);
      } else if (signal && signal.type === 'answer' && pc.signalingState === 'have-local-offer') {
         await pc.setRemoteDescription(signal);
        log(`✅ 已接收 ${peerId} 的回應`);
      }
    } catch (err) {
      console.error('信號處理錯誤:', err);
    }
  });

  // 監聽 ICE candidates
  const candidatesRef = ref(db, `rooms/${currentRoomId}/signals/${peerId}_to_${currentUserId}/candidates`);
  onValue(candidatesRef, (snapshot) => {
    const candidates = snapshot.val();
    if (candidates) {
      Object.values(candidates).forEach(async (data) => {
        try {
          if (data.candidate && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          }
        } catch (err) {
          console.error('添加 ICE candidate 失敗:', err);
        }
      });
    }
  });

  // 如果是發起者，創建 offer - 已修正：移除 .toJSON()
  if (isInitiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await set(ref(db, `rooms/${currentRoomId}/signals/${currentUserId}_to_${peerId}/offer`), offer);
      log(`📡 已發送連接請求給 ${peerId}`);
    } catch (err) {
      console.error('創建 offer 失敗:', err);
    }
  }

  return pc;
}

// ===== DataChannel 設置 =====
function setupDataChannel(channel, peerId) {
  channel.binaryType = 'arraybuffer';

  channel.onopen = () => {
    log(`✅ DataChannel 已連接: ${peerId}`);
  };

  channel.onclose = () => {
    log(`❌ DataChannel 已關閉: ${peerId}`);
  };

  channel.onerror = (error) => {
    log(`❌ DataChannel 錯誤: ${error}`);
  };

  channel.onmessage = (event) => {
    handleDataChannelMessage(event.data, peerId);
  };
}

// ===== 檔案傳輸處理 =====
function handleDataChannelMessage(data, peerId) {
  if (typeof data === 'string') {
    const message = JSON.parse(data);
    
    if (message.type === 'file-meta') {
      // 接收檔案元數據
      const transferId = message.transferId;
      fileTransfers[transferId] = {
        fileName: message.fileName,
        fileSize: message.fileSize,
        fileType: message.fileType,
        chunks: [],
        receivedSize: 0,
        totalChunks: message.totalChunks,
        senderId: peerId,
        senderName: currentMembers[peerId]?.name || "使用者"
      };
      
      addFileToList(transferId, message.fileName, message.fileSize, peerId, false);
      log(`📥 準備接收檔案: ${message.fileName} (${formatFileSize(message.fileSize)})`);
    } else if (message.type === 'file-chunk-ack') {
      // 收到確認，繼續發送下一個chunk
      const transfer = fileTransfers[message.transferId];
      if (transfer && transfer.isSending) {
        sendNextChunk(message.transferId, peerId);
      }
    }
  } else {
    // 接收檔案數據塊
    handleFileChunk(data, peerId);
  }
}

function handleFileChunk(arrayBuffer, peerId) {
  // 從數據中提取 transferId (前36字節)
  const transferIdBuffer = arrayBuffer.slice(0, 36);
  const transferId = new TextDecoder().decode(transferIdBuffer);
  const chunkData = arrayBuffer.slice(36);
  
  const transfer = fileTransfers[transferId];
  if (!transfer) return;

  transfer.chunks.push(chunkData);
  transfer.receivedSize += chunkData.byteLength;

  // 更新進度
  updateFileProgress(transferId, transfer.receivedSize, transfer.fileSize);

  // 發送確認
  const channel = dataChannels[peerId];
  if (channel && channel.readyState === 'open') {
    channel.send(JSON.stringify({
      type: 'file-chunk-ack',
      transferId: transferId
    }));
  }

  // 檢查是否接收完成
  if (transfer.receivedSize >= transfer.fileSize) {
    completeFileReceive(transferId);
  }
}

function completeFileReceive(transferId) {
  const transfer = fileTransfers[transferId];
  if (!transfer) return;

  // 合併所有chunks
  const blob = new Blob(transfer.chunks, { type: transfer.fileType });
  
  // 創建下載連結
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = transfer.fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  log(`✅ 檔案接收完成: ${transfer.fileName}`);
  updateFileStatus(transferId, 'completed');
}

// ===== 檔案發送 =====
async function sendFile(file, targetPeerId) {
  const channel = dataChannels[targetPeerId];
  
  if (!channel || channel.readyState !== 'open') {
    alert('與該成員的連接未建立');
    return;
  }

  const transferId = `${currentUserId}_${Date.now()}`;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  fileTransfers[transferId] = {
    file: file,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    totalChunks: totalChunks,
    currentChunk: 0,
    isSending: true,
    targetPeerId: targetPeerId
  };

  addFileToList(transferId, file.name, file.size, currentUserId, true);
  
  // 只向指定的 peer 發送
  channel.send(JSON.stringify({
    type: 'file-meta',
    transferId: transferId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    totalChunks: totalChunks
  }));

  setTimeout(() => sendNextChunk(transferId, targetPeerId), 100);
}

function sendNextChunk(transferId, peerId) {
  const transfer = fileTransfers[transferId];
  const channel = dataChannels[peerId];

  if (!transfer || !channel || channel.readyState !== 'open') return;

  if (transfer.currentChunk >= transfer.totalChunks) {
    log(`✅ 檔案發送完成給 ${peerId}: ${transfer.fileName}`);
    updateFileStatus(transferId, 'completed');
    return;
  }

  const start = transfer.currentChunk * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, transfer.fileSize);
  const chunk = transfer.file.slice(start, end);

  const reader = new FileReader();
  reader.onload = (e) => {
    // 將 transferId 和數據打包
    const transferIdBuffer = new TextEncoder().encode(transferId.padEnd(36, ' '));
    const combinedBuffer = new Uint8Array(transferIdBuffer.length + e.target.result.byteLength);
    combinedBuffer.set(new Uint8Array(transferIdBuffer), 0);
    combinedBuffer.set(new Uint8Array(e.target.result), transferIdBuffer.length);

    try {
      channel.send(combinedBuffer.buffer);
      transfer.currentChunk++;
      
      // 更新進度
      updateFileProgress(transferId, transfer.currentChunk * CHUNK_SIZE, transfer.fileSize);
    } catch (err) {
      console.error('發送chunk失敗:', err);
    }
  };

  reader.readAsArrayBuffer(chunk);
}
function showMemberSelectForFile(file) {
  const modal = document.getElementById("memberModal");
  const memberList = document.getElementById("memberList");
  
  memberList.innerHTML = "<h3>選擇傳送對象：</h3>";
  
  Object.entries(currentMembers).forEach(([memberId, memberData]) => {
    if (memberId === currentUserId) return; // 不顯示自己
    
    const name = memberData.name || "使用者" + memberId.substring(0, 4);
    const btn = document.createElement("button");
    btn.className = "member-item";
    btn.style.cursor = "pointer";
    btn.innerHTML = `<span>${name}</span>`;
    btn.onclick = () => {
      sendFile(file, memberId);
      modal.classList.add("hidden");
    };
    memberList.appendChild(btn);
  });
  
  modal.classList.remove("hidden");
}

// 修改檔案選擇事件
fileInput.addEventListener('change', (e) => {
  const files = e.target.files;
  if (files.length > 0) {
    if (Object.keys(dataChannels).length === 0) {
      alert('沒有可用的連接');
      return;
    }
    showMemberSelectForFile(files[0]); // 一次只處理一個檔案
  }
  fileInput.value = '';
});
// ===== UI 檔案列表管理 =====
function addFileToList(transferId, fileName, fileSize, userId, isSending) {
  const fileList = document.getElementById('fileList');
  const fileItem = document.createElement('div');
  fileItem.className = 'file-item';
  fileItem.id = `file-${transferId}`;

  const userName = userId === currentUserId ? '我' : (currentMembers[userId]?.name || '使用者');
  const direction = isSending ? '📤 發送中' : '📥 接收中';

  fileItem.innerHTML = `
    <div class="file-info">
      <div style="font-size: 32px;">📄</div>
      <div style="flex: 1;">
        <div style="font-weight: bold; color: #333;">${fileName}</div>
        <div style="font-size: 14px; color: #666;">${formatFileSize(fileSize)} · ${direction} · ${userName}</div>
        <div class="file-progress">
          <div class="file-progress-bar" id="progress-${transferId}" style="width: 0%"></div>
        </div>
      </div>
    </div>
    ${isSending ? `<button class="btn btn-secondary" onclick="cancelFileTransfer('${transferId}')" style="padding: 8px 16px;">取消</button>` : ''}
  `;

  fileList.appendChild(fileItem);
}

// 取消檔案傳輸
window.cancelFileTransfer = function(transferId) {
  const transfer = fileTransfers[transferId];
  if (transfer && transfer.isSending) {
    transfer.isSending = false;
    updateFileStatus(transferId, 'cancelled');
    log(`❌ 已取消發送: ${transfer.fileName}`);
  }
}

function updateFileProgress(transferId, loaded, total) {
  const progressBar = document.getElementById(`progress-${transferId}`);
  if (progressBar) {
    const percent = (loaded / total * 100).toFixed(1);
    progressBar.style.width = percent + '%';
  }
}

function updateFileStatus(transferId, status) {
  const fileItem = document.getElementById(`file-${transferId}`);
  if (fileItem) {
    const statusText = status === 'completed' ? '✅ 完成' : '❌ 失敗';
    const infoDiv = fileItem.querySelector('.file-info > div > div:nth-child(2)');
    if (infoDiv) {
      infoDiv.innerHTML = infoDiv.innerHTML.replace(/(📤 發送中|📥 接收中)/, statusText);
    }
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// ===== 成員列表功能 =====
function showMemberList() {
  const modal = document.getElementById("memberModal");
  const memberList = document.getElementById("memberList");
  
  memberList.innerHTML = "";
  
  get(ref(db, "rooms/" + currentRoomId)).then(snapshot => {
    const roomData = snapshot.val();
    const hostId = roomData?.hostId;
    const isCurrentUserHost = hostId === currentUserId;
    
    const sortedMembers = Object.entries(currentMembers).sort(([idA, dataA], [idB, dataB]) => {
      if (idA === hostId) return -1;
      if (idB === hostId) return 1;
      return dataA.joinedAt - dataB.joinedAt;
    });
    
    sortedMembers.forEach(([memberId, memberData]) => {
      const memberItem = document.createElement("div");
      memberItem.className = "member-item";
      
      const isMe = memberId === currentUserId;
      const isHost = memberId === hostId;
      const name = memberData.name || "使用者" + memberId.substring(0, 4);
      const initial = name.charAt(0).toUpperCase();
      
      let actionButtons = '';
      if (isCurrentUserHost && !isMe) {
        actionButtons = `
          <div class="member-actions">
            <button class="action-btn transfer-btn" data-member-id="${memberId}" data-member-name="${name}" title="轉交房主">
              👑
            </button>
            <button class="action-btn kick-btn" data-member-id="${memberId}" data-member-name="${name}" title="踢除成員">
              🚫
            </button>
          </div>
        `;
      }
      
      memberItem.innerHTML = `
        <div class="member-info">
          <div class="member-avatar">${initial}</div>
          <span class="member-name">${name}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          ${isHost ? '<span class="member-badge">👑 房主</span>' : ''}
          ${isMe ? '<span class="you-badge">我</span>' : ''}
          ${actionButtons}
        </div>
      `;
      
      memberList.appendChild(memberItem);
    });
    
    document.querySelectorAll('.transfer-btn').forEach(btn => {
      btn.onclick = async () => {
        const memberId = btn.dataset.memberId;
        const memberName = btn.dataset.memberName;
        
        if (confirm(`確定要將房主轉交給 ${memberName} 嗎？`)) {
          await transferHost(memberId);
        }
      };
    });
    
    document.querySelectorAll('.kick-btn').forEach(btn => {
      btn.onclick = async () => {
        const memberId = btn.dataset.memberId;
        const memberName = btn.dataset.memberName;
        
        if (confirm(`確定要踢除 ${memberName} 嗎？`)) {
          await kickMember(memberId);
        }
      };
    });
  });
  
  modal.classList.remove("hidden");
}

async function transferHost(newHostId) {
  if (!currentRoomId) return;
  
  try {
    const roomRef = ref(db, "rooms/" + currentRoomId);
    const snapshot = await get(roomRef);
    
    if (!snapshot.exists()) {
      log("❌ 房間不存在");
      return;
    }
    
    const roomData = snapshot.val();
    
    if (roomData.hostId !== currentUserId) {
      log("❌ 只有房主可以轉交房主權限");
      return;
    }
    
    if (!roomData.members || !roomData.members[newHostId]) {
      log("❌ 該成員不在房間內");
      return;
    }
    
    await update(roomRef, { hostId: newHostId });
    await update(ref(db, `rooms/${currentRoomId}/members/${currentUserId}`), { isHost: false });
    await update(ref(db, `rooms/${currentRoomId}/members/${newHostId}`), { isHost: true });
    
    const newHostName = roomData.members[newHostId].name || "使用者" + newHostId.substring(0, 4);
    log(`👑 已將房主轉交給: ${newHostName}`);
    
    showMemberList();
  } catch (err) {
    log("❌ 轉交房主失敗: " + err.message);
  }
}

async function kickMember(memberId) {
  if (!currentRoomId) return;
  
  try {
    const roomRef = ref(db, "rooms/" + currentRoomId);
    const snapshot = await get(roomRef);
    
    if (!snapshot.exists()) {
      log("❌ 房間不存在");
      return;
    }
    
    const roomData = snapshot.val();
    
    if (roomData.hostId !== currentUserId) {
      log("❌ 只有房主可以踢除成員");
      return;
    }
    
    if (memberId === currentUserId) {
      log("❌ 不能踢除自己");
      return;
    }
    
    await remove(ref(db, `rooms/${currentRoomId}/members/${memberId}`));
    
    if (peerConnections[memberId]) {
      peerConnections[memberId].close();
      delete peerConnections[memberId];
    }
    if (dataChannels[memberId]) {
      delete dataChannels[memberId];
    }
    
    const memberName = roomData.members[memberId]?.name || "使用者" + memberId.substring(0, 4);
    log(`🚫 已踢除成員: ${memberName}`);
    
    showMemberList();
  } catch (err) {
    log("❌ 踢除成員失敗: " + err.message);
  }
}

function hideMemberList() {
  document.getElementById("memberModal").classList.add("hidden");
}

// ===== 監聽成員變化並建立連接 =====
function setupMemberConnections() {
  onValue(ref(db, "rooms/" + currentRoomId + "/members"), async (snapshot) => {
    const members = snapshot.val();
    if (!members) return;

    if (!members[currentUserId]) {
      handleKickedOut();
      return;
    }

    currentMembers = members;
    const memberIds = Object.keys(members);
    updateMemberCount(memberIds.length);

    // 與新成員建立連接
    for (const memberId of memberIds) {
      if (memberId !== currentUserId && !peerConnections[memberId]) {
        // 如果當前用戶ID較小，則作為發起者
        const isInitiator = currentUserId < memberId;
        await createPeerConnection(memberId, isInitiator);
      }
    }

    // 清理已離開成員的連接
    for (const peerId in peerConnections) {
      if (!members[peerId]) {
        peerConnections[peerId].close();
        delete peerConnections[peerId];
        delete dataChannels[peerId];
      }
    }
  });
}

// ===== 開房 =====
document.getElementById("createRoomBtn").onclick = async () => {
  currentRoomId = Math.random().toString(36).substring(2, 7);
  
  const roomData = {
    createdAt: Date.now(),
    hostId: currentUserId,
    members: {
      [currentUserId]: {
        joinedAt: Date.now(),
        isHost: true,
        name: currentUserName
      }
    }
  };

  await set(ref(db, "rooms/" + currentRoomId), roomData);

  setupMemberConnections();

  const url = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}`;
  
  showInRoomUI(currentRoomId);
  updateRoomLinkUI(url);
  initChatListener();

  log("🎯 你是 Host");
  log("✅ 建立房間: " + currentRoomId);
};

// ===== 分享房間 =====
document.getElementById("shareBtn").onclick = async () => {
  if (!currentRoomId) return;
  
  const url = `${window.location.origin}${window.location.pathname}?room=${currentRoomId}`;
  
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'WebRTC 房間邀請',
        text: '點擊連結加入房間',
        url: url
      });
      log("✅ 分享成功");
    } catch (err) {
      if (err.name !== 'AbortError') {
        log("❌ 分享失敗");
      }
    }
  } else {
    try {
      await navigator.clipboard.writeText(url);
      log("✅ 連結已複製到剪貼簿");
    } catch (err) {
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      log("✅ 連結已複製");
    }
  }
};

// ===== 加入房間 =====
async function joinRoom(roomId) {
  const roomRef = ref(db, "rooms/" + roomId);
  const snap = await get(roomRef);
  
  if (!snap.exists()) {
    alert("房間不存在");
    return;
  }

  currentRoomId = roomId;

  await set(ref(db, "rooms/" + roomId + "/members/" + currentUserId), {
    joinedAt: Date.now(),
    isHost: false,
    name: currentUserName
  });

  setupMemberConnections();

  hostListener = onValue(ref(db, "rooms/" + currentRoomId + "/hostId"), (snapshot) => {
    const hostId = snapshot.val();
    if (hostId === currentUserId) {
      log("🎯 你成為新的 Host！");
    }
  });

  const url = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
  
  showInRoomUI(roomId);
  updateRoomLinkUI(url);
  initChatListener();
  
  log("✅ 加入房間: " + roomId);
}

document.getElementById("joinRoomBtn").onclick = async () => {
  const roomId = document.getElementById("joinRoomId").value.trim();
  if (!roomId) return alert("請輸入房號");
  joinRoom(roomId);
};

// ===== 離開房間 =====
document.getElementById("leaveRoomBtn").onclick = async () => {
  if (!currentRoomId) return;

  if (membersListener) membersListener();
  if (hostListener) hostListener();
  if (messagesListener) messagesListener();
  membersListener = null;
  hostListener = null;
  messagesListener = null;

  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  dataChannels = {};

  const roomRef = ref(db, "rooms/" + currentRoomId);
  const snap = await get(roomRef);
  
  if (snap.exists()) {
    const roomData = snap.val();
    const members = roomData.members || {};
    
    await remove(ref(db, "rooms/" + currentRoomId + "/members/" + currentUserId));

    if (roomData.hostId === currentUserId) {
      const remainingMembers = Object.entries(members)
        .filter(([id]) => id !== currentUserId)
        .sort(([, a], [, b]) => a.joinedAt - b.joinedAt);

      if (remainingMembers.length > 0) {
        const newHostId = remainingMembers[0][0];
        await update(ref(db, "rooms/" + currentRoomId), { hostId: newHostId });
        await update(ref(db, "rooms/" + currentRoomId + "/members/" + newHostId), { isHost: true });
        log("👑 Host 已交接給: " + newHostId);
      } else {
        await remove(roomRef);
        log("🗑️ 房間已刪除（最後一人離開）");
      }
    }
  }

  log("👋 已離開房間: " + currentRoomId);
  currentRoomId = null;
  currentMembers = {};
  clearChatMessages();
  resetUI();
};

// ===== 自動加入 =====
window.addEventListener("load", () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get("room");
  if (roomParam) {
    joinRoom(roomParam);
  }
});

// ===== 聊天功能 =====
function clearChatMessages() {
  const chatMessages = document.getElementById("chatMessages");
  chatMessages.innerHTML = `
    <div class="message received">
      <div class="message-sender">系統</div>
      <div>歡迎來到聊天室！</div>
    </div>
  `;
}

function initChatListener() {
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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function sendMessage(text) {
  if (!currentRoomId || !text.trim()) return;
  
  const messageData = {
    userId: currentUserId,
    userName: currentUserName,
    text: text.trim(),
    timestamp: serverTimestamp()
  };
  
  try {
    const newMessageRef = ref(db, "rooms/" + currentRoomId + "/messages/" + currentUserId + "_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7));
    await set(newMessageRef, messageData);
    log("💬 訊息已發送");
  } catch (err) {
    log("❌ 發送訊息失敗: " + err.message);
  }
}

document.getElementById("sendBtn").onclick = () => {
  const input = document.getElementById("chatInput");
  const message = input.value.trim();
  if (!message) return;
  
  sendMessage(message);
  input.value = "";
};

// ===== 螢幕分享功能 =====
document.getElementById("startScreenBtn").onclick = async () => {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ 
      video: true,
      audio: false 
    });
    
    const video = document.getElementById("screenVideo");
    video.srcObject = screenStream;
    video.style.display = "block";
    
    document.getElementById("videoPlaceholder").style.display = "none";
    document.getElementById("startScreenBtn").classList.add("hidden");
    document.getElementById("stopScreenBtn").classList.remove("hidden");
    
    log("🎬 開始分享螢幕");
    
    screenStream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
    };
  } catch (err) {
    log("❌ 無法分享螢幕: " + err.message);
  }
};

document.getElementById("stopScreenBtn").onclick = () => {
  stopScreenShare();
};

function stopScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  
  const video = document.getElementById("screenVideo");
  video.srcObject = null;
  video.style.display = "none";
  
  document.getElementById("videoPlaceholder").style.display = "block";
  document.getElementById("startScreenBtn").classList.remove("hidden");
  document.getElementById("stopScreenBtn").classList.add("hidden");
  
  log("⏹️ 停止分享螢幕");
}

// ===== 檔案選擇處理 =====
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('fileDropZone');

fileInput.addEventListener('change', (e) => {
  const files = e.target.files;
  if (files.length > 0) {
    Array.from(files).forEach(file => {
      sendFile(file);
    });
  }
  fileInput.value = ''; // 重置input
});

dropZone.addEventListener('click', () => {
  fileInput.click();
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    Array.from(files).forEach(file => {
      sendFile(file);
    });
  }
});

// ===== 成員相關事件 =====
document.getElementById("memberCount").onclick = () => {
  showMemberList();
};

document.getElementById("closeMemberModal").onclick = () => {
  hideMemberList();
};

document.getElementById("memberModal").onclick = (e) => {
  if (e.target.id === "memberModal") {
    hideMemberList();
  }
};

document.getElementById("updateNameBtn").onclick = async () => {
  const newName = document.getElementById("newNameInput").value.trim();
  
  if (!newName) {
    alert("請輸入名稱");
    return;
  }
  
  if (newName.length > 20) {
    alert("名稱不能超過 20 個字");
    return;
  }
  
  if (!currentRoomId) return;
  
  try {
    await update(ref(db, "rooms/" + currentRoomId + "/members/" + currentUserId), {
      name: newName
    });
    
    currentUserName = newName;
    document.getElementById("newNameInput").value = "";
    log("✅ 名稱已更新為: " + newName);
    
    showMemberList();
  } catch (err) {
    log("❌ 更新名稱失敗: " + err.message);
  }
};

document.getElementById("newNameInput").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    document.getElementById("updateNameBtn").click();
  }
});

// ===== 遊戲選擇 =====
document.querySelectorAll('.game-card').forEach(card => {
  card.addEventListener('click', () => {
    const game = card.dataset.game;
    const gameName = card.querySelector('.game-title').textContent;
    log(`🎮 選擇遊戲: ${gameName}`);
    alert(`即將開始 ${gameName}！\n(遊戲功能開發中...)`);
  });
});
