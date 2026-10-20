# Validation record — 2026-10-20

Release: **1.5.2** (manifest version 1.5.2).

The maintainer confirmed that the tool works, requested skipping additional live
installation/editor testing, and approved stable publication. This is maintainer
acceptance, not an independently observed integration-test result. Runtime logic
is unchanged from 1.5.2-rc.1; only displayed version text changed.

## Completed

- `node --check content.js`: passed.
- `node --test test-content.cjs`: **12 tests passed, 0 failed**.
- Covered finite input parsing, HDD/camera/channel normalization, component totals,
  promotional arithmetic, non-writing Preview, only-empty/overwrite behavior,
  unknown HDD rejection, custom HDD prices, missing/negative recorder prices,
  invalid totals, per-row identity, SKU tokens and synthetic input events.
- Manifest is valid JSON, uses Manifest V3, references existing scripts/icons,
  and all PNG dimensions match their declared 16/48/128 sizes.
- Reviewed shipped source for explicit network calls and storage use.
- Release files were reviewed for credentials/private data; no credentials or
  customer data were identified. This is a source review and pattern scan, not a
  guarantee against every possible secret format.

## Not completed

- Browser UI fixture execution: localhost connection timed out; file-URL access
  was blocked by the automation browser policy. No UI screenshot is claimed.
- Chrome Load unpacked installation and permission prompt.
- Real eBay authenticated editor, React state persistence, scrolling/recycled
  rows, SKU Save/Run/Undo and final listing save behavior.
- Cross-browser, cross-origin frame and eBay editor variant compatibility.

`demo.html` is a reproducible synthetic fixture using the shipped content script.
Unit tests use DOM stubs and do not establish browser/editor integration.

## Manual release checklist

1. Load the release ZIP unpacked in Chrome and check the extension error panel.
2. Open the synthetic fixture and verify £230.00 without promotion and £261.36
   with input 10; verify Preview does not edit inputs.
3. Check custom 3TB pricing, invalid/negative inputs and only-empty preservation.
4. Check SKU tokens, camera rules, Save, Stop and Undo.
5. On a disposable draft listing, verify headers, iframe behavior, all scrolled
   rows and that eBay retains the edits. Do not publish a listing just to test.
6. Record browser version and editor configuration when completing future integration validation.
