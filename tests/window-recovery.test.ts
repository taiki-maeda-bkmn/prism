import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { installWslgWindowRecovery } from '../src/main/window-recovery';

class WindowStub extends EventEmitter {
  destroyed = false;
  minimized = false;
  maximized = false;
  bounds = { x: 80, y: 40, width: 1100, height: 760 };
  restores = 0;
  paints = 0;
  duringRestore?: () => void;
  operations: string[] = [];

  webContents = {
    invalidate: () => {
      assert.equal(this.destroyed, false, 'a closed window cannot repaint');
      this.paints += 1;
      this.operations.push('paint');
    },
  };

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    assert.equal(this.destroyed, false, 'a closed window cannot be queried');
    return this.minimized;
  }

  restore(): void {
    assert.equal(this.destroyed, false, 'a closed window cannot be restored');
    this.restores += 1;
    this.operations.push('restore');
    this.duringRestore?.();
    this.minimized = false;
  }
}

test('taskbar focus restores a still-minimized compositor before repainting', async (t) => {
  for (const maximized of [false, true]) {
    await t.test(maximized ? 'previously maximized' : 'previously windowed', () => {
      const window = new WindowStub();
      window.minimized = true;
      window.maximized = maximized;
      const bounds = { ...window.bounds };
      installWslgWindowRecovery(window);

      window.emit('focus');

      assert.equal(window.minimized, false);
      assert.equal(window.maximized, maximized);
      assert.deepEqual(window.bounds, bounds);
      assert.deepEqual(window.operations, ['restore', 'paint']);
    });
  }
});

test('ordinary focus repaints without restoring or changing the window geometry', () => {
  const window = new WindowStub();
  window.maximized = true;
  const bounds = { ...window.bounds };
  installWslgWindowRecovery(window);

  window.emit('focus');
  window.emit('focus');

  assert.equal(window.restores, 0);
  assert.equal(window.paints, 2);
  assert.equal(window.maximized, true);
  assert.deepEqual(window.bounds, bounds);
});

test('focus emitted during restore does not recursively restore the window', () => {
  const window = new WindowStub();
  window.minimized = true;
  // A native focus event can arrive before restore has cleared minimized state.
  window.duringRestore = () => window.emit('focus');
  installWslgWindowRecovery(window);

  window.emit('focus');

  assert.equal(window.minimized, false);
  assert.equal(window.restores, 1);
  assert.equal(window.paints, 1);

  // A later minimize/restore cycle must still recover independently.
  window.minimized = true;
  window.emit('focus');
  assert.equal(window.minimized, false);
  assert.equal(window.restores, 2);
  assert.equal(window.paints, 2);
});

test('late focus and resize events do not access a closed window', () => {
  const window = new WindowStub();
  window.minimized = true;
  installWslgWindowRecovery(window);
  window.destroyed = true;

  assert.doesNotThrow(() => {
    window.emit('focus');
    window.emit('resize');
  });
  assert.equal(window.restores, 0);
  assert.equal(window.paints, 0);
});

test('closing during native restore does not repaint destroyed web contents', () => {
  const window = new WindowStub();
  window.minimized = true;
  window.duringRestore = () => { window.destroyed = true; };
  installWslgWindowRecovery(window);

  assert.doesNotThrow(() => window.emit('focus'));
  assert.equal(window.restores, 1);
  assert.equal(window.paints, 0);
});

test('a failed native restore does not prevent a later focus from recovering', () => {
  const window = new WindowStub();
  window.minimized = true;
  const failure = new Error('native restore failed');
  window.duringRestore = () => { throw failure; };
  installWslgWindowRecovery(window);

  assert.throws(() => window.emit('focus'), failure);
  assert.equal(window.paints, 0);
  window.duringRestore = undefined;
  window.emit('focus');

  assert.equal(window.minimized, false);
  assert.equal(window.restores, 2);
  assert.equal(window.paints, 1);
});

test('resizing repaints the resized surface without restoring the window', () => {
  const window = new WindowStub();
  installWslgWindowRecovery(window);

  window.bounds = { x: 0, y: 0, width: 1920, height: 1040 };
  window.maximized = true;
  window.emit('resize');
  window.bounds = { x: 80, y: 40, width: 1100, height: 760 };
  window.maximized = false;
  window.emit('resize');

  assert.equal(window.paints, 2);
  assert.equal(window.restores, 0);
});
