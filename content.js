/**
 * PLaMo Translate - Content Script
 * Implements selection floating button, translation popover card,
 * context menu trigger, and whole-page paragraph translation.
 */

(() => {
  // Guard against multiple injections
  if (window.__plamoTranslateInjected) return;
  window.__plamoTranslateInjected = true;

  // Active state
  let currentSettings = { ...DEFAULT_SETTINGS };
  let floatingTriggerEl = null;
  let popoverCardEl = null;
  let pageBarEl = null;
  let lastSelectionData = null;
  let userHasMovedPopover = false;
  let isPageTranslationActive = false;
  let isPageTranslationPaused = false;
  let pageTranslationAbortController = null;
  let pageTranslationUrl = null;
  const pageQueue = new Set();
  let pageIntersectionObserver = null;
  let pageMutationObserver = null;
  let pageRescanTimer = null;
  let pageDoneCount = 0;
  let pageBarIdleShown = false;
  let pageBarError = null;
  // 原文要素 → 挿入済みの訳文。原文が差し替わったら訳文を破棄して再翻訳するために保持する
  const pageTranslated = new Map(); // el → { shell, source }

  // Initialize Settings
  chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
    if (stored) {
      currentSettings = { ...DEFAULT_SETTINGS, ...stored };
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      for (const [key, change] of Object.entries(changes)) {
        currentSettings[key] = change.newValue;
      }
    }
  });

  // i18n Translation Helper
  function t(key, params = {}) {
    const lang = (typeof PlamoI18n !== 'undefined' && PlamoI18n.resolveUiLang)
      ? PlamoI18n.resolveUiLang(currentSettings.uiLang)
      : 'ja';
    return (typeof PlamoI18n !== 'undefined' && PlamoI18n.t)
      ? PlamoI18n.t(key, params, lang)
      : key;
  }

  // -------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------
  function removeElement(el) {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }

  function getActiveSelection() {
    const activeEl = document.activeElement;
    const isInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');

    if (isInput) {
      const start = activeEl.selectionStart;
      const end = activeEl.selectionEnd;
      if (typeof start === 'number' && typeof end === 'number' && end > start) {
        const text = activeEl.value.substring(start, end).trim();
        const rect = activeEl.getBoundingClientRect();
        return {
          text,
          rect,
          isEditable: true,
          inputElement: activeEl,
          selectionStart: start,
          selectionEnd: end
        };
      }
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;

    const text = selection.toString().trim();
    if (!text || text.length < 1 || text.length > 8000) return null;

    try {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const isEditable = !!(selection.anchorNode && selection.anchorNode.parentElement && selection.anchorNode.parentElement.closest('[contenteditable="true"]'));

      return {
        text,
        rect,
        range: range.cloneRange(),
        isEditable,
        editableContainer: isEditable ? selection.anchorNode.parentElement.closest('[contenteditable="true"]') : null
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------
  // Floating Trigger Button
  // -------------------------------------------------------------
  function showFloatingTrigger(selectionData) {
    removeFloatingTrigger();
    if (currentSettings.selectionMode === 'off') return;

    const rect = selectionData.rect;
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    floatingTriggerEl = document.createElement('div');
    floatingTriggerEl.className = 'plamo-ext-floating-trigger';
    floatingTriggerEl.setAttribute('role', 'button');
    floatingTriggerEl.setAttribute('title', t('floatingTriggerTitle'));
    floatingTriggerEl.innerHTML = `
      <span class="plamo-ext-trigger-icon">🌐</span>
      <span class="plamo-ext-trigger-label">PLaMo</span>
    `;

    // Position near the selection
    const top = window.scrollY + rect.bottom + 6;
    let left = window.scrollX + rect.right - 20;

    // Boundary check
    if (left + 80 > window.innerWidth) {
      left = window.innerWidth - 90;
    }
    if (left < 10) left = 10;

    floatingTriggerEl.style.top = `${top}px`;
    floatingTriggerEl.style.left = `${left}px`;

    floatingTriggerEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    floatingTriggerEl.addEventListener('mouseup', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    floatingTriggerEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeFloatingTrigger();
      openPopoverCard(selectionData);
    });

    document.body.appendChild(floatingTriggerEl);
  }

  function removeFloatingTrigger() {
    if (floatingTriggerEl) {
      removeElement(floatingTriggerEl);
      floatingTriggerEl = null;
    }
  }

  // -------------------------------------------------------------
  // Floating Translation Popover Card
  // Supports Approach A (Native Float Window via chrome.windows.create - Fastest)
  // and Approach B (In-page OOPIF iframe)
  // -------------------------------------------------------------
  function openPopoverCard(selectionData) {
    removeFloatingTrigger();
    removePopoverCard();
    lastSelectionData = selectionData;

    const displayMode = currentSettings.inlineDisplayMode || 'window';
    if (displayMode === 'iframe') {
      openIframePopover(selectionData);
    } else {
      openFloatWindow(selectionData);
    }
  }

  function openFloatWindow(selectionData) {
    const text = selectionData.text;
    const rect = selectionData.rect || { top: 120, bottom: 160, left: 200, width: 400, height: 40 };

    // Calculate approximate screen coordinates based on browser window and selection
    const titleBarOffset = Math.max(0, (window.outerHeight - window.innerHeight));
    const screenX = Math.round(window.screenX + (rect.left || 100));
    const screenY = Math.round(window.screenY + titleBarOffset + (rect.bottom || 100) + 8);

    chrome.runtime.sendMessage({
      type: 'OPEN_FLOAT_WINDOW',
      text,
      isEditable: Boolean(selectionData.isEditable),
      screenX,
      screenY
    }).catch(err => {
      console.warn('[PLaMo Content] Failed to open float window, falling back to iframe:', err);
      openIframePopover(selectionData);
    });
  }

  function openIframePopover(selectionData) {
    const text = selectionData.text;
    const rect = selectionData.rect || { top: 120, bottom: 160, left: window.innerWidth / 2 - 200, width: 400, height: 40 };

    popoverCardEl = document.createElement('iframe');
    popoverCardEl.className = 'plamo-ext-popover-iframe';
    popoverCardEl.setAttribute('allow', 'clipboard-write');
    popoverCardEl.tabIndex = 0;

    const payload = {
      text,
      isEditable: Boolean(selectionData.isEditable),
      isWindowMode: false
    };
    popoverCardEl.src = chrome.runtime.getURL('popover.html') + '#' + encodeURIComponent(JSON.stringify(payload));

    // Position Card near selection
    let cardTop = window.scrollY + rect.bottom + 8;
    let cardLeft = window.scrollX + rect.left;

    // Check bottom overflow
    const estimatedHeight = 180;
    if (rect.bottom + estimatedHeight > window.innerHeight && rect.top > estimatedHeight) {
      cardTop = window.scrollY + rect.top - estimatedHeight - 8;
    }

    // Check right overflow & clamp to viewport
    const cardWidth = Math.max(300, Math.min(window.innerWidth - 30, currentSettings.popoverCustomWidth || 440));
    const customHeight = currentSettings.popoverCustomHeight ? Math.max(140, Math.min(window.innerHeight - 30, currentSettings.popoverCustomHeight)) : 0;
    const maxLeft = window.scrollX + window.innerWidth - cardWidth - 16;
    if (cardLeft > maxLeft) {
      cardLeft = maxLeft;
    }
    if (cardLeft < window.scrollX + 10) {
      cardLeft = window.scrollX + 10;
    }

    popoverCardEl.style.top = `${cardTop}px`;
    popoverCardEl.style.left = `${cardLeft}px`;
    popoverCardEl.style.width = `${cardWidth}px`;
    if (customHeight > 0) {
      popoverCardEl.style.height = `${customHeight}px`;
    }

    // Prevent selection events inside card from bubbling
    popoverCardEl.addEventListener('mousedown', (e) => e.stopPropagation());

    // Auto-focus the iframe on load to promote extension process to foreground in Chromium (Approach C)
    popoverCardEl.addEventListener('load', () => {
      try {
        popoverCardEl.focus();
      } catch {}
    });

    document.body.appendChild(popoverCardEl);
    try {
      popoverCardEl.focus();
    } catch {}
  }

  function removePopoverCard() {
    if (popoverCardEl) {
      removeElement(popoverCardEl);
      popoverCardEl = null;
    }
    userHasMovedPopover = false;
  }

  // Listen for messages from popover.html iframe
  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'PLAMO_RESIZE') {
      if (popoverCardEl && typeof e.data.height === 'number') {
        const newHeight = e.data.height;
        popoverCardEl.style.height = `${newHeight}px`;

        // Adjust top position if height expansion overflows the bottom of viewport (only if user hasn't manually moved it)
        if (!userHasMovedPopover && lastSelectionData && lastSelectionData.rect) {
          const rect = lastSelectionData.rect;
          const currentTop = parseFloat(popoverCardEl.style.top) || 0;
          if (rect.top > newHeight && (currentTop + newHeight > window.scrollY + window.innerHeight - 10)) {
            popoverCardEl.style.top = `${Math.max(window.scrollY + 10, window.scrollY + rect.top - newHeight - 8)}px`;
          }
        }
      }
    } else if (e.data.type === 'PLAMO_USER_MOVE') {
      if (popoverCardEl && typeof e.data.deltaX === 'number' && typeof e.data.deltaY === 'number') {
        userHasMovedPopover = true;
        const currentLeft = parseFloat(popoverCardEl.style.left) || 0;
        const currentTop = parseFloat(popoverCardEl.style.top) || 0;

        const newLeft = currentLeft + e.data.deltaX;
        const newTop = currentTop + e.data.deltaY;

        // Viewport boundaries: keep at least 60px visible horizontally, 40px vertically
        const minLeft = window.scrollX + 10;
        const maxLeft = window.scrollX + window.innerWidth - 60;
        const minTop = window.scrollY + 10;
        const maxTop = window.scrollY + window.innerHeight - 40;

        popoverCardEl.style.left = `${Math.max(minLeft, Math.min(maxLeft, newLeft))}px`;
        popoverCardEl.style.top = `${Math.max(minTop, Math.min(maxTop, newTop))}px`;
      }
    } else if (e.data.type === 'PLAMO_USER_RESIZE') {
      if (popoverCardEl) {
        if (typeof e.data.width === 'number') {
          const clampedWidth = Math.max(300, Math.min(window.innerWidth - 20, e.data.width));
          popoverCardEl.style.width = `${clampedWidth}px`;
          currentSettings.popoverCustomWidth = clampedWidth;
        }
        if (typeof e.data.height === 'number') {
          const clampedHeight = Math.max(140, Math.min(window.innerHeight - 20, e.data.height));
          popoverCardEl.style.height = `${clampedHeight}px`;
          currentSettings.popoverCustomHeight = clampedHeight;
        }
      }
    } else if (e.data.type === 'PLAMO_REPLACE_TEXT') {
      if (lastSelectionData && e.data.text) {
        handleTextReplacement(lastSelectionData, e.data.text);
        removePopoverCard();
      }
    } else if (e.data.type === 'PLAMO_CLOSE') {
      removePopoverCard();
    }
  });

  function handleTextReplacement(selectionData, newText) {
    if (!selectionData) return;

    if (selectionData.inputElement) {
      const input = selectionData.inputElement;
      const start = selectionData.selectionStart;
      const end = selectionData.selectionEnd;
      const oldVal = input.value;
      input.value = oldVal.substring(0, start) + newText + oldVal.substring(end);
      input.setSelectionRange(start + newText.length, start + newText.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
    } else if (selectionData.range) {
      selectionData.range.deleteContents();
      selectionData.range.insertNode(document.createTextNode(newText));
    }
  }

  // -------------------------------------------------------------
  // Mouse & Selection Event Listeners
  // -------------------------------------------------------------
  document.addEventListener('mouseup', (e) => {
    // If clicking inside our popup iframe, card or trigger, don't re-trigger
    if (e.target.closest('.plamo-ext-popover-iframe') || e.target.closest('.plamo-ext-popover-card') || e.target.closest('.plamo-ext-floating-trigger')) {
      return;
    }

    setTimeout(() => {
      const selData = getActiveSelection();
      if (selData && selData.text.length > 0) {
        if (currentSettings.selectionMode === 'instant') {
          openPopoverCard(selData);
        } else if (currentSettings.selectionMode === 'button') {
          showFloatingTrigger(selData);
        }
      } else {
        removeFloatingTrigger();
      }
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (floatingTriggerEl && !floatingTriggerEl.contains(e.target)) {
      removeFloatingTrigger();
    }
    if (popoverCardEl && !popoverCardEl.contains(e.target)) {
      removePopoverCard();
    }
  });

  // -------------------------------------------------------------
  // Whole-Page Translation - Smart Content Extractor
  // -------------------------------------------------------------

  /**
   * Locate the primary content container (article, main, markdown body, etc.)
   * Falls back to document.body if no explicit container is found.
   */
  function findMainContentRoot() {
    const primarySelectors = [
      'article',
      'main',
      '[role="main"]',
      '.article-body',
      '.article-content',
      '.entry-content',
      '.post-content',
      '.post-body',
      '.markdown-body',
      '#content',
      '#main-content',
      '.main-content'
    ];

    for (const sel of primarySelectors) {
      const candidates = document.querySelectorAll(sel);
      // 複数ヒットは一覧ページとみなし、1 件に絞らない
      if (candidates.length > 1) continue;
      for (const el of candidates) {
        // Ensure container has substantial text (> 120 chars) and is visible
        if (el.innerText && el.innerText.trim().length > 120) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return el;
          }
        }
      }
    }

    return document.body;
  }

  function findTranslatableElements() {
    const root = findMainContentRoot();
    const selector = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, figcaption, [slot="title"]';
    const all = Array.from(root.querySelectorAll(selector));

    const targetLang = currentSettings.targetLang || 'ja';
    const isTargetJapanese = targetLang === 'ja' || targetLang === 'ja-easy';

    // Comprehensive blacklist selector to filter out navigation, widgets, ads and sidebars
    const noiseSelector = [
      'header',
      'nav',
      'footer',
      'aside',
      'script',
      'style',
      'code',
      'pre',
      'noscript',
      '[contenteditable="true"]',
      '[role="navigation"]',
      '[role="complementary"]',
      '[role="banner"]',
      '[aria-hidden="true"]',
      '.sidebar',
      '#sidebar',
      '.comments',
      '#comments',
      '.comment-list',
      '.ad',
      '.advertisement',
      '.ad-container',
      '.social-share',
      '.share-buttons',
      '.breadcrumb',
      '.breadcrumbs',
      '.pagination',
      '.toc',
      '.table-of-contents',
      '.related-posts',
      '.recommended',
      '.cookie-banner',
      '.modal',
      '.dialog'
    ].join(', ');

    const kept = all.filter(el => {
      // 1. Ignore elements inside noise containers
      if (el.closest(noiseSelector)) {
        return false;
      }

      // 2. Ignore elements inside extension UI
      if (el.closest('.plamo-ext-popover-card, .plamo-ext-floating-trigger, .plamo-ext-page-bar, .plamo-ext-popover-iframe, .plamo-ext-replaced, .plamo-ext-tooltip-host')) {
        return false;
      }

      // 3. Ignore if already marked, or if it contains a marked descendant
      if (el.closest('[data-plamo-origin]') || el.querySelector('[data-plamo-origin]')) {
        return false;
      }

      // 操作部品を含む要素は置換すると機能を失うため対象外
      if (el.querySelector('button, input, select, textarea, video, audio, iframe, canvas')) {
        return false;
      }

      // 4. Check text content length & visibility
      const text = el.innerText ? el.innerText.trim() : '';
      if (text.length < 15) return false;

      // 5. Skip if mostly numbers or symbols
      if (/^[\d\s\p{P}+<=>~^$]+$/u.test(text)) return false;

      // 6. Link Density check: if >50% of the text is inside <a> tags, it is a navigation/menu list
      const anchorLinks = el.querySelectorAll('a');
      if (anchorLinks.length > 0) {
        let linkCharCount = 0;
        anchorLinks.forEach(a => {
          linkCharCount += (a.innerText || '').trim().length;
        });
        if (linkCharCount / text.length >= 0.5) {
          return false;
        }
      }

      // 7. Skip already-translated language (e.g. Japanese text when target is Japanese)
      if (isTargetJapanese && typeof isJapaneseText === 'function' && isJapaneseText(text)) {
        return false;
      }

      // 8. Visibility check
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }

      return true;
    });

    // ponytail: 末端のみ訳すため <li>親テキスト<ul>…</ul></li> の親側テキストは訳されない。必要なら直下テキストのみ訳す方式へ。
    return kept.filter((el, i) => !(kept[i + 1] && el.contains(kept[i + 1])));
  }

  // -------------------------------------------------------------
  // Whole-Page Translation - Source extraction / Translation assembly
  // -------------------------------------------------------------
  const replacedParts = new WeakMap();

  const collapseSpaces = (str) => str.replace(/\s+/g, ' ');
  const escapeMarkup = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const unescapeMarkup = (str) => str
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const stripLinkMarkers = (str) => str.replace(/<a\b[^>]*>/g, '').replace(/<\/a>/g, '');

  // ponytail: リンク以外の装飾は平文化する。必要になったら同じ目印方式で対象を広げる
  function extractParts(el) {
    const parts = [];
    const allowLinks = !el.closest('a');
    const breakLine = () => {
      const last = parts[parts.length - 1];
      if (last && last.text !== '\n') parts.push({ text: '\n' });
    };
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          parts.push({ text: collapseSpaces(child.nodeValue) });
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          // display: contents は checkVisibility() が false になるが中身は表示される
          const display = getComputedStyle(child).display;
          if (display !== 'contents' && !child.checkVisibility()) continue;
          if (child.tagName === 'BR') {
            parts.push({ text: '\n' });
            continue;
          }
          const isBlock = /^(block|flex|grid|list-item|table|flow-root)/.test(display);
          if (isBlock) breakLine();
          if (allowLinks && child instanceof HTMLAnchorElement && child.hasAttribute('href') && child.innerText.trim()) {
            parts.push({ link: child, text: collapseSpaces(child.innerText) });
          } else {
            walk(child);
          }
          if (isBlock) breakLine();
        }
      }
    };
    walk(el);

    while (parts.length) {
      parts[0].text = parts[0].text.trimStart();
      if (parts[0].text || parts[0].link) break;
      parts.shift();
    }
    while (parts.length) {
      const last = parts[parts.length - 1];
      last.text = last.text.trimEnd();
      if (last.text || last.link) break;
      parts.pop();
    }
    return parts;
  }

  function buildSource(el) {
    const parts = extractParts(el);
    const links = parts.filter(p => p.link).map(p => p.link);
    if (links.length === 0) {
      return { text: el.innerText.trim(), parts, links };
    }
    let n = 0;
    const text = parts.map(p => p.link
      ? `<a href="${++n}">${escapeMarkup(p.text)}</a>`
      : escapeMarkup(p.text)).join('');
    return { text, parts, links };
  }

  function partsToFragment(parts) {
    const frag = document.createDocumentFragment();
    for (const p of parts) {
      if (p.link) {
        const a = p.link.cloneNode(false);
        a.textContent = p.text;
        frag.appendChild(a);
      } else {
        frag.appendChild(document.createTextNode(p.text));
      }
    }
    return frag;
  }

  // モデル出力は必ず textContent / テキストノードで挿入する（HTML として解釈しない）
  function buildTranslation(translated, links) {
    const frag = document.createDocumentFragment();
    if (links.length === 0) {
      frag.appendChild(document.createTextNode(translated));
      return frag;
    }

    const re = /<a href="(\d+)">([\s\S]*?)<\/a>/g;
    const segments = [];
    const seen = new Set();
    let last = 0;
    let ok = true;
    for (const m of translated.matchAll(re)) {
      const n = Number(m[1]);
      if (n < 1 || n > links.length || seen.has(n)) { ok = false; break; }
      seen.add(n);
      segments.push({ text: translated.slice(last, m.index) });
      segments.push({ n, text: m[2] });
      last = m.index + m[0].length;
    }
    if (!ok || seen.size !== links.length) {
      frag.appendChild(document.createTextNode(unescapeMarkup(stripLinkMarkers(translated))));
      return frag;
    }
    segments.push({ text: translated.slice(last) });

    for (const seg of segments) {
      if (seg.n) {
        const a = links[seg.n - 1].cloneNode(false);
        a.textContent = unescapeMarkup(seg.text);
        frag.appendChild(a);
      } else if (seg.text) {
        frag.appendChild(document.createTextNode(unescapeMarkup(stripLinkMarkers(seg.text))));
      }
    }
    return frag;
  }

  function createShell(el, lang) {
    const shell = el.localName.includes('-') ? document.createElement('div') : el.cloneNode(false);
    shell.removeAttribute('id');
    shell.removeAttribute('data-plamo-origin');
    if (el.slot) shell.slot = el.slot;
    shell.classList.add('plamo-ext-replaced');
    shell.lang = lang;
    shell.dir = 'auto';
    return shell;
  }

  // -------------------------------------------------------------
  // Whole-Page Translation - Hover tooltip (original text)
  // -------------------------------------------------------------
  let tooltipHost = null;
  let tooltipCard = null;
  let tooltipShowTimer = null;
  let tooltipHideTimer = null;

  const TOOLTIP_CSS = `
    :host { all: initial; }
    .card {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 2147483647;
      display: none;
      box-sizing: border-box;
      max-width: min(480px, 100vw - 16px);
      padding: 8px 12px;
      background: #1e293b;
      color: #ffffff;
      font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", "Meiryo", sans-serif;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }
    a { color: #93c5fd; text-decoration: underline; }
  `;

  function ensureTooltip() {
    if (tooltipHost && tooltipHost.isConnected) return;
    tooltipHost = document.createElement('div');
    tooltipHost.className = 'plamo-ext-tooltip-host';
    const root = tooltipHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = TOOLTIP_CSS;
    tooltipCard = document.createElement('div');
    tooltipCard.className = 'card';
    root.append(style, tooltipCard);
    tooltipHost.addEventListener('mouseenter', () => clearTimeout(tooltipHideTimer));
    tooltipHost.addEventListener('mouseleave', scheduleTooltipHide);
    document.documentElement.appendChild(tooltipHost);
  }

  function hideTooltip() {
    clearTimeout(tooltipShowTimer);
    clearTimeout(tooltipHideTimer);
    if (tooltipCard) tooltipCard.style.display = 'none';
  }

  function scheduleTooltipHide() {
    clearTimeout(tooltipShowTimer);
    clearTimeout(tooltipHideTimer);
    tooltipHideTimer = setTimeout(hideTooltip, 200);
  }

  function showTooltip(shell) {
    const parts = replacedParts.get(shell);
    if (!parts || !shell.isConnected || document.body.classList.contains('plamo-ext-show-original')) return;
    ensureTooltip();
    tooltipCard.replaceChildren(partsToFragment(parts));
    tooltipCard.style.display = 'block';

    const rect = shell.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const { width, height } = tooltipCard.getBoundingClientRect();
    let top = rect.bottom + 6;
    if (top + height > vh - 8) top = Math.max(8, rect.top - height - 6);
    const left = Math.max(8, Math.min(rect.left, vw - width - 8));
    tooltipCard.style.left = `${left}px`;
    tooltipCard.style.top = `${top}px`;
  }

  function removeTooltip() {
    hideTooltip();
    removeElement(tooltipHost);
    tooltipHost = null;
    tooltipCard = null;
  }

  document.addEventListener('mouseover', (e) => {
    const shell = e.target instanceof Element ? e.target.closest('.plamo-ext-replaced') : null;
    if (!shell) return;
    clearTimeout(tooltipHideTimer);
    clearTimeout(tooltipShowTimer);
    tooltipShowTimer = setTimeout(() => showTooltip(shell), 250);
  });

  document.addEventListener('mouseout', (e) => {
    const shell = e.target instanceof Element ? e.target.closest('.plamo-ext-replaced') : null;
    if (!shell) return;
    if (e.relatedTarget instanceof Node && shell.contains(e.relatedTarget)) return;
    scheduleTooltipHide();
  });

  window.addEventListener('scroll', hideTooltip, { capture: true, passive: true });

  function togglePageTranslation() {
    if (isPageTranslationActive) {
      if (location.href.split('#')[0] === pageTranslationUrl) {
        setPagePaused(!isPageTranslationPaused);
        return;
      }
      restorePageTranslation();
    }

    startPageTranslation();
  }

  const OWN_UI_SELECTOR = '.plamo-ext-replaced, .plamo-ext-page-bar, .plamo-ext-tooltip-host, .plamo-ext-popover-card, .plamo-ext-floating-trigger, .plamo-ext-popover-iframe';

  function isOwnNode(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!el && !!el.closest(OWN_UI_SELECTOR);
  }

  // 再開時は失敗した要素も再試行の対象に戻す
  function setPagePaused(paused) {
    isPageTranslationPaused = paused;
    if (!paused) {
      pageBarError = null;
      document.querySelectorAll('[data-plamo-origin="error"]').forEach(el => el.removeAttribute('data-plamo-origin'));
      watchNewCandidates();
    }
    updatePageBar();
  }

  // 原文が消えた・書き換わった、または訳文が除去された組は破棄し、再走査で再翻訳させる
  function syncTranslated() {
    for (const [el, { shell, source }] of pageTranslated) {
      if (el.isConnected && shell.isConnected && el.textContent === source) continue;
      pageTranslated.delete(el);
      shell.remove();
      if (el.isConnected) el.removeAttribute('data-plamo-origin');
    }
  }

  function watchNewCandidates(candidates = findTranslatableElements()) {
    for (const el of candidates) {
      el.setAttribute('data-plamo-origin', 'pending');
      pageIntersectionObserver.observe(el);
    }
  }

  function distanceToViewport(el) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= 0) return -rect.bottom;
    if (rect.top >= window.innerHeight) return rect.top - window.innerHeight;
    return 0;
  }

  function takeNearestQueued() {
    let nearest = null;
    let best = Infinity;
    for (const el of pageQueue) {
      const d = distanceToViewport(el);
      if (d < best) { best = d; nearest = el; }
    }
    pageQueue.delete(nearest);
    return nearest;
  }

  // 中断された場合は false
  async function translateElement(el, signal) {
    el.setAttribute('data-plamo-origin', 'translating');

    let failure = null;
    // 通信・バックエンド障害のときだけ全体を一時停止し、再開時にまとめて再試行させる（要素固有の失敗では止めない）
    let pauseOnFailure = false;
    try {
      const source = el.textContent;
      const { text, parts, links } = buildSource(el);
      pauseOnFailure = true;
      const response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_TEXT',
        text,
        targetLang: currentSettings.targetLang || 'ja',
        form: currentSettings.form || 'none'
      });

      if (signal.aborted) return false;

      if (!response || !response.ok) {
        failure = response ? response.error : '応答なし';
      } else {
        pauseOnFailure = false;
        if (!response.translatedText || !response.translatedText.trim()) {
          failure = '翻訳結果が空です';
        } else {
          const lang = response.effectiveTargetLang || currentSettings.targetLang || 'ja';
          const shell = createShell(el, lang === 'ja-easy' ? 'ja' : lang);
          shell.appendChild(buildTranslation(response.translatedText, links));
          replacedParts.set(shell, parts);
          el.after(shell);
          pageTranslated.set(el, { shell, source });
          el.setAttribute('data-plamo-origin', 'done');
        }
      }
    } catch (err) {
      if (signal.aborted) return false;
      failure = err.message || String(err);
    }

    if (failure !== null) {
      el.setAttribute('data-plamo-origin', 'error');
      console.warn('[PLaMo] page translation failed:', failure);
      if (pauseOnFailure) isPageTranslationPaused = true;
      showPageBarError(failure);
    } else {
      pageDoneCount++;
      pageBarError = null;
      updatePageBar();
    }
    return true;
  }

  async function startPageTranslation() {
    const initialCandidates = findTranslatableElements();
    if (initialCandidates.length === 0) {
      alert('翻訳可能なテキストブロックが見つかりませんでした。');
      return;
    }

    isPageTranslationActive = true;
    isPageTranslationPaused = false;
    // アンカー移動は同一ページとして扱う
    pageTranslationUrl = location.href.split('#')[0];
    const controller = new AbortController();
    pageTranslationAbortController = controller;
    const { signal } = controller;

    pageDoneCount = 0;
    pageBarIdleShown = false;
    pageBarError = null;
    pageTranslated.clear();
    renderPageBar();

    pageIntersectionObserver = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        pageQueue.add(entry.target);
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '1000px 0px', scrollMargin: '1000px 0px' });

    // ponytail: 変化のたびにルート全体を再走査する。重くなれば追加ノードの部分木だけ走査する方式へ。
    // 変化し続けるページでも再走査が止まらないよう間引きで実行する。
    // 訳文だけが外部から除去された場合も同期させるため、除去は自前ノードでも拾う
    pageMutationObserver = new MutationObserver((records) => {
      const relevant = records.some(r => !isOwnNode(r.target) &&
        (r.type === 'characterData' || r.removedNodes.length > 0 || [...r.addedNodes].some(n => !isOwnNode(n))));
      if (!relevant || pageRescanTimer) return;
      pageRescanTimer = setTimeout(() => {
        pageRescanTimer = null;
        syncTranslated();
        watchNewCandidates();
      }, 800);
    });
    pageMutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

    watchNewCandidates(initialCandidates);

    while (!signal.aborted) {
      while (isPageTranslationPaused && !signal.aborted) {
        await new Promise(r => setTimeout(r, 400));
      }
      if (signal.aborted) break;

      for (const el of pageQueue) {
        if (!el.isConnected) {
          pageQueue.delete(el);
        } else if (!el.checkVisibility()) {
          // 非表示の間は待機させ、再表示時に IntersectionObserver が再度キューへ戻す
          pageQueue.delete(el);
          pageIntersectionObserver.observe(el);
        }
      }

      if (pageQueue.size === 0) {
        await new Promise(r => setTimeout(r, 300));
        if (pageQueue.size === 0 && !pageBarIdleShown && !signal.aborted) {
          pageBarIdleShown = true;
          updatePageBar();
        }
        continue;
      }

      if (pageBarIdleShown) {
        pageBarIdleShown = false;
        updatePageBar();
      }
      if (!(await translateElement(takeNearestQueued(), signal))) break;

      // Short delay between blocks to avoid overloading LM Studio
      await new Promise(r => setTimeout(r, 60));
    }
  }

  function renderPageBar() {
    removePageBar();

    const srcLabel = document.body.classList.contains('plamo-ext-show-original') ? t('btnShowTranslation') : t('btnShowOriginal');
    pageBarEl = document.createElement('div');
    pageBarEl.className = 'plamo-ext-page-bar';
    pageBarEl.innerHTML = `
      <span class="plamo-ext-page-title">🌐 PLaMo</span>
      <span class="plamo-ext-page-progress">${t('pageTranslatingProgress', { current: 0, total: 0 })}</span>
      <button class="plamo-ext-btn-sm plamo-ext-page-toggle-src" title="${srcLabel}">${srcLabel}</button>
      <button class="plamo-ext-btn-sm plamo-ext-page-pause" title="${t('btnPause')}">${t('btnPause')}</button>
      <button class="plamo-ext-btn-sm plamo-ext-page-restore" title="${t('btnRestore')}">${t('btnRestore')}</button>
    `;

    const toggleSrcBtn = pageBarEl.querySelector('.plamo-ext-page-toggle-src');
    const pauseBtn = pageBarEl.querySelector('.plamo-ext-page-pause');
    const restoreBtn = pageBarEl.querySelector('.plamo-ext-page-restore');

    toggleSrcBtn.addEventListener('click', () => {
      document.body.classList.toggle('plamo-ext-show-original');
      const showingOriginal = document.body.classList.contains('plamo-ext-show-original');
      toggleSrcBtn.textContent = showingOriginal ? t('btnShowTranslation') : t('btnShowOriginal');
      toggleSrcBtn.title = toggleSrcBtn.textContent;
      hideTooltip();
    });

    pauseBtn.addEventListener('click', () => {
      setPagePaused(!isPageTranslationPaused);
    });

    restoreBtn.addEventListener('click', () => {
      restorePageTranslation();
    });

    document.body.appendChild(pageBarEl);
  }

  function updatePageBar() {
    if (!pageBarEl) return;
    const pauseBtn = pageBarEl.querySelector('.plamo-ext-page-pause');
    pauseBtn.textContent = isPageTranslationPaused ? t('btnResume') : t('btnPause');
    pauseBtn.title = pauseBtn.textContent;
    const progressEl = pageBarEl.querySelector('.plamo-ext-page-progress');
    if (pageBarError !== null) {
      progressEl.textContent = t('pageTranslationError', { message: pageBarError });
    } else if (isPageTranslationPaused) {
      progressEl.textContent = t('pageTranslationPaused');
    } else if (pageBarIdleShown) {
      progressEl.textContent = t('pageTranslationIdle', { total: pageDoneCount });
    } else {
      progressEl.textContent = t('pageTranslatingProgress', { current: pageDoneCount, total: pageDoneCount + pageQueue.size });
    }
  }

  function showPageBarError(message) {
    pageBarError = message;
    updatePageBar();
  }

  function removePageBar() {
    if (pageBarEl) {
      removeElement(pageBarEl);
      pageBarEl = null;
    }
  }

  function restorePageTranslation() {
    isPageTranslationActive = false;
    isPageTranslationPaused = false;
    if (pageTranslationAbortController) {
      pageTranslationAbortController.abort();
      pageTranslationAbortController = null;
    }
    if (pageIntersectionObserver) pageIntersectionObserver.disconnect();
    pageIntersectionObserver = null;
    if (pageMutationObserver) pageMutationObserver.disconnect();
    pageMutationObserver = null;
    clearTimeout(pageRescanTimer);
    pageRescanTimer = null;
    pageQueue.clear();
    pageTranslated.clear();
    pageBarError = null;

    document.body.classList.remove('plamo-ext-show-original');
    document.querySelectorAll('.plamo-ext-replaced').forEach(removeElement);
    document.querySelectorAll('[data-plamo-origin]').forEach(el => el.removeAttribute('data-plamo-origin'));
    removeTooltip();

    removePageBar();
  }

  // -------------------------------------------------------------
  // Listen for Background Commands
  // -------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === 'SHOW_INLINE_TRANSLATION') {
      const selData = getActiveSelection() || {
        text: message.text,
        rect: { top: 120, bottom: 160, left: window.innerWidth / 2 - 180, width: 360, height: 40 },
        isEditable: false
      };
      openPopoverCard(selData);
      sendResponse({ ok: true });
    } else if (message.type === 'PLAMO_REPLACE_TEXT') {
      if (lastSelectionData && message.text) {
        handleTextReplacement(lastSelectionData, message.text);
      }
      sendResponse({ ok: true });
    } else if (message.type === 'TOGGLE_PAGE_TRANSLATION') {
      togglePageTranslation();
      sendResponse({ ok: true });
    } else if (message.type === 'RESTORE_PAGE_TRANSLATION') {
      restorePageTranslation();
      sendResponse({ ok: true });
    }
  });

})();
