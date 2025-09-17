// extension/content.js
// DreamWeb Overlay — Built around Chrome's on‑device Summarizer API.
// - Summarizes the current page into adaptive slides (8–30) with multi‑sentence bodies.
// - Generates a punchy, unique title for each slide via Prompt API (short, ≤6 words).
// - No "Scene 1/2" labels anywhere.
// - Translator API support for on‑device translation of rendered slides.
// - Optional Rewriter chip support to adjust tone (kept for users who have the origin trial).

const overlayId = '__dreamweb_overlay__';
let currentOpts = { tone: 'default', lang: 'en' };
let lastBuilt = null;
let pageImages = [];
let playAllState = { isPlaying:false, idx:0 };
let lastUrlKey = '';

// Listen from popup/background
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type === 'DREAM_START') {
    currentOpts = { ...currentOpts, ...(msg.opts||{}) };
    const data = extractReadable(document);
    const images = extractPageImages(document);
    pageImages = Array.isArray(images) ? images : [];
    lastUrlKey = location.href.split('#')[0];

    // Try local cache to keep UX snappy
    try {
      const cached = JSON.parse(localStorage.getItem('__dw_cache__:'+lastUrlKey) || 'null');
      if (cached?.script?.scenes?.length) {
        lastBuilt = cached;
        createOverlay();
        setOverlayStatus('Loading cached story…');
        updateProgress(60);
        renderDream({
          outline: cached.outline,
          script: cached.script,
          scenes: cached.scenes,
          title: cached.title || document.title,
          meta: { fromCache:true }
        });
      }
    } catch {}

    createOverlay();
    setOverlayStatus('Preparing story…');
    updateProgress(8);

    // Ask background to build (it may pass back scenes, or nothing)
    chrome.runtime.sendMessage({
      type: 'DREAM_BUILD',
      payload: { url: location.href, title: data.title, text: data.text, images, opts: currentOpts }
    });
  }

  if (msg?.type === 'DREAM_RENDER') {
    const { outline, script, scenes: rawScenes, meta, title } = msg.payload || {};
    lastBuilt = msg.payload;

    let sceneList = Array.isArray(script?.scenes) ? script.scenes : (Array.isArray(rawScenes) ? rawScenes : []);
    const ctx = extractReadable(document);

    // If none provided OR caller allows dynamic scenes (default), build via Summarizer
    const allowDynamic = msg.payload?.meta?.allowDynamicScenes !== false;
    if ((!sceneList || !sceneList.length) && ctx?.text) {
      const gen = await buildScenesFromContent(title || document.title, ctx.text);
      if (Array.isArray(gen) && gen.length) sceneList = gen;
    }

    // Optional polish without changing the count (keeps titles unique & short)
    try {
      if (sceneList && sceneList.length && allowDynamic) {
        sceneList = await maybeRetitleAndSummarize(sceneList, title || document.title, ctx.text);
      }
      if (lastBuilt?.script) lastBuilt.script.scenes = sceneList;
      try { localStorage.setItem('__dw_cache__:'+lastUrlKey, JSON.stringify(lastBuilt)); } catch {}
    } catch {}

    renderDream({
      outline,
      script: { ...(script||{}), scenes: sceneList },
      scenes: sceneList,
      title: title || document.title,
      meta: { ...(meta||{}), enriched: true }
    });
    updateProgress(100);
    setOverlayStatus(meta?.fromCache ? 'Loaded from cache.' : 'Ready.');
  }

  if (msg?.type === 'DREAM_IMAGE_READY') {
    const { idx, url } = msg.payload || {};
    const card = document.querySelector(`.dw-card[data-idx="${idx}"]`);
    if (card && url) {
      const imgEl = card.querySelector('.dw-img');
      const cvsEl = card.querySelector('.dw-canvas');
      imgEl.src = url;
      imgEl.onload = () => { imgEl.style.display = 'block'; if (cvsEl) cvsEl.style.display = 'none'; };
      imgEl.onerror = () => { imgEl.style.display = 'none'; if (cvsEl) cvsEl.style.display = 'block'; };
    }
  }
});

// ---- DOM extraction (inline; no imports) ----
function extractReadable(doc) {
  const title = doc.querySelector('h1')?.innerText?.trim() || doc.title || 'Untitled';
  let container = doc.querySelector('article, main');
  let parts = [];
  if (container) {
    parts = [...container.querySelectorAll('h2,h3,p,li')].map(n => n.innerText?.trim()).filter(Boolean);
  } else {
    parts = [...doc.querySelectorAll('p')].slice(0, 200).map(n => n.innerText?.trim()).filter(Boolean);
  }
  parts = parts.filter(p => p.length > 30 && !/cookies|subscribe|sign in|advert/i.test(p));
  return { title, text: parts.join('\n\n') };
}

function extractPageImages(doc) {
  const out = [];
  const nodes = Array.from(doc.images || []);
  for (const img of nodes) {
    try {
      const src = img.currentSrc || img.src || '';
      if (!/^https?:\/\//i.test(src)) continue;                // absolute only
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 200 || h < 200) continue;                        // ignore tiny
      const badSrc = /sprite|icon|logo|avatar|emoji|transparent|data:image/i.test(src);
      const badAlt = img.alt && /logo|icon/i.test(img.alt);
      if (badSrc || badAlt) continue;                          // ignore logos/ui
      out.push(src);
    } catch {}
  }
  // de-dup, cap to a dozen
  return Array.from(new Set(out)).slice(0, 12);
}

// ---- Overlay building ----
function createOverlay() {
  let root = document.getElementById(overlayId);
  if (root) return;

  root = document.createElement('div');
  root.id = overlayId;
  root.innerHTML = `
    <div class="dw-backdrop"></div>
    <div class="dw-shell" role="dialog" aria-modal="true">
      <div class="dw-header">
        <div class="dw-title"><i class="dw-dot"></i> DreamSlide </div>
        <div class="dw-controls">
          <div class="dw-toolbar">
            <span class="dw-tip">Navigate</span>
            <kbd class="dw-kbd">[</kbd><span class="dw-tip">prev</span>
            <kbd class="dw-kbd">]</kbd><span class="dw-tip">next</span>
            <kbd class="dw-kbd">Space</kbd><span class="dw-tip">play</span>
          </div>
          <select id="dw-lang" class="dw-select dw-focus-ring" aria-label="Language">
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="pt">Português</option>
            <option value="it">Italiano</option>
            <option value="nl">Nederlands</option>
            <option value="sv">Svenska</option>
            <option value="ru">Русский</option>
            <option value="ar">العربية</option>
            <option value="hi">हिन्दी</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="zh">中文</option>
            <option value="th">ไทย</option>
          </select>
          <button class="dw-chip dw-focus-ring" data-tone="default">Default</button>
          <button class="dw-chip dw-focus-ring" data-tone="kid-friendly">Kid</button>
          <button class="dw-chip dw-focus-ring" data-tone="skeptical">Skeptical</button>
          <button class="dw-chip dw-focus-ring" data-tone="optimistic">Optimistic</button>
          <button class="dw-chip dw-focus-ring" data-tone="expert">Expert</button>
          <button id="dw-playall" class="dw-btn primary dw-focus-ring" aria-label="Play all slides">▶ Play All</button>
          <button id="dw-close" class="dw-close dw-focus-ring" aria-label="Close overlay">✕</button>
        </div>
      </div>

      <div class="dw-statusbar">
        <div id="dw-status">Loading…</div>
        <div class="dw-progress" aria-label="Progress"><i id="dw-progress-bar" style="width:8%"></i></div>
      </div>

      <div id="dw-content" class="dw-content"></div>
    </div>
  `;
  document.body.appendChild(root);

  const playAllBtn = document.getElementById('dw-playall');
  if (playAllBtn) {
    playAllBtn.addEventListener('click', () => {
      if (playAllState.isPlaying) {
        speechSynthesis.cancel();
        playAllState.isPlaying = false;
        playAllBtn.textContent = '▶ Play All';
        return;
      }
      playAllState.isPlaying = true;
      playAllState.idx = 0;
      playAllBtn.textContent = '⏸ Stop';
      playNextScene();
    });
  }

  // events
  document.getElementById('dw-close').onclick = () => root.remove();
  const langSel = document.getElementById('dw-lang');
  langSel.value = currentOpts.lang;
  langSel.onchange = async () => {
    const target = langSel.value;
    const previous = currentOpts.lang || 'en';
    currentOpts.lang = target;
    if (!lastBuilt?.script) return;

    setOverlayStatus('Translating…');
    updateProgress(25);

    try {
      const used = await translateOverlayWithTranslator(target, previous);
      if (used) {
        const root=document.getElementById('__dreamweb_overlay__');
        if (root) root.dataset.lang = normalizeLang(target);
        setOverlayStatus('Translated with AI.');
        return;
      }
    } catch (e) {
      console.warn('Translator API failed, falling back:', e);
    }

    // Fallback to previous background behavior
    chrome.runtime.sendMessage({
      type: 'DREAM_RERENDER_LANG',
      payload: { url: location.href, script: lastBuilt.script, opts: currentOpts }
    });
  };

  document.querySelectorAll('.dw-chip').forEach(btn => {
    btn.onclick = async () => {
      document.querySelectorAll('.dw-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentOpts.tone = btn.dataset.tone;
      if (!lastBuilt?.script) return;
      setOverlayStatus('Rewriting tone…');
      updateProgress(25);

      // Try Rewriter API first; fallback to background if unavailable
      try {
        const used = await rewriteOverlayWithRewriter(currentOpts.tone);
        if (used) {
          updateProgress(80);
          setOverlayStatus('Tone updated with AI.');
          return;
        }
      } catch (err) {
        console.warn('Rewriter failed, falling back:', err);
      }

      chrome.runtime.sendMessage({
        type: 'DREAM_RERENDER_TONE',
        payload: { url: location.href, script: lastBuilt.script, opts: currentOpts }
      });
    };
  });

  // keyboard nav
  window.addEventListener('keydown', onKeys);
}

function onKeys(e){
  const items = [...document.querySelectorAll('.dw-card[data-idx]')];
  if (!items.length) return;
  const cur = document.activeElement?.closest?.('.dw-card[data-idx]');
  const idx = cur ? Number(cur.dataset.idx) : 0;

  if (e.key === ']') {
    e.preventDefault();
    const next = items[Math.min(idx+1, items.length-1)];
    next?.querySelector('button.dw-play')?.focus();
    next?.scrollIntoView({ behavior:'smooth', block:'center' });
  }
  if (e.key === '[') {
    e.preventDefault();
    const prev = items[Math.max(idx-1, 0)];
    prev?.querySelector('button.dw-play')?.focus();
    prev?.scrollIntoView({ behavior:'smooth', block:'center' });
  }
  if (e.code === 'Space'){
    const btn = (cur || items[0])?.querySelector('button.dw-play');
    if (btn){ e.preventDefault(); btn.click(); }
  }
}

function setOverlayStatus(txt) {
  const s = document.getElementById('dw-status');
  if (s) s.textContent = txt;
}
function updateProgress(pct){
  const bar = document.getElementById('dw-progress-bar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

// ---------- Sanitizers ----------
function sanitizeText(raw = '') {
  let s = String(raw || '').trim();

  // Remove junk prefixes
  s = s.replace(/^\s*[-•]+\s*/, '');
  s = s.replace(/^rewrite\b[^:]*:\s*/i, '');
  s = s.replace(/^in\s+\d+[-–]?\d*\s*sentences?:?\s*/i, '');
  s = s.replace(/^\(?\s*slide\s*\d+\)?\s*/i, '');
  s = s.replace(/\s+/g, ' ').trim();

  // Limit only if *really* massive (keep multi-sentence slides)
  const words = s.split(/\s+/);
  if (words.length > 500) {
    s = words.slice(0, 500).join(' ') + '…';
  }

  if (s && !/[.!?]$/.test(s)) s += '.';
  return s;
}

function sanitizeTitle(raw=''){
  let t = String(raw || '');
  t = t.replace(/^\(?\s*(scene|slide)\s*\d+\)?\s*:\s*/i,'');
  t = t.replace(/^rewrite\b[^:]*:\s*/i,'');
  t = t.replace(/\s+/g,' ').trim();
  return t || 'Untitled';
}

// --- Rewriter API (optional; origin trial) ---
function toneToContext(tone) {
  switch (tone) {
    case 'kid-friendly':
      return 'Rewrite for kids aged 8–10: simple words, warm and encouraging, short sentences, no jargon.';
    case 'skeptical':
      return 'Rewrite with a cautious, evidence-seeking tone: neutral, avoids hype, briefly notes uncertainty.';
    case 'optimistic':
      return 'Rewrite upbeat and inspiring, focus on the positive, energetic but not cheesy.';
    case 'expert':
      return 'Rewrite concise and expert: precise, neutral, assumes an informed reader, no fluff.';
    case 'default':
    default:
      return 'Rewrite clear and friendly for a general audience.';
  }
}

async function getRewriterInstance(sharedContext, monitorProgress = true) {
  if (!('Rewriter' in self)) return null;
  const availability = await Rewriter.availability();
  if (availability === 'unavailable') return null;

  const opts = {
    sharedContext,
    tone: 'as-is',
    format: 'plain-text',
    length: 'as-is',
    monitor(m) {
      if (!monitorProgress) return;
      m.addEventListener('downloadprogress', (e) => {
        const pct = Math.floor((e.loaded || 0) * 100);
        setOverlayStatus(`Generating content…`);
        updateProgress(Math.min(50, 10 + pct * 0.4));
      });
    }
  };

  try {
    const rewriter = await Rewriter.create(opts);
    return rewriter || null;
  } catch {
    return null;
  }
}

async function rewriteOverlayWithRewriter(tone) {
  const ctx = toneToContext(tone);
  const rewriter = await getRewriterInstance('DreamSlide is rewriting slide blurbs.', true);
  if (!rewriter) return false;

  // Hero hook
  try {
    const heroP = document.querySelector('.dw-hero .dw-hero-text p');
    if (heroP && heroP.textContent?.trim()) {
      const out = await rewriter.rewrite(heroP.textContent, { context: ctx });
      if (out && typeof out === 'string') heroP.textContent = sanitizeText(out);
    }
  } catch {}

  // Each slide
  const cards = Array.from(document.querySelectorAll('.dw-card[data-idx]'));
  for (let i = 0; i < cards.length; i++) {
    const p = cards[i].querySelector('.dw-copy p');
    if (!p) continue;
    const original = p.textContent || '';
    if (!original.trim()) continue;
    try {
      const rewritten = await rewriter.rewrite(original, { context: ctx });
      if (rewritten && typeof rewritten === 'string') p.textContent = sanitizeText(rewritten);
    } catch {}
  }

  try { rewriter.destroy && rewriter.destroy(); } catch {}
  return true;
}

/* ===== Translator API (built-in, on-device) ===== */
function normalizeLang(l = 'en') {
  const m = String(l || 'en').toLowerCase();
  const map = { 'zh-cn':'zh', 'zh-hans':'zh', 'zh-hant':'zh', 'pt-br':'pt', 'pt-pt':'pt' };
  return map[m] || m.split('-')[0] || 'en';
}

async function getTranslatorInstance(sourceLanguage, targetLanguage) {
  if (!('Translator' in self)) return null;

  try {
    const avail = await Translator.availability({
      sourceLanguage: normalizeLang(sourceLanguage || 'en'),
      targetLanguage: normalizeLang(targetLanguage || 'en'),
    });
    if (avail === 'unavailable') return null;
  } catch {}

  try {
    const translator = await Translator.create({
      sourceLanguage: normalizeLang(sourceLanguage || 'en'),
      targetLanguage: normalizeLang(targetLanguage || 'en'),
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const pct = Math.floor((e.loaded || 0) * 100);
          setOverlayStatus(`Translating to ${targetLanguage}…`);
          updateProgress(Math.min(60, 20 + pct * 0.4));
        });
      },
    });
    return translator || null;
  } catch {
    return null;
  }
}

/** Translate hero + all slide titles & paragraphs in place. */
async function translateOverlayWithTranslator(targetLanguage, sourceLanguage) {
  const target = normalizeLang(targetLanguage || 'en');
  let source = normalizeLang(sourceLanguage || (navigator.language || 'en'));
  if (source === target) return true;

  const translator = await getTranslatorInstance(source, target);
  if (!translator) return false;

  const heroTitle = document.querySelector('.dw-hero .dw-page-title');
  const heroP = document.querySelector('.dw-hero .dw-hero-text p');
  const sceneTitles = Array.from(document.querySelectorAll('.dw-card[data-idx] .dw-copy .dw-scene-title'));
  const sceneParas = Array.from(document.querySelectorAll('.dw-card[data-idx] .dw-copy p'));

  const translateNode = async (node) => {
    if (!node || !node.textContent) return;
    const raw = node.textContent.trim();
    if (!raw) return;
    try {
      const out = await translator.translate(raw);
      if (typeof out === 'string' && out.trim()) node.textContent = out.trim();
    } catch {}
  };

  await translateNode(heroTitle);
  await translateNode(heroP);
  for (const n of sceneTitles) await translateNode(n);
  for (const n of sceneParas) await translateNode(n);

  try {
    const root = document.getElementById('__dreamweb_overlay__');
    if (root) root.dataset.lang = normalizeLang(target);
  } catch {}

  try { translator.destroy && translator.destroy(); } catch {}
  return true;
}

// ---- image loading helper (aggressive eager to avoid missed loads) ----
function makeLazy(imgEl, src) {
  try {
    if (!imgEl) return;
    imgEl.loading = 'eager';
    imgEl.decoding = 'sync';
    imgEl.src = src;
  } catch {}
}

// ---- Content segmentation helpers ----
function splitIntoBlocks(text = '') {
  const chunks = String(text || '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (let c of chunks) {
    if (/^\s*(?:\d+[\).\s]|[-•*]\s)/m.test(c)) {
      const items = c.split(/\n\s*(?=\d+[\).\s]|[-•*]\s)/).map(s=>s.trim()).filter(Boolean);
      out.push(...items);
    } else {
      out.push(c);
    }
  }
  return out;
}

// ---------- Summarizer + Prompt title helpers ----------
async function getSummarizerInstance(options = {}) {
  if (!('Summarizer' in self)) return null;
  const availability = await Summarizer.availability().catch(() => 'unavailable');
  if (availability === 'unavailable') return null;
  try {
    const summarizer = await Summarizer.create({
      sharedContext: options.sharedContext || 'Create clear, faithful summaries for a slide deck.',
      type: options.type || 'tldr',
      format: options.format || 'plain-text',
      length: options.length || 'long', // aim for 4–6 sentences
      monitor(m) {
        let statusSet = false;
        m.addEventListener('downloadprogress', (e) => {
          const pct = Math.floor((e.loaded || 0) * 100);
          // Only set status once, update progress each time
          if (e && typeof e.loaded === 'number') {
            if (!statusSet) {
              setOverlayStatus('AI is generating detailed slides…');
              statusSet = true;
            }
            updateProgress(Math.min(85, 30 + e.loaded * 0.6));
          }
        });
      }
    });
    return summarizer || null;
  } catch {
    return null;
  }
}

// Prompt API ONLY to mint a short, punchy title (≤6 words)
// Prompt API ONLY to mint a short, punchy title (≤6 words)
async function titleFromPromptAPI(sectionText = '', pageTitle = '') {
    const norm = (s = '') => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  
    const quickHeuristic = (text = '') => {
      const s = String(text || '').split(/(?<=[.!?])\s+/)[0] || String(text || '');
      const STOP = new Set([
        'the','a','an','and','or','but','for','nor','so','to','of','in','on','at','by',
        'with','from','about','as','into','over','after','before','between','through',
        'during','without','within','along','across','behind','beyond','under','above'
      ]);
      const tokens = s.replace(/[.!?,"“”'()\-\u2013\u2014]+/g,' ')
                      .trim()
                      .split(/\s+/)
                      .filter(w => w && !STOP.has(w.toLowerCase()));
      return sanitizeTitle(tokens.slice(0, 6).join(' ')) || 'Key Insight';
    };
  
    const src  = String(sectionText || '').slice(0, 1200);
    const page = String(pageTitle  || '').slice(0, 160);
    if (!src && !page) return 'Key Insight';
  
    try {
      if (!('LanguageModel' in self)) return quickHeuristic(src || page);
      const availability = await LanguageModel.availability().catch(() => 'unavailable');
      if (availability === 'unavailable') return quickHeuristic(src || page);
  
      const params  = await LanguageModel.params().catch(() => ({}));
      const session = await LanguageModel.create({
        initialPrompts: [{
          role: 'system',
          content: 'You write concise, punchy slide titles. 3–6 words, no quotes, no numbering, not a full sentence, no trailing punctuation.'
        }],
        temperature: params?.defaultTemperature ?? 0.7,
        topK:        params?.defaultTopK ?? 3
      });
  
      try {
        const res = await session.prompt([
          { role: 'user', content: [
              { type: 'text', value:
  `Page: ${page}
  
  Text:
  ${src}
  
  Constraints:
  - Return ONLY a title of 3–6 words.
  - No quotes, numbers, or labels.
  - Do NOT reuse phrases verbatim from the text.
  - Use a different angle than the body text.` }
          ]}
        ]);
  
        let t = sanitizeTitle(String(res || '').trim());
        const srcNorm = norm(src);
  
        // If verbatim/contained, get an alternative angle
        if (!t || !t.trim() || srcNorm.includes(norm(t)) || norm(t) === srcNorm) {
          const alt = await session.prompt(
            `Alternative angle title, 3–6 words, obey constraints. Source:\n${src}`
          );
          const altT = sanitizeTitle(String(alt || '').trim());
          if (altT && !srcNorm.includes(norm(altT))) t = altT;
        }
  
        if (!t || srcNorm.includes(norm(t))) t = quickHeuristic(src || page);
        return t;
      } catch {
        return quickHeuristic(src || page);
      } finally {
        try { session.destroy && session.destroy(); } catch {}
      }
    } catch {
      return quickHeuristic(src || page);
    }
  }

/**
 * Build slides from page content.
 * - Overview slide via Summarizer (whole page)
 * - Then per-section summaries via Summarizer
 * - Titles via Prompt API (short, no numbering)
 * - Count adapts to content (8–30)
 */
async function buildScenesFromContent(pageTitle = '', pageText = '') {
  try {
    const MAX = 30, MIN = 8;

    // Prepare sections (prefer substantial blocks)
    const sections = splitIntoBlocks(pageText || '').filter(b => (b || '').trim().split(/\s+/).length > 30);

    const summarizer = await getSummarizerInstance({
      sharedContext: `Create readable slide paragraphs for a deck titled "${pageTitle}".`,
      type: 'tldr',
      format: 'plain-text',
      length: 'long'
    });

    const slides = [];

    // Overview first (whole page)
    if (summarizer) {
      try {
        const overview = await summarizer.summarize(String(pageText || '').slice(0, 18000), {
          context: 'Write 4–6 full sentences that capture the gist. No bullets.'
        });
        const title = await titleFromPromptAPI(pageTitle, pageTitle);
        slides.push({ title, line: sanitizeText(String(overview || '')) });
      } catch {}
    }

    // Per-section summaries
    for (let i = 0; i < sections.length && slides.length < MAX; i++) {
      const block = sections[i];
      let summary = '';
      if (summarizer) {
        try {
          summary = await summarizer.summarize(block.slice(0, 8000), {
            context: 'Produce 4–6 full sentences suitable for a single slide. No lists.'
          });
        } catch {}
      }
      if (!summary) {
        // Fallback: take 3–6 sentences from the block
        summary = block.split(/(?<=[.!?])\s+/).slice(0, 6).join(' ') || block;
      }
      const title = await titleFromPromptAPI(block, pageTitle);
      slides.push({ title, line: sanitizeText(String(summary || block)) });
    }

    // Ensure a minimum count if content is short
    if (slides.length < MIN) {
      const parts = String(pageText || '').split(/(?<=[.!?])\s+/).filter(Boolean);
      for (const p of parts) {
        if (slides.length >= MIN) break;
        slides.push({ title: sanitizeTitle(p.split(/\s+/).slice(0, 6).join(' ')), line: sanitizeText(p) });
      }
    }

    return slides.slice(0, MAX);
  } catch (e) {
    console.warn('buildScenesFromContent (Summarizer) failed:', e);
    // Heuristic fallback (no APIs)
    const blocks = splitIntoBlocks(pageText || '');
    const out = [];
    const ov = (pageText || '').split(/(?<=[.!?])\s+/).slice(0, 5).join(' ');
    out.push({ title: sanitizeTitle(pageTitle || 'Overview'), line: sanitizeText(ov) });
    for (const b of blocks) {
      if (out.length >= 30) break;
      out.push({ title: sanitizeTitle(b.split(/\s+/).slice(0, 6).join(' ')), line: sanitizeText(b) });
    }
    return out;
  }
}

function renderDream({ outline, script, scenes, title, meta }) {
  const content = document.getElementById('dw-content');
  if (!content) return;
  content.innerHTML = '';
  const fallbackImages = Array.isArray(pageImages) ? pageImages : [];
  const sceneList = Array.isArray(script?.scenes)
    ? script.scenes
    : (Array.isArray(scenes) ? scenes : []);

  if (!sceneList.length) {
    const empty = document.createElement('section');
    empty.className = 'dw-card';
    empty.innerHTML = `
      <div class="dw-copy">
        <div class="dw-scene-title">No content found on this page</div>
        <p>This page has little readable text. Try any article (e.g., a Wikipedia page), or press “Enter Story Mode” again after opening an article.</p>
      </div>`;
    content.appendChild(empty);
    return;
  }

  // HERO
  const hero = document.createElement('section');
  hero.className = 'dw-card dw-hero';
  hero.innerHTML = `
    <div class="dw-hero-media">
      <img class="dw-img" alt="" style="display:none;" />
      <canvas class="dw-canvas" width="1280" height="720" aria-hidden="true"></canvas>
      <div class="dw-hero-overlay"
           style="position:absolute;inset:0;
                  background:linear-gradient(to top,
                    rgba(0,0,0,0.7),
                    rgba(0,0,0,0.4) 50%,
                    rgba(0,0,0,0) 80%);
                  pointer-events:none;"></div>
    </div>
    <div class="dw-hero-text">
      <div class="dw-page-title">${escapeHtml(title || document.title)}</div>
      <p>${escapeHtml(sanitizeText(script?.hook || 'Let’s begin…'))}</p>
      <div class="dw-meta">${meta?.availability ? `Model: ${escapeHtml(String(meta.availability))}` : ''}</div>
      <div class="dw-tip">Tip: Use <span class="dw-kbd">[</span> <span class="dw-kbd">]</span> to move slides, <span class="dw-kbd">Space</span> to play narration.</div>
    </div>
  `;
  content.appendChild(hero);
  const heroImgEl    = hero.querySelector('.dw-img');
  const heroCanvasEl = hero.querySelector('.dw-canvas');

  // Track used images so the hero image won't repeat on the first slide
  const usedImages = new Set();

  const firstWithImage = sceneList.find(s => s && s.image);
  const heroSrc = (firstWithImage && firstWithImage.image) || (fallbackImages[0] || '');
  if (heroSrc) usedImages.add(heroSrc);

  heroImgEl.setAttribute('referrerpolicy', 'no-referrer');
  heroImgEl.setAttribute('crossorigin', 'anonymous');

  if (heroSrc) {
    heroImgEl.loading = 'eager';
    heroImgEl.decoding = 'sync';
    heroImgEl.src = heroSrc;
    heroImgEl.onload = () => { heroImgEl.style.display = 'block'; if (heroCanvasEl) heroCanvasEl.style.display = 'none'; };
    heroImgEl.onerror = () => { heroImgEl.style.display = 'none'; if (heroCanvasEl) heroCanvasEl.style.display = 'block'; paintCanvasGradient(heroCanvasEl, (script?.hook||'') + title); };
  } else {
    paintCanvasGradient(heroCanvasEl, (script?.hook||'') + title);
  }

  // SCENES
  sceneList.forEach((sc, i) => {
    const card = document.createElement('section');
    card.className = 'dw-card';
    card.dataset.idx = String(i);
    card.setAttribute('role','region');
    card.setAttribute('aria-label', 'Story slide');
    card.innerHTML = `
      <div class="dw-media">
        <img class="dw-img" alt="" style="display:none;" />
        <canvas class="dw-canvas" width="1280" height="720" aria-hidden="true"></canvas>
      </div>
      <div class="dw-copy">
        <div class="dw-scene-title">${escapeHtml(sanitizeTitle(sc.title || 'Untitled'))}</div>
        <p>${escapeHtml(sanitizeText(sc.line || ''))}</p>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
          <button class="dw-btn secondary dw-play dw-focus-ring" aria-label="Play narration for slide ${i+1}">Play narration</button>
          <span class="dw-tip">~8s</span>
        </div>
      </div>
    `;
    content.appendChild(card);

    const spin = document.createElement('div');
    spin.className = 'dw-loading';
    spin.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:#cdd4e5;pointer-events:none;';
    spin.setAttribute('role','status');
    spin.setAttribute('aria-live','polite');
    spin.textContent = 'Loading…';
    card.querySelector('.dw-media')?.appendChild(spin);

    const imgEl = card.querySelector('.dw-img');
    const cvsEl = card.querySelector('.dw-canvas');

    imgEl.onload = () => {
      imgEl.style.display = 'block';
      spin.style.display = 'none';
      if (cvsEl) cvsEl.style.display = 'none';
    };
    imgEl.onerror = () => {
      imgEl.style.display = 'none';
      spin.style.display = 'none';
      if (cvsEl) { cvsEl.style.display = 'block'; paintCanvasGradient(cvsEl, (sc.title||'') + (sc.line||'')); }
    };

    // Prefer the scene's own image; else choose a non-reused fallback
    let candidate = '';
    if (sc && sc.image && !usedImages.has(sc.image)) {
      candidate = sc.image;
    } else if (fallbackImages.length) {
      const L = fallbackImages.length;
      for (let step = 0; step < L; step++) {
        const idx2 = (i + step) % L;
        const cand = fallbackImages[idx2];
        if (cand && !usedImages.has(cand)) { candidate = cand; break; }
      }
    }
    if (candidate) usedImages.add(candidate);

    if (!candidate) {
      // Ask background to generate an AI image for the scene
      chrome.runtime.sendMessage({
        type: 'DREAM_GEN_IMAGE',
        payload: { idx: i, prompt: `${sc.title || ''} ${sc.line || ''}`.trim(), opts: currentOpts }
      });
    }

    imgEl.setAttribute('referrerpolicy', 'no-referrer');
    imgEl.setAttribute('crossorigin', 'anonymous');
    imgEl.loading = 'eager';
    imgEl.decoding = 'sync';

    if (candidate) {
      imgEl.src = candidate;
    } else {
      paintCanvasGradient(cvsEl, (sc.title||'') + (sc.line||''));
    }
  });

  // Narration (Web Speech)
  content.querySelectorAll('.dw-btn.dw-play').forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      const s = sceneList[idx] || {};
      speak(s.line ? String(s.line) : '', currentOpts.lang);
    });
  });
}

// ---- visuals & utils ----
function paintCanvasGradient(canvas, seed) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = canvas.width, H = canvas.height;
  const s = String(seed || '');

  // deterministic palette
  const base = Math.abs(hash(s)) % 360;
  const c1 = `hsl(${base}, 75%, 55%)`;
  const c2 = `hsl(${(base + 60) % 360}, 70%, 45%)`;
  const c3 = `hsl(${(base + 200) % 360}, 65%, 40%)`;

  if (canvas.__dwStop) { cancelAnimationFrame(canvas.__dwStop); canvas.__dwStop = null; }

  let t = 0;
  const bokeh = Array.from({ length: 10 }, (_, i) => ({
    r: 30 + ((hash(s + 'b' + i) >>> 3) % 120),
    x: ((hash(s + 'x' + i) % W) + W) % W,
    y: ((hash(s + 'y' + i) % H) + H) % H,
    sp: 0.15 + ((hash(s + 's' + i) & 255) / 255) * 0.4,
    a: 0.05 + ((hash(s + 'a' + i) & 127) / 127) * 0.12,
  }));

  function frame() {
    t += 0.006;

    const ang = t * 0.6 + (base * Math.PI / 180);
    const cx = W * (0.5 + 0.25 * Math.cos(ang));
    const cy = H * (0.5 + 0.25 * Math.sin(ang));
    const g = ctx.createLinearGradient(0, 0, cx, cy);
    g.addColorStop(0, c1);
    g.addColorStop(0.5, c2);
    g.addColorStop(1, c3);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const v = ctx.createRadialGradient(W/2, H/2, Math.min(W, H) * 0.2, W/2, H/2, Math.max(W, H) * 0.8);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < bokeh.length; i++) {
      const b = bokeh[i];
      const x = (b.x + Math.cos(t * b.sp + i) * 25 + W) % W;
      const y = (b.y + Math.sin(t * (b.sp * 0.9) + i) * 25 + H) % H;
      const rg = ctx.createRadialGradient(x, y, 0, x, y, b.r);
      rg.addColorStop(0, `rgba(255,255,255,${b.a})`);
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(x, y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Grain (sparse)
    const grain = 0.035;
    const imgData = ctx.getImageData(0, 0, W, H);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 320) {
      const n = (Math.random() - 0.5) * 255 * grain;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(imgData, 0, 0);

    canvas.__dwStop = requestAnimationFrame(frame);
  }

  frame();
}

function speak(text, lang = 'en') {
  const u = new SpeechSynthesisUtterance(text);
  const m = (lang || currentOpts.lang || 'en').toLowerCase();
  const map = {
    en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-PT', it: 'it-IT',
    nl: 'nl-NL', sv: 'sv-SE', ru: 'ru-RU', ar: 'ar-SA', hi: 'hi-IN',
    ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', th: 'th-TH'
  };
  u.lang = map[m.split('-')[0]] || 'en-US';
  u.rate = 1.0; u.pitch = 1.0;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

function playNextScene() {
  const cards = Array.from(document.querySelectorAll('.dw-card[data-idx]'));
  if (!playAllState.isPlaying || !cards.length) return;
  const i = playAllState.idx;
  const scene = (lastBuilt?.script?.scenes || [])[i] || {};
  const text = scene.line ? String(scene.line) : '';
  if (!text) { playAllState.idx = i + 1; return playNextScene(); }

  const u = new SpeechSynthesisUtterance(text);
  const m = (currentOpts.lang||'en').toLowerCase();
  const map={en:'en-US',es:'es-ES',fr:'fr-FR',de:'de-DE',pt:'pt-PT',it:'it-IT',nl:'nl-NL',sv:'sv-SE',ru:'ru-RU',ar:'ar-SA',hi:'hi-IN',ja:'ja-JP',ko:'ko-KR',zh:'zh-CN',th:'th-TH'};
  u.lang = map[m.split('-')[0]]||'en-US';
  u.onend = () => {
    playAllState.idx = i + 1;
    if (playAllState.idx >= cards.length) {
      playAllState.isPlaying = false;
      const b=document.getElementById('dw-playall'); if (b) b.textContent='▶ Play All';
      return;
    }
    cards[playAllState.idx]?.scrollIntoView({ behavior:'smooth', block:'center' });
    playNextScene();
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function hash(s) { s=String(s); let h=0; for (let i=0;i<s.length;i++) { h=(h<<5)-h+s.charCodeAt(i); h|=0; } return Math.abs(h); }
function escapeHtml(s=''){ return s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

