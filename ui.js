const PUBLIC_BASE_URL = "https://yang-s-k.github.io/web_RTC/";

export function log(msg) {
  const logEl = document.getElementById("log");
  logEl.textContent = msg;
  console.log(msg);
}

export function showInRoomUI(roomId) {
  document.getElementById("createSection").style.display = "none";
  document.getElementById("joinSection").style.display = "none";
  document.getElementById("roomInfo").classList.remove("hidden");
  document.getElementById("mainContent").classList.remove("hidden");
  document.getElementById("roomIdDisplay").textContent = "房號: " + roomId;
  document.getElementById("qrSection").style.display = "flex";
}

export function updateMemberCount(count) {
  const memberCountEl = document.getElementById("memberCount");
  memberCountEl.textContent = `👥 ${count} 人`;
}

export function updateRoomLinkUI(url) {
  const canvas = document.getElementById("qrcode");
  if (url && window.QRCode && typeof QRCode.toCanvas === "function") {
    QRCode.toCanvas(canvas, url, (err) => {
      if (err) log("❌ QR Code 生成失敗");
    });
  }
}

export function getRoomShareUrl(roomId) {
  const publicUrl = new URL(PUBLIC_BASE_URL);
  publicUrl.searchParams.set("room", roomId);
  return publicUrl.toString();
}

export function updateBrowserUrl(roomId) {
  const publicUrl = new URL(PUBLIC_BASE_URL);
  publicUrl.searchParams.set("room", roomId);
  if (window.location.origin === publicUrl.origin) {
    const newPath = publicUrl.pathname + publicUrl.search;
    history.replaceState(null, "", newPath);
  } else {
    history.replaceState(null, "", `${window.location.pathname}?room=${roomId}`);
  }
}

export function resetUI() {
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

export function addFileToList(transferId, fileName, fileSize, userName, isSending) {
  const fileList = document.getElementById('fileList');
  const fileItem = document.createElement('div');
  fileItem.className = 'file-item';
  fileItem.id = `file-${transferId}`;
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

export function updateFileProgress(transferId, loaded, total) {
  const progressBar = document.getElementById(`progress-${transferId}`);
  if (progressBar) {
    const percent = (loaded / total * 100).toFixed(1);
    progressBar.style.width = percent + '%';
  }
}

export function updateFileStatus(transferId, status) {
  const fileItem = document.getElementById(`file-${transferId}`);
  if (fileItem) {
    const statusText = status === 'completed' ? '✅ 完成' : '❌ 失敗';
    const infoDiv = fileItem.querySelector('.file-info > div > div:nth-child(2)');
    if (infoDiv) {
      infoDiv.innerHTML = infoDiv.innerHTML.replace(/(📤 發送中|📥 接收中)/, statusText);
    }
  }
}

export function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

export async function shareRoomLink(url) {
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
}

// === URL 與房號記憶 ===
export function setRoomParamInUrl(roomId) {
  const url = new URL(window.location.href);
  if (roomId) url.searchParams.set('room', roomId);
  else url.searchParams.delete('room');
  window.history.replaceState({}, '', url.toString());
}

export function rememberLastRoomId(roomId) {
  try { localStorage.setItem('lastRoomId', roomId || ''); } catch {}
}

export function getLastRoomId() {
  try { return localStorage.getItem('lastRoomId') || ''; } catch { return ''; }
}

export function fillJoinInputWithLastRoom() {
  const el = document.getElementById('joinRoomId');
  const id = getLastRoomId();
  if (el) el.value = id || '';
}


