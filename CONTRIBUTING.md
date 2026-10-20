# Contributing

Use Issues for bugs and small feature proposals. Include the extension version,
browser version, eBay domain, relevant column names, expected result and actual
result. Use synthetic values and redact account/customer information.

For code changes, fork the repository, make a focused branch and open a pull
request. Run `node --check content.js` and `node --test test-content.cjs`.
Add a regression test for calculation/input-handling changes. Explain any new
permissions, storage or network behavior. Keep the runtime dependency-free unless
there is a clear reason to change it.

Test browser changes with `demo.html` first. Never use a live listing as an
unreviewed automated test target. State explicitly which live editor configurations
you have tested; fixture results alone do not establish live compatibility.

Contributions are submitted under the project's MIT license.
