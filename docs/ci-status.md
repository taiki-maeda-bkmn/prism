# GitHub Actions audit — 2026-11-06

Prism supports Windows and Linux. Both `.github/workflows/ci.yml` and
`.github/workflows/pdf.yml` now schedule build/unit checks only on
`ubuntu-latest` and `windows-latest`. Their separate Linux desktop journeys
remain enabled. This removes two macOS jobs per workflow-triggering event;
application code and the installed native Windows release are unchanged.

## Results inspected

These are the completed runs before the macOS removal, not results for this
configuration change. The user explicitly requested this CI audit.

| Revision | Workflow | Linux build/unit | Windows build/unit | macOS build/unit | Linux desktop |
| --- | --- | --- | --- | --- | --- |
| `826f77d` (PR #56) | [Checks](https://github.com/taiki-maeda-bkmn/prism/actions/runs/42223857740) | Pass | Fail | Pass | Fail |
| `826f77d` (PR #56) | [PDF manager checks](https://github.com/taiki-maeda-bkmn/prism/actions/runs/42223857853) | Pass | Fail | Fail | Pass |
| `9e5a50d` (`main`) | [Checks](https://github.com/taiki-maeda-bkmn/prism/actions/runs/42219821694) | Pass | Pass | Pass | Fail |
| `9e5a50d` (`main`) | [PDF manager checks](https://github.com/taiki-maeda-bkmn/prism/actions/runs/42219821658) | Pass | Fail | Fail | Pass |

Removing macOS does not resolve the supported-platform failures below.

## Follow-up work

1. **Build the standalone PDF app before the integrated desktop suite.**
   The [Linux desktop job](https://github.com/taiki-maeda-bkmn/prism/actions/runs/42223857740/job/127912258095)
   fails in the standalone session-lifecycle journey because
   `pdf-manager/dist/main.cjs` is missing. The script runs `test:e2e`, which builds
   only the main app. Ensure the standalone build exists on a clean runner before
   launching that journey. The same failure appears on `main`.
2. **Compare canonical paths in the PDF preservation test.**
   The [Windows PDF job](https://github.com/taiki-maeda-bkmn/prism/actions/runs/42223857853/job/127912258981)
   fails in `existing catalog bytes, document IDs, metadata and managed PDFs
   survive opening without migration`. The store returns the real path containing
   `runneradmin`, while the fixture expects its equivalent `RUNNER~1` alias.
   Normalize the expected path while preserving the byte, ID, and metadata
   assertions. This also fails on `main`. The removed macOS job has the equivalent
   `/private/var` versus `/var` mismatch.
3. **Investigate the long-line snippet parse budget.**
   The [Windows main job](https://github.com/taiki-maeda-bkmn/prism/actions/runs/42223857740/job/127912258502)
   returns no completion for the 100,000-character fixture in
   `prose boundaries stay responsive after a long run of text`. It fails the
   completion assertion, not the 1.5-second responsiveness assertion. The
   implementation and test are unchanged from the passing `main` run. The
   50 ms `ensureSyntaxTree` budget is a suspected cause, not a confirmed diagnosis;
   reproduce it before choosing a fix, retaining the responsiveness requirement.
4. **Stabilize desktop assertions during saves and font inspection.**
   The inspected PR #56 Linux run passed four journeys only after retrying
   transient `ENOENT` reads during save publication. The inspected `main` run also
   failed font inspection because its CDP node ID was stale. Wait for completed
   saves and acquire a current node when inspecting fonts, retaining exact-byte
   and actual-glyph assertions.

These follow-ups remain open. No failed supported-platform check was removed or
allowed to fail silently as part of the macOS cleanup.
