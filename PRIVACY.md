# Privacy

Applies to the source and extension package for 1.5.2.

The extension reads compatible variation tables and edits price and SKU inputs.
It contains no explicit network requests, telemetry, analytics, remote libraries
or backend. It does not request cookies, browsing history or account credentials.
The broad eBay site access in the manifest permits the content script to run in
matching top-level documents and frames.

Pricing setup is held in memory until the page is reloaded. SKU settings are saved
only when the user clicks Save, using the key `skuWizardCfg_v2` in the current eBay
origin's localStorage. Settings include option text/token mappings, column order,
patterns, separator, only-empty preference and camera rules.

This localStorage belongs to the website origin. It is not private extension
storage and can be read by scripts on that origin. Do not put sensitive information
into tokens or patterns. eBay's normal page code can react to the input/change
events emitted by the extension and may process the edited values.

To remove saved settings, remove that key from the relevant origin's localStorage
using browser developer tools, or clear site data for that origin. Clearing all
site data can sign you out and reset other eBay preferences. Uninstalling the
extension does not necessarily remove website localStorage.

Links in documentation open external sites governed by their own policies.
Do not include customer data, credentials or private listing information in public
GitHub issues. For private contact, use https://karmand.co.uk/contact.
