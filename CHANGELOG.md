# Changelog

## 1.5.2 — 2026-10-20

- Promote 1.5.2-rc.1 with maintainer approval and confirmation of working behavior.
- Update manifest/display version and documentation; runtime logic is unchanged.
- Automated checks pass. Additional Chrome/eBay integration testing was waived by
  the maintainer and was not independently completed.

## 1.5.2-rc.1 — 2026-10-20

First standalone public release candidate. Chrome's numeric manifest version is
1.5.2; `version_name` identifies this release candidate.

- Preserve the 1.5.1 per-row WeakMap identity fix and corrected promotion explanation.
- Show calculated amounts in price Preview; limit it to the first ten rendered rows.
- Reject malformed/non-finite numeric input and negative recorder prices.
- Require valid prices for selected HDDs, including custom capacities.
- Skip unknown HDD costs instead of silently using zero.
- Set injected buttons to `type="button"` so they do not submit surrounding forms.
- Refresh the price table reference during scrolling.
- Avoid HTML interpolation of custom HDD labels.
- Correct the promotion preview range and avoid repeated preview listeners.
- Add English documentation, privacy notes, MIT license, synthetic fixture and tests.
- Remove the redundant bulkedit host entry already covered by the wildcard.

Live eBay validation is still required. Virtualized-row handling and SKU Undo have
documented limitations; this release is not presented as production-validated.

## 1.5.1 — existing source reviewed

Existing project source contained a per-row identity fix and corrected promotional
formula wording/range. These were preserved when preparing this release.

## 1.5.0 — supplied baseline

Supplied Manifest V3 extension with price wizard, promotional formula, editable
HDD prices, SKU mapping/patterns, rules, preview, scrolling, Save and limited Undo.
