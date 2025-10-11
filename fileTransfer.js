// fileTransfer.js
import { currentMembers, currentUserId } from './members.js';
import { isPeerConnected } from './webrtc.js';
import { log, addFileToList, updateFileProgress, updateFileStatus, formatFileSize } from './ui.js';

export const dataChannels = {};
let fileTransfers = {};
const CHUNK_SIZE = 16384;
let isFileDialogOpen = false;

// ---- DataChannel 綁定 ----
export function setupDataChannel(channel, peerId) {
  channel.binaryType = 'arraybuffer';

  // 用 addEventListener 讓我們可以在 ensureChannelOpen 裡再加監聽
  channel.addEventListener('open', () => {
    log(`✅ DataChannel 已連接: ${peerId}`);
  });
  channel.addEventListener('close', () => {
    log(`❌ DataChannel 已關閉: ${peerId}`);
  });
  channel.addEventListener('error', (e) => {
    log(`❌ DataChannel 錯誤: ${e?.message || e}`);
  });
  channel.addEventListener('message', (event) => {
    handleDataChannelMessage(event.data, peerId);
  });

  dataChannels[peerId] = channel;
}

export function removeDataChannel(peerId) {
  if (dataChannels[peerId]) delete dataChannels[peerId];
}

// ---- 工具：安全取得成員 ----
function getOtherMembersSafe() {
  if (!currentMembers || typeof currentMembers !== 'object') return [];
  return Object.entries(currentMembers).filter(([id]) => id !== currentUserId);
}

// 允許先選人，再等待通道開啟
async function ensureChannelOpen(peerId, timeoutMs = 8000) {
  // 已有且為 open
  const existing = dataChannels[peerId];
  if (existing && existing.readyState === 'open') return existing;

  // 如果尚未建立通道，持續輪詢一下
  return await new Promise((resolve, reject) => {
    let finished = false;

    const tryResolve = () => {
      if (finished) return;
      const ch = dataChannels[peerId];
      if (ch && ch.readyState === 'open') {
        finished = true;
        cleanup();
        resolve(ch);
      }
    };

    const poll = setInterval(tryResolve, 200);

    // 若目前已有通道物件，監聽其 open
    let ch = dataChannels[peerId];
    const onOpen = () => { tryResolve(); };
    ch?.addEventListener?.('open', onOpen);

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error('DataChannel 開啟逾時'));
    }, timeoutMs);

    function cleanup() {
      clearInterval(poll);
      clearTimeout(timer);
      ch?.removeEventListener?.('open', onOpen);
    }
  });
}

// ---- UI：選擇傳送對象（改為可先選人，再等待連線）----
export function showMemberSelectForFile(file) {
  const modal = document.getElementById("memberModal");
  const memberList = document.getElementById("memberList");

  memberList.innerHTML = "<h3 style='color: #667eea; margin-bottom: 15px;'>選擇傳送對象：</h3>";

  const others = getOtherMembersSafe();
  if (others.length === 0) {
    memberList.innerHTML += "<p style='color: #999; text-align: center;'>目前沒有其他成員</p>";
    modal.classList.remove("hidden");
    return;
  }

  // 顯示所有其他成員，但加上狀態
  others.forEach(([memberId, memberData]) => {
    const name = (memberData && memberData.name) ? memberData.name : ("使用者" + memberId.substring(0, 4));
    const dc = dataChannels[memberId];
    const dcOpen = !!(dc && dc.readyState === 'open');
    const connected = isPeerConnected(memberId);

    const statusText = dcOpen
      ? '可傳送'
      : (connected ? '連線已建立，等待通道…' : '連接中…');

    const item = document.createElement("div");
    item.className = "member-item";
    item.style.cursor = "pointer";
    item.innerHTML = `
      <div class="member-info">
        <div class="member-avatar">${name.charAt(0).toUpperCase()}</div>
        <span class="member-name">${name}</span>
      </div>
      <span style="color:${dcOpen ? '#16a34a' : '#a3a3a3'};font-size:14px;">${statusText}</span>
    `;

    item.onclick = async () => {
      try {
        if (!connected) {
          log(`⏳ 正在等待與 ${name} 建立連線…`);
        }
        // 等待 DataChannel open（最長 8 秒）
        await ensureChannelOpen(memberId, 8000);
        sendFile(file, memberId);
        modal.classList.add("hidden");
      } catch (e) {
        alert(`與 ${name} 的連線尚未就緒，請稍後再試（${e.message || e}）`);
      }
    };

    memberList.appendChild(item);
  });

  modal.classList.remove("hidden");
}

// ---- 收到的 DataChannel 訊息 ----
function handleDataChannelMessage(data, peerId) {
  if (typeof data === 'string') {
    const message = JSON.parse(data);
    if (message.type === 'file-meta') {
      const transferId = message.transferId;
      fileTransfers[transferId] = {
        fileName: message.fileName,
        fileSize: message.fileSize,
        fileType: message.fileType,
        chunks: [],
        receivedSize: 0,
        totalChunks: message.totalChunks,
        senderId: peerId,
        senderName: currentMembers?.[peerId]?.name || "使用者"
      };
      const senderName = currentMembers?.[peerId]?.name || "使用者";
      addFileToList(transferId, message.fileName, message.fileSize, senderName, false);
      log(`📥 準備接收檔案: ${message.fileName} (${formatFileSize(message.fileSize)})`);
    } else if (message.type === 'file-chunk-ack') {
      const transfer = fileTransfers[message.transferId];
      if (transfer && transfer.isSending) {
        sendNextChunk(message.transferId, peerId);
      }
    }
  } else {
    handleFileChunk(data, peerId);
  }
}

function handleFileChunk(arrayBuffer, peerId) {
  const transferIdBuffer = arrayBuffer.slice(0, 36);
  const transferId = new TextDecoder().decode(transferIdBuffer);
  const chunkData = arrayBuffer.slice(36);

  const transfer = fileTransfers[transferId];
  if (!transfer) return;

  transfer.chunks.push(chunkData);
  transfer.receivedSize += chunkData.byteLength;

  updateFileProgress(transferId, transfer.receivedSize, transfer.fileSize);

  const channel = dataChannels[peerId];
  if (channel && channel.readyState === 'open') {
    channel.send(JSON.stringify({ type: 'file-chunk-ack', transferId }));
  }

  if (transfer.receivedSize >= transfer.fileSize) {
    completeFileReceive(transferId);
  }
}

function completeFileReceive(transferId) {
  const transfer = fileTransfers[transferId];
  if (!transfer) return;

  const blob = new Blob(transfer.chunks, { type: transfer.fileType });
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

// ---- 發送檔案 ----
export async function sendFile(file, targetPeerId) {
  // 若通道尚未 open，先等它開
  try {
    await ensureChannelOpen(targetPeerId, 8000);
  } catch (e) {
    alert('與該成員的連接未建立，請稍後再試');
    return;
  }

  const channel = dataChannels[targetPeerId];
  if (!channel || channel.readyState !== 'open') {
    alert('與該成員的連接未建立');
    return;
  }

  const transferId = `${currentUserId}_${Date.now()}`;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  fileTransfers[transferId] = {
    file,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    totalChunks,
    currentChunk: 0,
    isSending: true,
    targetPeerId
  };

  const userName = '我';
  addFileToList(transferId, file.name, file.size, userName, true);

  channel.send(JSON.stringify({
    type: 'file-meta',
    transferId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    totalChunks
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
    const transferIdBuffer = new TextEncoder().encode(transferId.padEnd(36, ' '));
    const combinedBuffer = new Uint8Array(transferIdBuffer.length + e.target.result.byteLength);
    combinedBuffer.set(new Uint8Array(transferIdBuffer), 0);
    combinedBuffer.set(new Uint8Array(e.target.result), transferIdBuffer.length);

    try {
      channel.send(combinedBuffer.buffer);
      transfer.currentChunk++;
      updateFileProgress(transferId, transfer.currentChunk * CHUNK_SIZE, transfer.fileSize);
    } catch (err) {
      console.error('發送chunk失敗:', err);
    }
  };
  reader.readAsArrayBuffer(chunk);
}

// ---- 取消檔案傳輸 ----
export function cancelFileTransfer(transferId) {
  const transfer = fileTransfers[transferId];
  if (transfer && transfer.isSending) {
    transfer.isSending = false;
    updateFileStatus(transferId, 'cancelled');
    log(`❌ 已取消發送: ${transfer.fileName}`);
  }
}

// ---- input / drop 事件（保留原行為）----
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('fileDropZone');

if (fileInput) {
  fileInput.addEventListener('change', (e) => {
    isFileDialogOpen = false;
    const files = e.target.files;
    if (files && files.length > 0) {
      showMemberSelectForFile(files[0]);
    }
    fileInput.value = '';
  });
  fileInput.addEventListener('cancel', () => { isFileDialogOpen = false; });
}

if (dropZone) {
  dropZone.addEventListener('click', () => {
    if (isFileDialogOpen) return;
    isFileDialogOpen = true;
    fileInput?.click();
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
    if (files && files.length > 0) {
      showMemberSelectForFile(files[0]);
    }
  });
}
