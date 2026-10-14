# Save recovery

The final external-change check and a filesystem rename cannot form a portable compare-and-swap operation. Save publication must preserve the displaced version and refuse to overwrite a newly created destination.

## Transaction

1. Prepare a private transaction in the note parent's `.prism-recovery/` directory. Flush a validated manifest and the draft before changing the note path.
2. Move the current note to `original.md` in that transaction. This captures the file present at publication, including a replacement that arrived after the earlier conflict check.
3. Compare the captured version with the expected snapshot. On a mismatch, restore it only if the note path is absent and report the conflict while retaining the draft.
4. Publish the draft with exclusive creation. If another writer has recreated the destination, preserve that destination and the captured original.
5. Flush a `complete` marker when publication or restoration is settled. Retain recovery files; do not prune them automatically.

The recovery directory stays beside the note so capture does not cross filesystem boundaries. Retaining the captured inode also preserves later writes through an already-open external file handle.

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

Recovery copies consume disk space and remain available for manual inspection. Automatic retention limits and a recovery browser are follow-up work.
