import { spawn } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';

// JXA exposes copyfile.h through Apple's system bridge. An allocated native
// state avoids converting a JavaScript value into an opaque NULL pointer.
const COPY_SCRIPT = `
ObjC.import('copyfile');
ObjC.import('stdio');
function run() {
  var state = $.copyfile_state_alloc();
  try {
    if ($.fcopyfile(3, 4, state, $.COPYFILE_ALL) !== 0) {
      $.perror('Prism fcopyfile');
      throw new Error('Native file metadata copying failed.');
    }
  } finally {
    $.copyfile_state_free(state);
  }
}
`;

export async function copyMacDescriptors(source: FileHandle, destination: FileHandle): Promise<void> {
  const env = { ...process.env };
  delete env.COPYFILE_DISABLE;
  delete env.COPY_EXTENDED_ATTRIBUTES_DISABLE;
  await new Promise<void>((resolve, reject) => {
    // Only verified file descriptors reach the fixed script. fcopyfile reads
    // their actual stat/ACL/xattrs, unlike cp's FTS stat of /dev/fd entries.
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', COPY_SCRIPT], {
      stdio: ['ignore', 'ignore', 'pipe', source.fd, destination.fd],
      env, timeout: 15_000,
    });
    let detail = '';
    child.stderr?.on('data', (chunk: Buffer) => { detail = (detail + chunk.toString()).slice(0, 4096); });
    child.once('error', (cause) => reject(new Error('The system metadata copier is unavailable; the note was not safely copied.', { cause })));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not preserve the note's file metadata${detail.trim() ? `: ${detail.trim()}` : '.'}`));
    });
  });
}
