# Pin notebook directories during filesystem operations

Status: **open P2; not implemented**. Tracking [Codex review finding](https://github.com/beautysamurai/prism/pull/2#discussion_r4271421512).

## Problem and current behavior

Prism validates relative note paths, rejects detected symbolic links, checks the notebook root identity, and checks for file replacements and conflicting edits. These checks protect ordinary operations on a stable directory tree. They do not make the notebook a filesystem sandbox against concurrent directory replacement.

For example, another process can rename `Ideas` after its validation and replace the old name with a symlink or junction to another directory. A subsequent path-based create, rename, copy, or cleanup can resolve through the replacement. Post-operation validation can detect the change but cannot undo side effects outside the notebook. This requires another local process changing the directory tree; renderer path traversal alone does not trigger it.

The existing conflict and recovery tests do not establish safety against this race. This review thread must remain open until the implementation and native race tests below pass. The pull request remains unmerged.

## Implementation breakdown

1. **Add deterministic reproductions.** Replace a nested parent immediately after validation for read, nested creation, save capture/publication, and interrupted-save recovery. Verify that outside sentinel files are neither returned to the renderer nor changed, created, or deleted. Include cleanup after failure, two nested levels, and replacement of a recovery directory. Use symlinks on Linux/macOS and junctions on Windows.
2. **Introduce a directory-handle filesystem interface.** Represent the selected root and each verified child directory with owned handles. Operations take a parent handle and a single validated basename, rather than reopening an absolute parent pathname. Cover listing, opening, exclusive creation, directory creation, capture/rename, copying, restoration, and unlink/cleanup. Keep metadata copying on checked file handles and retain current conflict/recovery guarantees.
3. **Implement and prove each platform backend.** Linux can use directory-relative POSIX APIs or held descriptors through `/proc/self/fd`. macOS needs directory-relative native operations; `/dev/fd/<number>/child` is not a usable equivalent. Windows needs handle-relative native access or directory handles that prevent ancestor replacement while an operation runs. Prototype a small native helper or stable-ABI addon before selecting the build/distribution approach. Failure to obtain a safe handle must abort the operation, without a pathname-based fallback.
4. **Wire the whole filesystem layer.** Update workspace scanning, reads, creation, saves, recovery loading, metadata source acquisition, and temporary-file cleanup together. Pin recovery directories as well as note parents. Keep the UI and IPC contract unchanged, close handles on every exit, and avoid changing Electron's global working directory.
5. **Validate and close the finding.** Run deterministic races and the existing conflict/metadata suites on Linux, macOS, and Windows. Run all desktop journeys. Document build/runtime requirements and any filesystem restrictions, then request review of the implementation commit and resolve the original thread only after verification.

## Acceptance criteria

- Replacing any checked ancestor cannot redirect an operation to the replacement directory.
- A changed directory either leaves the operation attached to its verified original directory or causes an error before unintended side effects.
- Outside files remain unchanged after both successful operations and failed-operation cleanup.
- Existing exclusive publication, retained recovery copies, metadata preservation, and draft protection continue to pass.
- Unsupported backends or filesystem capabilities produce an explicit error rather than weakening the boundary.

This is a filesystem-layer change, not an additional `realpath` check in `safeParent`. Rechecking a name before a later pathname operation leaves the same check/use gap.
