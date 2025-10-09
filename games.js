import { log } from './ui.js';

// 監聽遊戲卡片的點擊事件
document.querySelectorAll('.game-card').forEach(card => {
  card.addEventListener('click', () => {
    const gameName = card.querySelector('.game-title').textContent;
    log(`🎮 選擇遊戲: ${gameName}`);
    alert(`即將開始 ${gameName}！\n(遊戲功能開發中...)`);
  });
});
