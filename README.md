# Teklink Zoho Desk Helper

Chrome extension that adds a smarter Zoho Desk reply composer and a robust, zero‑backend attachment viewer (images, audio/video, PDFs, Office docs, spreadsheets, markdown, JSON, archives, and more). Works embedded inside Zoho Desk and as a standalone viewer tab.

---
## Contents
- What’s included
- How it works
- Supported file types
- ZIP sub‑viewer (deep navigation)
- Buttons & behaviors
- Install / Load the extension
- Libraries (no backend required)
- Configuration & URLs
- Composer enhancements
- Security notes
- Troubleshooting

---
## What’s included
```
.
├─ manifest.json                          # MV3 manifest (see below)
├─ content/
│  ├─ replyEnhancements.js                # Composer logic (quoted text hide/show, etc.)
│  └─ replyEnhancements.css               # Styling injected into the Zoho page
├─ viewer.html                            # In-extension viewer UI
├─ viewer.css
├─ viewer.js                              # All preview logic + ZIP navigation
├─ previewer.html                         # Minimal page that hosts viewer.html in a new tab
└─ libs/                                  # Pure client-side libs (copied locally)
   ├─ docx-preview.min.js
   ├─ mammoth.browser.min.js
   ├─ xlsx.full.min.js
   ├─ jszip.min.js
   ├─ marked.min.js
   ├─ pptxjs.js           # (optional; recognized, not required by default flow)
   ├─ pptxjs.css          # (optional; see above)
   └─ webodf.js           # (optional ODF playground; not used in main path)
```

**Manifest (MV3)** exposes everything the viewer needs as web_accessible_resources and injects the composer scripts/CSS into Zoho Desk pages.
```json
{
  "manifest_version": 3,
  "name": "Teklink Zoho Desk Helper",
  "version": "1.9.0",
  "description": "Composer formatting + robust attachment viewer for Zoho Desk.",
  "permissions": [],
  "host_permissions": ["*://desk.theteklink.com/*", "*://*.zohodesk.com/*"],
  "content_scripts": [
    {
      "matches": ["*://desk.theteklink.com/*", "*://*.zohodesk.com/*"],
      "js": ["content.js", "content/replyEnhancements.js"],
      "css": ["content/replyEnhancements.css"],
      "run_at": "document_idle",
      "all_frames": true,
      "match_about_blank": true
    }
  ],
  "web_accessible_resources": [
    {
      "resources": [
        "viewer.html",
        "viewer.css",
        "viewer.js",
        "libs/docx-preview.min.js",
        "libs/mammoth.browser.min.js",
        "libs/xlsx.full.min.js",
        "libs/jszip.min.js",
        "libs/marked.min.js",
        "libs/pptxjs.js",
        "libs/pptxjs.css",
        "libs/webodf.js",
        "previewer.html"
      ],
      "matches": ["<all_urls>"]
    }
  ],
  "action": { "default_title": "Teklink Zoho Desk Helper" }
}
```

---
## How it works

### Embedded vs Standalone
- **Embedded**: the viewer runs inside an iframe injected into the Zoho Desk UI. All network fetches go through a proxy (the content script) via `postMessage` (`proxyFetch`) so cookies/auth work and CORS is avoided.
- **Standalone**: the viewer can open as a separate tab using `previewer.html`.
  The viewer understands URL params like:
  - `?embedded=0`
  - `?url=<fileUrl>&name=<optionalName>`
  - `?zip=<archiveUrl>&entry=<path/in/zip>` (deep‑open an entry)

### Smart dispatch
`viewer.js` inspects the extension and routes to a renderer:
- Images, SVG, Audio, Video
- **PDF** (with inline viewer; **Open** uses the original URL for Chrome’s native PDF viewer)
- **Word family** via `docx-preview` with Mammoth fallback
- **Excel/CSV/TSV/ODS** via `xlsx`
- **Markdown** via `marked`
- **JSON** (collapsible tree) and plain text
- **ZIP** listing, with per‑entry **Open**, **Download**, and **Prev/Next** inside the archive

---
## Supported file types

**Images:** png, jpg, jpeg, gif, webp, bmp, svg  
**Video:** mp4, webm, ogg, ogv, mov, m4v  
**Audio:** mp3, wav, m4a, aac, flac  
**Text/Code:** txt, md/markdown, cfg, ini, conf, log, css, yaml/yml  
**Data:** json, csv, tsv  
**PDF:** pdf  

**Word family:**
- Best‑effort preview: docx, docm, dotx, dotm (docx‑preview → Mammoth fallback)
- Light fallback: rtf (plain‑text extraction)
- Not supported in‑browser: doc, dot (legacy binary) → we show a friendly “no preview” message
- OpenDocument (text): odt → parsed from content.xml for a basic HTML rendering

**Excel family:** xlsx, xlsm, xlsb, xls, csv, tsv, xltx, xltm, xlt, xlam, xla, ods

**Presentations:** Recognized (pptx, pptm, ppt, xps, potx, potm, pot, thmx, ppsx, ppsm, pps, ppam, ppa, odp), but not rendered client‑side. (We display “no preview” unless you wire a server‑side converter to PDF.)

**Archives:** zip, 7z, rar, gz, tar (ZIP is fully explored; others are recognized but not parsed client‑side)

> If you later decide to support PowerPoint: add a server endpoint (e.g., LibreOffice/soffice or Aspose) to convert PPT* → PDF, then load the returned PDF into the existing PDF path.

---
## ZIP sub‑viewer (deep navigation)

When you open a `.zip`, we:
- List entries with **Name**, **Size**, **Open**, **Download**.
- Clicking **Open** enters ZIP sub‑navigation (the top counter & title reflect position within the archive).
- Title shows `archiveName/path/inside.zip`.
- **Prev/Next** iterate through entries **inside the ZIP**, not the ticket’s attachment list.
- A “← Back to archive” overlay returns to the entry list.
- “Open in new tab” for an entry uses:
  `previewer.html?zip=<archiveURL>&entry=<path/in/zip>&name=<entryName>`

---
## Buttons & behaviors

- **Open**
  - **ZIP entry:** opens a new tab targeted at that entry (`?zip=...&entry=...`).
  - **PDF file:** opens the **original file URL** (Chrome’s native PDF viewer, avoids CORS).
  - **All other files:** opens `previewer.html?url=<original>`.
- **Download**
  - **ZIP entry:** downloads just the entry.
  - **Other files:** downloads the current file (embedded: requests a direct download via the content script).
- **Prev/Next**
  - **ZIP mode:** steps through entries within the archive.
  - **Thread mode:** steps through the ticket’s attachments (when embedded and multiple attachments are present).
- **Refresh**
  - **ZIP mode:** re‑opens the active entry.
  - **File mode:** re‑renders the current file.
  - If your backend rejects unknown params, avoid cache‑busting: call `render(current.src, current.name)` directly.

---
## Install / Load the extension

1. Put the files in a folder as shown above.
2. Copy the JS libraries into `/libs/`:
   - docx-preview.min.js
   - mammoth.browser.min.js
   - xlsx.full.min.js
   - jszip.min.js
   - marked.min.js
   - (optional) pptxjs.js, pptxjs.css, webodf.js
3. Open `chrome://extensions` → **Developer mode** → **Load unpacked** → select the folder.
4. Navigate to Zoho Desk; the composer and the viewer should activate automatically.

---
## Libraries (no backend required)

- DOCX: https://github.com/VolodymyrBaydalka/docxjs
- DOCX fallback: https://github.com/mwilliamson/mammoth.js
- Spreadsheets: https://github.com/SheetJS/sheetjs
- Archives: https://stuk.github.io/jszip/
- Markdown: https://marked.js.org/

Local copies live in `/libs/` so the extension runs offline and passes MV3 restrictions.

---
## Configuration & URLs

- **Embedded mode**: the host page posts `zd-viewer-load` with `{ src, name, index, total, embedded }`.
- **Standalone mode**:
  - `viewer.html?url=<fileUrl>&name=<fileName>`
  - `viewer.html?zip=<archiveUrl>&entry=<path/in/zip>&name=<entryName>`
- **Custom viewer base**: optional `viewer_base=<absolute URL>` to override the default `previewer.html` for “Open in new tab”.
- **NetFree quirk**: PDFs try `?inline=true` first, and may retry with a raw `~nfopt(...)` suffix when the proxy returns HTTP 418. The order is important; `inline=true` must come first.

---
## Composer enhancements

From `content/replyEnhancements.js` + `content/replyEnhancements.css`:
- Quoted text **Hide/Show** toggle in the composer footer (sticky fallback).
- Header normalization: collapses email “— on [date] wrote —” into “On … wrote:”.
- Quoted‑text scoping: finds signature end or header and hides everything beneath by default (toggle restores). Does **not** apply to comments.
- Dark mode tweak: quoted blocks forced to white background get a dark text color to avoid white‑on‑white.
- Layout: reply editor wrapper height set to **80%**.
  ```css
  .zd_v2-replyeditor-detailwrapper,
  .zd_v2-replyeditor-wrapper { height: 80% !important; }
  ```

---
## Security notes

- Dangerous inline types are blocked by extension: html, htm, xhtml, mhtml, js, mjs.
- Embedded network loads use `proxyFetch` via `postMessage` to the content script (cookies/auth preserved).
- PDF “Open in new tab” opens the **original URL** → Chrome’s native PDF viewer (best CORS behavior).

---
## Troubleshooting

- **PDF won’t render embedded (CORS)**: use **Open** (new tab)—we open the original URL for PDFs.
- **Backend rejects `__ts` on refresh**: change the refresh handler to `render(current.src, current.name)` (no cache‑busting param).
- **Legacy Word `.doc/.dot`**: not renderable in‑browser; user should download or open externally.
- **Presentations**: recognized but not rendered. For preview, add a server‑side converter (LibreOffice/Aspose) to PDF and reuse the PDF path.
