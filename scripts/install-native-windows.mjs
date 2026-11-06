import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const markerName = 'prism-native-install.json';
const launcherFiles = ['start-markdown.mjs', 'desktop-session.mjs', 'electron-launch.mjs', 'native-windows-launch.ps1'];

export function checksumForArtifact(manifest, filename) {
  const entries = manifest.split(/\r?\n/).flatMap(line => {
    const match = /^([a-f\d]{64})\s+\*?(.+)$/i.exec(line.trim());
    return match?.[2] === filename ? [match[1].toLowerCase()] : [];
  });
  if (entries.length !== 1) throw new Error(`Expected one official checksum for ${filename}.`);
  return entries[0];
}

export function validateDestination(value, platform = process.platform) {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Provide an absolute Windows destination with --destination.');
  if (platform === 'win32') {
    if (!/^[A-Za-z]:[\\/].+/.test(value)) throw new Error('Use a local Windows drive, not a network or WSL UNC folder.');
    const resolved = path.win32.resolve(value);
    if (resolved === path.win32.parse(resolved).root) throw new Error('Choose a dedicated PrismNative folder, not a drive root.');
    return resolved;
  }
  const resolved = path.posix.resolve(value);
  if (platform !== 'linux' || !path.posix.isAbsolute(value) || !/^\/mnt\/[a-z]\/.+/i.test(resolved)) {
    throw new Error('From WSL, --destination must be a dedicated folder on a Windows drive, such as /mnt/c/Users/me/AppData/Local/PrismNative.');
  }
  return resolved;
}

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function windowsPath(filename) {
  return process.platform === 'win32' ? filename : execFileSync('wslpath', ['-w', filename], { encoding: 'utf8' }).trim();
}

async function download(url, filename) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  let received = 0;
  const bounded = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      callback(received > 500 * 1024 * 1024 ? new Error('The Electron archive exceeds the download limit.') : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(filename, { flags: 'wx' }));
}

export async function stageNativeWindows({ destination, architecture = 'x64', archive } = {}) {
  destination = validateDestination(destination);
  if (!['x64', 'arm64'].includes(architecture)) throw new Error('Choose --architecture x64 or arm64.');
  const project = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
  const version = project.devDependencies.electron;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Electron must have an exact pinned version.');
  await Promise.all(['dist/main.cjs', 'dist/preload.cjs', 'dist/renderer/index.html', 'assets/prism.ico',
    ...launcherFiles.map(name => `scripts/${name}`), 'scripts/native-windows-activate.ps1'].map(name => access(path.join(repository, name))));

  const existing = await readdir(destination).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (existing.length) {
    const marker = JSON.parse(await readFile(path.join(destination, markerName), 'utf8').catch(() => {
      throw new Error('The destination is not an existing Prism native installation or an empty folder.');
    }));
    if (marker.application !== 'Prism' || marker.format !== 1) throw new Error('The destination has an unrecognized installation marker.');
  }
  await mkdir(destination, { recursive: true });
  if (!existing.length) await writeFile(path.join(destination, markerName), JSON.stringify({ application: 'Prism', format: 1 }) + '\n', { flag: 'wx' });

  const artifact = `electron-v${version}-win32-${architecture}.zip`;
  const baseURL = `https://github.com/electron/electron/releases/download/v${version}`;
  const manifestResponse = await fetch(`${baseURL}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) });
  if (!manifestResponse.ok) throw new Error(`Could not read official Electron checksums (${manifestResponse.status}).`);
  const checksums = await manifestResponse.text();
  if (checksums.length > 2 * 1024 * 1024) throw new Error('Unexpectedly large Electron checksum manifest.');
  const expected = checksumForArtifact(checksums, artifact);
  const cache = path.join(destination, 'cache');
  await mkdir(cache, { recursive: true });
  const archiveFile = archive ? path.resolve(archive) : path.join(cache, artifact);
  const cachedDigest = await digest(archiveFile).catch(error => {
    if (error.code === 'ENOENT' && !archive) return undefined;
    throw error;
  });
  if (cachedDigest && cachedDigest !== expected) throw new Error(`SHA256 mismatch for ${archiveFile}; the archive was not extracted.`);
  if (!cachedDigest) {
    const partial = path.join(cache, `.download-${randomBytes(8).toString('hex')}.zip`);
    try {
      console.error(`Downloading verified Windows Electron ${version} (${architecture})...`);
      await download(`${baseURL}/${artifact}`, partial);
      if (await digest(partial) !== expected) throw new Error('Downloaded Electron archive failed SHA256 verification.');
      await rename(partial, archiveFile);
    } finally {
      await rm(partial, { force: true });
    }
  }

  const id = `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`;
  const releases = path.join(destination, 'releases');
  const temporary = path.join(releases, `.staging-${id}`);
  const release = path.join(releases, id);
  await mkdir(temporary, { recursive: true });
  try {
    const runtime = path.join(temporary, 'node_modules', 'electron');
    await mkdir(path.join(runtime, 'dist'), { recursive: true });
    const { default: extract } = await import('@electron-internal/extract-zip');
    await extract(archiveFile, { dir: path.join(runtime, 'dist') });
    await access(path.join(runtime, 'dist', 'electron.exe'));
    await writeFile(path.join(runtime, 'path.txt'), 'electron.exe\n');
    await mkdir(path.join(temporary, 'scripts'));
    await cp(path.join(repository, 'dist'), path.join(temporary, 'dist'), { recursive: true });
    await cp(path.join(repository, 'assets', 'prism.ico'), path.join(temporary, 'prism.ico'));
    for (const name of launcherFiles) await cp(path.join(repository, 'scripts', name), path.join(temporary, 'scripts', name));
    await writeFile(path.join(temporary, 'package.json'), JSON.stringify({
      name: project.name, productName: 'Prism', version: project.version, private: true,
      description: project.description, type: 'module', main: 'dist/main.cjs',
    }, null, 2) + '\n');
    let sourceCommit = null;
    try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { /* A source archive can also be staged. */ }
    await writeFile(path.join(temporary, 'release.json'), JSON.stringify({
      application: 'Prism', format: 1, id, platform: 'win32', architecture, electron: version,
      archiveSHA256: expected, sourceCommit, builtAt: new Date().toISOString(),
      mainSHA256: await digest(path.join(temporary, 'dist', 'main.cjs')),
    }, null, 2) + '\n');
    // Only a complete release becomes selectable. Staging never changes the
    // active release, shortcuts, notebook, recovery drafts, or PDF catalogue.
    await rename(temporary, release);
    await cp(path.join(repository, 'scripts', 'native-windows-activate.ps1'), path.join(destination, 'activate.ps1'));
    return {
      destination, release, releaseId: id, windowsRelease: windowsPath(release),
      windowsLauncher: windowsPath(path.join(release, 'scripts', 'native-windows-launch.ps1')),
      windowsActivator: windowsPath(path.join(destination, 'activate.ps1')),
      archiveSHA256: expected, activated: false,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run stage:windows -- --destination <Windows folder, or /mnt/c/... from WSL> [--architecture x64|arm64] [--archive <official Electron ZIP>]\nBuild first with npm run build. This command stages only; it never launches Prism, installs shortcuts, or moves user data.');
  } else {
    try {
      const options = {};
      for (let i = 0; i < args.length; i += 2) {
        if (!['--destination', '--architecture', '--archive'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${args[i]}`);
        const key = args[i].slice(2);
        if (Object.hasOwn(options, key)) throw new Error(`Repeated option: ${args[i]}`);
        options[key] = args[i + 1];
      }
      console.log(JSON.stringify(await stageNativeWindows(options), null, 2));
    } catch (error) {
      console.error(`Prism native staging failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
