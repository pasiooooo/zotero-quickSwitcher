// SPDX-License-Identifier: AGPL-3.0-or-later
document.addEventListener("showing", function show(event) {
  if (event.target.querySelector?.("#qs-preferences-root")) Zotero.QuickSwitcherRuntime?.renderPreferences(window);
}, true);
