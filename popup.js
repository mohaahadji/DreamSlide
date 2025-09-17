// extension/popup.js (unchanged logic, but adds pretty tone chips)
const tones = ['default', 'kid-friendly', 'skeptical', 'optimistic', 'expert'];
const logEl = document.getElementById('log');
const toneWrap = document.getElementById('tones');
const langSel = document.getElementById('lang');

let state = { tone: 'default', lang: 'en' };

tones.forEach(t => {
  const el = document.createElement('div');
  el.className = 'chip' + (t === state.tone ? ' active' : '');
  el.textContent = t;
  el.onclick = () => {
    state.tone = t;
    [...toneWrap.children].forEach(c => c.classList.remove('active'));
    el.classList.add('active');
  };
  toneWrap.appendChild(el);
});

langSel.onchange = () => (state.lang = langSel.value);

document.getElementById('start').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: 'DREAM_START', opts: { tone: state.tone, lang: state.lang } });
};

document.getElementById('clear').onclick = async () => {
    const res = await chrome.runtime.sendMessage({ type: 'DREAM_CLEAR_CACHE' }).catch(() => null);
    writeLog(res?.ok ? 'Cache cleared.' : 'Failed to clear cache.');
};

function writeLog(s) { logEl.textContent += `${s}\n`; }
chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === 'DREAM_LOG') writeLog(msg.message); });