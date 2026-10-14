import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { MAX_NOTE_BYTES, WorkspaceStore } from '../src/main/workspace';
import { RECOVERY_DIRECTORY } from '../src/main/recovery';
import { copyFileWithMetadata, createMetadataCopier } from '../src/main/metadata';

const run = promisify(execFile);
const oldContent = '# Original\n\nBefore the edit.\n';
const newContent = '# Saved\n\nA separate new version.\n';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-metadata-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'Note.md');
  await fs.writeFile(target, oldContent);
  return { root, target };
}

async function assertPreservedSave<T>(root: string, target: string, readMetadata: (file: string) => Promise<T>) {
  const expected = await readMetadata(target);
  // Use the real platform copy implementation, including its metadata handling.
  const store = await WorkspaceStore.open(root);
  const loaded = await store.load();
  assert.deepEqual(loaded.warnings, []);
  const original = loaded.notes.find(note => note.path === 'Note.md');
  assert.ok(original);
  const saved = await store.save(original.path, newContent, original.modified);
  assert.equal(saved.content, newContent);

  const transactions = await fs.readdir(path.join(root, RECOVERY_DIRECTORY));
  assert.equal(transactions.length, 1);
  const recovery = path.join(root, RECOVERY_DIRECTORY, transactions[0]);
  const retainedOriginal = path.join(recovery, 'original.md');
  const retainedDraft = path.join(recovery, 'draft.md');
  assert.equal(await fs.readFile(path.join(recovery, 'complete'), 'utf8'), '1\n');
  for (const file of [target, retainedOriginal, retainedDraft]) {
    assert.deepEqual(await readMetadata(file), expected, `Metadata changed on ${path.relative(root, file)}`);
  }
  assert.equal(await fs.readFile(target, 'utf8'), newContent);
  assert.equal(await fs.readFile(retainedOriginal, 'utf8'), oldContent);
  assert.equal(await fs.readFile(retainedDraft, 'utf8'), newContent);

  // Metadata preservation must not alias the live note and recovery contents.
  await fs.writeFile(target, 'A later live edit.');
  assert.equal(await fs.readFile(retainedOriginal, 'utf8'), oldContent);
  assert.equal(await fs.readFile(retainedDraft, 'utf8'), newContent);
  await fs.writeFile(retainedOriginal, 'A later write through the original file.');
  assert.equal(await fs.readFile(target, 'utf8'), 'A later live edit.');
  assert.equal(await fs.readFile(retainedDraft, 'utf8'), newContent);
}

async function seedLinuxMetadata(target: string) {
  // The Linux UAPI representation uses a version header and little-endian
  // (tag, permissions, id) entries. The named current UID also works inside
  // restricted user namespaces where other numeric UIDs are unmapped.
  await run('python3', ['-c', `
import os, struct, sys
target = sys.argv[1]
os.setxattr(target, 'user.prism.metadata', b'Prism\\x00metadata\\xff\\n')
entries = [(1, 6, 0xffffffff), (2, 4, os.getuid()), (4, 0, 0xffffffff), (16, 4, 0xffffffff), (32, 0, 0xffffffff)]
acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in entries)
os.setxattr(target, 'system.posix_acl_access', acl)
`, target]);
}

async function readLinuxMetadata(file: string) {
  const { stdout } = await run('python3', ['-c', `
import base64, json, os, sys
names = ['user.prism.metadata', 'system.posix_acl_access']
print(json.dumps({name: base64.b64encode(os.getxattr(sys.argv[1], name)).decode('ascii') for name in names}))
`, file]);
  return { attributes: JSON.parse(stdout) as Record<string, string>, mode: (await fs.stat(file)).mode & 0o777 };
}

test('Linux saves retain binary user xattrs and a custom POSIX access ACL on live and recovery files', { skip: process.platform !== 'linux' }, async (t) => {
  const { root, target } = await fixture(t);
  await seedLinuxMetadata(target);
  await assertPreservedSave(root, target, readLinuxMetadata);
});

test('reopening after interrupted publication restores Linux metadata and keeps the independent draft', { skip: process.platform !== 'linux' }, async (t) => {
  const { root, target } = await fixture(t);
  await seedLinuxMetadata(target);
  const expected = await readLinuxMetadata(target);
  const store = await WorkspaceStore.open(root, {
    ...fs,
    copyFile: async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); },
  });
  const [original] = (await store.load()).notes;
  // Draft preparation uses production metadata copying. Publication and the
  // immediate restoration fail, leaving the journal for the next application.
  await assert.rejects(store.save(original.path, newContent, original.modified), /Automatic restoration could not finish/);
  await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
  const transactions = await fs.readdir(path.join(root, RECOVERY_DIRECTORY));
  assert.equal(transactions.length, 1);
  const recovery = path.join(root, RECOVERY_DIRECTORY, transactions[0]);
  const retainedOriginal = path.join(recovery, 'original.md');
  const retainedDraft = path.join(recovery, 'draft.md');
  await assert.rejects(fs.lstat(path.join(recovery, 'complete')), { code: 'ENOENT' });

  const reopened = await WorkspaceStore.open(root);
  const loaded = await reopened.load();
  assert.equal(loaded.notes.find(note => note.path === original.path)?.content, oldContent);
  assert.ok(loaded.warnings.some(warning => warning.includes('Recovered Note.md.')));
  for (const file of [target, retainedOriginal, retainedDraft]) assert.deepEqual(await readLinuxMetadata(file), expected);
  assert.equal(await fs.readFile(target, 'utf8'), oldContent);
  assert.equal(await fs.readFile(retainedOriginal, 'utf8'), oldContent);
  assert.equal(await fs.readFile(retainedDraft, 'utf8'), newContent);
  await fs.writeFile(target, 'An edit after recovery.');
  assert.equal(await fs.readFile(retainedOriginal, 'utf8'), oldContent);
  assert.equal(await fs.readFile(retainedDraft, 'utf8'), newContent);
});

async function writeMacAttribute(file: string, name: string, value: Buffer) {
  await run('/usr/bin/xattr', ['-wx', name, value.toString('hex'), file]);
}

async function readMacAttributes(file: string, names: string[]) {
  const result: Record<string, string> = {};
  for (const name of names) {
    const { stdout } = await run('/usr/bin/xattr', ['-px', name, file]);
    result[name] = stdout.replace(/\s/g, '').toLowerCase();
  }
  return result;
}

test('macOS saves retain Finder tags and binary extended attributes on live and recovery files', { skip: process.platform !== 'darwin' }, async (t) => {
  const { root, target } = await fixture(t);
  const plist = path.join(root, 'tags.plist');
  await fs.writeFile(plist, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>Prism\n2</string><string>Review\n4</string></array></plist>');
  await run('/usr/bin/plutil', ['-convert', 'binary1', plist]);
  const names = ['com.prism.integration-test', 'com.apple.metadata:_kMDItemUserTags'];
  await writeMacAttribute(target, names[0], Buffer.from([0, 255, 10, 80, 114, 105, 115, 109]));
  await writeMacAttribute(target, names[1], await fs.readFile(plist));
  await assertPreservedSave(root, target, file => readMacAttributes(file, names));
});

test('macOS saves retain the resource fork on live and recovery files', { skip: process.platform !== 'darwin' }, async (t) => {
  const { root, target } = await fixture(t);
  const name = 'com.apple.ResourceFork';
  try {
    await writeMacAttribute(target, name, Buffer.from('Prism resource fork\0\u00ff', 'utf8'));
  } catch (error) {
    if (/operation not supported|not supported on this filesystem/i.test(String((error as { stderr?: string }).stderr))) {
      t.skip('The temporary filesystem does not support resource forks.');
      return;
    }
    throw error;
  }
  await assertPreservedSave(root, target, file => readMacAttributes(file, [name]));
});

async function powershell(script: string, file: string) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${script}`], {
    env: { ...process.env, PRISM_METADATA_TARGET: file },
    windowsHide: true,
  });
  return stdout.trim();
}

test('Windows saves retain a protected custom DACL and alternate data stream on live and recovery files', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, target } = await fixture(t);
  const alternateStream = Buffer.from([0, 255, 10, 80, 114, 105, 115, 109]);
  await fs.writeFile(`${target}:PrismTest`, alternateStream);
  await powershell(`
$target = $env:PRISM_METADATA_TARGET
$acl = Get-Acl -LiteralPath $target
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($currentUser, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow))
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow))
Set-Acl -LiteralPath $target -AclObject $acl
`, target);
  const readMetadata = async (file: string) => ({ ...JSON.parse(await powershell(`
$acl = Get-Acl -LiteralPath $env:PRISM_METADATA_TARGET
@{ sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access); protected = $acl.AreAccessRulesProtected } | ConvertTo-Json -Compress
`, file)) as { sddl: string; protected: boolean }, alternateStream: (await fs.readFile(`${file}:PrismTest`)).toString('base64') });
  const initial = await readMetadata(target);
  assert.equal(initial.protected, true);
  assert.match(initial.sddl, /\(A;[^)]*;;;WD\)/, 'The fixture must have a distinct explicit Everyone rule.');
  assert.equal(initial.alternateStream, alternateStream.toString('base64'));
  await assertPreservedSave(root, target, readMetadata);
});

test('metadata copies never overwrite an existing file or follow an existing destination symlink', async (t) => {
  const { root, target: source } = await fixture(t);
  const existing = path.join(root, 'Existing.md');
  await fs.writeFile(existing, 'Another application owns this destination.');
  await assert.rejects(copyFileWithMetadata(source, existing, constants.COPYFILE_EXCL), { code: 'EEXIST' });
  assert.equal(await fs.readFile(existing, 'utf8'), 'Another application owns this destination.');
  assert.equal(await fs.readFile(source, 'utf8'), oldContent);
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'Alias.md');
    await fs.symlink(existing, alias);
    await assert.rejects(copyFileWithMetadata(source, alias, constants.COPYFILE_EXCL), { code: 'EEXIST' });
    assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(existing, 'utf8'), 'Another application owns this destination.');
  }
});

test('a failed POSIX metadata copy retains external edits to the claimed destination', { skip: process.platform === 'win32' }, async (t) => {
  const { root, target: source } = await fixture(t);
  const target = path.join(root, 'Claimed.md');
  const copy = createMetadataCopier(async () => {
    // A different process can edit even the exact inode our copier created.
    await fs.writeFile(target, 'External edit while metadata copying failed.');
    throw new Error('Metadata preservation failed.');
  });
  await assert.rejects(copy(source, target, constants.COPYFILE_EXCL), /Metadata preservation failed/);
  assert.equal(await fs.readFile(target, 'utf8'), 'External edit while metadata copying failed.');
  assert.equal(await fs.readFile(source, 'utf8'), oldContent);
});

test('oversized metadata-copy sources are refused before creating a destination', async (t) => {
  const { root, target: source } = await fixture(t);
  const target = path.join(root, 'Too-large-copy.md');
  await fs.truncate(source, MAX_NOTE_BYTES + 1);
  await assert.rejects(copyFileWithMetadata(source, target, constants.COPYFILE_EXCL), /larger than 2 MB/);
  assert.equal((await fs.stat(source)).size, MAX_NOTE_BYTES + 1);
  await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
});
