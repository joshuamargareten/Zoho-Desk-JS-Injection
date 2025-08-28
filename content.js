(() => {
  // ===== CONFIG =====
  const BRAND_COLOR = "#1b1464";
  const LINE_HEIGHT = 1.5;
  const EDITOR_IFRAME_SEL = 'iframe.KB_Editor_iframe[name="deskEditor_New"]';

  // ===== GLOBALS =====
  let CURRENT_OVERLAY = null;
  let MSG_HANDLER_INSTALLED = false;

  // ===== STYLE (overlay) =====
  function injectOverlayCSS() {
    if (document.getElementById("zd-ext-overlay-style")) return;
    const s = document.createElement("style");
    s.id = "zd-ext-overlay-style";
    s.textContent = `
      .zd-ext-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.35);backdrop-filter:blur(1px)}
      .zd-ext-modal{position:fixed;inset:2vh 2vw;border-radius:12px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.35)}
      .zd-ext-frame{width:100%;height:100%;border:0;background:transparent}
    `;
    document.documentElement.appendChild(s);
  }

  // ===== UTILS =====
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const resUrl = (p) => chrome.runtime.getURL(p);
  const abs = (u) => { try { return new URL(u, location.href).toString(); } catch { return u; } };
  const isVisible = (el) => !!el && el.getBoundingClientRect().width > 0;

  function getEditor() {
    const f = document.querySelector(EDITOR_IFRAME_SEL);
    if (!f) return { frame: null, idoc: null, iwin: null };
    try { return { frame: f, idoc: f.contentDocument, iwin: f.contentWindow }; } catch { return { frame: f, idoc: null, iwin: null }; }
  }

  function findActionButton(labels) {
    const nodes = Array.from(document.querySelectorAll('button,[role="button"],a[role="button"],a,div[role="button"]'));
    const m = (el) => {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      const a = (el.getAttribute("title") || el.getAttribute("aria-label") || "").trim().toLowerCase();
      return labels.some(l => t === l || t.includes(l) || a === l || a.includes(l));
    };
    return nodes.find(el => isVisible(el) && !el.disabled && m(el));
  }

  // ===== COMPOSER PRIMER =====
  function blockIsEmpty(el) {
    if (!el) return true;
    const html = (el.innerHTML || "").trim();
    return html === "" || html === "<br>";
  }

  function getCurrentBlock(idoc) {
    const sel = idoc.getSelection && idoc.getSelection();
    let node = sel && sel.anchorNode;
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    while (node && node.parentElement && node.parentElement !== idoc.body) node = node.parentElement;
    return (node && node.parentElement === idoc.body) ? node : idoc.body.firstElementChild || idoc.body;
  }

  function primeBlockIfEmpty(idoc, block) {
    if (!block) return;
    if (!blockIsEmpty(block)) return;

    if (!block.style.lineHeight) block.style.lineHeight = String(LINE_HEIGHT);
    if (!block.style.letterSpacing) block.style.letterSpacing = "0.5px";

    let span = block.querySelector(':scope > span.colour');
    if (!span) {
      span = idoc.createElement('span');
      span.className = 'colour';
      span.setAttribute('style', `color:${BRAND_COLOR}`);
      span.textContent = '\u200B'; // ZWSP
      block.innerHTML = "";
      block.appendChild(span);
      block.appendChild(idoc.createElement('br'));
    }

    try {
      const sel = idoc.getSelection();
      const range = idoc.createRange();
      const t = span.firstChild;
      range.setStart(t, t.length);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      idoc.body.focus();
    } catch { }
  }

  function primeOnFocus() {
    const { idoc } = getEditor();
    if (!idoc) return;
    const blk = getCurrentBlock(idoc);
    primeBlockIfEmpty(idoc, blk);
  }

  function primeBeforeSend() {
    const { idoc } = getEditor();
    if (!idoc) return;
    const blk = getCurrentBlock(idoc) || idoc.body.firstElementChild;
    primeBlockIfEmpty(idoc, blk);
  }

  function watchEditor() {
    (async () => {
      while (true) {
        const { idoc } = getEditor();
        if (idoc && !idoc.__zdPrimed) {
          idoc.__zdPrimed = true;
          primeBlockIfEmpty(idoc, idoc.body.firstElementChild || idoc.body);
          idoc.addEventListener('focusin', primeOnFocus, true);

          idoc.addEventListener('keydown', (e) => {
            const ctrl = e.ctrlKey || e.metaKey;
            const shift = e.shiftKey;
            if (ctrl && !shift && e.key === "Enter") { e.preventDefault(); sendAction(); }
            if (ctrl && shift && (e.key === "d" || e.key === "D")) { e.preventDefault(); discardAction(); }
          }, true);
        }
        await sleep(800);
      }
    })();
  }

  // ===== SHORTCUTS =====
  function sendAction() {
    primeBeforeSend();
    const btn = findActionButton(["send", "reply", "submit"]);
    if (btn) { btn.click(); return; }
    const { frame } = getEditor();
    const form = frame && (frame.closest('form') || document.querySelector('form[method][action*="reply"]'));
    if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
  }
  function discardAction() {
    const btn = findActionButton(["discard", "discard draft", "cancel"]);
    if (btn) btn.click();
  }
  function installTopShortcuts() {
    if (document.__zdShortcutsInstalled) return;
    document.__zdShortcutsInstalled = true;
    document.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      if (ctrl && !shift && e.key === "Enter") { e.preventDefault(); sendAction(); }
      if (ctrl && shift && (e.key === "d" || e.key === "D")) { e.preventDefault(); discardAction(); }
    }, true);
  }
  function installSendHook() {
    if (document.__zdSendHookInstalled) return;
    document.__zdSendHookInstalled = true;
    const capture = (e) => {
      const el = e.target;
      if (!el) return;
      const label = ((el.innerText || el.textContent || "") + " " + (el.getAttribute('aria-label') || "") + " " + (el.getAttribute('title') || "")).toLowerCase();
      if (/send|reply|submit/.test(label)) primeBeforeSend();
    };
    document.addEventListener('pointerdown', capture, true);
    document.addEventListener('click', capture, true);
  }

  // ===== VIEWER (proxy fetch + overlay) =====
  function getSiblingAttachments(originEl) {
    const container = originEl?.closest?.('[data-test-id="attachments"]');
    if (!container) return [];
    return Array.from(container.querySelectorAll('.zd_v2-attachment-attachment')).map(card => {
      const a = card.parentElement?.querySelector('.zd_v2-attachment-attachDownload');
      const nameEl = card.querySelector('.zd_v2-attachment-atatchName');
      return {
        card,
        href: abs(a?.getAttribute('href') || ""),
        filename: (nameEl?.textContent || "").trim()
      };
    }).filter(x => !!x.href);
  }

  function installGlobalMessageHandler() {
    if (MSG_HANDLER_INSTALLED) return;
    MSG_HANDLER_INSTALLED = true;

    window.addEventListener('message', async (e) => {
      const msg = e.data || {};
      if (!msg || !msg.type) return;
      const ui = CURRENT_OVERLAY;

      if (msg.type === 'zd-viewer-request-close') {
        ui?.close();
      } else if (msg.type === 'zd-viewer-request-open-new-tab') {
        const u = new URL(msg.src, location.href);
        //if (!u.searchParams.has('inline')) u.searchParams.set('inline', 'true');
        // NOTE: no "disposition" param per request
        window.open(u.toString(), "_blank", "noopener");
      } else if (msg.type === 'zd-viewer-request-direct-download') {
        const a = document.createElement('a');
        a.href = msg.src; a.target = "_blank"; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
      } else if (msg.type === 'zd-viewer-nav-prev') {
        if (ui?.nav?.list?.length > 1) { ui.nav.index = (ui.nav.index - 1 + ui.nav.list.length) % ui.nav.list.length; ui.feed(); }
      } else if (msg.type === 'zd-viewer-nav-next') {
        if (ui?.nav?.list?.length > 1) { ui.nav.index = (ui.nav.index + 1) % ui.nav.list.length; ui.feed(); }
      } else if (msg.type === 'zd-fetch') {
        const { id, url } = msg;
        try {
          const res = await fetch(url, { credentials: 'include' });
          const ct = res.headers.get('content-type') || '';
          const status = res.status;
          const ab = await res.arrayBuffer();
          e.source?.postMessage({ type: 'zd-fetch-result', id, ok: true, ct, status, buf: ab }, '*', [ab]);
        } catch (err) {
          e.source?.postMessage({ type: 'zd-fetch-result', id, ok: false, error: String(err) }, '*');
        }
      }
    });
  }

  function openOverlay() {
    if (CURRENT_OVERLAY) { try { CURRENT_OVERLAY.close(); } catch { } CURRENT_OVERLAY = null; }
    injectOverlayCSS();

    const overlay = document.createElement('div');
    overlay.className = 'zd-ext-overlay'; overlay.tabIndex = 0;

    const modal = document.createElement('div');
    modal.className = 'zd-ext-modal';

    const frame = document.createElement('iframe');
    frame.className = 'zd-ext-frame';
    frame.src = resUrl('viewer.html?embedded=1');

    modal.appendChild(frame);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = () => { try { overlay.remove(); } catch { } if (CURRENT_OVERLAY === ui) CURRENT_OVERLAY = null; };

    overlay.addEventListener('pointerdown', (ev) => {
      const path = ev.composedPath();
      if (!path.includes(modal)) close();
    });
    const onEsc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onEsc, { once: true });

    const nav = { list: [], names: [], index: 0 };
    function feed() {
      const src = nav.list[nav.index];
      const name = nav.names[nav.index] || '';
      frame.contentWindow.postMessage({ type: 'zd-viewer-load', payload: { src, name, index: nav.index, total: nav.list.length, embedded: true } }, '*');
    }

    const ui = { overlay, modal, frame, close, nav, feed };
    CURRENT_OVERLAY = ui;
    installGlobalMessageHandler();
    return ui;
  }

  function openAttachmentViaViewer(originEl, href) {
    const items = getSiblingAttachments(originEl);
    const list = items.map(x => x.href);
    const names = items.map(x => x.filename);
    const index = Math.max(0, list.indexOf(href));

    const ui = openOverlay();
    ui.nav.list = list;
    ui.nav.names = names;
    ui.nav.index = index;
    ui.frame.addEventListener('load', () => ui.feed(), { once: true });
  }

  function installAttachmentInterceptor() {
    const handler = (e) => {
      // Allow Zoho's download icon to work normally
      if (e.target.closest?.('.zd_v2-attachment-attachDownload')) return;

      const card = e.target.closest?.('.zd_v2-attachment-attachment');
      if (!card) return;

      const left = (e.button === 0);
      const mods = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
      if (!left || mods) return;

      const a = card.parentElement?.querySelector('.zd_v2-attachment-attachDownload');
      const href = a?.getAttribute('href'); if (!href) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();

      openAttachmentViaViewer(card, abs(href));
    };

    ['pointerdown', 'click'].forEach(evt => document.addEventListener(evt, handler, true));

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const card = e.target.closest?.('.zd_v2-attachment-attachment'); if (!card) return;
      const a = card.parentElement?.querySelector('.zd_v2-attachment-attachDownload');
      const href = a?.getAttribute('href'); if (!href) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();

      openAttachmentViaViewer(card, abs(href));
    }, true);
  }

  // ===== INIT =====
  (function init() {
    injectOverlayCSS();
    installTopShortcuts();
    installSendHook();
    watchEditor();
    installAttachmentInterceptor();
  })();
})();
