# Import a PDF from a URL

## Scope

Add **Import from URL** to the shared PDF library in Prism and Prism PDF. Paste
a public HTTPS link that returns a PDF, follow ordinary redirects, and save the
document into the existing managed library. Show progress and allow cancellation
while downloading. Reuse identical content without replacing titles, tags,
favorites, document links, or reading positions.

Arbitrary webpage extraction, browser cookies/login sessions, batch downloads,
browser extensions, and AI services are separate requirements. A website's
**Download PDF** link is the intended input. Private-network links are unsupported.

## Implementation steps

1. Main-process downloader: bounded public HTTPS requests, validated and pinned
   DNS destinations on every redirect, TLS verification, time/size limits,
   cancellation, progress, PDF validation, and safe filenames.
2. Shared library writer and one active import job: verify library ownership
   before downloading, keep partial bytes in memory, and use the existing atomic
   catalogue/file publication and content deduplication.
3. Narrow IPC and shared dialog: no renderer networking, resumable progress after
   renderer reload, clear errors and duplicate results, and explicit **Open PDF**.
4. Shutdown and verification: cancelled note-close prompts retain downloads;
   accepted closes abort downloads and drain accepted saves before releasing the
   library. Test with disposable profiles, then request review on an unmerged PR.

## Limits and behavior

- A download is limited to 100 MiB; URLs and redirect chains are bounded.
- Login pages, HTML responses, invalid PDFs, timeouts, and unavailable sites show
  a retryable error. Importing does not use the browser's authentication session.
- **Cancel** stops a download before the library changes. The brief final
  **Adding to library** stage completes its atomic save before the app closes.
- A successful download stays available offline in the normal PDF storage.
  Source websites and original local files are not modified.
- Existing arXiv and Rates & Execution discovery retain their dedicated imports.

## Verification

Both builds/typechecks pass, with 355 main unit passes (five platform skips) and
98 PDF unit passes. The PDF suite includes 32 new transport/storage/job cases.
Twenty-three integrated desktop journeys and all seven standalone journeys pass,
including five new URL-import journeys covering redirects, progress with/without
Content-Length, cancellation and retry, HTML/login/private-address/size errors,
duplicate metadata, draft/undo retention, renderer reload, dirty-close decisions,
offline restart, and 420-pixel dialogs at 150% text size in all three themes.
Native checks use isolated profiles and libraries. A real HTTPS download of W3C's
public `dummy.pdf` also succeeds through the production downloader.

Transport deliberately avoids browser credentials and system proxy inheritance.
It selects one verified address per request; automatic fallback across addresses
and authenticated/proxy downloads remain outside this increment. IPv6 public
allocation ranges should be refreshed when IANA allocates new ranges.
