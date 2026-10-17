import { statSync } from 'node:fs';
import path from 'node:path';

function isSocket(filename) {
  try { return statSync(filename).isSocket(); }
  catch { return false; }
}

// Chromium selects its display backend before application JavaScript runs.
// Select native Wayland at launch on WSLg to avoid Xwayland's displaced
// borderless maximized windows, while preserving an explicit backend choice.
export function electronLaunchArguments(args, {
  platform = process.platform, env = process.env, socketExists = isSocket,
} = {}) {
  const unchanged = [...args];
  if (platform !== 'linux' || !env.WSL_DISTRO_NAME || !env.WAYLAND_DISPLAY) return unchanged;
  if (args.some(arg => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='))) return unchanged;
  // A remote X server or an isolated Xvfb display is a deliberate alternative
  // to the WSLg desktop, even when it inherits WSL's Wayland environment.
  if (env.DISPLAY && !/^(?:unix)?:0(?:\.0)?$/.test(env.DISPLAY)) return unchanged;
  const socket = path.posix.isAbsolute(env.WAYLAND_DISPLAY)
    ? env.WAYLAND_DISPLAY
    : env.XDG_RUNTIME_DIR && path.posix.isAbsolute(env.XDG_RUNTIME_DIR)
      ? path.posix.join(env.XDG_RUNTIME_DIR, env.WAYLAND_DISPLAY) : undefined;
  if (!socket || !socketExists(socket)) return unchanged;
  const hint = args.findLast(arg => arg.startsWith('--ozone-platform-hint='))?.split('=')[1]
    ?? env.ELECTRON_OZONE_PLATFORM_HINT;
  return [`--ozone-platform=${hint === 'x11' ? 'x11' : 'wayland'}`, ...args];
}
