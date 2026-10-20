/**
 * eBay Price Wizard - Content Script
 * Automatically fills variation prices on eBay UK listing pages.
 * Works inside iframes (all_frames: true).
 * No external dependencies. No DevTools needed.
 */

(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────────────

  const WIZARD_ID = 'ebay-price-wizard';

  /** Default HDD price map (normalized key: lowercase, e.g. "500gb", "1tb") */
  const DEFAULT_HDD_PRICES = {
    '500gb':   19.99,
    '1tb':     49.99,
    '2tb':     69.99,
    '4tb':    129.99,
    '6tb':    229.99,
    '8tb':    268.99,
    '10tb':   380.99,
    '12tb':   450.99,
    '14tb':   510.99,
    '16tb':   538.99,
    '18tb':   648.99,
    '20tb':   760.99,
    '0tb':      0.00,
  };

  // ─── Utility helpers ─────────────────────────────────────────────────────────

  /** Remove existing wizard if present */
  function destroyWizard() {
    const el = document.getElementById(WIZARD_ID);
    if (el) el.remove();
  }

  /** Safely parse a float; return null if invalid */
  function safeFloat(val) {
    const text = String(val).replace(/[£,\s]/g, '');
    if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Normalize an HDD capacity string to a lookup key.
   * "6T" → "6tb", "1TB" → "1tb", "500GB" → "500gb",
   * "No HDD" / "No Hard Drive" / "0TB" → "0tb"
   */
  function normalizeHdd(raw) {
    if (!raw) return null;
    const s = raw.trim().toLowerCase();
    if (/^(no[\s_-]*(hdd|hard\s*drive)?|0\s*[tg]b?|none)$/i.test(s)) return '0tb';
    // Handle bare "6T" style (no B)
    const bareT = s.match(/^(\d+(?:\.\d+)?)\s*t$/);
    if (bareT) return bareT[1] + 'tb';
    // Standard: 500gb, 1tb, etc.
    const match = s.match(/^(\d+(?:\.\d+)?)\s*(gb|tb)$/);
    if (match) return match[1] + match[2];
    return null;
  }

  /**
   * Parse camera quantity from a cell string.
   * "No Camera", "NO Camera (Only NVR)" → 0
   * "x1", "1x camera", "2x", "1", "64" → integer
   */
  function parseCameraQty(raw) {
    if (!raw) return null;
    const s = raw.trim().toLowerCase();
    if (/no[\s_-]*camera|only\s*nvr|only\s*dvr/.test(s)) return 0;
    const m = s.match(/(\d+)/);
    if (m) return parseInt(m[1], 10);
    return null;
  }

  /**
   * Parse recorder channel count from a cell string.
   * "4 channel", "8 CHANNEL HIKVISION", "16 Channel", "32ch" → 4/8/16/32
   */
  function parseChannel(raw) {
    if (!raw) return null;
    const s = raw.trim().toLowerCase();
    const m = s.match(/(\d+)\s*(?:ch(?:annel)?)/);
    if (m) return parseInt(m[1], 10);
    // fallback: first number in string
    const m2 = s.match(/(\d+)/);
    if (m2) return parseInt(m2[1], 10);
    return null;
  }

  /**
   * Fuzzy-match a table header text to a column role.
   * Returns: 'nvr' | 'hdd' | 'camera' | 'price' | null
   */
  function matchColumnRole(headerText) {
    const t = (headerText || '').toLowerCase();
    if (/price/.test(t)) return 'price';
    if (/nvr|dvr/.test(t)) return 'nvr';
    if (/hdd|hard.?drive/.test(t)) return 'hdd';
    if (/camera/.test(t)) return 'camera';
    return null;
  }

  /**
   * React-safe way to set an input value and fire the events eBay listens to.
   */
  function setInputValue(input, value) {
    if (!input) return;
    // contenteditable elements have no .value
    if (input.isContentEditable) {
      input.textContent = value;
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur',   { bubbles: true }));
      return;
    }
    // Walk the element's own prototype chain to find the native value setter.
    // Works for <input>, <textarea>, <select> — fixes "Illegal invocation"
    // when the SKU field is a textarea/combobox instead of a plain input.
    let proto = Object.getPrototypeOf(input);
    let desc = null;
    while (proto && !desc) {
      desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (!desc) proto = Object.getPrototypeOf(proto);
    }
    try {
      if (desc && desc.set) desc.set.call(input, value);
      else input.value = value;
    } catch (e) {
      try { input.value = value; } catch (e2) {}
    }
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur',   { bubbles: true }));
  }

  /**
   * Determine whether an input price is considered "empty"
   * (blank, "0", "0.00", or just whitespace).
   */
  function isPriceEmpty(input) {
    const v = (input.value || '').trim();
    return v === '' || safeFloat(v) === 0;
  }

  // ─── Grid discovery ───────────────────────────────────────────────────────────

  /**
   * Find the variations table in the current document.
   * Tries the current frame first, then looks inside any iframes.
   * Returns { table, doc } or null.
   */
  function findVariationsTable(doc) {
    // Look for a table with a "price" column header
    const tables = doc.querySelectorAll('table');
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('thead th, thead td'));
      const roles = headers.map(h => matchColumnRole(h.textContent));
      if (roles.includes('price') && (roles.includes('nvr') || roles.includes('hdd') || roles.includes('camera'))) {
        return { table, doc };
      }
    }
    return null;
  }

  /**
   * Get column index map { nvr, hdd, camera, price } by reading thead.
   */
  function getColumnMap(table) {
    const headers = Array.from(table.querySelectorAll('thead th, thead td'));
    const map = {};
    headers.forEach((th, i) => {
      const role = matchColumnRole(th.textContent);
      if (role && !(role in map)) map[role] = i;
    });
    return map;
  }

  /**
   * Extract unique HDD values from all currently-visible rows.
   */
  function extractHddValues(table, colMap) {
    if (!('hdd' in colMap)) return [];
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const seen = new Set();
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      const cell = cells[colMap.hdd];
      if (cell) {
        const raw = cell.textContent.trim();
        if (raw) seen.add(raw);
      }
    });
    return Array.from(seen);
  }

  /**
   * Find the scrollable container for a table.
   */
  function findScrollParent(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      if (/auto|scroll/.test(style.overflow + style.overflowY)) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  /**
   * Re-locate the variations table fresh. eBay's React re-renders can replace
   * the table node, leaving old references detached (writes go nowhere).
   * The old Tampermonkey script re-found the grid every time — same idea here.
   */
  function liveTable(fallback) {
    const found = findVariationsTable(document);
    return (found && found.table) || fallback;
  }

  // ─── Main fill engine ─────────────────────────────────────────────────────────

  /**
   * Process visible rows.
   * Returns { processed, skipped } counts and adds entries to skipLog.
   */
  const priceRowIds = new WeakMap();
  let nextPriceRowId = 0;

  function processVisibleRows(table, colMap, config, processedIds, skipLog, previewMode) {
    const { channelPrices, hddPrices, cameraPrice, enabledHdds, onlyEmpty } = config;
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    let processed = 0, skipped = 0;

    rows.forEach((row, idx) => {
      // Stable per-row identity, including one-row Preview wrappers in the same millisecond.
      if (!priceRowIds.has(row)) priceRowIds.set(row, ++nextPriceRowId);
      const rowId = priceRowIds.get(row);
      if (processedIds.has(rowId)) return;

      const cells = row.querySelectorAll('td');

      // ── Price input ────────────────────────────────────────────
      const priceIdx = colMap.price;
      if (priceIdx === undefined) { skipped++; return; }
      const priceCell = cells[priceIdx];
      if (!priceCell) { skipped++; return; }
      const priceInput = priceCell.querySelector('input[type="text"], input:not([type])');
      if (!priceInput) { skipped++; return; }

      // Only-empty check
      if (onlyEmpty && !isPriceEmpty(priceInput)) {
        processedIds.add(rowId);
        return;
      }

      // ── Channel ────────────────────────────────────────────────
      let channel = null;
      if ('nvr' in colMap) {
        const cell = cells[colMap.nvr];
        if (cell) channel = parseChannel(cell.textContent);
      }
      const basePrice = channel !== null ? channelPrices[channel] : undefined;
      if (!Number.isFinite(basePrice) || basePrice < 0) {
        skipLog.push(`Row skipped: channel "${channel}" has no price set.`);
        skipped++;
        return;
      }

      // ── HDD ────────────────────────────────────────────────────
      let hddCost = 0;
      if ('hdd' in colMap) {
        const cell = cells[colMap.hdd];
        const raw = cell ? cell.textContent.trim() : '';
        const key = normalizeHdd(raw);

        // Check if this HDD is enabled
        if (key === null) {
          skipLog.push(`Row skipped: unrecognized HDD value "${raw}".`);
          skipped++;
          return;
        }
        if (!enabledHdds.has(key)) {
          skipLog.push(`Row skipped: HDD "${raw}" not selected as available.`);
          skipped++;
          return;
        }
        hddCost = hddPrices[key] !== undefined ? hddPrices[key] : DEFAULT_HDD_PRICES[key];
        if (!Number.isFinite(hddCost) || hddCost < 0) {
          skipLog.push(`Row skipped: HDD "${raw}" has no valid price.`);
          skipped++;
          return;
        }
      }

      // ── Camera ────────────────────────────────────────────────
      let cameraCost = 0;
      if ('camera' in colMap) {
        const cell = cells[colMap.camera];
        const raw = cell ? cell.textContent.trim() : '';
        const qty = parseCameraQty(raw);
        if (qty === null) {
          skipLog.push(`Row skipped: unrecognized camera qty "${raw}".`);
          skipped++;
          return;
        }
        cameraCost = qty * cameraPrice;
      }

      // ── Compute final price ────────────────────────────────────
      // Formula: finalPrice = (baseTotal * 100) / (100 - (userInput * 1.2))
      // e.g. user enters 10 → divisor = 100 - 12 = 88 → price / 0.88
      const baseTotal = basePrice + hddCost + cameraCost;
      const promoMultiplier = config.promoMultiplier || 1;
      // promoMultiplier already encodes: 100 / (100 - input*1.2)
      const calculated = baseTotal * promoMultiplier;
      if (!Number.isFinite(calculated) || calculated < 0) {
        skipLog.push('Row skipped: calculated price is invalid.');
        skipped++;
        return;
      }
      const finalPrice = calculated.toFixed(2);

      if (previewMode) {
        skipLog.push(`Preview: ${channel}ch → £${finalPrice}`);
      } else {
        priceInput.focus();
        setInputValue(priceInput, finalPrice);
        // Visual confirmation
        priceInput.style.backgroundColor = '#d4edda';
        setTimeout(() => { priceInput.style.backgroundColor = ''; }, 1500);
      }

      processedIds.add(rowId);
      processed++;
    });

    return { processed, skipped };
  }

  // ─── Scroll-and-fill loop ─────────────────────────────────────────────────────

  async function scrollAndFill(table, colMap, config, updateProgress, previewMode, stopRef) {
    const scrollParent = findScrollParent(table);
    // Start from the top so every virtualized row gets a chance to render
    scrollParent.scrollTop = 0;
    await new Promise(res => setTimeout(res, 300));
    const processedIds = new Set();
    const skipLog = [];
    let totalProcessed = 0, totalSkipped = 0;
    let staleRounds = 0;
    const MAX_STALE = 4;

    while (!stopRef.stopped) {
      const before = processedIds.size;
      const { processed, skipped } = processVisibleRows(
        liveTable(table), colMap, config, processedIds, skipLog, previewMode
      );
      totalProcessed += processed;
      totalSkipped   += skipped;
      updateProgress(totalProcessed, totalSkipped, skipLog.slice(-5));

      const after = processedIds.size;
      if (after === before) {
        staleRounds++;
        if (staleRounds >= MAX_STALE) break; // no new rows for several passes → done
      } else {
        staleRounds = 0;
      }

      // Scroll down
      const prevScrollTop = scrollParent.scrollTop;
      scrollParent.scrollTop += 900;
      if (scrollParent.scrollTop === prevScrollTop) break; // can't scroll further

      // Wait for DOM to update
      await new Promise(res => setTimeout(res, 350));
    }

    return { totalProcessed, totalSkipped, skipLog };
  }

  // ─── UI ───────────────────────────────────────────────────────────────────────

  const STYLES = `
    #${WIZARD_ID} {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      color: #222;
      width: 340px;
      max-height: 90vh;
      box-shadow: 0 8px 32px rgba(0,0,0,0.22);
      border-radius: 12px;
      background: #fff;
      border: 1px solid #e0e0e0;
      overflow: visible;
      display: flex;
      flex-direction: column;
    }
    #${WIZARD_ID} .pw-header {
      background: linear-gradient(135deg,#0064d2,#0095d0);
      color:#fff;
      padding: 12px 16px;
      font-weight:700;
      font-size:15px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      cursor:move;
      user-select:none;
      border-radius: 12px 12px 0 0;
      flex-shrink: 0;
    }
    #${WIZARD_ID} .pw-header span { font-size:11px; font-weight:400; opacity:.8; }
    #${WIZARD_ID} .pw-body { padding:10px 14px; overflow-y: auto; flex: 1; }
    #${WIZARD_ID} .pw-row { margin-bottom:10px; }
    #${WIZARD_ID} label { display:block; font-size:12px; font-weight:600; margin-bottom:3px; color:#444; }
    #${WIZARD_ID} input[type=text], #${WIZARD_ID} input[type=number] {
      width:100%; box-sizing:border-box; padding:7px 9px;
      border:1px solid #ccc; border-radius:6px; font-size:13px;
      transition: border-color .2s;
    }
    #${WIZARD_ID} input:focus { outline:none; border-color:#0064d2; }
    #${WIZARD_ID} .pw-toggle-row {
      display:flex; align-items:center; gap:8px;
      margin-bottom:10px; font-size:12px; color:#555;
    }
    #${WIZARD_ID} input[type=checkbox] { width:16px; height:16px; cursor:pointer; }
    #${WIZARD_ID} .pw-btns { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
    #${WIZARD_ID} button {
      flex:1; padding:9px 6px; border:none; border-radius:7px;
      font-size:13px; font-weight:600; cursor:pointer; transition:opacity .15s;
    }
    #${WIZARD_ID} button:hover { opacity:.85; }
    #${WIZARD_ID} .btn-wizard { background:#0064d2; color:#fff; }
    #${WIZARD_ID} .btn-preview { background:#f5a623; color:#fff; }
    #${WIZARD_ID} .btn-run { background:#27ae60; color:#fff; }
    #${WIZARD_ID} .btn-stop { background:#e74c3c; color:#fff; }
    #${WIZARD_ID} .btn-close { background:#eee; color:#555; }
    #${WIZARD_ID} .pw-progress {
      background:#f7f9fc; border-top:1px solid #eee;
      padding:10px 14px; font-size:12px; min-height:40px;
      flex-shrink: 0;
      border-radius: 0 0 12px 12px;
    }
    #${WIZARD_ID} .pw-progress strong { color:#0064d2; }
    #${WIZARD_ID} .pw-log { margin-top:6px; max-height:80px; overflow-y:auto; font-size:11px; color:#888; }
    #${WIZARD_ID} .pw-error { color:#c0392b; font-weight:600; }
    #${WIZARD_ID} .pw-success { color:#27ae60; font-weight:600; }
    #${WIZARD_ID} .pw-section-title {
      font-size:12px; font-weight:700; color:#0064d2;
      margin:10px 0 6px; text-transform:uppercase; letter-spacing:.5px;
    }
    #${WIZARD_ID} .pw-hdd-checks label {
      font-weight:400; display:flex; align-items:center; gap:6px; margin-bottom:6px;
    }
    #${WIZARD_ID} .pw-hdd-checks .hdd-name {
      flex: 1; font-size:12px; color:#333;
    }
    #${WIZARD_ID} .pw-hdd-checks .hdd-price-input {
      width: 72px !important; padding: 4px 6px !important;
      font-size: 12px !important; text-align: right;
      border: 1px solid #ccc; border-radius: 5px;
      background: #fffbe6;
      flex-shrink: 0;
    }
    #${WIZARD_ID} .pw-hdd-checks .hdd-price-input:focus {
      border-color: #0064d2; background: #fff; outline: none;
    }
    #${WIZARD_ID} .pw-hdd-checks .hdd-unrecognized {
      font-size:11px; color:#c0392b;
    }
    #${WIZARD_ID} .pw-hdd-scroll {
      height: 200px;
      min-height: 200px;
      max-height: 200px;
      overflow-y: scroll !important;
      overflow-x: hidden;
      border: 1px solid #d0d0d0;
      border-radius: 7px;
      padding: 5px 8px;
      margin: 6px 0 6px;
      background: #fafafa;
      display: block;
    }
    #${WIZARD_ID} .pw-hdd-scroll > div {
      margin-bottom: 4px !important;
    }
    #${WIZARD_ID} .btn-sku { background:#6f42c1; color:#fff; }
    #${WIZARD_ID} fieldset {
      border:1px solid #ddd; border-radius:6px; margin:0 0 8px; padding:6px 8px;
    }
    #${WIZARD_ID} legend {
      font-weight:700; font-size:12px; padding:0 4px; color:#0064d2;
    }
    #${WIZARD_ID} .sku-opt {
      display:flex; align-items:center; gap:6px; margin:3px 0;
    }
    #${WIZARD_ID} .sku-opt span {
      flex:0 0 96px; font-size:11px; color:#555;
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    }
    #${WIZARD_ID} .sku-opt input[type=text] {
      flex:1; min-width:0; padding:3px 5px; font-size:12px;
    }
    #${WIZARD_ID} .sku-ord { flex:0 0 34px !important; text-align:center; }
    #${WIZARD_ID} .sku-fill-btn {
      flex:0 0 44px !important; padding:4px !important; font-size:11px !important;
      background:#777 !important; color:#fff !important;
    }
    #${WIZARD_ID} .sku-pre {
      background:#f6f6f6; border:1px solid #e2e2e2; border-radius:5px; padding:6px;
      max-height:150px; overflow:auto; white-space:pre-wrap; word-break:break-all;
      font-size:11px; font-family:monospace; margin-top:8px;
    }
    #${WIZARD_ID} .pw-step { display:none; }
    #${WIZARD_ID} .pw-step.active { display:block; }
    #${WIZARD_ID} .pw-note {
      font-size:11px; color:#888; margin-top:3px; line-height:1.4;
    }
  `;

  function injectStyles() {
    if (document.getElementById(WIZARD_ID + '-styles')) return;
    const style = document.createElement('style');
    style.id = WIZARD_ID + '-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  /**
   * Create the floating panel and return handles to its sub-elements.
   */
  function createPanel() {
    destroyWizard();
    injectStyles();

    const panel = document.createElement('div');
    panel.id = WIZARD_ID;

    panel.innerHTML = `
      <div class="pw-header" id="pw-drag-handle">
        🧙 eBay Price Wizard
        <span>v1.5.2 · CCTV Kit Pricing</span>
      </div>
      <div class="pw-body">

        <!-- Step 0: Main controls -->
        <div class="pw-step active" id="pw-step-main">
          <div class="pw-note" style="margin-bottom:10px;">
            Click <strong>Wizard</strong> to set up prices, then use
            <strong>Preview</strong> (test first 10 rows) or <strong>Run</strong> (fill all).
          </div>
          <div class="pw-toggle-row">
            <input type="checkbox" id="pw-only-empty" checked>
            <label for="pw-only-empty" style="display:inline;font-weight:400;">
              Only fill empty / zero prices
            </label>
          </div>
          <div class="pw-btns">
            <button class="btn-wizard" id="pw-btn-wizard">🧙 Wizard</button>
            <button class="btn-preview" id="pw-btn-preview" disabled>👁 Preview</button>
            <button class="btn-run" id="pw-btn-run" disabled>▶ Run</button>
            <button class="btn-stop" id="pw-btn-stop" style="display:none;">■ Stop</button>
          </div>
          <div class="pw-btns" style="margin-top:6px;">
            <button class="btn-sku" id="pw-btn-sku">🏷 SKU Wizard</button>
            <button class="btn-close" id="pw-btn-close">✕ Close</button>
          </div>
        </div>

        <!-- Step 1: Recorder prices -->
        <div class="pw-step" id="pw-step-1">
          <div class="pw-section-title">Step 1 of 4 — Recorder Base Prices</div>
          <div class="pw-note">Leave blank if that channel count is NOT in this listing.</div>
          <div class="pw-row">
            <label>4-channel recorder price (£)</label>
            <input type="number" id="pw-ch4" placeholder="e.g. 89.99" min="0" step="0.01">
          </div>
          <div class="pw-row">
            <label>8-channel recorder price (£)</label>
            <input type="number" id="pw-ch8" placeholder="e.g. 119.99" min="0" step="0.01">
          </div>
          <div class="pw-row">
            <label>16-channel recorder price (£)</label>
            <input type="number" id="pw-ch16" placeholder="e.g. 159.99" min="0" step="0.01">
          </div>
          <div class="pw-row">
            <label>32-channel recorder price (£)</label>
            <input type="number" id="pw-ch32" placeholder="e.g. 219.99" min="0" step="0.01">
          </div>
          <div class="pw-btns">
            <button class="btn-close" id="pw-s1-back">← Back</button>
            <button class="btn-run" id="pw-s1-next">Next →</button>
          </div>
        </div>

        <!-- Step 2: Camera price -->
        <div class="pw-step" id="pw-step-2">
          <div class="pw-section-title">Step 2 of 4 — Camera Price</div>
          <div class="pw-row">
            <label>Price of ONE camera (£) <span style="color:#c0392b">*</span></label>
            <input type="number" id="pw-cam-price" placeholder="e.g. 25.00" min="0" step="0.01">
            <div class="pw-note">This will be multiplied by the camera quantity in each row.</div>
          </div>
          <div class="pw-btns">
            <button class="btn-close" id="pw-s2-back">← Back</button>
            <button class="btn-run" id="pw-s2-next">Next →</button>
          </div>
        </div>

        <!-- Step 3: HDD selection -->
        <div class="pw-step" id="pw-step-3">
          <div class="pw-section-title">Step 3 of 4 — Available Hard Drives</div>
          <div class="pw-note">
            Tick the HDD sizes included in this listing bundle.
            Rows with unticked sizes will be skipped.
          </div>
          <div class="pw-hdd-scroll">
            <div class="pw-hdd-checks" id="pw-hdd-checks">
              <!-- populated dynamically -->
            </div>
          </div>
          <div class="pw-btns" style="margin-top:10px;">
            <button class="btn-close" id="pw-s3-back">← Back</button>
            <button class="btn-run" id="pw-s3-next">Next →</button>
          </div>
        </div>

        <!-- Step 4: Promotional price markup -->
        <div class="pw-step" id="pw-step-4">
          <div class="pw-section-title">Step 4 of 4 — Promotional Price (Optional)</div>
          <div class="pw-note" style="margin-bottom:10px;">
            This optional adjustment uses <strong>base price ÷ (1 − input × 1.2 / 100)</strong>.<br><br>
            Enter a value from <strong>0 to 83.33</strong>.<br>
            <em>Example: input <strong>10</strong> divides the base by <strong>0.88</strong>,
            increasing it by approximately <strong>13.64%</strong>.</em><br><br>
            Leave blank to use the base price with no markup.
          </div>
          <div class="pw-row">
            <label>Your promotional input (0–83.33, or leave blank)</label>
            <input type="number" id="pw-promo-pct" placeholder="e.g. 10 → base ÷ 0.88"
                   min="0" max="83.33" step="0.01">
            <div class="pw-note" id="pw-promo-preview" style="margin-top:6px;color:#0064d2;font-weight:600;"></div>
          </div>
          <div class="pw-btns" style="margin-top:10px;">
            <button class="btn-close" id="pw-s4-back">← Back</button>
            <button class="btn-run" id="pw-s4-done">✔ Done — Ready!</button>
          </div>
        </div>

        <!-- SKU Wizard (merged from eBay SKU Wizard userscript) -->
        <div class="pw-step" id="pw-step-sku">
          <div class="pw-section-title">🏷 SKU Wizard</div>
          <div class="pw-note" style="margin-bottom:8px;">
            Builds SKUs like <strong>DVR-8CH+4xCAM+2TB</strong> from the spec columns.
            Pattern: {v} = token, {n} = number found in the option text.
            Empty token = that option is skipped.
          </div>
          <div id="pw-sku-cols"></div>

          <!-- Smart camera rules (reads channel + camera columns from the table) -->
          <fieldset>
            <legend>Camera Rules (smart)</legend>
            <div class="sku-opt">
              <input type="checkbox" id="pw-sku-rule-bychan" checked
                     style="width:15px;height:15px;flex-shrink:0;cursor:pointer;">
              <small style="color:#555;font-size:11px;">
                Limit by channel: 4ch → 0-4 cams, 8ch → 0-8, 16ch → 0-16, 32ch → 0-32.
                Rows above the limit are skipped.
              </small>
            </div>
            <div class="sku-opt">
              <span>allowed qty</span>
              <input type="text" id="pw-sku-rule-allowed" placeholder="optional, e.g. 0-2-4-6-8">
            </div>
            <div class="sku-opt">
              <input type="checkbox" id="pw-sku-rule-nozero"
                     style="width:15px;height:15px;flex-shrink:0;cursor:pointer;">
              <small style="color:#555;font-size:11px;">
                Skip "No Camera" rows (no SKU for 0 cameras)
              </small>
            </div>
          </fieldset>

          <div class="sku-opt" style="margin-top:6px;">
            <span>separator</span>
            <input type="text" id="pw-sku-sep" style="flex:0 0 44px;text-align:center;">
            <input type="checkbox" id="pw-sku-onlyempty" checked
                   style="width:15px;height:15px;flex-shrink:0;cursor:pointer;">
            <small style="color:#666;font-size:11px;">only fill empty SKUs</small>
          </div>
          <div class="pw-btns">
            <button class="btn-preview" id="pw-sku-preview">👁 Preview</button>
            <button class="btn-run" id="pw-sku-run">▶ Run</button>
            <button class="btn-stop" id="pw-sku-stop" style="display:none;">■</button>
          </div>
          <div class="pw-btns" style="margin-top:6px;">
            <button class="btn-close" id="pw-sku-undo">↺ Undo</button>
            <button class="btn-wizard" id="pw-sku-save">💾 Save</button>
            <button class="btn-close" id="pw-sku-back">← Back</button>
          </div>
          <pre class="sku-pre" id="pw-sku-out">Set your tokens, then Preview.</pre>
        </div>

      </div>
      <div class="pw-progress" id="pw-progress">
        <span id="pw-status">Waiting — click Wizard to start.</span>
        <div class="pw-log" id="pw-log"></div>
      </div>
    `;

    panel.querySelectorAll('button').forEach(button => { button.type = 'button'; });
    document.body.appendChild(panel);
    makeDraggable(panel, panel.querySelector('#pw-drag-handle'));
    return panel;
  }

  function makeDraggable(el, handle) {
    let ox = 0, oy = 0, startX = 0, startY = 0;
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      startX = e.clientX; startY = e.clientY;
      ox = el.offsetLeft; oy = el.offsetTop;
      const onMove = ev => {
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.left = (ox + ev.clientX - startX) + 'px';
        el.style.top  = (oy + ev.clientY - startY) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function showStep(id) {
    document.querySelectorAll(`#${WIZARD_ID} .pw-step`).forEach(s => s.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
  }

  function setStatus(msg, type) {
    const el = document.getElementById('pw-status');
    if (!el) return;
    el.textContent = msg;
    el.className = type === 'error' ? 'pw-error' : type === 'success' ? 'pw-success' : '';
  }

  function appendLog(lines) {
    const el = document.getElementById('pw-log');
    if (!el) return;
    lines.forEach(line => {
      const d = document.createElement('div');
      d.textContent = line;
      el.appendChild(d);
    });
    el.scrollTop = el.scrollHeight;
  }

  function clearLog() {
    const el = document.getElementById('pw-log');
    if (el) el.innerHTML = '';
  }

  // ─── SKU Wizard helpers (merged from eBay SKU Wizard userscript v1.0.0) ──────

  const SKU_CFG_KEY = 'skuWizardCfg_v2'; // same key as the userscript → old saved settings carry over
  const SKU_SKIP = /^(|actions?|photos?|photo|images?|sku|custom label.*|ean|upc|isbn|epid|mpn|brand|quantity|available quantity|price|start price|buy it now.*|delete|select|edit)$/i;

  const skuText = el => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
  const skuNum = s => { const m = String(s).match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  const skuReadVal = el => (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el.value : skuText(el);

  function loadSkuCfg() {
    try { return JSON.parse(localStorage.getItem(SKU_CFG_KEY)) || {}; } catch (e) { return {}; }
  }
  const skuCfg = loadSkuCfg();
  if (!skuCfg.cols) skuCfg.cols = {};
  if (!skuCfg.sep) skuCfg.sep = '+';
  function saveSkuCfg() {
    try { localStorage.setItem(SKU_CFG_KEY, JSON.stringify(skuCfg)); } catch (e) {}
  }

  /** Cell at header index, tolerating an extra leading cell (e.g. checkbox column). */
  function skuCellAt(row, i, headersLen) {
    const c = Array.from(row.children);
    const off = c.length - headersLen;
    return c[i + (off > 0 ? off : 0)] || c[i];
  }

  /** Find (or activate) the SKU input in a row. */
  function skuInputOf(row, skuIndex, headersLen) {
    const cell = skuCellAt(row, skuIndex, headersLen);
    if (!cell) return null;
    let inp = cell.querySelector('input,textarea,[contenteditable="true"]');
    if (!inp) { cell.click(); inp = cell.querySelector('input,textarea,[contenteditable="true"]'); }
    return inp;
  }

  /** Build the token for one column value, using pattern {v}/{n} and the map. */
  function skuTokenFor(col, optText) {
    let v = col.map[optText];
    if (v === undefined) v = /^no\b/i.test(optText) ? '' : optText.replace(/\s+/g, '-');
    v = String(v).trim();
    const n = skuNum(optText);
    if (!v) return '';
    if (col.pattern.includes('{n}') && n === 0) return '';
    return col.pattern.replace(/\{v\}/g, v).replace(/\{n\}/g, String(n)).trim();
  }

  /** Default SKU part order: recorder (NVR/DVR) → camera → HDD → everything else. */
  function skuDefaultOrder(name, index) {
    const role = matchColumnRole(name);
    if (role === 'nvr') return 1;
    if (role === 'camera') return 2;
    if (role === 'hdd') return 3;
    return 10 + index;
  }

  /**
   * Analyse the variations table for SKU building:
   * find the SKU/Custom label column, and collect spec columns + their options
   * from the currently visible rows (merged with saved config).
   */
  function skuAnalyse(table) {
    const headers = Array.from(table.querySelectorAll('thead th, thead td')).map(skuText);
    const skuIndex = headers.findIndex(h => /^(sku|custom label.*)$/i.test(h));
    if (skuIndex < 0) return null;
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const cols = [];
    headers.forEach((name, index) => {
      if (SKU_SKIP.test(name)) return;
      const set = new Set();
      rows.forEach(r => {
        const v = skuText(skuCellAt(r, index, headers.length));
        if (v) set.add(v);
      });
      if (!set.size || set.size > 60) return;
      const options = Array.from(set);
      const isQty = /qty|quantity|camera/i.test(name) &&
                    options.some(o => /^x?\s*\d+$/i.test(o) || /^no /i.test(o));
      const saved = skuCfg.cols[name] || {};
      cols.push({
        index, name, options,
        include: saved.include !== false,
        // Order: recorder → camera → HDD by default. Old saved orders (from the
        // index-based scheme) are ignored until the user saves once with v2.
        order:   (skuCfg.orderV2 === true && saved.order != null)
                   ? saved.order
                   : skuDefaultOrder(name, index),
        pattern: saved.pattern || (isQty ? '{n}x{v}' : '{v}'),
        map:     Object.assign({}, saved.map),
      });
    });
    return { headers, skuIndex, cols };
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────────

  /**
   * Check if this frame contains the variations grid, then initialize.
   */
  function tryInit() {
    // Look for the table in this document
    const result = findVariationsTable(document);
    if (!result) return; // not this frame

    const { table } = result;
    const colMap = getColumnMap(table);

    if (!('price' in colMap)) return; // no price column found

    // State
    let config = null;
    const stopRef = { stopped: false };

    const panel = createPanel();

    // ── Wizard navigation ────────────────────────────────────────

    document.getElementById('pw-btn-wizard').addEventListener('click', () => {
      showStep('pw-step-1');
      setStatus('Fill in your recorder prices…');
    });

    // Step 1 → 2
    document.getElementById('pw-s1-next').addEventListener('click', () => {
      showStep('pw-step-2');
    });
    document.getElementById('pw-s1-back').addEventListener('click', () => {
      showStep('pw-step-main');
    });

    // Step 2 → 3
    document.getElementById('pw-s2-next').addEventListener('click', () => {
      const camPriceInput = document.getElementById('pw-cam-price');
      const camPrice = safeFloat(camPriceInput.value);
      if (camPrice === null || camPrice < 0) {
        setStatus('Please enter a valid camera price.', 'error');
        return;
      }

      // Auto-detect HDD values from currently-visible rows (used only for pre-ticking)
      const hddRaws = extractHddValues(table, colMap);
      const detectedKeys = new Set(
        hddRaws.map(r => normalizeHdd(r)).filter(Boolean)
      );

      const checksContainer = document.getElementById('pw-hdd-checks');
      checksContainer.innerHTML = '';

      // Always show the FULL list of all known HDD sizes.
      // Detected sizes → pre-ticked. Undetected → unticked (user can tick manually).
      // Order: No HDD first, then 500GB, 1TB … 20TB
      const ALL_HDD_ORDER = [
        { key: '0tb',   label: 'No HDD / 0TB' },
        { key: '500gb', label: '500GB' },
        { key: '1tb',   label: '1TB' },
        { key: '2tb',   label: '2TB' },
        { key: '4tb',   label: '4TB' },
        { key: '6tb',   label: '6TB' },
        { key: '8tb',   label: '8TB' },
        { key: '10tb',  label: '10TB' },
        { key: '12tb',  label: '12TB' },
        { key: '14tb',  label: '14TB' },
        { key: '16tb',  label: '16TB' },
        { key: '18tb',  label: '18TB' },
        { key: '20tb',  label: '20TB' },
      ];

      // Also append any grid values that aren't in the known list (unrecognized)
      hddRaws.forEach(raw => {
        const k = normalizeHdd(raw);
        if (k && !ALL_HDD_ORDER.find(e => e.key === k)) {
          ALL_HDD_ORDER.push({ key: k, label: raw, unrecognized: true });
        }
      });

      ALL_HDD_ORDER.forEach(({ key, label, unrecognized }) => {
        const defaultPrice = DEFAULT_HDD_PRICES[key];
        const isDetected  = detectedKeys.has(key);
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:7px;margin-bottom:5px;';

        // Badge shown when this size wasn't found in the grid
        const badge = !isDetected
          ? `<span style="font-size:10px;color:#aaa;flex-shrink:0;">(not in grid)</span>`
          : '';

        if (unrecognized || defaultPrice === undefined) {
          row.innerHTML = `
            <input type="checkbox" data-key="${key}" ${isDetected ? 'checked' : ''}
                   style="width:15px;height:15px;flex-shrink:0;cursor:pointer;">
            <span class="hdd-name"></span>
            <span class="hdd-unrecognized">⚠ set price</span>
            <input type="number" class="hdd-price-input" data-hdd-key="${key}"
                   min="0" step="0.01" placeholder="Price" aria-label="Custom HDD price">
            ${badge}
          `;
        } else {
          row.innerHTML = `
            <input type="checkbox" data-key="${key}" ${isDetected ? 'checked' : ''}
                   style="width:15px;height:15px;flex-shrink:0;cursor:pointer;">
            <span class="hdd-name">${label}</span>
            ${badge}
            <span style="font-size:11px;color:#888;flex-shrink:0;margin-left:auto;">£</span>
            <input type="number"
                   class="hdd-price-input"
                   data-hdd-key="${key}"
                   value="${defaultPrice}"
                   min="0" step="0.01"
                   title="Edit price for ${label}"
                   style="width:68px;padding:3px 5px;font-size:12px;text-align:right;
                          border:1px solid #ccc;border-radius:5px;background:#fffbe6;flex-shrink:0;">
          `;
        }
        row.querySelector('.hdd-name').textContent = label;
        checksContainer.appendChild(row);
      });

      showStep('pw-step-3');
    });
    document.getElementById('pw-s2-back').addEventListener('click', () => {
      showStep('pw-step-1');
    });

    // Step 3: Next → step 4
    document.getElementById('pw-s3-next').addEventListener('click', () => {
      showStep('pw-step-4');
      // Update the live preview label whenever user types
      const promoInput = document.getElementById('pw-promo-pct');
      const promoPreview = document.getElementById('pw-promo-preview');
      const updatePreview = () => {
        const v = safeFloat(promoInput.value);
        if (v === null || promoInput.value.trim() === '') {
          promoPreview.textContent = 'No promo — base price will be used.';
        } else if (v < 0 || v > 83.33) {
          promoPreview.textContent = '⚠ Please enter a number between 0 and 83.33.';
        } else {
          const effectiveInput = v * 1.2;
          const divisor = 100 - effectiveInput;
          if (divisor <= 0) {
            promoPreview.textContent = '⚠ Value too high — divisor becomes zero.';
          } else {
            const multiplier = (100 / divisor).toFixed(5);
            promoPreview.textContent =
              `✔ Formula: (price × 100) ÷ (100 − ${effectiveInput.toFixed(2)}) = price × ${multiplier}`;
          }
        }
      };
      promoInput.oninput = updatePreview;
      updatePreview();
    });
    document.getElementById('pw-s3-back').addEventListener('click', () => {
      showStep('pw-step-2');
    });

    // Step 4: Done → build config
    document.getElementById('pw-s4-done').addEventListener('click', () => {
      // Gather channel prices
      const channelPrices = {};
      for (const ch of [4, 8, 16, 32]) {
        const raw = document.getElementById(`pw-ch${ch}`).value.trim();
        const val = safeFloat(raw);
        if (raw && (val === null || val < 0)) {
          setStatus('Recorder prices must be finite, non-negative numbers.', 'error');
          showStep('pw-step-1');
          return;
        }
        if (val !== null) channelPrices[ch] = val;
      }
      if (Object.keys(channelPrices).length === 0) {
        setStatus('Please enter at least one recorder price.', 'error');
        showStep('pw-step-1');
        return;
      }

      const cameraPrice = safeFloat(document.getElementById('pw-cam-price').value);

      if (cameraPrice === null || cameraPrice < 0) {
        setStatus('Please enter a valid camera price.', 'error');
        showStep('pw-step-2');
        return;
      }

      // Enabled HDDs + per-run editable prices
      const enabledHdds = new Set();
      const hddPrices = { ...DEFAULT_HDD_PRICES }; // start from defaults

      const checks = document.querySelectorAll('#pw-hdd-checks input[type=checkbox]');
      checks.forEach(cb => {
        if (cb.checked && cb.dataset.key) enabledHdds.add(cb.dataset.key);
      });

      // Override default prices with whatever the user typed in the price inputs
      const priceInputs = document.querySelectorAll('#pw-hdd-checks input.hdd-price-input');
      for (const inp of priceInputs) {
        const key = inp.dataset.hddKey;
        const val = safeFloat(inp.value);
        if (enabledHdds.has(key) && (val === null || val < 0)) {
          setStatus('Set a valid non-negative price for each selected HDD.', 'error');
          showStep('pw-step-3');
          return;
        }
        if (key && val !== null && val >= 0) hddPrices[key] = val;
      }

      // If no HDD column, add a dummy so rows aren't blocked
      if (checks.length === 0) enabledHdds.add('__none__');

      // Promo formula: finalPrice = (basePrice * 100) / (100 - (userInput * 1.2))
      // Expressed as a multiplier: 100 / (100 - userInput*1.2)
      // e.g. user enters 10 → 100 / (100-12) = 100/88 ≈ 1.13636
      const promoRaw = safeFloat(document.getElementById('pw-promo-pct').value);
      let promoMultiplier = 1;
      let promoLabel = 'No promo';
      if (promoRaw !== null && document.getElementById('pw-promo-pct').value.trim() !== '') {
        if (promoRaw < 0 || promoRaw > 83.33) {
          setStatus('Promo input must be between 0 and 83.33.', 'error');
          return;
        }
        const divisor = 100 - (promoRaw * 1.2);
        if (divisor <= 0) {
          setStatus('Promo % is too high — divisor would be zero or negative.', 'error');
          return;
        }
        promoMultiplier = 100 / divisor;
        promoLabel = `Promo: (price×100)÷(100−${(promoRaw*1.2).toFixed(2)}) [input: ${promoRaw}%]`;
      }

      config = {
        channelPrices,
        cameraPrice: cameraPrice || 0,
        hddPrices,       // contains defaults + any user edits from Step 3
        enabledHdds,
        promoMultiplier,
        onlyEmpty: document.getElementById('pw-only-empty').checked,
      };

      showStep('pw-step-main');

      const chSummary = Object.entries(channelPrices)
        .map(([ch, p]) => `${ch}ch=£${p}`)
        .join(', ');
      setStatus(`✔ Ready! ${chSummary} | Cam=£${cameraPrice} | ${promoLabel}`, 'success');

      document.getElementById('pw-btn-preview').disabled = false;
      document.getElementById('pw-btn-run').disabled     = false;
    });
    document.getElementById('pw-s4-back').addEventListener('click', () => {
      showStep('pw-step-3');
    });

    // ── Preview ──────────────────────────────────────────────────

    document.getElementById('pw-btn-preview').addEventListener('click', async () => {
      if (!config) return;
      clearLog();
      setStatus('Previewing first 10 rows…');
      config.onlyEmpty = document.getElementById('pw-only-empty').checked;

      // Only process first 10 rows for preview
      const previewIds = new Set();
      const skipLog = [];
      let count = 0;
      const currentTable = liveTable(table);
      const currentMap = getColumnMap(currentTable);
      const rows = Array.from(currentTable.querySelectorAll('tbody tr')).slice(0, 10);
      for (const row of rows) {
        const result = processVisibleRows({
          querySelectorAll: () => [row]
        }, currentMap, config, previewIds, skipLog, true);
        count += result.processed;
      }

      appendLog(skipLog.length ? skipLog : ['Preview complete — no skips so far.']);
      setStatus(`Preview done: ${count} rows would be updated.`, 'success');
    });

    // ── Run ──────────────────────────────────────────────────────

    document.getElementById('pw-btn-run').addEventListener('click', async () => {
      if (!config) return;
      stopRef.stopped = false;
      clearLog();
      setStatus('Running…');
      config.onlyEmpty = document.getElementById('pw-only-empty').checked;

      document.getElementById('pw-btn-run').disabled     = true;
      document.getElementById('pw-btn-preview').disabled = true;
      document.getElementById('pw-btn-stop').style.display = '';

      const updateProgress = (proc, skip, recentSkips) => {
        setStatus(`✔ Processed: ${proc}  |  ⚠ Skipped: ${skip}`);
        if (recentSkips.length) appendLog(recentSkips);
      };

      const tblLive = liveTable(table);
      const cmLive = getColumnMap(tblLive);
      const { totalProcessed, totalSkipped, skipLog } = await scrollAndFill(
        tblLive, ('price' in cmLive) ? cmLive : colMap, config, updateProgress, false, stopRef
      );

      document.getElementById('pw-btn-run').disabled     = false;
      document.getElementById('pw-btn-preview').disabled = false;
      document.getElementById('pw-btn-stop').style.display = 'none';

      if (stopRef.stopped) {
        setStatus(`Stopped. Processed: ${totalProcessed}  Skipped: ${totalSkipped}`, 'error');
      } else {
        setStatus(`✅ Done! Processed: ${totalProcessed}  Skipped: ${totalSkipped}`, 'success');
      }
      if (skipLog.length) {
        appendLog(['— Skip reasons —', ...skipLog]);
      }
    });

    // ── Stop ─────────────────────────────────────────────────────

    document.getElementById('pw-btn-stop').addEventListener('click', () => {
      stopRef.stopped = true;
    });

    // ── Close ────────────────────────────────────────────────────

    document.getElementById('pw-btn-close').addEventListener('click', () => {
      destroyWizard();
    });

    // ── SKU Wizard (merged from userscript) ──────────────────────

    let skuState = null;
    let skuUndo = null;
    const skuStopRef = { stopped: false };

    function skuOut(msg) {
      const el = document.getElementById('pw-sku-out');
      if (el) el.textContent = msg;
    }

    /** Build one SKU string for a row from the current column config. */
    function buildSkuFor(row) {
      const hLen = skuState.headers.length;
      const parts = [];
      skuState.cols
        .filter(c => c.include)
        .sort((a, b) => a.order - b.order)
        .forEach(c => {
          const tk = skuTokenFor(c, skuText(skuCellAt(row, c.index, hLen)));
          if (tk) parts.push(tk);
        });
      return parts.join(skuCfg.sep);
    }

    /** Read the current camera-rule settings from the UI. */
    function readSkuRules() {
      return {
        byChannel: document.getElementById('pw-sku-rule-bychan').checked,
        allowed:   document.getElementById('pw-sku-rule-allowed').value.trim(),
        noZero:    document.getElementById('pw-sku-rule-nozero').checked,
      };
    }

    /** Parse "0-2-4-6-8" / "0,2,4,6,8" / "0 2 4" into a Set of ints; null if empty. */
    function parseAllowedQty(s) {
      if (!s) return null;
      const nums = String(s).match(/\d+/g);
      if (!nums || !nums.length) return null;
      return new Set(nums.map(n => parseInt(n, 10)));
    }

    /**
     * Smart camera rules. Uses the table's own channel (NVR/DVR) and camera
     * columns via the fuzzy colMap + the existing parsers.
     * Returns null if the row passes, or a skip-reason string.
     */
    function skuCameraRuleCheck(row, rules, allowedSet) {
      const hLen = skuState.headers.length;
      let qty = null, ch = null;
      if ('camera' in colMap) {
        qty = parseCameraQty(skuText(skuCellAt(row, colMap.camera, hLen)));
      }
      if ('nvr' in colMap) {
        ch = parseChannel(skuText(skuCellAt(row, colMap.nvr, hLen)));
      }
      if (qty === null) return null; // no camera info in this row → rules don't apply
      if (rules.noZero && qty === 0) return 'No Camera row (rule)';
      if (allowedSet && !allowedSet.has(qty)) return `qty ${qty} not in allowed list`;
      if (rules.byChannel && ch !== null && qty > ch) return `qty ${qty} > ${ch}ch limit`;
      return null;
    }

    /** Render the per-column fieldsets (include / order / pattern / token map). */
    function renderSkuCols() {
      const wrap = document.getElementById('pw-sku-cols');
      wrap.innerHTML = '';
      skuState.cols.sort((a, b) => a.order - b.order).forEach(col => {
        const fs = document.createElement('fieldset');
        const lg = document.createElement('legend');
        lg.textContent = col.name;
        fs.appendChild(lg);

        // use / order / pattern row
        const top = document.createElement('div');
        top.className = 'sku-opt';
        const lbl = document.createElement('span');
        lbl.textContent = 'use / order / pattern';
        const inc = document.createElement('input');
        inc.type = 'checkbox'; inc.checked = col.include;
        inc.style.cssText = 'width:15px;height:15px;flex-shrink:0;cursor:pointer;';
        inc.onchange = () => { col.include = inc.checked; };
        const ord = document.createElement('input');
        ord.type = 'text'; ord.value = col.order; ord.className = 'sku-ord';
        ord.oninput = () => { col.order = skuNum(ord.value); };
        const pat = document.createElement('input');
        pat.type = 'text'; pat.value = col.pattern;
        pat.title = 'pattern: {v}=token, {n}=number in option';
        pat.oninput = () => { col.pattern = pat.value; };
        top.append(lbl, inc, ord, pat);
        fs.appendChild(top);

        // "set all options" row
        const sa = document.createElement('div');
        sa.className = 'sku-opt';
        const saLbl = document.createElement('span');
        saLbl.textContent = 'all options';
        const setAll = document.createElement('input');
        setAll.type = 'text'; setAll.placeholder = 'same value for all…';
        const bAll = document.createElement('button');
        bAll.type = 'button';
        bAll.textContent = 'Fill'; bAll.className = 'sku-fill-btn';
        sa.append(saLbl, setAll, bAll);
        fs.appendChild(sa);

        // one row per option with editable token
        const optWrap = document.createElement('div');
        col.options.forEach(o => {
          const r = document.createElement('div');
          r.className = 'sku-opt';
          const sp = document.createElement('span');
          sp.textContent = o; sp.title = o;
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.value = col.map[o] !== undefined
            ? col.map[o]
            : (/^no\b/i.test(o) ? '' : o.replace(/\s+/g, '-'));
          inp.placeholder = '(empty = skip)';
          col.map[o] = inp.value;
          inp.oninput = () => { col.map[o] = inp.value; };
          r.append(sp, inp);
          r.dataset.opt = o;
          r._inp = inp;
          optWrap.appendChild(r);
        });
        bAll.onclick = () => {
          Array.from(optWrap.children).forEach(r => {
            if (/^no\b/i.test(r.dataset.opt)) return;
            r._inp.value = setAll.value;
            col.map[r.dataset.opt] = setAll.value;
          });
        };
        fs.appendChild(optWrap);
        wrap.appendChild(fs);
      });
      document.getElementById('pw-sku-sep').value = skuCfg.sep;
      document.getElementById('pw-sku-onlyempty').checked = skuCfg.onlyEmpty !== false;
      const rules = skuCfg.rules || {};
      document.getElementById('pw-sku-rule-bychan').checked = rules.byChannel !== false;
      document.getElementById('pw-sku-rule-allowed').value = rules.allowed || '';
      document.getElementById('pw-sku-rule-nozero').checked = !!rules.noZero;
    }

    // Open SKU view
    document.getElementById('pw-btn-sku').addEventListener('click', () => {
      skuState = skuAnalyse(liveTable(table));
      if (!skuState) {
        setStatus('SKU / Custom label column not found in this grid.', 'error');
        return;
      }
      renderSkuCols();
      showStep('pw-step-sku');
      skuOut(`Detected ${skuState.cols.length} spec column(s) from visible rows.\nSet your tokens, then Preview.`);
    });

    document.getElementById('pw-sku-sep').addEventListener('input', e => {
      skuCfg.sep = e.target.value;
    });
    document.getElementById('pw-sku-onlyempty').addEventListener('change', e => {
      skuCfg.onlyEmpty = e.target.checked;
    });
    document.getElementById('pw-sku-back').addEventListener('click', () => {
      showStep('pw-step-main');
    });

    // Save settings for next time (same storage key as the old userscript)
    document.getElementById('pw-sku-save').addEventListener('click', () => {
      skuState.cols.forEach(c => {
        skuCfg.cols[c.name] = { include: c.include, order: c.order, pattern: c.pattern, map: c.map };
      });
      skuCfg.rules = readSkuRules();
      skuCfg.orderV2 = true; // from now on, saved orders take precedence
      saveSkuCfg();
      skuOut('Settings saved — they will be remembered for future listings.');
    });

    // Preview first 10 visible rows: current SKU → generated SKU
    document.getElementById('pw-sku-preview').addEventListener('click', () => {
      const hLen = skuState.headers.length;
      const rules = readSkuRules();
      const allowedSet = parseAllowedQty(rules.allowed);
      const tbl = liveTable(table);
      const rows = Array.from(tbl.querySelectorAll('tbody tr')).slice(0, 10);
      const lines = rows.map((r, i) => {
        const inp = skuInputOf(r, skuState.skuIndex, hLen);
        const cur = inp ? (skuReadVal(inp) || '(empty)') : '?';
        const reason = skuCameraRuleCheck(r, rules, allowedSet);
        const target = reason
          ? `(skip: ${reason})`
          : (buildSkuFor(r) || '(nothing to write)');
        return `${i + 1}. ${cur}\n   →  ${target}`;
      });
      skuOut(lines.join('\n') || 'No rows visible.');
    });

    // Run: fill all SKUs using the same scroll-and-fill engine as prices
    document.getElementById('pw-sku-run').addEventListener('click', async () => {
      if (!confirm('Fill SKUs for all variations in this grid?')) return;
      skuStopRef.stopped = false;
      skuUndo = [];
      const hLen = skuState.headers.length;
      const tbl = liveTable(table);
      const scrollParent = findScrollParent(tbl);
      // Clear markers from any previous run — otherwise re-runs see nothing new
      tbl.querySelectorAll('tbody tr').forEach(r => { delete r.dataset.pwSkuDone; });
      // Start from the top so the whole virtualized grid is covered
      scrollParent.scrollTop = 0;
      await new Promise(res => setTimeout(res, 350));
      const rules = readSkuRules();
      const allowedSet = parseAllowedQty(rules.allowed);
      const skipReasons = {};
      const addReason = k => { skipReasons[k] = (skipReasons[k] || 0) + 1; };
      let filled = 0, skipped = 0, stale = 0;
      const MAX_STALE = 4;
      document.getElementById('pw-sku-stop').style.display = '';
      document.getElementById('pw-sku-run').disabled = true;

      while (!skuStopRef.stopped) {
        const rows = Array.from(tbl.querySelectorAll('tbody tr'));
        let newSeen = 0;
        for (const row of rows) {
          if (row.dataset.pwSkuDone) continue;
          row.dataset.pwSkuDone = '1';
          newSeen++;
          const ruleReason = skuCameraRuleCheck(row, rules, allowedSet);
          if (ruleReason) { skipped++; addReason(ruleReason); continue; }
          let inp = skuInputOf(row, skuState.skuIndex, hLen);
          if (!inp) {
            // cell.click() may render the editor a tick later — wait and retry once
            await new Promise(res => setTimeout(res, 100));
            inp = skuInputOf(row, skuState.skuIndex, hLen);
          }
          if (!inp) { skipped++; addReason('no SKU field found'); continue; }
          const cur = skuReadVal(inp);
          if (skuCfg.onlyEmpty !== false && cur.trim()) { skipped++; addReason('already has SKU'); continue; }
          const val = buildSkuFor(row);
          if (!val) { skipped++; addReason('empty SKU result'); continue; }
          try {
            setInputValue(inp, val);
            skuUndo.push([inp, cur]);
            filled++;
          } catch (e) {
            skipped++; addReason('write error');
          }
        }
        skuOut(`Filled: ${filled}  |  Skipped: ${skipped}`);
        if (newSeen === 0) {
          stale++;
          if (stale >= MAX_STALE) break;
        } else {
          stale = 0;
        }
        const prev = scrollParent.scrollTop;
        scrollParent.scrollTop += 900;
        if (scrollParent.scrollTop === prev) break;
        await new Promise(res => setTimeout(res, 350));
      }

      document.getElementById('pw-sku-stop').style.display = 'none';
      document.getElementById('pw-sku-run').disabled = false;
      if (filled === 0 && skipped === 0) {
        skuOut(
          'No rows were processed at all.\n' +
          '1) Reload this eBay page (F5) — after updating the extension the page MUST be reloaded.\n' +
          '2) Check the panel header shows v1.5.2.\n' +
          '3) Then open SKU Wizard again and Run.'
        );
        return;
      }
      const reasonTxt = Object.entries(skipReasons)
        .map(([k, v]) => `  ${v}× ${k}`).join('\n');
      skuOut(
        `${skuStopRef.stopped ? 'Stopped.' : 'Done.'} Filled: ${filled}  Skipped: ${skipped}` +
        (reasonTxt ? `\nSkip reasons:\n${reasonTxt}` : '') +
        `\nCheck the grid, then save the listing yourself.`
      );
    });

    document.getElementById('pw-sku-stop').addEventListener('click', () => {
      skuStopRef.stopped = true;
    });

    // Undo the last run (works for inputs still mounted in the DOM)
    document.getElementById('pw-sku-undo').addEventListener('click', () => {
      if (!skuUndo || !skuUndo.length) { skuOut('Nothing to undo.'); return; }
      skuUndo.forEach(([inp, v]) => { try { setInputValue(inp, v); } catch (e) {} });
      skuOut('Reverted ' + skuUndo.length + ' SKU field(s).');
      skuUndo = null;
    });
  }

  // ─── Entry point ─────────────────────────────────────────────────────────────

  /**
   * Wait for the variations grid to appear (it may load dynamically or
   * be inside an iframe that loads after the main page).
   */
  function waitForGrid() {
    // Try immediately
    tryInit();
    if (document.getElementById(WIZARD_ID)) return;

    // Otherwise poll until found (max 30s)
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      tryInit();
      if (document.getElementById(WIZARD_ID) || attempts > 60) {
        clearInterval(interval);
      }
    }, 500);
  }

  // Only run in frames that look like eBay listing/variation pages
  const url = window.location.href;
  const isEbayListingPage =
    /ebay\.co\.uk/.test(url) ||
    /ebay\.com/.test(url) ||
    /bulkedit\.ebay/.test(url) ||
    /msku/i.test(url) ||
    document.title.toLowerCase().includes('ebay');

  if (isEbayListingPage || window !== window.top) {
    // Run after DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', waitForGrid);
    } else {
      waitForGrid();
    }
  }

})();
