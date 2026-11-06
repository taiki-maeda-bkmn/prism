import os from 'node:os';

/** Bound startup and release this launch's owned session when its browser exits. */
export function superviseDesktopChild(child, {
  token,
  startupTimeoutMs = 30_000,
  terminateGraceMs = 2_000,
  processGroup = false,
  signalSource = process,
  signalGroup = (pid, signal) => process.kill(-pid, signal),
  writeStdout = chunk => process.stdout.write(chunk),
  reportError = message => console.error(message),
} = {}) {
  if (!/^[a-f0-9]{32,64}$/.test(token ?? '')) throw new Error('A startup token is required.');
  return new Promise(resolve => {
    const marker = `\nPRISM_READY:${token}\n`;
    let tail = '\n';
    let ready = false;
    let finished = false;
    let timedOut = false;
    let groupKilled = false;
    let escalation;
    const running = () => !finished && child.exitCode === null && child.signalCode === null;

    function signal(signal, group = false) {
      if (!running()) return;
      try {
        if (group && processGroup && child.pid) {
          signalGroup(child.pid, signal);
          if (signal === 'SIGKILL') groupKilled = true;
        }
        else child.kill(signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') reportError(`Prism could not stop its startup process: ${error.message}`);
      }
    }

    const deadline = setTimeout(() => {
      if (!running() || ready) return;
      timedOut = true;
      reportError(`Prism did not open a window within ${Math.round(startupTimeoutMs / 1000)} seconds. Closing this failed startup; launch Prism again to retry.`);
      signal('SIGTERM', true);
      // A stuck startup can ignore SIGTERM. Never retain this timer after exit
      // or readiness, and never apply it to an already-open editing session.
      if (running()) escalation = setTimeout(() => signal('SIGKILL', true), terminateGraceMs);
    }, startupTimeoutMs);

    function receive(chunk) {
      writeStdout(chunk);
      if (ready) return;
      const text = tail + chunk.toString('utf8');
      if (text.includes(marker)) {
        ready = true;
        clearTimeout(deadline);
        clearTimeout(escalation);
      }
      // Keep enough for a marker split across writes, without retaining logs.
      tail = text.slice(-marker.length);
    }
    const interrupt = () => signal('SIGINT');
    const terminate = () => signal('SIGTERM');
    function finish(code, exitSignal) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      signalSource.removeListener('SIGINT', interrupt);
      signalSource.removeListener('SIGTERM', terminate);
      child.removeListener('error', failed);
      child.removeListener('exit', finish);
      child.stdout?.removeListener('data', receive);
      // The launcher created this dedicated group with detached: true. The
      // browser has now exited, so any surviving Chromium processes belong to
      // a finished session. Signal once here, never from a timer after reaping
      // the browser, when its old PID could have been reused by another app.
      if (processGroup && child.pid && !groupKilled) {
        try { signalGroup(child.pid, 'SIGKILL'); }
        catch (error) {
          if (error?.code !== 'ESRCH') reportError(`Prism could not clean up its finished session: ${error.message}`);
        }
      }
      // Chromium descendants can inherit stdout. Waiting for `close` keeps the
      // wrapper alive after the browser has exited; release our pipe on `exit`.
      child.stdout?.destroy();
      const exitCode = timedOut && !ready ? 1 : code ?? (exitSignal ? 128 + (os.constants.signals[exitSignal] ?? 0) : 1);
      resolve({ exitCode, ready, timedOut });
    }
    function failed(error) {
      reportError(`Prism could not start: ${error.message}`);
      // Spawn failure has no child and no subsequent exit event. A later kill
      // error must not abandon a browser that is still running.
      if (!child.pid) finish(1, null);
    }

    child.stdout?.on('data', receive);
    child.once('exit', finish);
    child.on('error', failed);
    signalSource.on('SIGINT', interrupt);
    signalSource.on('SIGTERM', terminate);
  });
}
