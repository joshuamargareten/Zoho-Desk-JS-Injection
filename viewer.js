(() => {
    if (window.__zdViewerWired) return;
    window.__zdViewerWired = true;

    const qs = new URLSearchParams(location.search);
    const EMBEDDED = qs.get('embedded') === '1' || qs.get('embedded') === 'true';

    // External viewer page (override with ?viewer_base=... if you like)
    const VIEWER_BASE = qs.get('viewer_base')
        || (location.origin + '/viewer.html');

    // Zoho Office Integrator relay (Google Apps Script). You can override with ?zoi_relay=...
    const ZOI_RELAY = qs.get('zoi_relay')
        || 'https://script.google.com/a/macros/theteklink.com/s/AKfycbzlWTWa4eE7FQDtRSRm0CZ9U8sH-rmfQ7PqlWyCFLY0NDfPYO1VQBQvbKANnb-W2fcuVw/exec';

    // Map extensions → which OI app to use (informational; actual routing uses sets below)
    const ZOI_APP_BY_EXT = Object.freeze({
        // Writer
        doc: 'writer', docx: 'writer', docm: 'writer',
        dot: 'writer', dotx: 'writer', dotm: 'writer',
        rtf: 'writer', odt: 'writer', sxw: 'writer',
        html: 'writer', htm: 'writer', tex: 'writer', md: 'writer',
        // Sheet
        xlsx: 'sheet', xlsm: 'sheet', xlsb: 'sheet', xls: 'sheet',
        csv: 'sheet', tsv: 'sheet', xltx: 'sheet', xltm: 'sheet',
        xlt: 'sheet', xlam: 'sheet', xla: 'sheet', ods: 'sheet', sxc: 'sheet', txt: 'sheet',
        // Show
        pptx: 'show', pptm: 'show', ppt: 'show',
        ppsx: 'show', ppsm: 'show', pps: 'show',
        potx: 'show', potm: 'show', pot: 'show',
        odp: 'show', thmx: 'show', xps: 'show', ppa: 'show', ppam: 'show'
    });

    // -------- ZOI caching (avoid re-spending credits) --------
    const ZOI_CACHE_NS = 'zoi_cache_v1';
    const ZOI_CACHE_TTL = 12 * 60 * 60 * 1000; // 12h

    function normalizeForKey(s) {
        try {
            const u = new URL(s, location.href);
            u.searchParams.delete('__ts');
            u.searchParams.delete('inline');
            return u.toString();
        } catch { return s || ''; }
    }
    function zoiHash(s) { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return (x >>> 0).toString(16); }
    function zoiCacheKey(app, name, src) { return `${app}:${(name || '').slice(0, 120)}:${zoiHash(normalizeForKey(src || ''))}`; }

    function zoiCacheGet(key) {
        try {
            const all = JSON.parse(localStorage.getItem(ZOI_CACHE_NS) || '{}');
            const rec = all[key];
            if (!rec) return null;
            if (Date.now() - rec.t > ZOI_CACHE_TTL) {
                delete all[key];
                localStorage.setItem(ZOI_CACHE_NS, JSON.stringify(all));
                return null;
            }
            return rec;
        } catch { return null; }
    }
    function zoiCacheSet(key, val) {
        try {
            const all = JSON.parse(localStorage.getItem(ZOI_CACHE_NS) || '{}');
            all[key] = { ...val, t: Date.now() };
            localStorage.setItem(ZOI_CACHE_NS, JSON.stringify(all));
        } catch { }
    }

    // One-time consent guard (don’t keep opening tabs)
    let ZOI_AUTH_PROMPTED = false;

    // Optional deep-open into a ZIP from a new tab: ?zip=<archiveURL>&entry=<path/in/zip>
    const BOOT_ZIP_URL = qs.get('zip') || '';
    const BOOT_ZIP_ENTRY = qs.get('entry') || '';

    let current = { src: qs.get('src') || qs.get('url') || "", name: qs.get('name') || "" };
    let nav = { index: 0, total: 0, embedded: EMBEDDED };

    // ZIP sub-navigation state
    let zipNav = null; // { parentSrc, parentName, entries, index }
    const inZipNav = () => !!zipNav;
    const activeZipEntry = () => inZipNav() ? zipNav.entries[zipNav.index] : null;

    const stage = document.getElementById('stage');
    const btnClose = document.getElementById('btnClose');
    const btnPrev = document.getElementById('btnPrev');
    const btnNext = document.getElementById('btnNext');
    const btnOpen = document.getElementById('btnOpen');
    const btnDownload = document.getElementById('btnDownload');
    const btnRefresh = document.getElementById('btnRefresh');
    const counter = document.getElementById('counter');
    const titleEl = document.getElementById('title');

    const uid = () => Math.random().toString(36).slice(2);

    // ===== Busy / spinner UI and async task guard =====
    let __taskSeq = 0;                       // increments per render
    const nextTask = () => (++__taskSeq);    // return a new task id
    const isTaskActive = (t) => t === __taskSeq;

    function setButtonsDisabled(disabled) {
        [btnPrev, btnNext, btnOpen, btnDownload, btnRefresh].forEach(b => {
            if (!b) return;
            b.disabled = !!disabled;
            b.classList.toggle('disabled', !!disabled);
        });
    }

    // inject tiny spinner style once
    (function injectLoadingCSS() {
        if (document.getElementById('__zdLoadingCSS')) return;
        const s = document.createElement('style');
        s.id = '__zdLoadingCSS';
        s.textContent = `
    .zd-loading { display:flex; align-items:center; justify-content:center; min-height:60vh; }
    .zd-loading .box { display:flex; gap:12px; align-items:center; font-size:14px; color:var(--text); }
    .zd-loading .spin { width:18px; height:18px; border:3px solid var(--border); border-top-color: var(--text);
        border-radius:50%; animation:zdspin 0.9s linear infinite;}
    @keyframes zdspin { to { transform:rotate(360deg); } }
    `;
        document.head.appendChild(s);
    })();

    let __loadingEl = null;
    function showLoading(msg) {
        clearStage();
        const wrap = document.createElement('div'); wrap.className = 'pad';
        const inner = document.createElement('div'); inner.className = 'pad-inner zd-loading';
        const box = document.createElement('div'); box.className = 'box';
        const spin = document.createElement('div'); spin.className = 'spin';
        const text = document.createElement('div'); text.className = 'msg'; text.textContent = msg || 'Loading…';
        box.appendChild(spin); box.appendChild(text); inner.appendChild(box); wrap.appendChild(inner); stage.appendChild(wrap);
        __loadingEl = text;
        setButtonsDisabled(true);
    }
    function updateLoading(msg) {
        if (__loadingEl) __loadingEl.textContent = msg || 'Loading…';
    }
    function hideLoading() {
        setButtonsDisabled(false);
        __loadingEl = null; // stage gets redrawn by renderers
    }


    // -------- Viewer URL builder (supports ?url=... OR ?zip=...&entry=...)
    function buildViewerUrl({ url, name, zip, entry }) {
        try {
            const base = new URL(VIEWER_BASE);
            base.searchParams.set('embedded', '0');
            if (zip && entry) {
                base.searchParams.set('zip', zip);
                base.searchParams.set('entry', entry);
                if (name) base.searchParams.set('name', name);
                return base.toString();
            }
            if (url) {
                base.searchParams.set('url', url);
                base.searchParams.set('src', url);
                if (name) base.searchParams.set('name', name);
                return base.toString();
            }
            return VIEWER_BASE;
        } catch { return url || VIEWER_BASE; }
    }

    function setCounter() {
        if (inZipNav()) {
            const total = zipNav.entries.length;
            counter.textContent = total ? `${zipNav.index + 1} / ${total}` : '— / —';
        } else {
            counter.textContent = nav.total ? `${nav.index + 1} / ${nav.total}` : '— / —';
        }
    }
    function setTitle() {
        if (inZipNav()) {
            const en = zipNav.entries[zipNav.index]?.name || '';
            titleEl.textContent = `${zipNav.parentName}/${en}`;
        } else {
            titleEl.textContent = current.name || current.src || 'Untitled';
        }
    }
    function setNavVisible() {
        const showZip = inZipNav() && zipNav.entries.length > 1;
        const showThread = !!(nav.embedded && nav.total > 1);
        const show = showZip || showThread;
        btnPrev.classList.toggle('hidden', !show);
        btnNext.classList.toggle('hidden', !show);
        counter.classList.toggle('hidden', !(nav.embedded || inZipNav()));
    }

    function clearStage() { stage.innerHTML = ""; }
    function requestClose() { if (nav.embedded) parent.postMessage({ type: 'zd-viewer-request-close' }, '*'); else window.close(); }

    // Build URL with inline=true (NO "disposition")
    function withInline(u) {
        try {
            const url = new URL(u, location.href);
            if (!url.searchParams.has('inline')) url.searchParams.set('inline', 'true');
            return url.toString();
        } catch { return u; }
    }

    // NetFree helper: append raw ~nfopt(...) AFTER inline=true was added.
    function withNetfreeOpts(u) {
        const id = Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join('');
        const suffix = `~nfopt(fileDistorted=${id}&uploadEmbeddedImages=1)`;
        return u.includes('?') ? `${u}&${suffix}` : `${u}?${suffix}`;
    }

    // ---- Proxy fetch via parent (content script) ----
    function proxyFetch(url) {
        return new Promise((resolve, reject) => {
            if (!nav.embedded) { reject(new Error("proxyFetch only in embedded mode")); return; }
            const id = uid();
            const onMsg = (e) => {
                const m = e.data || {};
                if (m.type !== 'zd-fetch-result' || m.id !== id) return;
                window.removeEventListener('message', onMsg);
                if (!m.ok) { reject(new Error(m.error || "Fetch failed")); return; }
                resolve({ ct: m.ct || '', status: m.status || 0, buf: m.buf });
            };
            window.addEventListener('message', onMsg);
            parent.postMessage({ type: 'zd-fetch', id, url }, '*');
        });
    }

    // ---- Helpers ----
    const decodeText = (buf) => {
        try { return new TextDecoder('utf-8', { fatal: false }).decode(buf); }
        catch { return ""; }
    };
    function installMarginCloser(container, mediaEl) {
        container.addEventListener('pointerdown', (ev) => {
            const path = ev.composedPath();
            if (!path.includes(mediaEl)) requestClose();
        });
    }
    function clickCloseOn(container) {
        container.addEventListener('pointerdown', (ev) => {
            if (ev.target === container) requestClose();
        });
    }
    function showError(msg) {
        clearStage();
        const pad = document.createElement('div'); pad.className = 'pad';
        const inner = document.createElement('div'); inner.className = 'pad-inner';
        const box = document.createElement('div'); box.className = 'error'; box.textContent = msg;
        inner.appendChild(box); pad.appendChild(inner); stage.appendChild(pad);
        if (nav.embedded) installMarginCloser(pad, box);
    }
    function showBlocked(custom) {
        clearStage();
        const pad = document.createElement('div'); pad.className = 'pad';
        const inner = document.createElement('div'); inner.className = 'pad-inner';
        const box = document.createElement('div'); box.className = 'error';
        box.innerHTML = `<strong>${custom || "Preview blocked for security."}</strong><div>Use “Open in new tab” or “Direct download”.</div>`;
        inner.appendChild(box); pad.appendChild(inner); stage.appendChild(pad);
        if (nav.embedded) installMarginCloser(pad, box);
    }
    function showNoPreview(custom) {
        clearStage();
        const pad = document.createElement('div'); pad.className = 'pad';
        const inner = document.createElement('div'); inner.className = 'pad-inner';
        const box = document.createElement('div'); box.className = 'error';
        box.innerHTML = `<strong>${custom || "No preview available."}</strong><div>Use “Open in new tab” or “Direct download”.</div>`;
        inner.appendChild(box); pad.appendChild(inner); stage.appendChild(pad);
        if (nav.embedded) installMarginCloser(pad, box);
    }
    function humanSize(n) {
        if (!Number.isFinite(n)) return "";
        const u = ["B", "KB", "MB", "GB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
    }
    function isPdfBytes(buf) {
        try { const s = new TextDecoder('ascii').decode(buf.slice(0, 5)); return s === '%PDF-'; } catch { return false; }
    }

    // Convert ArrayBuffer → base64 (chunked, safe for big files)
    function abToBase64(ab) {
        const CHUNK = 0x8000;
        const bytes = new Uint8Array(ab);
        let out = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(out);
    }

    // --- ZIP preview helpers ---
    function mimeFromExt(name) {
        const ext = (name.split('.').pop() || '').toLowerCase();
        switch (ext) {
            case 'png': return 'image/png';
            case 'jpg': case 'jpeg': return 'image/jpeg';
            case 'gif': return 'image/gif';
            case 'webp': return 'image/webp';
            case 'bmp': return 'image/bmp';
            case 'svg': return 'image/svg+xml';
            case 'pdf': return 'application/pdf';
            case 'mp4': return 'video/mp4';
            case 'webm': return 'video/webm';
            case 'ogg': case 'ogv': return 'video/ogg';
            case 'mov': case 'm4v': return 'video/mp4';
            case 'mp3': return 'audio/mpeg';
            case 'wav': return 'audio/wav';
            case 'm4a': return 'audio/mp4';
            case 'aac': return 'audio/aac';
            case 'flac': return 'audio/flac';
            case 'md': case 'markdown': case 'txt': case 'cfg': case 'ini': case 'conf':
            case 'log': case 'css': case 'yaml': case 'yml': case 'json': case 'xml':
            case 'csv': case 'tsv': return 'text/plain';
            // complex types -> use viewer renderers
            case 'docx': case 'docm': case 'dotx': case 'dotm': case 'dot': case 'rtf': case 'odt':
            case 'xlsx': case 'xlsm': case 'xlsb': case 'xls': case 'ods':
            case 'xltx': case 'xltm': case 'xlt': case 'xlam': case 'xla':
                return 'application/octet-stream';
            default: return 'application/octet-stream';
        }
    }

    // ---- ZOI helpers ----
    function getZoiAppForExt(ext) {
        if (DOC_TYPES.has(ext)) return 'writer';
        if (SHEET_TYPES.has(ext)) return 'sheet';
        if (PPT_TYPES.has(ext)) return 'show';
        return null;
    }

    // Try inline preview via Zoho Office Integrator (uses Apps Script relay). Returns true if used.
    async function tryZohoOffice(src, name, ext, taskId) {
        if (!nav.embedded) return false;        // only in embedded mode (proxyFetch for private URLs)
        const app = getZoiAppForExt(ext);
        if (!app) return false;

        // Cache hit? Embed directly.
        const key = zoiCacheKey(app, name || '', src || '');
        const cached = zoiCacheGet(key);
        if (cached && cached.openUrl) {
            clearStage();
            const host = document.createElement('div'); host.className = 'doc-edge';
            const f = document.createElement('iframe'); f.className = 'doc-frame';
            f.src = cached.openUrl;
            host.appendChild(f); stage.appendChild(host);
            if (nav.embedded) clickCloseOn(host);
            return true;
        }

        // 1) Download bytes
        showLoading('Downloading…');
        let ab;
        try {
            const { buf } = await proxyFetch(src);
            if (!isTaskActive(taskId)) return true; // user navigated away; do nothing
            ab = buf;
        } catch {
            if (!isTaskActive(taskId)) return true;
            return false;
        }

        // 2) Encode
        updateLoading('Preparing…');
        const dataBase64 = abToBase64(ab);
        if (!isTaskActive(taskId)) return true;

        // 3) Build relay payload
        let resp, ct, text, json;
        try {
            const body = {
                app,
                dataBase64,
                name: name || ('file.' + (ext || 'bin')),
                language: 'en',
                lang: 'en',
            };
            if (app === 'sheet') body.permissions = { "document.export": true, "document.print": true };
            if (app === 'show') body.document_info = { document_name: name || 'Untitled', document_id: (name || 'doc').replace(/[^\w\-.]+/g, '_').slice(0, 64) };

            // 4) Call Apps Script relay
            updateLoading('Uploading to Zoho…');
            resp = await fetch(ZOI_RELAY, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                cache: 'no-cache',
                credentials: 'include'
            });
            ct = (resp.headers.get('content-type') || '').toLowerCase();
            text = await resp.text();
            if (ct.includes('application/json')) json = JSON.parse(text);
        } catch (e) {
            if (!isTaskActive(taskId)) return true;
            showError('ZOI relay error: ' + (e.message || e));
            return false;
        }

        // 5) If first-time auth page showed up (HTML/redirect), prompt user
        if (!json || !json.openUrl) {
            if (!ZOI_AUTH_PROMPTED) {
                ZOI_AUTH_PROMPTED = true;
                const authUrl = ZOI_RELAY; // open the web app itself; user consents, then refresh
                if (nav.embedded) parent.postMessage({ type: 'zd-viewer-request-open-new-tab', src: authUrl, name: 'Authorize Zoho Office Relay' }, '*');
                else window.open(authUrl, '_blank', 'noopener');
                showError('Please authorize the relay in the new tab, then return and click Refresh.');
            }
            return false;
        }

        // Cache + embed
        zoiCacheSet(key, { openUrl: json.openUrl });
        if (!isTaskActive(taskId)) return true;
        clearStage();
        const host = document.createElement('div'); host.className = 'doc-edge';
        const f = document.createElement('iframe'); f.className = 'doc-frame';
        f.src = json.openUrl;
        host.appendChild(f); stage.appendChild(host);
        if (nav.embedded) clickCloseOn(host);
        hideLoading();
        return true;
    }

    // Open via ZOI using a URL source (for "Open" button). Uses cache when available.
    async function openWithZOI(app, name, src) {
        const key = zoiCacheKey(app, name || '', src || '');
        const cached = zoiCacheGet(key);
        if (cached && cached.openUrl) {
            const url = cached.openUrl;
            if (nav.embedded) parent.postMessage({ type: 'zd-viewer-request-open-new-tab', src: url, name }, '*');
            else window.open(url, '_blank', 'noopener');
            return true;
        }

        // fetch file bytes
        let buf;
        try {
            if (nav.embedded) { const r = await proxyFetch(src); buf = r.buf; }
            else { const r = await fetch(src, { credentials: 'include', cache: 'reload' }); buf = await r.arrayBuffer(); }
        } catch (e) {
            showError('Could not fetch file for ZOI: ' + (e.message || e));
            return false;
        }

        return await openWithZOIFromBuffer(app, name, buf, key);
    }

    // Open via ZOI when we already have bytes (ZIP entry)
    async function openWithZOIFromBuffer(app, name, ab, cacheKey) {
        let resp, ct, text, json;
        try {
            const body = JSON.stringify({
                app,
                dataBase64: abToBase64(ab),
                name,
                language: 'en',
                permissions: app === 'sheet' ? { "document.export": true, "document.print": true } : undefined,
                document_info: app === 'show' ? { document_name: name || 'Untitled', document_id: (name || 'doc').replace(/[^\w\-.]+/g, '_').slice(0, 64) } : undefined
            });
            resp = await fetch(ZOI_RELAY, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
                cache: 'no-cache',
                credentials: 'include'
            });
            ct = (resp.headers.get('content-type') || '').toLowerCase();
            text = await resp.text();
            if (ct.includes('application/json')) json = JSON.parse(text);
        } catch (e) {
            showError('ZOI relay error: ' + (e.message || e));
            return false;
        }

        // If not JSON or missing openUrl → needs consent
        if (!json || !json.openUrl) {
            if (!ZOI_AUTH_PROMPTED) {
                ZOI_AUTH_PROMPTED = true;
                const authUrl = ZOI_RELAY;
                if (nav.embedded) parent.postMessage({ type: 'zd-viewer-request-open-new-tab', src: authUrl, name: 'Authorize Zoho Office Relay' }, '*');
                else window.open(authUrl, '_blank', 'noopener');
                showError('Please authorize the relay in the new tab, then return and click Refresh.');
            }
            return false;
        }

        if (cacheKey) zoiCacheSet(cacheKey, { openUrl: json.openUrl });

        const url = json.openUrl;
        if (nav.embedded) parent.postMessage({ type: 'zd-viewer-request-open-new-tab', src: url, name }, '*');
        else window.open(url, '_blank', 'noopener');
        return true;
    }

    // ---- Renderers ----
    async function renderImage(src, forceSvg = false) {
        clearStage();
        const pad = document.createElement('div'); pad.className = 'pad';
        const inner = document.createElement('div'); inner.className = 'pad-inner';
        const img = document.createElement('img'); img.className = 'media-img'; img.alt = current.name || "image";
        inner.appendChild(img); pad.appendChild(inner); stage.appendChild(pad);

        try {
            if (nav.embedded) {
                const { buf } = await proxyFetch(src);
                const type = forceSvg ? 'image/svg+xml'
                    : /\.(svg)$/i.test(current.name || src) ? 'image/svg+xml'
                        : /\.(png)$/i.test(current.name || src) ? 'image/png'
                            : /\.(jpe?g)$/i.test(current.name || src) ? 'image/jpeg'
                                : /\.(gif)$/i.test(current.name || src) ? 'image/gif'
                                    : 'application/octet-stream';
                const url = URL.createObjectURL(new Blob([buf], { type }));
                img.src = url;
            } else {
                img.src = src; // keep your existing direct path behavior
            }
            if (nav.embedded) installMarginCloser(pad, img);
        } catch (e) { showError(`Image failed: ${e.message || e}`); }
    }

    async function renderVideo(src) {
        clearStage();
        const pad = document.createElement('div'); pad.className = 'pad';
        const inner = document.createElement('div'); inner.className = 'pad-inner';
        const vid = document.createElement('video'); vid.className = 'media-video'; vid.controls = true;
        inner.appendChild(vid); pad.appendChild(inner); stage.appendChild(pad);

        try {
            if (nav.embedded) {
                const { buf, ct } = await proxyFetch(src);
                const url = URL.createObjectURL(new Blob([buf], { type: ct || 'video/*' }));
                vid.src = url;
            } else {
                vid.src = src;
            }
            if (nav.embedded) installMarginCloser(pad, vid);
        } catch (e) { showError(`Video failed: ${e.message || e}`); }
    }

    async function renderAudio(src) {
        clearStage();
        const pad = document.createElement('div'); pad.className = 'pad';
        const inner = document.createElement('div'); inner.className = 'pad-inner';
        const aud = document.createElement('audio'); aud.className = 'media-audio'; aud.controls = true;
        inner.appendChild(aud); pad.appendChild(inner); stage.appendChild(pad);

        try {
            if (nav.embedded) {
                const { buf, ct } = await proxyFetch(src);
                const url = URL.createObjectURL(new Blob([buf], { type: ct || 'audio/*' }));
                aud.src = url;
            } else {
                aud.src = src;
            }
            if (nav.embedded) installMarginCloser(pad, aud);
        } catch (e) { showError(`Audio failed: ${e.message || e}`); }
    }

    async function renderPDF(src) {
        clearStage();
        const host = document.createElement('div'); host.className = 'doc-edge';
        const f = document.createElement('iframe'); f.className = 'doc-frame';
        host.appendChild(f); stage.appendChild(host);

        async function tryLoad(u, tryNetfree) {
            try {
                if (nav.embedded) {
                    const baseInline = withInline(u);
                    let res = await proxyFetch(baseInline);
                    if (res.status === 418 && tryNetfree) {
                        const nfUrl = withNetfreeOpts(baseInline);
                        res = await proxyFetch(nfUrl);
                    }
                    if (!isPdfBytes(res.buf)) throw new Error("Not a PDF or blocked.");
                    const url = URL.createObjectURL(new Blob([res.buf], { type: 'application/pdf' }));
                    f.src = url;
                    return true;
                } else {
                    f.src = withInline(u);
                    return true;
                }
            } catch { return false; }
        }

        const ok = await tryLoad(src, /*tryNetfree*/ true);
        if (!ok) {
            if (nav.embedded) {
                parent.postMessage({ type: 'zd-viewer-request-open-new-tab', src: withInline(src) }, '*');
                showError("PDF could not be rendered here. Opened in a new tab.");
            } else {
                showError("PDF could not be rendered.");
            }
        }
        if (nav.embedded) clickCloseOn(host);
    }

    // ----- Word-family -----
    async function renderDOCX_like(src) {
        clearStage();
        const host = document.createElement('div'); host.className = 'doc-edge doc-withpad';
        const doc = document.createElement('div'); doc.className = 'doc-host';
        const pad = document.createElement('div'); pad.className = 'doc-pad'; pad.textContent = 'Loading…';
        doc.appendChild(pad); host.appendChild(doc); stage.appendChild(host);

        try {
            const { buf } = nav.embedded
                ? await proxyFetch(src)
                : await (async () => {
                    const r = await fetch(src, { credentials: 'include', cache: 'reload' });
                    return { buf: await r.arrayBuffer() };
                })();

            // Try docx-preview first
            try {
                pad.innerHTML = "";
                const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
                await window.docx.renderAsync(blob, pad, undefined, {
                    inWrapper: true, useBase64URL: true, ignoreLastRenderedPageBreak: false
                });
                if (nav.embedded) clickCloseOn(host);
                return;
            } catch { /* try mammoth */ }

            try {
                const result = await window.mammoth.convertToHtml({ arrayBuffer: buf }, { includeDefaultStyleMap: true });
                pad.innerHTML = result.value || "<em>(Empty)</em>";
                if (nav.embedded) clickCloseOn(host);
                return;
            } catch { /* ignore */ }

            showNoPreview("This Word document can't be previewed here.");
        } catch (e) { showError(`Word preview failed: ${e.message || e}`); }
    }

    // RTF (plain text fallback)
    async function renderRTF(src) {
        clearStage();
        const pad = document.createElement('div'); pad.className = 'pad';
        const inner = document.createElement('div'); inner.className = 'pad-inner';
        const box = document.createElement('div'); box.className = 'text-wrap';
        const pre = document.createElement('pre'); pre.className = 'code';
        box.appendChild(pre); inner.appendChild(box); pad.appendChild(inner); stage.appendChild(pad);
        try {
            const raw = nav.embedded
                ? decodeText((await proxyFetch(src)).buf)
                : await (await fetch(src, { credentials: 'include', cache: 'reload' })).text();
            const txt = raw
                .replace(/\\'[0-9a-fA-F]{2}/g, '?')
                .replace(/\\[a-z]+-?\d*\s?/g, '')
                .replace(/[{}]/g, '')
                .replace(/\r\n?/g, '\n')
                .trim();
            pre.textContent = txt || "(empty)";
            if (nav.embedded) installMarginCloser(pad, box);
        } catch (e) { showError(`RTF failed: ${e.message || e}`); }
    }

    // ODT (use WebODF if present; fallback to content.xml mapping)
    async function renderODT(src) {
        clearStage();
        const host = document.createElement('div'); host.className = 'doc-edge doc-withpad';
        const doc = document.createElement('div'); doc.className = 'doc-host';
        const pad = document.createElement('div'); pad.className = 'doc-pad'; pad.textContent = 'Loading…';
        doc.appendChild(pad); host.appendChild(doc); stage.appendChild(host);
        try {
            const ab = nav.embedded
                ? (await proxyFetch(src)).buf
                : await (await fetch(src, { credentials: 'include', cache: 'reload' })).arrayBuffer();

            // Prefer WebODF if available
            if (window.odf && window.odf.OdfCanvas) {
                pad.innerHTML = '';
                const holder = document.createElement('div');
                holder.style.minHeight = '70vh';
                holder.style.border = '1px solid var(--border)';
                holder.style.background = 'var(--bg)';
                pad.appendChild(holder);

                const blob = new Blob([ab], { type: 'application/vnd.oasis.opendocument.text' });
                const url = URL.createObjectURL(blob);
                const canvas = new window.odf.OdfCanvas(holder);
                canvas.load(url);
                if (nav.embedded) clickCloseOn(host);
                return;
            }

            // Fallback: JSZip -> content.xml
            const zip = await window.JSZip.loadAsync(ab);
            const entry = zip.file('content.xml');
            if (!entry) { showNoPreview("ODT content not found."); return; }
            const xml = await entry.async('text');
            const html = xml
                .replace(/<text:p[^>]*>/g, '<p>').replace(/<\/text:p>/g, '</p>')
                .replace(/<text:h[^>]*>/g, '<h3>').replace(/<\/text:h>/g, '</h3>')
                .replace(/<\/?office:text[^>]*>/g, '');
            pad.innerHTML = html || "<em>(Empty)</em>";
            if (nav.embedded) clickCloseOn(host);
        } catch (e) { showError(`ODT failed: ${e.message || e}`); }
    }

    async function renderDOC_Fallback() {
        showNoPreview("Legacy Word document (DOC/DOT) preview not supported.");
    }

    // ----- Excel-family -----
    async function renderSheet(src) {
        clearStage();
        const host = document.createElement('div'); host.className = 'doc-edge doc-withpad';
        const doc = document.createElement('div'); doc.className = 'doc-host';
        const pad = document.createElement('div'); pad.className = 'doc-pad'; pad.textContent = 'Loading…';
        doc.appendChild(pad); host.appendChild(doc); stage.appendChild(host);

        try {
            const { buf, ct } = nav.embedded
                ? await proxyFetch(src)
                : await (async () => { const r = await fetch(src, { credentials: 'include', cache: 'reload' }); return { buf: await r.arrayBuffer(), ct: r.headers.get('content-type') || '' }; })();

            let wb;
            const name = (current.name || "").toLowerCase();
            const isText = /csv|tsv|text\/plain/.test(ct || "") || /\.csv$|\.tsv$/i.test(name);
            if (isText) {
                const text = new TextDecoder('utf-8').decode(buf);
                wb = window.XLSX.read(text, { type: 'string' });
            } else {
                wb = window.XLSX.read(buf, { type: 'array' });
            }

            const tabs = document.createElement('div'); tabs.style.display = 'flex'; tabs.style.gap = '8px'; tabs.style.marginBottom = '12px';
            const body = document.createElement('div');
            pad.innerHTML = ''; pad.appendChild(tabs); pad.appendChild(body);

            wb.SheetNames.forEach((name, i) => {
                const b = document.createElement('button'); b.textContent = name; b.className = 'btn'; b.style.background = i === 0 ? 'var(--btn-hover)' : 'var(--btn-bg)';
                b.onclick = () => { tabs.querySelectorAll('button').forEach(x => x.style.background = 'var(--btn-bg)'); b.style.background = 'var(--btn-hover)'; renderBody(name); };
                tabs.appendChild(b);
            });

            function renderBody(name) {
                body.innerHTML = window.XLSX.utils.sheet_to_html(wb.Sheets[name], { header: "", footer: "" });
                const tbl = body.querySelector('table');
                if (tbl) {
                    tbl.style.width = "100%"; tbl.style.borderCollapse = "collapse"; tbl.style.background = "var(--bg)";
                    tbl.querySelectorAll('td,th').forEach(td => { td.style.border = "1px solid var(--border)"; td.style.padding = "6px 8px"; td.style.color = "var(--text)"; });
                }
            }
            renderBody(wb.SheetNames[0]);
        } catch (e) { showError(`Spreadsheet failed: ${e.message || e}`); }
        if (nav.embedded) clickCloseOn(host);
    }

    // ----- PowerPoint-family (recognized; preview fallback) -----
    async function renderPPT_like() {
        showNoPreview("Presentation preview not supported here.");
    }

    // Enter/exit ZIP sub-view
    function enterZipNav(entry) {
        const ctx = window.__zipCtx;
        if (!ctx) return;
        zipNav = {
            parentSrc: ctx.src,
            parentName: ctx.name || 'archive.zip',
            entries: ctx.entries,
            index: ctx.entries.indexOf(entry)
        };
        setCounter(); setTitle(); setNavVisible();
    }
    function exitZipNav() {
        zipNav = null;
        setCounter(); setTitle(); setNavVisible();
    }

    // Open a ZIP entry in the normal viewer pipeline (sub-view aware)
    async function openZipEntryInViewer(entry) {
        enterZipNav(entry);

        const zipSrc = zipNav.parentSrc;
        const zipName = zipNav.parentName;

        try {
            const blob = await entry.async('blob');
            const typed = new Blob([blob], { type: mimeFromExt(entry.name) });
            const url = URL.createObjectURL(typed);

            current = { src: url, name: entry.name };
            setTitle(); setCounter(); setNavVisible();

            const taskId = nextTask();
            renderByType(url, entry.name, taskId);

            setTimeout(() => {
                const overlay = document.createElement('div');
                Object.assign(overlay.style, { position: 'absolute', top: '10px', left: '10px', zIndex: '5', pointerEvents: 'none' });
                const back = document.createElement('button');
                back.textContent = '← Back to archive';
                back.className = 'btn';
                back.style.pointerEvents = 'auto';
                back.onclick = () => { URL.revokeObjectURL(url); exitZipNav(); render(zipSrc, zipName); };
                overlay.appendChild(back);
                stage.appendChild(overlay);

                const mo = new MutationObserver(() => { if (!stage.contains(overlay)) mo.disconnect(); });
                mo.observe(stage, { childList: true, subtree: true });
            }, 0);
        } catch (e) {
            showError('Preview failed: ' + (e.message || e));
        }
    }

    // Render ZIP (list + open actions)
    async function renderZIP(src) {
        clearStage();
        const wrap = document.createElement('div'); wrap.className = 'pad';
        const inner = document.createElement('div'); inner.className = 'pad-inner';
        const box = document.createElement('div'); box.className = 'zip-list';
        inner.appendChild(box); wrap.appendChild(inner); stage.appendChild(wrap);

        try {
            const { buf } = nav.embedded
                ? await proxyFetch(src)
                : await (async () => { const r = await fetch(src, { credentials: 'include', cache: 'reload' }); return { buf: await r.arrayBuffer() }; })();

            const zip = await window.JSZip.loadAsync(buf);

            // Remember this archive for sub-navigation
            window.__zipCtx = {
                src,
                name: current.name,
                entries: Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name))
            };

            // Header
            const header = document.createElement('div');
            header.className = 'zip-row';
            header.innerHTML = `<div class="name" style="font-weight:700">Name</div><div class="size" style="width:120px;text-align:right">Size</div><div style="width:160px;text-align:right">Actions</div>`;
            box.appendChild(header);

            // Rows
            const entries = window.__zipCtx.entries;
            for (const f of entries) {
                const row = document.createElement('div'); row.className = 'zip-row';
                const name = document.createElement('div'); name.className = 'name'; name.textContent = f.name + (f.dir ? ' /' : '');
                const size = document.createElement('div'); size.className = 'size'; size.textContent = f.dir ? "" : humanSize(f._data?.uncompressedSize || f._data?.compressedSize || 0);
                const actions = document.createElement('div'); actions.style.width = '160px'; actions.style.textAlign = 'right';

                // Download entry
                const dl = document.createElement('button'); dl.className = 'btn'; dl.textContent = 'Download';
                dl.disabled = f.dir;
                dl.onclick = async (ev) => {
                    ev.stopPropagation();
                    try {
                        const blob = await f.async('blob');
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = f.name.split('/').pop() || 'file';
                        document.body.appendChild(a); a.click(); a.remove();
                        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
                    } catch (e) { alert('Download failed: ' + e); }
                };

                // Open entry in full viewer sub-view
                const canOpen = !f.dir;
                const openBtn = document.createElement('button');
                openBtn.className = 'btn';
                openBtn.textContent = 'Open';
                openBtn.disabled = !canOpen;
                if (canOpen) openBtn.onclick = (ev) => { ev.stopPropagation(); openZipEntryInViewer(f); };

                actions.appendChild(openBtn);
                actions.appendChild(dl);

                row.appendChild(name); row.appendChild(size); row.appendChild(actions);
                box.appendChild(row);
            }

            if (nav.embedded) {
                installMarginCloser(wrap, box);
                wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) requestClose(); });
            }

            // If this tab was opened with ?zip=...&entry=..., auto-open that entry now
            if (BOOT_ZIP_URL && BOOT_ZIP_ENTRY && src === BOOT_ZIP_URL) {
                const target = entries.find(e => e.name === BOOT_ZIP_ENTRY);
                if (target) openZipEntryInViewer(target);
            }
        } catch (e) {
            showError(`ZIP failed: ${e.message || e}`);
        }
    }

    async function renderTextLike(src) {
        clearStage();
        const pad = document.createElement('div'); pad.className = 'pad';
        const inner = document.createElement('div'); inner.className = 'pad-inner';
        const box = document.createElement('div'); box.className = 'text-wrap';
        const pre = document.createElement('pre'); pre.className = 'code';
        box.appendChild(pre); inner.appendChild(box); pad.appendChild(inner); stage.appendChild(pad);

        try {
            let text = "";
            if (nav.embedded) {
                const { buf } = await proxyFetch(src);
                text = decodeText(buf);
            } else {
                const r = await fetch(src, { credentials: 'include', cache: 'reload' }); text = await r.text();
            }
            pre.textContent = text || "(empty)";
            if (nav.embedded) installMarginCloser(pad, box);
        } catch (e) { showError(`Text failed: ${e.message || e}`); }
    }

    async function renderMarkdown(src) {
        clearStage();
        const pad = document.createElement('div'); pad.className = 'pad';
        const inner = document.createElement('div'); inner.className = 'pad-inner';
        const box = document.createElement('div'); box.className = 'text-wrap';
        inner.appendChild(box); pad.appendChild(inner); stage.appendChild(pad);

        try {
            let md = "";
            if (nav.embedded) {
                const { buf } = await proxyFetch(src);
                md = decodeText(buf);
            } else {
                const r = await fetch(src, { credentials: 'include', cache: 'reload' }); md = await r.text();
            }
            const html = window.marked.parse(md || "");
            box.innerHTML = html || "<em>(empty)</em>";
            if (nav.embedded) installMarginCloser(pad, box);
        } catch (e) { showError(`Markdown failed: ${e.message || e}`); }
    }

    function makeJsonRow(key, value) {
        const spanK = document.createElement('span'); spanK.className = 'json-key'; spanK.textContent = key ? `"${key}": ` : "";
        if (value === null) {
            const v = document.createElement('span'); v.className = 'json-null'; v.textContent = 'null';
            return [spanK, v];
        }
        if (Array.isArray(value) || typeof value === 'object') {
            const toggle = document.createElement('span'); toggle.className = 'json-toggle'; toggle.textContent = Array.isArray(value) ? 'Array' : 'Object';
            const container = document.createElement('div'); container.style.marginLeft = '16px'; container.style.display = 'none';
            toggle.addEventListener('click', () => { container.style.display = container.style.display === 'none' ? 'block' : 'none'; });
            const row = document.createElement('div'); row.className = 'json-row'; row.appendChild(spanK); row.appendChild(toggle);
            const wrap = document.createElement('div'); wrap.appendChild(row); wrap.appendChild(container);
            const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
            for (const [k, v] of entries) {
                const sub = document.createElement('div'); sub.className = 'json-row';
                const parts = makeJsonRow(k, v);
                parts.forEach(p => sub.appendChild(p));
                container.appendChild(sub);
            }
            return [wrap];
        }
        const spanV = document.createElement('span');
        if (typeof value === 'string') { spanV.className = 'json-str'; spanV.textContent = `"${value}"`; }
        else if (typeof value === 'number') { spanV.className = 'json-num'; spanV.textContent = String(value); }
        else if (typeof value === 'boolean') { spanV.className = 'json-bool'; spanV.textContent = String(value); }
        else { spanV.textContent = String(value); }
        return [spanK, spanV];
    }

    async function renderJSON(src) {
        clearStage();
        const pad = document.createElement('div'); pad.className = 'pad';
        const inner = document.createElement('div'); inner.className = 'pad-inner';
        const box = document.createElement('div'); box.className = 'text-wrap';
        const tree = document.createElement('div'); tree.className = 'json-tree';
        box.appendChild(tree); inner.appendChild(box); pad.appendChild(inner); stage.appendChild(pad);

        try {
            let raw = "";
            if (nav.embedded) {
                const { buf } = await proxyFetch(src);
                raw = decodeText(buf);
            } else {
                const r = await fetch(src, { credentials: 'include', cache: 'reload' }); raw = await r.text();
            }
            try {
                const obj = JSON.parse(raw);
                tree.innerHTML = "";
                const top = document.createElement('div'); top.className = 'json-row';
                const parts = makeJsonRow("", obj);
                parts.forEach(p => top.appendChild(p));
                tree.appendChild(top);
            } catch {
                const pre = document.createElement('pre'); pre.className = 'code'; pre.textContent = raw || "(empty)";
                box.innerHTML = ""; box.appendChild(pre);
            }
            if (nav.embedded) installMarginCloser(pad, box);
        } catch (e) { showError(`JSON failed: ${e.message || e}`); }
    }

    async function renderSVG(src) { return renderImage(src, true); }

    // ---- Dispatcher ----
    function isSecurityBlocked(srcOrName) {
        const low = (current.name || srcOrName || "").toLowerCase();
        return /\.(html?|xhtml|mhtml?|js|mjs)$/i.test(low);
    }
    function extOf(nameOrUrl) {
        const u = (nameOrUrl || "").toLowerCase();
        const m = u.match(/\.([a-z0-9]+)(?:[\?#].*)?$/i);
        return m ? m[1] : "";
    }

    // Extension groups
    const DOC_TYPES = new Set(['docx', 'docm', 'doc', 'dotx', 'dotm', 'dot', 'rtf', 'odt']);
    const SHEET_TYPES = new Set(['xlsx', 'xlsm', 'xlsb', 'xls', 'csv', 'tsv', 'xltx', 'xltm', 'xlt', 'xlam', 'xla', 'ods']);
    const PPT_TYPES = new Set(['pptx', 'pptm', 'ppt', 'xps', 'potx', 'potm', 'pot', 'thmx', 'ppsx', 'ppsm', 'pps', 'ppam', 'ppa', 'odp']);

    function renderByType(src, name, taskId) {
        const ext = extOf(name || src);
        if (isSecurityBlocked(name || src)) return showBlocked();

        // markdown / json / text (keep local)
        if (ext === 'md' || ext === 'markdown') return renderMarkdown(src);
        if (ext === 'json') return renderJSON(src);
        if (['txt', 'cfg', 'ini', 'conf', 'log', 'css', 'yaml', 'yml'].includes(ext)) return renderTextLike(src);

        // vector / raster (keep local)
        if (ext === 'svg') return renderSVG(src);
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return renderImage(src);

        // media (keep local)
        if (['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v'].includes(ext)) return renderVideo(src);
        if (['mp3', 'wav', 'm4a', 'aac', 'flac'].includes(ext)) return renderAudio(src);

        // pdf (keep your existing path)
        if (ext === 'pdf') return renderPDF(src);

        // docs → try Zoho OI, then fallback to your current handlers
        if (DOC_TYPES.has(ext)) {
            (async () => {
                if (await tryZohoOffice(src, name, ext, taskId)) return;
                hideLoading();
                if (ext === 'rtf') return renderRTF(src);
                if (ext === 'odt') return renderODT(src);
                if (ext === 'doc' || ext === 'dot') return renderDOC_Fallback(src);
                return renderDOCX_like(src);
            })();
            return;
        }

        // sheets → try Zoho OI, then fallback
        if (SHEET_TYPES.has(ext)) {
            (async () => {
                if (await tryZohoOffice(src, name, ext, taskId)) return;
                hideLoading();
                return renderSheet(src);
            })();
            return;
        }

        // presentations → try Zoho OI, then fallback
        if (PPT_TYPES.has(ext)) {
            (async () => {
                if (await tryZohoOffice(src, name, ext, taskId)) return;
                hideLoading();
                return renderPPT_like(src, ext);
            })();
            return;
        }

        // archives (keep local)
        if (['zip', '7z', 'rar', 'gz', 'tar'].includes(ext)) return renderZIP(src);

        return showNoPreview();
    }

    function render(src, name) {
        const taskId = nextTask();
        current = { src, name };
        setCounter(); setTitle(); setNavVisible();
        if (!src) { showError("No source URL."); return; }
        renderByType(src, name, taskId);
    }

    // ---- UI wiring ----
    btnClose.addEventListener('click', () => requestClose());

    btnPrev.addEventListener('click', async () => {
        if (inZipNav()) {
            zipNav.index = (zipNav.index - 1 + zipNav.entries.length) % zipNav.entries.length;
            openZipEntryInViewer(zipNav.entries[zipNav.index]);
        } else if (nav.embedded) {
            parent.postMessage({ type: 'zd-viewer-nav-prev' }, '*');
        }
    });

    btnNext.addEventListener('click', async () => {
        if (inZipNav()) {
            zipNav.index = (zipNav.index + 1) % zipNav.entries.length;
            openZipEntryInViewer(zipNav.entries[zipNav.index]);
        } else if (nav.embedded) {
            parent.postMessage({ type: 'zd-viewer-nav-next' }, '*');
        }
    });

    btnOpen.addEventListener('click', async () => {
        // ZIP sub-view first
        if (inZipNav()) {
            const entry = activeZipEntry();
            if (!entry) return;

            const ext = (entry.name.split('.').pop() || '').toLowerCase();
            const app = getZoiAppForExt(ext);

            // Prefer ZOI for supported types inside ZIP
            if (app) {
                try {
                    const ab = await entry.async('arraybuffer');
                    const ok = await openWithZOIFromBuffer(app, entry.name, ab /* no cache for ZIP by default */);
                    if (ok) return;
                } catch { }
            }

            // Fallback: open our viewer for that entry (your current behavior)
            const viewerUrl = buildViewerUrl({ zip: zipNav.parentSrc, entry: entry.name, name: entry.name });
            if (nav.embedded) parent.postMessage({ type: 'zd-viewer-request-open-new-tab', src: viewerUrl, name: entry.name }, '*');
            else window.open(viewerUrl, "_blank", "noopener");
            return;
        }

        // Top-level file
        const ext = (current.name || current.src || '').split('.').pop().toLowerCase();
        if (ext === 'pdf') {
            // your PDF rule: open original URL
            const original = withInline(current.src);
            if (nav.embedded) parent.postMessage({ type: 'zd-viewer-request-open-new-tab', src: original, name: current.name }, '*');
            else window.open(original, "_blank", "noopener");
            return;
        }

        // Try ZOI for Writer/Sheet/Show types
        const app = getZoiAppForExt(ext);
        if (app) {
            const ok = await openWithZOI(app, current.name, current.src);
            if (ok) return;
        }

        // Fallback to your viewer
        const viewerUrl = buildViewerUrl({ url: withInline(current.src), name: current.name });
        if (nav.embedded) parent.postMessage({ type: 'zd-viewer-request-open-new-tab', src: viewerUrl, name: current.name }, '*');
        else window.open(viewerUrl, "_blank", "noopener");
    });

    btnDownload.addEventListener('click', async () => {
        if (inZipNav()) {
            const entry = activeZipEntry();
            if (!entry) return;
            try {
                const blob = await entry.async('blob');
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = entry.name.split('/').pop() || 'file';
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            } catch (e) { alert('Download failed: ' + e); }
            return;
        }
        if (nav.embedded) {
            parent.postMessage({ type: 'zd-viewer-request-direct-download', src: current.src }, '*');
        } else {
            const a = document.createElement('a'); a.href = current.src; a.target = "_blank"; a.rel = "noopener";
            document.body.appendChild(a); a.click(); a.remove();
        }
    });

    // REFRESH: no extra query params; just re-render (standalone fetches use cache:'reload')
    btnRefresh.addEventListener('click', () => {
        if (inZipNav()) {
            const entry = activeZipEntry();
            if (entry) openZipEntryInViewer(entry);
            return;
        }
        render(current.src, current.name);
    });

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') requestClose(); });

    // Embedded bootstrap
    window.addEventListener('message', (e) => {
        const m = e.data || {};
        if (m.type === 'zd-viewer-load') {
            const { src, name, index, total, embedded } = m.payload || {};
            if (typeof index === 'number') nav.index = index;
            if (typeof total === 'number') nav.total = total;
            nav.embedded = !!embedded;
            exitZipNav();
            render(src, name);
        }
    });

    // Standalone boot
    (function bootStandalone() {
        if (!EMBEDDED) {
            nav = { index: 0, total: 0, embedded: false };
            if (BOOT_ZIP_URL) {
                current = { src: BOOT_ZIP_URL, name: current.name || (BOOT_ZIP_URL.split('/').pop() || 'archive.zip') };
                renderZIP(BOOT_ZIP_URL);
            } else if (current.src) {
                render(current.src, current.name);
            } else {
                setCounter(); setTitle(); setNavVisible();
            }
        } else {
            setCounter(); setTitle(); setNavVisible();
        }
    })();
})();
