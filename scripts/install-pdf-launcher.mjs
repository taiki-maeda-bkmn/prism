import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = path.join(root, 'scripts/launch-pdf.sh');
const icon = path.join(root, 'pdf-manager/assets/prism-pdf.png');
const marker = 'X-Prism-PDF-Launcher=true';

if (process.platform !== 'linux') throw new Error('This launcher installer supports Linux and Windows through WSL.');
if (/[\r\n\0]/.test(root)) throw new Error('The repository path cannot contain line breaks.');
await access(path.join(root, 'node_modules/electron/dist/electron'), constants.X_OK);
await Promise.all([
  path.join(root, 'pdf-manager/dist/main.cjs'),
  path.join(root, 'pdf-manager/dist/renderer/index.html'),
  launcher, icon,
].map(filename => access(filename, constants.R_OK)));

// Desktop Entry strings and Exec arguments have separate escaping rules.
const desktopString = value => value.replaceAll('\\', '\\\\').replaceAll('\t', '\\t');
const desktopArgument = value => desktopString('"' + value.replace(/[\\"`$]/g, '\\$&').replaceAll('%', '%%') + '"');
const dataHome = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME)
  ? process.env.XDG_DATA_HOME : path.join(os.homedir(), '.local/share');
const applications = path.join(dataHome, 'applications');
const desktopFile = path.join(applications, 'io.github.beautysamurai.PrismPDF.desktop');
const previous = await readFile(desktopFile, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
if (previous && !previous.split(/\r?\n/).includes(marker)) {
  throw new Error(`A different launcher already exists at ${desktopFile}; it was left untouched.`);
}
await mkdir(applications, { recursive: true });
await writeFile(desktopFile, [
  '[Desktop Entry]', 'Type=Application', 'Version=1.0', 'Name=Prism PDF',
  'Comment=Your local PDF library and reader',
  `Exec=/bin/sh ${desktopArgument(launcher)}`,
  `Icon=${desktopString(icon)}`, 'Terminal=false', 'Categories=Office;Viewer;',
  'StartupWMClass=prism-pdf', marker, '',
].join('\n'), { mode: 0o644 });
console.log(`Installed application launcher: ${desktopFile}`);

if (process.env.WSL_DISTRO_NAME) {
  const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const windowsPath = filename => execFileSync('wslpath', ['-w', filename], { encoding: 'utf8' }).trim();
  const config = Buffer.from(JSON.stringify({
    distro: process.env.WSL_DISTRO_NAME,
    launcherPath: launcher,
    iconPath: windowsPath(path.join(root, 'pdf-manager/assets/prism-pdf.ico')),
  }), 'utf8').toString('base64');
  const result = execFileSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', windowsPath(path.join(root, 'scripts/install-pdf-windows-shortcuts.ps1')),
    '-ConfigBase64', config,
  ], { encoding: 'utf8' });
  const shortcuts = JSON.parse(result.replace(/^\uFEFF/, '').trim());
  console.log(`Installed Windows desktop shortcut: ${shortcuts.desktop}`);
  console.log(`Installed Windows Start menu shortcut: ${shortcuts.startMenu}`);
}
