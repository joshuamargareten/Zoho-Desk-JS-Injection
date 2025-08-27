// replyEnhancements.prod.v5.js
(() => {
    // ---------- small utils ----------
    const norm = s => String(s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();

    // ---------- selectors ----------
    const SEL = {
        outerEditor: '.KB_Editor',
        iframe: '.KB_Editor_iframe'
    };

    // ---------- helpers ----------
    const getEmailShell = (node) =>
        node.closest('.zd_v2-replyeditor-detailwrapper, .zd_v2-replyeditor-wrapper');

    // ---------- CSS (host page) ----------
    const TOPLEVEL_CSS = `
    .zd-enh-toolbar-holder{
      display:inline-flex;align-items:center;gap:8px;margin-right:auto;
    }
    .zd-enh-toolbar-toggle{
      display:inline-flex;align-items:center;gap:.45rem;
      padding:6px 10px;border-radius:8px;
      /*background:Canvas;color:CanvasText;*/
      border:1px solid rgba(0,0,0,.15);
      font:12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      cursor:pointer;user-select:none;
    }
    .zd-enh-toolbar-toggle:hover{ filter:brightness(0.97); }

    .zd-enh-sticky-holder{ position:sticky;bottom:8px;left:8px;z-index:9;align-self:flex-start;margin-top:8px; }

    .zd-enh-composer-open{
      max-width: calc(100% - 15px);
      margin: 14px auto 26px auto;
      padding: 10px 12px;
      /*background: Canvas;*/
      box-shadow: 0 10px 22px rgba(0,0,0,.16), 0 3px 8px rgba(0,0,0,.10);
      border: none !important;
      border-radius: 12px;
    }
  
    .zd_v2-replyeditor-detailwrapper,
    .zd_v2-replyeditor-wrapper { height: 80% !important; }
    `;

    // ---------- CSS (iframe) ----------
    const IFRAME_CSS = `
      [data-zd-q-hide="1"]{ display:none !important; }
    `;

    function injectCSS(doc, id, css) {
        if (!doc || !doc.documentElement) return;
        if (doc.getElementById(id)) return;
        const s = doc.createElement('style');
        s.id = id; s.textContent = css;
        (doc.head || doc.documentElement).appendChild(s);
    }

    // ---------- Header normalization ----------
    const DASH = '[-\\u2013\\u2014]{2,}';
    const RE_ZOHO_DASHED_BLOCK =
        new RegExp(`${DASH}\\s*on\\s+([\\s\\S]*?)\\s*wrote\\s*${DASH}\\s*:?\\s*$`, 'i');
    const RE_HEADER_TAIL = /\bon\s+.+\s+wrote:?\s*$/i;

    function normalizeDashedHeadersBlockwise(root) {
        let normalized = 0;
        const blocks = root.querySelectorAll('div,p,blockquote,li,section,article,span');
        const MAX = 400;
        for (let i = 0; i < blocks.length && i < MAX; i++) {
            const el = blocks[i];
            const t = el.innerText;
            if (!t) continue;
            const m = t.match(RE_ZOHO_DASHED_BLOCK);
            if (m) {
                const inner = norm(m[1]);
                const repl = `On ${inner} wrote:`;
                if (t.trim() !== repl) { el.textContent = repl; normalized++; }
            }
        }
        return { normalized };
    }

    // ---------- Quote anchor & hide/show ----------
    const attrStr = el => (el.getAttribute('title') || el.getAttribute('data-title') || '').toLowerCase();
    function looksLikeSignEnd(el) {
        const s = attrStr(el).replace(/\s+/g, '').replace(/:+/g, '::');
        return s.includes('sign_holder::end');
    }
    function toTopChild(root, el) {
        let cur = el;
        while (cur && cur.parentNode !== root) cur = cur.parentNode;
        return cur || el || root.firstElementChild || root;
    }
    function findSignEnd(root) {
        const cand = root.querySelectorAll('[title],[data-title]');
        for (const el of cand) if (looksLikeSignEnd(el)) return toTopChild(root, el);
        return null;
    }
    function findHeaderBlock(root) {
        const blocks = root.querySelectorAll('div,p,blockquote,span,li');
        const MAX = 250;
        for (let i = 0; i < blocks.length && i < MAX; i++) {
            const el = blocks[i];
            const txt = norm(el.innerText || el.textContent || '');
            if (!txt) continue;
            if (RE_HEADER_TAIL.test(txt)) return toTopChild(root, el);
            if (RE_ZOHO_DASHED_BLOCK.test(txt)) return toTopChild(root, el);
        }
        return null;
    }
    function setHiddenAfter(root, anchor, hidden) {
        if (!anchor) return { hiddenCount: 0 };
        let hiddenCount = 0;
        for (let sib = anchor.nextSibling; sib; sib = sib.nextSibling) {
            if (sib.nodeType === 1) {
                if (hidden) { sib.setAttribute('data-zd-q-hide', '1'); hiddenCount++; }
                else { sib.removeAttribute('data-zd-q-hide'); }
            }
        }
        return { hiddenCount };
    }

    // ---------- Composer polish ----------
    function elevateComposer(outer) {
        const shell = getEmailShell(outer);
        if (shell) shell.classList.add('zd-enh-composer-open');
        return shell || null; // only email shells are valid
    }

    // ---------- Find bottom action bar (Send/Cancel row) ----------
    function findFooterLeftContainer(shell) {
        if (!shell) return null;

        // Target the row you specified (left side group)
        const row = shell.querySelector('.zd_v2-replyfooter-alignVertical');
        if (row) return row;

        // Fallback: last flex/grid row with any buttons
        const rows = shell.querySelectorAll('[data-test-id="containerComponent"],[data-selector-id="container"],div,section,footer');
        for (const r of rows) {
            const cls = r.className || '';
            if (/\breplyfooter-sendBtn\b/.test(cls)) continue; // do not attach inside send button container
            const cs = window.getComputedStyle(r);
            const hasBtns = r.querySelector('button,[role="button"],.zdr_button_tag,a');
            if (hasBtns && (cs.display === 'flex' || cs.display === 'grid')) return r;
        }
        return null;
    }

    // ---------- External toggle creation ----------
    function ensureToolbarToggle(shell, getState, onToggle) {
        if (!shell) return null;

        let holder = shell.querySelector('.zd-enh-toolbar-holder');
        if (!holder) {
            holder = document.createElement('div');
            holder.className = 'zd-enh-toolbar-holder';

            const leftGroup = findFooterLeftContainer(shell);
            if (leftGroup) {
                leftGroup.prepend(holder);   // lives at the left with the other buttons
            } else {
                // final fallback
                const sticky = document.createElement('div');
                sticky.className = 'zd-enh-sticky-holder';
                sticky.appendChild(holder);
                shell.appendChild(sticky);
            }
        }

        let btn = holder.querySelector('.zd-enh-toolbar-toggle');
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'zd-enh-toolbar-toggle';
            holder.appendChild(btn);
            btn.addEventListener('click', () => {
                const st = getState();
                onToggle(!st.hidden);
            });
        }

        const st = getState();
        btn.textContent = st.hidden ? 'Show Quoted Text' : 'Hide Quoted Text';
        return btn;
    }

    // ---------- Iframe wiring ----------
    const wired = new WeakSet();

    function wireOne(outer) {
        if (!outer || wired.has(outer)) return;
        // Only act on email composers
        const shell = elevateComposer(outer);
        if (!shell) return; // skip comments entirely
        wired.add(outer);

        injectCSS(document, 'zd-enh-style-top', TOPLEVEL_CSS);

        // strictly resolve the iframe inside this shell (avoid comment iframe)
        const iframe = shell.querySelector(SEL.iframe);
        if (!iframe) return;

        const onReady = () => {
            const doc = iframe.contentDocument; const body = doc?.body;
            if (!doc || !body) return;

            injectCSS(doc, 'zd-enh-style-iframe', IFRAME_CSS);

            // Normalize headers once (and again on mutations)
            const hdr = normalizeDashedHeadersBlockwise(body);

            // Anchor + default hide
            let anchor = findSignEnd(body) || findHeaderBlock(body);
            const hiddenDefault = true;
            const r0 = setHiddenAfter(body, anchor, hiddenDefault);

            const state = {
                hidden: hiddenDefault,
                hiddenCount: r0.hiddenCount,
                normalizedCount: hdr.normalized
            };
            outer.dataset.zdHidden = state.hidden ? '1' : '0';

            function getState() { return { ...state }; }
            function applyHidden(nextHidden) {
                anchor = findSignEnd(body) || findHeaderBlock(body) || anchor;
                const r = setHiddenAfter(body, anchor, nextHidden);
                state.hidden = nextHidden;
                state.hiddenCount = r.hiddenCount;
                outer.dataset.zdHidden = state.hidden ? '1' : '0';
                ensureToolbarToggle(shell, getState, applyHidden);
                return r;
            }

            ensureToolbarToggle(shell, getState, applyHidden);

            // Re-apply on DOM updates inside iframe
            const reapply = () => {
                const add = normalizeDashedHeadersBlockwise(body);
                state.normalizedCount += add.normalized;
                anchor = findSignEnd(body) || findHeaderBlock(body) || anchor;
                const r = setHiddenAfter(body, anchor, state.hidden);
                state.hiddenCount = r.hiddenCount;
                ensureToolbarToggle(shell, getState, applyHidden);
            };

            const mo = new MutationObserver(() => {
                // micro-debounce
                clearTimeout(mo._t);
                mo._t = setTimeout(reapply, 120);
            });
            mo.observe(body, { childList: true, subtree: true, characterData: true });
        };

        if (iframe.contentDocument?.readyState === 'complete' || iframe.contentDocument?.readyState === 'interactive') {
            onReady();
        } else {
            iframe.addEventListener('load', onReady, { once: true });
        }
    }

    function scanAll() {
        // Scope scanning to email composers only (prevents comment composer wiring)
        document.querySelectorAll(
          '.zd_v2-replyeditor-wrapper .KB_Editor:not(.zd-enh-wired), ' +
          '.zd_v2-replyeditor-detailwrapper .KB_Editor:not(.zd-enh-wired)'
        ).forEach(wireOne);
      }

    // ---------- boot ----------
    function boot() {
        injectCSS(document, 'zd-enh-style-top', TOPLEVEL_CSS);
        scanAll();
        const mo = new MutationObserver(() => {
            clearTimeout(mo._t);
            mo._t = setTimeout(scanAll, 150);
        });
        mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
