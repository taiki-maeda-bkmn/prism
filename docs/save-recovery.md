# Save recovery

The final external-change check and a filesystem rename cannot form a portable compare-and-swap operation. Save publication must preserve the displaced version and refuse to overwrite a newly created destination.

## Transaction

1. Prepare a private transaction in the note parent's `.prism-recovery/` directory. Flush a validated manifest and the draft before changing the note path.
2. Move the current note to `original.md` in that transaction. This captures the file present at publication, including a replacement that arrived after the earlier conflict check.
3. Compare the captured version with the expected snapshot. On a mismatch, restore it only if the note path is absent and report the conflict while retaining the draft.
4. Publish the draft with exclusive creation. If another writer has recreated the destination, preserve that destination and the captured original.
5. Flush a `complete` marker when publication or restoration is settled. Retain recovery files; do not prune them automatically.

The recovery directory stays beside the note so capture does not cross filesystem boundaries. Retaining the captured inode also preserves later writes through an already-open external file handle.

## File metadata

The draft begins as an independent copy of the original file, including its supported metadata. Updating its text does not change its access-control entries. Publication and restoration use the same metadata-preserving copy operation.

- Linux uses GNU `/bin/cp` to preserve ownership, permissions, ACLs, and extended attributes.
- macOS calls native `fcopyfile(COPYFILE_ALL)` through a fixed JavaScript for Automation script run by `/usr/bin/osascript`. It copies ownership, permissions, ACLs, extended attributes, Finder tags, and resource forks directly between inherited descriptors.
- Windows uses native copying for file attributes and alternate data streams, plus Windows PowerShell and handle-based security APIs to preserve owner, group, and discretionary ACLs, including inheritance protection.

POSIX destinations are claimed with exclusive creation before invoking the copier. The copier receives inherited file handles rather than notebook paths. The Windows security helper also operates on inherited handles. Replacing a pathname cannot redirect these metadata changes to another file.

Missing system helpers or insufficient permissions produce a save error. Failed copies are retained: another application may already have written into the same inode, so matching inode numbers alone do not justify deleting them. Original and draft copies remain available through the recovery transaction. Privileged audit ACLs are outside the metadata copied by the Windows helper.

## Loading after interruption

Inspect unfinished transactions and restore a captured original only when its validated destination is missing. Never replace an existing destination. Mark settled transactions complete so later deliberate deletion cannot resurrect a note from completed history. Recovery paths must remain inside the notebook and reject symlinks.

## Verification

- Inject an external edit immediately before capture; retain the external version and the unsaved draft.
- Create a competing destination after capture; preserve it without replacement.
- Write through an old open handle after a successful save; retain those bytes in recovery.
- Restart with an unfinished transaction and a missing note; restore the original.
- Restart with an unfinished transaction and an existing note; preserve the existing note.
- Delete a note after a completed save; do not restore it from completed history.
- Exercise exclusive-copy fallback, save failures, permissions, hard-link aliases, and the native save/draft flows.
- Verify actual Linux ACLs/xattrs, macOS ACLs/Finder metadata/resource forks, and Windows discretionary ACLs/alternate data streams on both live and retained files.

Recovery copies consume disk space and remain available for manual inspection. Automatic retention limits and a recovery browser are follow-up work.
