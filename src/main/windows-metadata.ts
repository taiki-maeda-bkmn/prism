import { spawn } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

// Pass open handles instead of names: a concurrent rename must not redirect ACL
// changes onto a different file. This command must never write to stdout, which
// is the destination file handle; all diagnostics go to stderr.
const aclCommand = `
$ErrorActionPreference = 'Stop'
$WarningPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class PrismFileSecurity {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern SafeFileHandle ReOpenFile(IntPtr handle, uint access, uint share, uint flags);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint GetSecurityInfo(IntPtr handle, uint type, uint information,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint SetSecurityInfo(SafeFileHandle handle, uint type, uint information,
    IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool GetSecurityDescriptorControl(IntPtr descriptor, out ushort control, out uint revision);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);

  public static void Copy() {
    IntPtr source = GetStdHandle(-10), destination = GetStdHandle(-11);
    if (source == IntPtr.Zero || source == new IntPtr(-1)
      || destination == IntPtr.Zero || destination == new IntPtr(-1))
      throw new InvalidOperationException("Missing file handles for metadata preservation.");
    IntPtr owner, group, dacl, sacl, descriptor;
    uint error = GetSecurityInfo(source, 1, 7, out owner, out group, out dacl, out sacl, out descriptor);
    if (error != 0) throw new Win32Exception((int)error);
    try {
      ushort control;
      uint revision;
      if (!GetSecurityDescriptorControl(descriptor, out control, out revision))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      // WRITE_DAC | WRITE_OWNER; Node's ordinary writable handle lacks these.
      using (SafeFileHandle writable = ReOpenFile(destination, 0x000C0000, 7, 0)) {
        if (writable.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint protection = (control & 0x1000) != 0 ? 0x80000000u : 0x20000000u;
        error = SetSecurityInfo(writable, 1, 7 | protection, owner, group, dacl, IntPtr.Zero);
        if (error != 0) throw new Win32Exception((int)error);
      }
    } finally { LocalFree(descriptor); }
  }
}
'@
  [PrismFileSecurity]::Copy()
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

/** Preserve owner/group/DACL on the pinned destination; native copying handles streams/attributes. */
export function preserveWindowsMetadata(source: FileHandle, destination: FileHandle): Promise<void> {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(aclCommand, 'utf16le').toString('base64')], {
      windowsHide: true,
      stdio: [source.fd, destination.fd, 'pipe'],
    });
    let diagnostic = '';
    let expired = false;
    const timeout = setTimeout(() => { expired = true; child.kill(); }, 15_000);
    child.stderr?.on('data', (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(-4096); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0 && !expired) resolve();
      else reject(new Error(expired ? 'Preserving file permissions timed out.' : `Could not preserve file permissions: ${diagnostic.trim() || `helper exited with ${code}`}`));
    });
  });
}
