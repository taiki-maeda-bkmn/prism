import test from 'node:test';
import assert from 'node:assert/strict';
import { checksumForArtifact, validateDestination } from '../scripts/install-native-windows.mjs';

test('Windows staging accepts dedicated drive folders from Windows and WSL', () => {
  assert.equal(validateDestination('/mnt/c/Users/me/Prism Native', 'linux'), '/mnt/c/Users/me/Prism Native');
  assert.equal(validateDestination('C:\\Users\\me\\Prism Native', 'win32'), 'C:\\Users\\me\\Prism Native');
});

test('Windows staging rejects WSL UNC, Linux, relative, control-character, and drive-root destinations', () => {
  for (const candidate of ['\\\\wsl.localhost\\Ubuntu\\home\\me', 'relative', 'C:\\', 'C:\\folder\\..', 'C:\\bad\npath']) {
    assert.throws(() => validateDestination(candidate, 'win32'));
  }
  for (const candidate of ['/home/me/prism', 'mnt/c/prism', '/mnt/c/', '/mnt/c/folder/..', '/mnt/c/../../home/me', '/mnt/c/bad\npath']) {
    assert.throws(() => validateDestination(candidate, 'linux'));
  }
});

test('archive verification selects the exact official filename and handles binary checksum markers', () => {
  const filename = 'electron-v44.7.2-win32-x64.zip';
  const expected = 'a'.repeat(64);
  assert.equal(checksumForArtifact(`${'b'.repeat(64)} *electron-v44.7.2-linux-x64.zip\r\n${expected} *${filename}\r\n`, filename), expected);
  assert.equal(checksumForArtifact(`${expected.toUpperCase()}  ${filename}\n`, filename), expected);
  assert.throws(() => checksumForArtifact(`${expected} *${filename}.bak`, filename));
  assert.throws(() => checksumForArtifact(`${expected} *${filename}\n${expected} *${filename}`, filename));
  assert.throws(() => checksumForArtifact(`short *${filename}`, filename));
});
