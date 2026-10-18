interface RecoverableWindow {
  on(event: 'focus' | 'resize', listener: () => void): unknown;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  webContents: { invalidate(): void };
}

/** Installed only for WSLg windows using native Wayland. */
export function installWslgWindowRecovery(window: RecoverableWindow): void {
  let restoring = false;
  window.on('focus', () => {
    if (restoring || window.isDestroyed()) return;
    restoring = true;
    try {
      // The Windows taskbar can return keyboard focus without Wayland's
      // activated configure. Chromium then keeps its compositor minimized,
      // leaving the last frame visible even though input is arriving again.
      // Restore also retains the window's previous maximized state.
      if (window.isMinimized()) window.restore();
      if (!window.isDestroyed()) window.webContents.invalidate();
    } finally {
      restoring = false;
    }
  });
  // WSLg can retain the smaller surface after restore -> maximize. Repaint
  // every pixel so the host receives the full surface at its new size.
  window.on('resize', () => {
    if (!window.isDestroyed()) window.webContents.invalidate();
  });
}
