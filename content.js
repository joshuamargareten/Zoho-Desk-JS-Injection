(() => {
  // The manifest injects into all frames (including Zoho's editor iframe). Everything here
  // reaches into the editor iframes from the top page, so a second copy running inside an
  // iframe would only double-handle keys.
  if (window.top !== window) return;

  // ===== CONFIG =====
  const BRAND_COLOR = "#1b1464";
  const LINE_HEIGHT = 1.5;
  const LETTER_SPACING = "0.5px";
  const EDITOR_IFRAME_SEL = 'iframe.KB_Editor_iframe[name="deskEditor_New"]';

  // Composer roots and their buttons (Zoho data-id values, verified Nov 2026).
  const COMPOSER_ROOT_SEL = '[data-id="commentBox"], .zd_v2-replyeditor-detailwrapper, .zd_v2-replyeditor-wrapper';
  const SEND_BTN_SEL = '[data-id="ticketSubmit_replySendOption"], [data-id="saveButtonId"]';
  const DISCARD_BTN_SEL = '[data-id="CancelBtn"], [data-id="clearButton"]';

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
  const resUrl = (p) => chrome.runtime.getURL(p);
  const abs = (u) => { try { return new URL(u, location.href).toString(); } catch { return u; } };
  const isVisible = (el) => !!el && el.getBoundingClientRect().width > 0;

  // ===== COMPOSER FORMATTING =====
  // Brand formatting is applied on the first keystroke into an empty line, never on focus or
  // when Zoho resets the editor. Writing into the editor after Zoho clears it (post-save or
  // Cancel) makes Zoho think there is unsaved text ("You haven't saved the comment...").
  const BLOCK_SEL = 'div,p,li,h1,h2,h3,h4,h5,h6,blockquote,td';

  function getCaretBlock(idoc) {
    const sel = idoc.getSelection && idoc.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    let node = sel.anchorNode;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node || node === idoc.body || !idoc.body.contains(node)) return null;
    return node.closest(BLOCK_SEL);
  }

  // "Empty" = no visible text or media. Covers "<br>", leftover empty wrappers after
  // select-all + delete, and lines that only hold our zero-width space.
  function isEmptyBlock(el) {
    if (el.querySelector('img,table,hr,iframe,video')) return false;
    return (el.textContent || '').replace(/[\u200B\u00A0\s]/g, '') === '';
  }

  // True when the caret's line (the text between <br>s around the caret) is empty. Shift+Enter
  // inserts a <br> and can leave the caret outside the coloured span, in a block that isn't empty.
  function caretLineIsEmpty(idoc, block, caret) {
    const lineText = (frag, lastLine) => {
      const lines = [''];
      const w = idoc.createTreeWalker(frag, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.nodeType === Node.TEXT_NODE) lines[lines.length - 1] += n.textContent;
        else if (n.tagName === 'BR') lines.push('');
      }
      return (lastLine ? lines[lines.length - 1] : lines[0]).replace(/[​ \s]/g, '');
    };
    const before = idoc.createRange();
    before.setStart(block, 0);
    before.setEnd(caret.startContainer, caret.startOffset);
    const after = idoc.createRange();
    after.setStart(caret.startContainer, caret.startOffset);
    after.setEnd(block, block.childNodes.length);
    return lineText(before.cloneContents(), true) === '' && lineText(after.cloneContents(), false) === '';
  }

  function hasExplicitColour(node, block) {
    for (let n = node; n; n = n.parentElement) {
      if (n.style?.color || (n.tagName === 'FONT' && n.getAttribute('color'))) return true;
      if (n === block) break;
    }
    return false;
  }

  function primeCaretBlock(idoc) {
    const block = getCaretBlock(idoc);
    if (!block) return;
    const sel = idoc.getSelection();
    const caret = sel.getRangeAt(0);
    const blockEmpty = isEmptyBlock(block);
    if (!blockEmpty && !caretLineIsEmpty(idoc, block, caret)) return;

    if (blockEmpty) {
      // Set per block (incl. <li>), because Zoho doesn't carry these onto new list items.
      if (!block.style.lineHeight) block.style.lineHeight = String(LINE_HEIGHT);
      if (!block.style.letterSpacing) block.style.letterSpacing = LETTER_SPACING;
    }

    let anchor = sel.anchorNode;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentElement;
    if (hasExplicitColour(anchor, block)) return; // brand colour already carried over, or user picked a colour

    const span = idoc.createElement('span');
    span.className = 'colour';
    span.setAttribute('style', `color:${BRAND_COLOR}`);
    const text = idoc.createTextNode('\u200B'); // ZWSP keeps the caret inside the span
    span.appendChild(text);

    if (blockEmpty && !block.querySelector('*:not(br)')) {
      block.textContent = '';
      block.appendChild(span);
      block.appendChild(idoc.createElement('br'));
    } else {
      caret.insertNode(span);
    }

    const range = idoc.createRange();
    range.setStart(text, 1);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const isTypingKey = (e) =>
    !!e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;

  // ===== SHORTCUTS (Ctrl+Enter = send/save, Ctrl+Shift+D = discard) =====
  // Buttons are looked up inside the composer the key was pressed in, by Zoho's data-id.
  // Matching button text page-wide used to hit "Reply All" / "Reply Actions" instead.
  function clickComposerButton(fromEl, selector) {
    const root = fromEl?.closest?.(COMPOSER_ROOT_SEL);
    if (!root) return false;
    const btn = Array.from(root.querySelectorAll(selector)).find(el => isVisible(el) && !el.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  }

  function handleShortcut(e, fromEl) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    let selector = null;
    if (!e.shiftKey && e.key === 'Enter') selector = SEND_BTN_SEL;
    else if (e.shiftKey && (e.key === 'd' || e.key === 'D')) selector = DISCARD_BTN_SEL;
    if (!selector) return;
    if (clickComposerButton(fromEl, selector)) {
      // Stop Zoho's own Ctrl+Enter handling too, so a reply can't be sent twice.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }

  // One shared listener: re-adding the same function is a no-op, so it's safe to re-wire on
  // every scan (Zoho creates a fresh iframe document each time a composer opens).
  function onEditorKeydown(e) {
    const idoc = e.currentTarget;
    if (isTypingKey(e)) { try { primeCaretBlock(idoc); } catch { } return; }
    handleShortcut(e, idoc.defaultView?.frameElement);
  }

  function watchEditors() {
    const wire = () => document.querySelectorAll(EDITOR_IFRAME_SEL).forEach(f => {
      try { f.contentDocument?.addEventListener('keydown', onEditorKeydown, true); } catch { }
    });
    wire();
    setInterval(wire, 800);
  }

  function installTopShortcuts() {
    // For focus in composer fields outside the editor iframe (To/CC/Subject).
    document.addEventListener('keydown', (e) => handleShortcut(e, document.activeElement), true);
  }

  // ===== VIEWER (proxy fetch + overlay) =====
  function getSiblingAttachments(originEl) {
    // Zoho renamed data-test-id -> data-id; accept both.
    const container = originEl?.closest?.('[data-id="attachments"], [data-test-id="attachments"]');
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
    let items = getSiblingAttachments(originEl);
    // Never open the viewer with an empty list (that produced "No source URL.")
    if (!items.some(x => x.href === href)) {
      const nameEl = originEl?.querySelector?.('.zd_v2-attachment-atatchName');
      items = [{ href, filename: (nameEl?.getAttribute('data-title') || nameEl?.textContent || '').trim() }];
    }
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
    watchEditors();
    installAttachmentInterceptor();
  })();
})();
