import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolvePDFProfileDirectory } from '../src/main/library-location';

test('uses the existing PDF profile under this OS account app-data directory', () => {
  const appData = path.resolve('profile', 'Application data');
  assert.equal(resolvePDFProfileDirectory({ appData, isPackaged: false }), path.join(appData, 'prism-pdf'));
  assert.equal(resolvePDFProfileDirectory({ appData, isPackaged: true }), path.join(appData, 'prism-pdf'));
});

test('resolves an explicit development profile without appending another profile directory', () => {
  const appData = path.resolve('normal-profile');
  const override = path.join('disposable-profile', '日本語');
  assert.equal(resolvePDFProfileDirectory({ appData, isPackaged: false, override }), path.resolve(override));
  const absolute = path.resolve('disposable-absolute-profile');
  assert.equal(resolvePDFProfileDirectory({ appData, isPackaged: false, override: absolute }), absolute);
});

test('ignores profile overrides in packaged applications and empty development overrides', () => {
  const appData = path.resolve('normal-profile');
  assert.equal(resolvePDFProfileDirectory({ appData, isPackaged: true, override: 'untrusted-profile' }), path.join(appData, 'prism-pdf'));
  assert.equal(resolvePDFProfileDirectory({ appData, isPackaged: false, override: '' }), path.join(appData, 'prism-pdf'));
});
