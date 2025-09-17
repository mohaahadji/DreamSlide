// extension/background.js

// === AI + Cache helpers inline ===
const CACHE_VERSION = 'titles_v2';

function sendToTab(tabId, msg) {
    if (!tabId) return;
    try { chrome.tabs.sendMessage(tabId, msg); } catch (e) { console.warn('sendToTab failed:', e?.message); }
  }

  function postStatus(tabId, text) {
    sendToTab(tabId, { type: 'DREAM_STATUS', status: String(text || '') });
  }

// Send logs back to popup
function postPopupLog(message) {
    chrome.runtime?.sendMessage?.({ type: 'DREAM_LOG', message });
  }
  
  // Prompt API availability
  async function checkAvailabilityWithProgress() {
  if (!('LanguageModel' in self)) return 'unavailable';
  try {
    const availability = await LanguageModel.availability();
    // In a SW, don’t create or download; just report status.
    return availability; // 'ready' | 'downloadable' | 'unavailable'
  } catch {
    return 'unavailable';
  }
}
  
  // Create session or fallback mock
  async function createSession() {
    if (!('LanguageModel' in self)) return mockSession();
    try {
      const params = await LanguageModel.params();
      return await LanguageModel.create({
        initialPrompts: [
          { role: 'system', content: 'You are a cinematic, accurate web explainer.' }
        ],
        temperature: params?.defaultTemperature ?? 1,
        topK: params?.defaultTopK ?? 3
      });
    } catch {
      return mockSession();
    }
  }
  
  function mockSession() {
    return {
      prompt: async (p) => "• " + String(p).slice(0, 40),
      destroy: () => {}
    };
  }
  
  // Simple cache (chrome.storage.local)
  async function cacheGet(key) {
    const all = (await chrome.storage.local.get(['dreamCache']))['dreamCache'] || {};
    return all[key];
  }
  async function cacheSet(key, value) {
    const all = (await chrome.storage.local.get(['dreamCache']))['dreamCache'] || {};
    all[key] = value;
    await chrome.storage.local.set({ dreamCache: all });
  }
  async function cacheClear() {
    await chrome.storage.local.remove(['dreamCache']);
  }
  
  // === Background message handling ===
  chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    try {
        if (msg?.type === 'DREAM_BUILD') {
            const { url, title, text, images: pageImages = [], opts } = msg.payload || {};
            const tabId = sender?.tab?.id;
            const key = (url || 'about:blank') + '::' + (opts?.tone || 'default') + '::' + (opts?.lang || 'en') + '::' + CACHE_VERSION;
          
            postStatus(tabId, 'Building…');
          
            let done = false;
            const watchdog = setTimeout(() => {
              if (done) return;
              const payload = {
                title: title || 'WebSlide',
                script: { hook: 'Preparing a quick preview…', scenes: [{ title: 'Loading…', line: 'Fetching and summarizing this page.' }] },
                meta: { availability: 'unknown', fromCache: false, timedOut: true }
              };
              sendToTab(tabId, { type: 'DREAM_RENDER', payload });
            }, 8000);
          
            (async () => {
              try {
                const cached = await cacheGet(key);
                if (cached) {
                  clearTimeout(watchdog); done = true;
                  sendToTab(tabId, { type: 'DREAM_RENDER', payload: { ...cached, meta: { ...(cached.meta||{}), fromCache: true } } });
                  return;
                }
          
                const availability = await checkAvailabilityWithProgress();
                const usingMock = availability !== 'ready';
                // Try to create a session only if already ready; otherwise mock
                let session;
                try {
                  if (availability === 'ready' && 'LanguageModel' in self) {
                    const params = await LanguageModel.params().catch(() => ({}));
                    session = await LanguageModel.create({
                      initialPrompts: [{ role: 'system', content: 'You are a cinematic, accurate web explainer.' }],
                      temperature: params?.defaultTemperature ?? 1,
                      topK: params?.defaultTopK ?? 3,
                    });
                  }
                } catch {}
                if (!session) session = { prompt: async (p) => String(p).slice(0, 120), destroy: () => {} };
          
                const base = (text || '').trim();
                const normalizedImages = Array.isArray(pageImages)
                ? pageImages.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u))
                : [];
                const fallback = base || 'This article discusses key ideas. WebSlide will transform it into scenes.';
                const parts = fallback.split(/[.!?]\s+/).map(s => s.trim()).filter(Boolean);
          
                let hook = 'Let’s explore this page as a story.';
                try {
                  if (!usingMock) {
                    const t = await session.prompt(
                      `Write a cinematic 1–2 sentence hook about: ${title || 'this page'}. No prefaces, no labels, no quotes.`
                    );
                    hook = sanitizeLine(t);
                  } else {
                    const t = `A quick tour of “${title || 'this page'}” — origins, turning points, and why it still matters today.`;
                    hook = sanitizeLine(t);
                  }
                } catch {}
          
                

                 
                  
                  function stripInstructionPhrases(s = '') {
                    // strip leaked prompt instructions
                    return String(s || '')
                      .replace(/^\s*turn the idea into one cinematic line[^.]*\.\s*/i, '')
                      .replace(/^\s*no prefaces,\s*no labels,\s*no quotes\.?\s*/i, '')
                      .replace(/^\s*\(?scene\s*\d+\)?\s*:\s*/i, '')
                      .trim();
                  }

                  function sanitizeLine(raw=''){
                    let s = stripInstructionPhrases(raw);
                    s = s.replace(/^\s*[-•]+\s*/,'');
                    s = s.replace(/^rewrite\b[^:]*:\s*/i,'');
                    s = s.replace(/^write\b[^:]*:\s*/i,'');
                    s = s.replace(/^in\s+\d+[-–]?\d*\s*sentences?:?\s*/i,'');
                    s = s.replace(/^\(?\s*scene\s*\d+\)?\s*:\s*/i,'');
                    s = s.replace(/\s+/g,' ').trim();
                    if (s && !/[.!?]$/.test(s)) s += '.';
                    return s;
                  }

                  // === Title helpers ===
                  function sanitizeTitle(raw=''){
                    let t = String(raw || '').trim();
                    // drop quotes and labels
                    t = t.replace(/^["'“”]+|["'“”]+$/g,'');
                    t = t.replace(/^\s*(?:scene|slide)\s*\d+\s*[:\-–]\s*/i,'');
                    t = t.replace(/^\s*(?:title|headline)\s*[:\-–]\s*/i,'');
                    // remove trailing sentence punctuation for cleaner headlines
                    t = t.replace(/[.!?]+$/,'');
                    // collapse whitespace
                    t = t.replace(/\s+/g,' ').trim();
                    // clamp to ~3–8 words
                    const words = t.split(/\s+/).filter(Boolean);
                    if (words.length > 8) t = words.slice(0, 8).join(' ');
                    // light title casing (don’t shout)
                    t = t.replace(/\b(\w)/g, (m) => m.toUpperCase());
                    // IMPORTANT: no default here; callers handle fallback
                    return t;
                  }
                  
                  function isBadTitle(t=''){
                    const s = String(t || '').trim().toLowerCase();
                    return !s || s === 'overview' || s === 'loading' || s === 'untitled';
                  }

                  function normalizeForCompare(s=''){
                    return String(s || '')
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g,' ')
                      .replace(/\s+/g,' ')
                      .trim();
                  }
                  function titlesEqual(a='', b=''){
                    return normalizeForCompare(a) === normalizeForCompare(b);
                  }
                  function titleFromLine(line=''){
                    // Use the first clause, drop stop words, clamp to 6 words
                    let s = String(line || '').split(/(?<=[.!?])\s+/)[0] || '';
                    s = s.replace(/[.!?,"“”'()\-]+/g,' ').replace(/\s+/g,' ').trim();
                    const STOP = new Set(['the','a','an','and','or','but','for','nor','so','to','of','in','on','at','by','with','from','about','as','into','over','after','before','between','through','during','without','within','along','across','behind','beyond','under','above']);
                    const tokens = s.split(' ').filter(w => w && !STOP.has(w.toLowerCase()));
                    const t = tokens.slice(0, 6).join(' ');
                    return sanitizeTitle(t || s.slice(0, 48)) || 'Overview';
                  }

                  function titleFromSrc(src=''){
                    let s = String(src || '').trim();
                    if (!s) return 'Overview';
                    // use the first sentence/phrase, then clamp
                    s = s.split(/(?<=[.!?])\s+/)[0] || s;
                    s = s.replace(/^[—–\-•\s]+/,'');
                    s = s.replace(/^\s*(?:scene|slide)\s*\d+\s*[:\-–]\s*/i,'');
                    s = s.replace(/[.,;:!?]+$/,'');
                    const words = s.split(/\s+/).slice(0, 6).join(' ');
                    return sanitizeTitle(words) || 'Overview';                  }

                  const wanted = Math.min(30, Math.max(8, Math.ceil(parts.length / 3)));                    
                  const sceneList = [];
                function pickImage(i) {
                if (!normalizedImages.length) return null;
                return normalizedImages[i % normalizedImages.length];
                }

                for (let i = 0; i < wanted; i++) {
                    const src = parts[i % parts.length] || `Key idea ${i+1}`;
                  
                    // Slide body (use Summarizer API instead of prompt)
                    let line = src;
                    if ('Summarizer' in self && availability === 'ready') {
                      const summarizer = await Summarizer.create({ type: 'tldr', length: 'long', format: 'plain-text' });
                      line = await summarizer.summarize(src, { context: 'Detailed slide text for a presentation' });
                    }
                  
                    // Slide title (use Rewriter API instead of hacking)
                    let finalTitle = '';
                    if ('Rewriter' in self) {
                      const rewriter = await Rewriter.create({ tone: 'as-is', format: 'plain-text', length: 'shorter' });
                      finalTitle = await rewriter.rewrite(src, {
                        context: 'Turn this into a short, punchy slide title (max 6 words). No quotes, no numbering.'
                      });
                    }
                  
                    // fallback if empty
                    if (!finalTitle.trim()) {
                      finalTitle = titleFromLine(line) || titleFromSrc(src) || 'Overview';
                    }
                  
                    sceneList.push({
                      title: sanitizeTitle(finalTitle),
                      line: sanitizeLine(line),
                      image: pickImage(i)
                    });
                  }

                // Summarize the page title into a short headline (distinct from the hook)
                let summarizedTitle = title || 'WebSlide';
                try {
                  if (!usingMock) {
                    const t = await session.prompt(
                      `Rewrite this into a short, punchy headline (max 6 words, no quotes, no numbering).\n` +
                      `Do not repeat this hook verbatim:\n${hook}\n\n` +
                      `TITLE:\n${title || 'this page'}`
                    );
                    summarizedTitle = sanitizeTitle(t);
                    if (titlesEqual(summarizedTitle, hook)) {
                      const alt = await session.prompt(
                        `Give a different short headline (max 6 words) that does NOT repeat:\n${hook}\n\nTITLE:\n${title || 'this page'}`
                      );
                      summarizedTitle = sanitizeTitle(alt) || summarizedTitle;
                    }
                  } else {
                    summarizedTitle = sanitizeTitle(title);
                  }
                } catch {
                  summarizedTitle = sanitizeTitle(title);
                }

                if (isBadTitle(summarizedTitle)) {
                    const alt2 = await session.prompt(
                      `Provide a different short headline (max 6 words). Avoid repeating this hook: ${hook}`
                    ).catch(() => '');
                    summarizedTitle = sanitizeTitle(alt2) || sanitizeTitle(title) || 'WebSlide';
                  }


                const payload = { 
                    title: summarizedTitle, 
                    script: { hook, scenes: sceneList }, 
                    meta: { availability, hadPageImages: normalizedImages.length > 0 } 
                  };                await cacheSet(key, payload);
          
                clearTimeout(watchdog); done = true;
                sendToTab(tabId, { type: 'DREAM_RENDER', payload });
              } catch (e) {
                clearTimeout(watchdog); done = true;
                sendToTab(tabId, { type: 'DREAM_ERROR', error: String(e?.message || e) });
              }
            })();
          
            return; // end DREAM_BUILD
          }
  
      if (msg?.type === 'DREAM_CLEAR_CACHE') {
        await cacheClear();
        sendResponse({ ok: true });
      }
    } catch (e) {
      console.error(e);
      chrome.tabs.sendMessage(sender.tab.id, { type: 'DREAM_ERROR', error: String(e) });
    }
  });