import { currentMembers, currentUserId, getOtherMembers } from './members.js';
import { log, addFileToList, updateFileProgress, updateFileStatus, formatFileSize } from './ui.js';

export const dataChannels = {};
let fileTransfers = {};
const CHUNK_SIZE = 16384;
let isFileDialogOpen = false;

// 設定 DataChannel 事件監聽並保存 Channel 引用
export function setupDataChannel(channel, peerId) {
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
  dataChannels[peerId] = channel;
}

// 移除指定 Peer 的 DataChannel 引用
export function removeDataChannel(peerId) {
  if (dataChannels[peerId]) {
    delete dataChannels[peerId];
  }
}

// 處理收到的 DataChannel 訊息
function handleDataChannelMessage(data, peerId) {
  if (typeof data === 'string') {
    const message = JSON.parse(data);
    if (message.type === 'file-meta') {
      // 接收檔案元數據，準備接收檔案
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
      const senderName = currentMembers[peerId]?.name || "使用者";
      addFileToList(transferId, message.fileName, message.fileSize, senderName, false);
      log(`📥 準備接收檔案: ${message.fileName} (${formatFileSize(message.fileSize)})`);
    } else if (message.type === 'file-chunk-ack') {
      // 收到回覆，發送下一個檔案區塊
      const transfer = fileTransfers[message.transferId];
      if (transfer && transfer.isSending) {
        sendNextChunk(message.transferId, peerId);
      }
    }
  } else {
    // 接收檔案區塊資料
    handleFileChunk(data, peerId);
  }
}

// 處理收到的檔案區塊
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
    channel.send(JSON.stringify({ type: 'file-chunk-ack', transferId: transferId }));
  }
  if (transfer.receivedSize >= transfer.fileSize) {
    completeFileReceive(transferId);
  }
}

// 完成檔案接收後，合併檔案並觸發下載
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

// 傳送檔案給指定的 Peer
export async function sendFile(file, targetPeerId) {
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
  const userName = '我';
  addFileToList(transferId, file.name, file.size, userName, true);
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

// 傳送下一個檔案區塊
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

// 獲取已連接的其他成員列表
function getConnectedMembers() {
  return getOtherMembers().filter(([memberId]) => {
    const channel = dataChannels[memberId];
    return channel && channel.readyState === 'open';
  });
}

// 顯示檔案傳送對象選擇清單
function showMemberSelectForFile(file) {
  const modal = document.getElementById("memberModal");
  const memberList = document.getElementById("memberList");
  memberList.innerHTML = "<h3 style='color: #667eea; margin-bottom: 15px;'>選擇傳送對象：</h3>";
  const otherMembers = getOtherMembers();
  if (otherMembers.length === 0) {
    memberList.innerHTML += "<p style='color: #999; text-align: center;'>目前沒有其他成員</p>";
    modal.classList.remove("hidden");
    return;
  }
  const availableMembers = getConnectedMembers();
  if (availableMembers.length === 0) {
    memberList.innerHTML += "<p style='color: #999; text-align: center;'>與其他成員的連接尚未建立，請稍後再試</p>";
    modal.classList.remove("hidden");
    return;
  }
  availableMembers.forEach(([memberId, memberData]) => {
    const name = memberData.name || "使用者" + memberId.substring(0, 4);
    const memberItem = document.createElement("div");
    memberItem.className = "member-item";
    memberItem.style.cursor = "pointer";
    memberItem.innerHTML = `
      <div class="member-info">
        <div class="member-avatar">${name.charAt(0).toUpperCase()}</div>
        <span class="member-name">${name}</span>
      </div>
      <span style="color: #667eea;">➤</span>
    `;
    memberItem.onclick = () => {
      sendFile(file, memberId);
      modal.classList.add("hidden");
    };
    memberList.appendChild(memberItem);
  });
  modal.classList.remove("hidden");
}

// 檔案選擇與拖放事件處理
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('fileDropZone');

fileInput.addEventListener('change', (e) => {
  isFileDialogOpen = false;
  const files = e.target.files;
  if (files.length > 0) {
    showMemberSelectForFile(files[0]);
  }
  fileInput.value = '';
});

fileInput.addEventListener('cancel', () => {
  isFileDialogOpen = false;
});

dropZone.addEventListener('click', () => {
  if (isFileDialogOpen) return;
  isFileDialogOpen = true;
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
    showMemberSelectForFile(files[0]);
  }
});

// 取消正在進行的檔案傳輸
export function cancelFileTransfer(transferId) {
  const transfer = fileTransfers[transferId];
  if (transfer && transfer.isSending) {
    transfer.isSending = false;
    updateFileStatus(transferId, 'cancelled');
    log(`❌ 已取消發送: ${transfer.fileName}`);
  }
}
