// SPDX-License-Identifier: AGPL-3.0-or-later
// Bootstrap follows Zotero's Make It Red / Zotero 10 plugin lifecycle.
var chromeHandle;
var pluginScope;

function install() {}
function uninstall() {}

async function startup(data) {
  if (Zotero.QuickSwitcherRuntime) {
    await Zotero.QuickSwitcherRuntime.stop();
    await Zotero.Promise.delay(0);
  }
  var aom = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = aom.registerChrome(Services.io.newURI(data.rootURI + "manifest.json"), [
    ["content", "quickswitcher", data.rootURI + "content/"],
  ]);
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);
  var win = Zotero.getMainWindow() || [...Services.wm.getEnumerator("zotero:reader")].find(window => !window.closed) || Services.appShell.hiddenDOMWindow;
  pluginScope = {
    Zotero, Services, ChromeUtils,
    Cc: Components.classes, Ci: Components.interfaces,
    IOUtils, PathUtils,
    ChromeWorker: typeof ChromeWorker !== "undefined" ? ChromeWorker : Components.utils.getGlobalForObject(Services).ChromeWorker,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: win.console,
    performance: win.performance,
    URL, DOMParser, crypto,
    TextEncoder: win.TextEncoder, TextDecoder: win.TextDecoder,
    structuredClone: win.structuredClone.bind(win),
  };
  Services.scriptloader.loadSubScript(data.rootURI + "content/quickswitcher.js", pluginScope, "UTF-8");
  await pluginScope.QuickSwitcher.start(data);
}

async function onMainWindowLoad({ window }) {
  await pluginScope?.QuickSwitcher.registerWindow(window);
}
async function onMainWindowUnload({ window }) {
  await pluginScope?.QuickSwitcher.unregisterWindow(window);
}
async function shutdown() {
  var stoppingScope = pluginScope;
  var stoppingChrome = chromeHandle;
  try { await stoppingScope?.QuickSwitcher.stop(); }
  finally {
    if (pluginScope === stoppingScope) pluginScope = null;
    stoppingChrome?.destruct();
    if (chromeHandle === stoppingChrome) chromeHandle = null;
  }
}
