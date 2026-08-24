// Sandbox-safe preload: no node, no IPC, no bridge. Two things the page cannot
// do for itself, both of which only matter once the game is a desktop app.
//
// It runs with `sandbox: true` and touches nothing but DOM events.

// 1. Chromium zooms the page on Ctrl/Cmd + wheel. The game binds Ctrl to Dash
//    and the wheel to cycling spells, so dashing while swapping spells — an
//    ordinary thing to do — silently rescales the HUD and the canvas. The game
//    cannot defend itself: src/core/input.js registers its wheel listener as
//    `{ passive: true }`, which forfeits the right to preventDefault. Cancelling
//    here on the capture phase kills the zoom while still letting that
//    bubble-phase listener see the event, so spell cycling keeps working.
window.addEventListener(
  'wheel',
  (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); },
  { passive: false, capture: true }
);

// 2. A GPU-process restart — routine on Windows after a driver reset, and on
//    macOS after sleep/wake with an external display — leaves three.js holding
//    a dead context and the window permanently black. Nothing in the game
//    listens for it, and the reload accelerator is deliberately gone, so
//    without this there is no way back except force-quitting.
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('game-canvas')?.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    location.reload();
  });
});
