// Preload for the printer window (desktop/print.cjs). Runs before any page script, in the page's own world
// (contextIsolation is off on purpose): window.print can never reach a printer from here — it only leaves the
// mark the printer waits for, so even a stale client that still calls window.print() in export mode is safe.
window.print = () => { document.documentElement.dataset.printCalled = '1' }
