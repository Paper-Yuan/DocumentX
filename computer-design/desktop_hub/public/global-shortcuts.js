/**
 * SafeDrop global shortcut bridge.
 *
 * The Tauri shell registers system-wide shortcuts and emits an event for each one; this
 * file turns those events into actions in the page. It is loaded last, after app.js, and
 * talks to it through the small `window.SafeDropUI` surface app.js publishes.
 *
 * Shortcuts (as registered by the shell):
 * - Ctrl+Shift+S (Cmd+Shift+S on macOS): toggle window visibility
 * - Ctrl+Shift+Q (Cmd+Shift+Q on macOS): pick files to send
 * - Ctrl+Shift+R (Cmd+Shift+R on macOS): ask the network again right now
 * - Escape: close the pairing sheet or the pairing-code dialog
 */

// Check if running in Tauri environment
const isTauri = window.__TAURI__ !== undefined;

if (isTauri) {
    const { listen } = window.__TAURI__.event;

    // Listen for quick send shortcut event
    listen('shortcut-quick-send', () => {
        console.log('Global shortcut: Quick send triggered');
        handleQuickSend();
    });

    // Listen for refresh devices shortcut event
    listen('shortcut-refresh-devices', () => {
        console.log('Global shortcut: Refresh devices triggered');
        handleRefreshDevices();
    });

    console.log('Global shortcuts initialized');
}

// Handle Escape key for closing dialogs (frontend-only)
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        handleEscapeKey();
    }
});

/**
 * Handle quick send file action: open the OS file picker for the page.
 */
function handleQuickSend() {
    if (window.SafeDropUI && window.SafeDropUI.pickFiles) {
        window.SafeDropUI.pickFiles();
        return;
    }

    // Dispatch custom event for the application to handle
    const event = new CustomEvent('quick-send-triggered', {
        detail: { source: 'global-shortcut' }
    });
    document.dispatchEvent(event);
    console.warn('Quick send: no SafeDropUI.pickFiles available, dispatched custom event');
}

/**
 * Handle the "ask again" action. Discovery already polls on a timer, so this only skips
 * the wait; the readout next to the list is what tells you when it last answered.
 */
function handleRefreshDevices() {
    if (window.SafeDropUI && window.SafeDropUI.refreshDevices) {
        window.SafeDropUI.refreshDevices();
        return;
    }

    // Dispatch custom event for the application to handle
    const event = new CustomEvent('refresh-devices-triggered', {
        detail: { source: 'global-shortcut' }
    });
    document.dispatchEvent(event);
    console.warn('Refresh devices: no SafeDropUI.refreshDevices available, dispatched custom event');
}

/**
 * Handle Escape key press: close the topmost floating layer, if there is one.
 *
 * The selectors here are the ones this page actually uses. The previous version looked for
 * `.modal.is-active` / `.dialog.is-open`, which this UI never sets, so Escape did nothing.
 * app.js also handles Escape for the pairing sheet; both paths are idempotent (removing a
 * class that is already gone), so running twice is harmless.
 */
function handleEscapeKey() {
    const openPairSheet = document.querySelector('.sheet-overlay.open');
    if (openPairSheet) {
        const closeBtn = openPairSheet.querySelector('#pairSheetClose, #pairCancelBtn');
        if (closeBtn) closeBtn.click();
        return;
    }

    const openModal = document.querySelector('.modal-overlay.open');
    if (openModal) {
        const closeBtn = openModal.querySelector('.modal-close-btn, #modalDoneBtn');
        if (closeBtn) closeBtn.click();
        return;
    }

    const contextMenu = document.querySelector('.chat-context-menu');
    if (contextMenu) {
        contextMenu.remove();
        return;
    }

    // Dispatch custom event for the application to handle
    const event = new CustomEvent('escape-key-pressed', {
        detail: { timestamp: Date.now() }
    });
    document.dispatchEvent(event);
}

// Export functions for use in other modules if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        handleQuickSend,
        handleRefreshDevices,
        handleEscapeKey
    };
}
