import { log } from './ui.js';

let screenStream = null;

// 開始螢幕分享
export async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
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
}

// 停止螢幕分享
export function stopScreenShare() {
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
