# eBay Price Wizard

Preview and fill CCTV kit variation prices and SKUs in compatible eBay listing grids.
Built by **Ali Karmand** from hands-on marketplace operations work.

**Release candidate: 1.5.2-rc.1.** Local tests cover calculation and input handling.
This release has not been validated against a live eBay seller listing. Review every
generated value before saving a listing.

[Download releases](https://github.com/Alainkay313/ebay-price-wizard/releases) ·
[Product page](https://karmand.co.uk/tools/ebay-price-wizard) ·
[Development case study](https://karmand.co.uk/case-studies/ebay-price-wizard)

## What it does

Preparing combinations of recorders, hard drives and cameras means repeating the
same calculations across a variation table. Price Wizard adds a floating panel to
a compatible table so you can configure component prices, preview the results and
fill the inputs.

- Four-step pricing wizard: recorder, camera, HDD and optional promotional adjustment.
- Recorder prices for 4, 8, 16 and 32 channels.
- Editable HDD prices; selection controls which capacities are processed.
- Preview of the first ten currently rendered rows, including calculated prices.
- Fill only empty/zero prices, or explicitly choose to overwrite existing prices.
- Scroll-and-fill with progress and Stop controls.
- SKU tokens, column ordering, `{v}` / `{n}` patterns and a configurable separator.
- SKU filters for channel capacity, an allowed quantity list and zero-camera rows.
- SKU preview, saved settings and limited Undo for inputs still mounted in the page.

The extension edits page inputs. It does **not** click eBay's final Save, Continue
or Publish controls.

## Install in Chrome

1. Download the extension ZIP attached to a release and extract it to a permanent folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode**, then choose **Load unpacked**.
4. Select the extracted folder containing `manifest.json`.
5. Open or reload a supported eBay listing page and open its variations editor.

The panel appears when the script detects a supported table. There is no toolbar
popup. Keep the extracted files in place. To update, replace the installed files,
click **Reload** on the extension card and reload the eBay page.

You can also load this repository's root folder directly. No build step, npm
installation or runtime library is required.

## Price example

All figures below are synthetic examples, not recommended selling prices.

| Component | Example |
|---|---:|
| 8-channel recorder | £100.00 |
| 2TB drive | £50.00 |
| 4 cameras at £20 each | £80.00 |
| Base total | **£230.00** |

```text
base = recorder + HDD + (camera quantity × camera price)
final = base × 100 / (100 − promotional input × 1.2)
```

Leave the promotional field blank for the base total. An input of `10` divides
£230 by `0.88`, giving **£261.36** after rounding to two decimal places. This is a
roughly 13.64% increase, not a simple 12% markup. The accepted input range is
0–83.33; values near the upper limit produce very large prices. The formula is
user-configured arithmetic, not an eBay fee, tax or profit calculator.

1. Open **Wizard** and enter component prices. Blank recorder prices skip that channel.
2. Select all HDD capacities needed, including ones outside the currently visible rows.
3. Set or verify each selected HDD price. Built-in values are examples, not live prices.
4. Finish setup, then choose **Preview** and check the amounts.
5. Choose **Run**, inspect the full grid and save through eBay yourself if satisfied.

## SKU example

Open **SKU Wizard**. For a row with an 8-channel recorder, four cameras and a 2TB
drive, configure:

| Column | Token | Pattern | Order |
|---|---|---|---:|
| Recorder option | `DVR-8CH` | `{v}` | 1 |
| Camera option | `CAM` | `{n}x{v}` | 2 |
| HDD option | `2TB` | `{v}` | 3 |

With separator `+`, the result is `DVR-8CH+4xCAM+2TB`.
An empty token omits that option. `{n}` uses the first number found in the option
text. The allowed-quantity field is a list: `0-2-4` means 0, 2 and 4, not a range.
**Save** stores SKU configuration; **Run** writes SKU fields.

## Permissions and privacy

The Manifest V3 content script is allowed on HTTPS pages under `ebay.co.uk` and
`ebay.com`, including subdomains. `all_frames: true` allows it to find variation
tables inside matching frames. These site scopes are broad because the editor can
move between eBay hosts; the panel still requires a matching table.

There are no additional API permissions, background service workers, remote
scripts, analytics or explicit network requests in the shipped extension.

Price configuration stays in the current page's memory. Clicking SKU **Save**
stores token mappings, patterns, order, separator and rule settings in the current
eBay origin's `localStorage`, under `skuWizardCfg_v2`. This is **site storage**,
not isolated extension storage: scripts on the same origin can access it, and
different eBay origins can have different settings. It is not suitable for secrets.
The page's normal eBay code may process changes to its inputs; saving the listing
is governed by eBay's own behavior.

See [PRIVACY.md](PRIVACY.md) for details and removal instructions.

## Compatibility and limitations

- Designed for English-language CCTV variation tables with `thead`, `tbody` and
  editable price inputs. Detection needs a Price column and an NVR/DVR, HDD or Camera header.
- Price calculation needs a recognizable recorder/channel column. Arbitrary eBay
  categories, languages and every editor layout are not supported.
- The script polls for a grid for about 30 seconds. Reload if it appears later,
  or after closing the panel.
- Options are detected from currently rendered rows. Review the full listing.
- eBay can replace or recycle table rows. Automatic scrolling is best effort;
  virtualized grids can leave rows unprocessed.
- SKU Undo only affects inputs retained from the last run that still represent
  the same mounted rows. It is not a listing backup and cannot reverse a saved listing.
- Price filling has no Undo. Keep **Only fill empty / zero prices** enabled unless
  overwriting is intended.
- Do not run price and SKU fills simultaneously. Stop a run before changing setup.

## Troubleshooting

| Symptom | Check |
|---|---|
| No floating panel | Reload after installation; open the variations table; check supported domain and headers. |
| Rows skipped | Check channel prices, selected HDD capacities, valid HDD costs and recognized camera quantities. |
| SKU inputs missing | Ensure SKU / Custom label is available and the table is in editable mode. |
| Some rows unchanged | Inspect skip reasons and virtualized rows; verify remaining rows manually before saving. |
| Changes disappear | Check the editor accepted the input changes before using its normal save flow. |
| Saved SKU settings absent | Check the eBay origin and whether browser site data was cleared. |

## Development and validation

Runtime: plain JavaScript and browser DOM APIs. Development tests need Node.js 18+:

```sh
node --check content.js
node --test test-content.cjs
```

`demo.html` runs the actual content script against **synthetic sample data**. It is
a local fixture, not an eBay page, and does not prove compatibility with the live
editor. Open it in a browser to explore the UI without touching a listing.

See [TESTING.md](TESTING.md) for results and remaining live checks.
Report reproducible problems in [Issues](https://github.com/Alainkay313/ebay-price-wizard/issues),
using anonymized examples. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License and independence

MIT © 2026 Ali Karmand. See [LICENSE](LICENSE).

This is an independent project, not affiliated with, endorsed by or sponsored by
eBay. eBay and other names belong to their respective owners.
