param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^Prism placement [a-f0-9]{32}$')]
  [string]$Title,
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [ValidateLength(1, 128)]
  [string]$Distribution,
  [ValidateRange(-1000000, 1000000)]
  [Nullable[int]]$RestoreX,
  [ValidateRange(-1000000, 1000000)]
  [Nullable[int]]$RestoreY
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# This process handles only the exact nonce-bearing host window. There is no
# foreground-window fallback, keyboard injection, screenshot, or focus change.
Add-Type @'
using System;
using System.Collections.Concurrent;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class PrismPlacement {
  private static readonly ConcurrentQueue<string> input = new ConcurrentQueue<string>();
  private static volatile bool inputClosed;
  private static volatile bool stopRequested;
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int size; public Rect monitor, work; public uint flags; }
  [StructLayout(LayoutKind.Sequential)] public struct GuiThreadInfo {
    public int size; public uint flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public Rect caretRect;
  }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetProp(IntPtr window, string name, IntPtr value);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr window, string name);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr RemoveProp(IntPtr window, string name);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref Rect rectangle, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

  public static void StartInput() {
    // Console.In is a synchronized TextReader on Windows PowerShell's .NET
    // Framework; its ReadLineAsync can block synchronously. Keep the blocking
    // read on one background thread while the main thread observes the HWND.
    var thread = new Thread(() => {
      try {
        string line;
        while ((line = Console.In.ReadLine()) != null) {
          if (line == "stop") { stopRequested = true; break; }
          if (line == "snapshot" && input.Count < 4) input.Enqueue(line);
        }
      } catch { }
      finally { inputClosed = true; }
    });
    thread.IsBackground = true;
    thread.Start();
  }
  public static string TakeCommand() {
    if (stopRequested) return "stop";
    string line;
    if (input.TryDequeue(out line)) return line;
    return inputClosed ? "stop" : null;
  }

  public static uint ProcessId(IntPtr window) {
    uint process; return GetWindowThreadProcessId(window, out process) == 0 ? 0 : process;
  }
  public static string ClassName(IntPtr window) {
    var name = new StringBuilder(256);
    return GetClassName(window, name, name.Capacity) == 0 ? "" : name.ToString();
  }
  public static bool Owned(IntPtr window, uint process, string className, string property) {
    return IsWindow(window) && ProcessId(window) == process && ClassName(window) == className && GetProp(window, property) == new IntPtr(1);
  }
  public static bool IsInteractiveMoveSize(IntPtr window) {
    uint process;
    uint thread = GetWindowThreadProcessId(window, out process);
    var info = new GuiThreadInfo();
    info.size = Marshal.SizeOf(typeof(GuiThreadInfo));
    // Query the owned window's GUI thread, never the global foreground thread.
    return thread != 0 && GetGUIThreadInfo(thread, ref info) && (info.flags & 2) != 0 && info.moveSize == window;
  }
  public static bool RestorePosition(IntPtr window, int x, int y, out int targetX, out int targetY) {
    targetX = x; targetY = y;
    Rect current;
    if (!GetWindowRect(window, out current)) return false;
    int width = current.right - current.left, height = current.bottom - current.top;
    if (width < 100 || height < 100 || width > 50000 || height > 50000) return false;
    var desired = new Rect { left = x, top = y, right = x + width, bottom = y + height };
    var monitor = new MonitorInfo();
    monitor.size = Marshal.SizeOf(typeof(MonitorInfo));
    if (!GetMonitorInfo(MonitorFromRect(ref desired, 2), ref monitor)) return false;
    targetX = Math.Max(monitor.work.left, Math.Min(x, monitor.work.right - width));
    targetY = Math.Max(monitor.work.top, Math.Min(y, monitor.work.bottom - height));
    if (current.left == targetX && current.top == targetY) return true;
    // NOSIZE | NOZORDER | NOACTIVATE | ASYNCWINDOWPOS. Native Electron owns
    // the surface dimensions and state; do not resize or activate the host.
    return SetWindowPos(window, IntPtr.Zero, targetX, targetY, 0, 0, 0x4015);
  }
}
'@

$window = [IntPtr]::Zero
$ownerProcess = [uint32]0
$ownerClass = ''
$property = 'Prism.Placement.' + $Title.Substring('Prism placement '.Length)
$lastNormal = $null
$lastEmitted = ''
$previousDpi = [PrismPlacement]::SetThreadDpiAwarenessContext([IntPtr](-4))
[PrismPlacement]::StartInput()

function Read-NormalBounds {
  if (-not [PrismPlacement]::Owned($window, $ownerProcess, $ownerClass, $property)) { return $null }
  if ([PrismPlacement]::IsIconic($window) -or [PrismPlacement]::IsZoomed($window)) { return $null }
  $rectangle = [PrismPlacement+Rect]::new()
  if (-not [PrismPlacement]::GetWindowRect($window, [ref]$rectangle)) { return $null }
  $width = $rectangle.right - $rectangle.left
  $height = $rectangle.bottom - $rectangle.top
  if ($width -lt 100 -or $height -lt 100 -or $width -gt 50000 -or $height -gt 50000 -or
      [Math]::Abs([long]$rectangle.left) -gt 1000000 -or [Math]::Abs([long]$rectangle.top) -gt 1000000) { return $null }
  return [ordered]@{ x = $rectangle.left; y = $rectangle.top; width = $width; height = $height }
}
function Send-Placement([string]$type, $normal) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject ([ordered]@{ type = $type; normal = $normal }) -Compress -Depth 3))
  [Console]::Out.Flush()
}
function Test-KnownOrigin($bounds, $origins) {
  if ($null -eq $bounds) { return $false }
  foreach ($origin in $origins) {
    if ([Math]::Abs($bounds.x - $origin.x) -le 2 -and [Math]::Abs($bounds.y - $origin.y) -le 2) { return $true }
  }
  return $false
}

try {
  $discovery = [System.Diagnostics.Stopwatch]::StartNew()
  while ($window -eq [IntPtr]::Zero -and $discovery.ElapsedMilliseconds -lt 6000) {
    if ([PrismPlacement]::TakeCommand() -eq 'stop') { return }
    $matches = [System.Collections.Generic.List[IntPtr]]::new()
    [void][PrismPlacement]::EnumWindows({ param($candidate, $parameter)
      $name = [System.Text.StringBuilder]::new(512)
      [void][PrismPlacement]::GetWindowText($candidate, $name, 512)
      if (($name.ToString() -ceq $Title -or $name.ToString() -ceq "$Title ($Distribution)") -and [PrismPlacement]::IsWindowVisible($candidate)) {
        $matches.Add($candidate)
      }
      return $true
    }, [IntPtr]::Zero)
    if ($matches.Count -gt 1) { return }
    if ($matches.Count -eq 1) { $window = $matches[0]; break }
    [System.Threading.Thread]::Sleep(100)
  }
  if ($window -eq [IntPtr]::Zero) { return }
  $ownerProcess = [PrismPlacement]::ProcessId($window)
  $ownerClass = [PrismPlacement]::ClassName($window)
  if ($ownerProcess -eq 0 -or -not $ownerClass -or -not [PrismPlacement]::SetProp($window, $property, [IntPtr](1))) { return }
  if ($PSBoundParameters.ContainsKey('RestoreX') -ne $PSBoundParameters.ContainsKey('RestoreY')) { return }
  # Weston can retain this mapping origin even after a Windows-only move.
  # Remember it before restoring the saved placement so later repair is scoped
  # to that known stale origin, rather than every move shortly after restore.
  $compositorOrigin = Read-NormalBounds
  if ($PSBoundParameters.ContainsKey('RestoreX') -and -not [PrismPlacement]::IsZoomed($window) -and -not [PrismPlacement]::IsIconic($window)) {
    $targetX = 0; $targetY = 0
    if (-not [PrismPlacement]::Owned($window, $ownerProcess, $ownerClass, $property) -or
        -not [PrismPlacement]::RestorePosition($window, $RestoreX, $RestoreY, [ref]$targetX, [ref]$targetY)) { return }
    $moving = [System.Diagnostics.Stopwatch]::StartNew()
    do {
      $current = Read-NormalBounds
      if ($null -ne $current -and [Math]::Abs($current.x - $targetX) -le 2 -and [Math]::Abs($current.y - $targetY) -le 2) { break }
      if ($moving.ElapsedMilliseconds -ge 1500) { return }
      [System.Threading.Thread]::Sleep(50)
    } while ($true)
  }
  $lastNormal = Read-NormalBounds
  Send-Placement 'ready' $lastNormal
  $candidateKey = ''
  $wasNonNormal = [PrismPlacement]::IsIconic($window) -or [PrismPlacement]::IsZoomed($window)
  $repairTarget = $null
  $repairTimer = $null
  $repairStableKey = ''
  $repairStableSince = 0
  $repairOrigins = [System.Collections.Generic.List[object]]::new()
  while ([PrismPlacement]::Owned($window, $ownerProcess, $ownerClass, $property)) {
    $nonNormal = [PrismPlacement]::IsIconic($window) -or [PrismPlacement]::IsZoomed($window)
    $current = Read-NormalBounds
    if ($nonNormal) {
      $repairTarget = $null
    } elseif ($wasNonNormal -and $null -ne $lastNormal) {
      # Moving the Windows host at startup does not update Weston's internal
      # normal origin. An Electron restore can therefore snap the host back to
      # its original mapping position. Repair that transition before recording
      # it as a user move, without touching the native surface size or state.
      $repairTarget = [ordered]@{ x = $lastNormal.x; y = $lastNormal.y }
      $repairTimer = [System.Diagnostics.Stopwatch]::StartNew()
      $repairStableKey = ''
      $repairOrigins.Clear()
      $repairOrigins.Add($repairTarget)
      if ($null -ne $compositorOrigin) { $repairOrigins.Add($compositorOrigin) }
    }
    $wasNonNormal = $nonNormal
    if ($null -ne $repairTarget -and [PrismPlacement]::IsInteractiveMoveSize($window)) {
      # Dragging a maximized window down is an intentional new placement.
      $repairTarget = $null
      $candidateKey = ''
    }
    if ($null -ne $repairTarget -and $null -ne $current) {
      if (-not (Test-KnownOrigin $current $repairOrigins)) {
        # Keyboard snap and other non-modal placement do not set GUI_INMOVESIZE.
        # A third origin is an intentional new placement; it wins immediately.
        $repairTarget = $null
        $candidateKey = ''
      } elseif ($repairTimer.ElapsedMilliseconds -ge 2200) {
        # A failed host operation must not turn into an endless positioning
        # loop. Keep the last valid placement for this snapshot and continue.
        $repairTarget = $null
        $current = $null
      } else {
        $targetX = 0; $targetY = 0
        if ([PrismPlacement]::RestorePosition($window, $repairTarget.x, $repairTarget.y, [ref]$targetX, [ref]$targetY)) {
          # Work-area clamping can change as native dimensions settle. Only
          # origins actually requested by this bridge join the allowed set.
          $issuedOrigin = [ordered]@{ x = $targetX; y = $targetY }
          if (-not (Test-KnownOrigin $issuedOrigin $repairOrigins)) { $repairOrigins.Add($issuedOrigin) }
          $current = Read-NormalBounds
          if ($null -ne $current -and -not (Test-KnownOrigin $current $repairOrigins)) {
            $repairTarget = $null
            $candidateKey = ''
          } elseif ($null -ne $current -and [Math]::Abs($current.x - $targetX) -le 2 -and [Math]::Abs($current.y - $targetY) -le 2) {
            $key = ConvertTo-Json -InputObject $current -Compress
            if ($key -ne $repairStableKey) {
              $repairStableKey = $key
              $repairStableSince = $repairTimer.ElapsedMilliseconds
            } elseif ($repairTimer.ElapsedMilliseconds - $repairStableSince -ge 600) {
              # Include native dimensions in settling: the compositor may send
              # another normal-size configure after its host state changes.
              $repairTarget = $null
            }
          } else { $repairStableKey = '' }
        }
      }
    }
    if ($null -ne $current -and $null -eq $repairTarget) {
      $key = ConvertTo-Json -InputObject $current -Compress
      # Two stable normal samples avoid capturing resize/maximize transition
      # geometry as the normal position. Minimized/maximized states retain it.
      if ($key -eq $candidateKey -and $key -ne $lastEmitted) {
        $lastNormal = $current
        $lastEmitted = $key
        Send-Placement 'placement' $lastNormal
      }
      $candidateKey = $key
    } else { $candidateKey = '' }
    $line = [PrismPlacement]::TakeCommand()
    if ($null -ne $line) {
      if ($line -eq 'snapshot' -or $line -eq 'stop') {
        if ($null -ne $current -and $null -eq $repairTarget) { $lastNormal = $current }
        Send-Placement 'snapshot' $lastNormal
      }
      if ($line -eq 'stop') { break }
    }
    [System.Threading.Thread]::Sleep(150)
  }
} finally {
  if ($window -ne [IntPtr]::Zero -and [PrismPlacement]::Owned($window, $ownerProcess, $ownerClass, $property)) {
    [void][PrismPlacement]::RemoveProp($window, $property)
  }
  if ($previousDpi -ne [IntPtr]::Zero) { [void][PrismPlacement]::SetThreadDpiAwarenessContext($previousDpi) }
}
