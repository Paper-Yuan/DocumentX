/**
 * SafeDrop Global Shortcuts Integration
 * Handles events emitted by Tauri global shortcuts
 * 
 * Shortcuts:
 * - Ctrl+Shift+S (Cmd+Shift+S on macOS): Toggle window visibility
 * - Ctrl+Shift+Q (Cmd+Shift+Q on macOS): Quick send file
 * - Ctrl+Shift+R (Cmd+Shift+R on macOS): Refresh device list
 * - Escape: Close dialogs (frontend only)
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
 * Handle quick send file action
 * Opens file selection dialog
 */
function handleQuickSend() {
    // Try to find and click the file input or send button
    const fileInput = document.querySelector('input[type="file"]');
    const sendButton = document.querySelector('[data-action="send"], .send-button, #sendButton');

    if (fileInput) {
        fileInput.click();
    } else if (sendButton) {
        sendButton.click();
    } else {
        // Dispatch custom event for the application to handle
        const event = new CustomEvent('quick-send-triggered', {
            detail: { source: 'global-shortcut' }
        });
        document.dispatchEvent(event);
        console.warn('Quick send: No file input or send button found, dispatched custom event');
    }
}

/**
 * Handle device list refresh action
 */
function handleRefreshDevices() {
    // Try to find and click the refresh button
    const refreshButton = document.querySelector('[data-action="refresh"], .refresh-button, #refreshButton');

    if (refreshButton) {
        refreshButton.click();
    } else {
        // Dispatch custom event for the application to handle
        const event = new CustomEvent('refresh-devices-triggered', {
            detail: { source: 'global-shortcut' }
        });
        document.dispatchEvent(event);
        console.warn('Refresh devices: No refresh button found, dispatched custom event');
    }
}

/**
 * Handle Escape key press
 * Closes open dialogs, modals, or overlays
 */
function handleEscapeKey() {
    // Try to find and close any open dialogs/modals
    const closeButtons = document.querySelectorAll(
        '.modal.is-active .modal-close, ' +
        '.dialog.is-open .dialog-close, ' +
        '[data-action="close"], ' +
        '.overlay.is-visible .close-button'
    );

    if (closeButtons.length > 0) {
        closeButtons[0].click();
        return;
    }

    // Try to find visible modals/dialogs and hide them
    const modals = document.querySelectorAll('.modal.is-active, .dialog.is-open, .overlay.is-visible');
    if (modals.length > 0) {
        modals[0].classList.remove('is-active', 'is-open', 'is-visible');
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
