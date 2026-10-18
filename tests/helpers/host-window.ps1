param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^Prism host geometry [a-f0-9]{32}$')]
  [string]$Title,
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [ValidateLength(1, 128)]
  [string]$Distribution,
  [ValidateSet('sample', 'observe', 'restore')]
  [string]$Action = 'sample'
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PrismHostWindow {
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int cbSize; public Rect monitor, work; public uint flags; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);
}
'@
[void][PrismHostWindow]::SetProcessDpiAwarenessContext([IntPtr](-4))
$matches = [System.Collections.Generic.List[IntPtr]]::new()
[void][PrismHostWindow]::EnumWindows({ param($window, $parameter)
  $name = [System.Text.StringBuilder]::new(512)
  [void][PrismHostWindow]::GetWindowText($window, $name, 512)
  # WSLg adds its distribution to the Windows title. Match only these exact
  # UUID-bearing titles, never a substring or a regular-expression search.
  if (($name.ToString() -ceq $Title -or $name.ToString() -ceq "$Title ($Distribution)") -and [PrismHostWindow]::IsWindowVisible($window)) {
    $matches.Add($window)
  }
  return $true
}, [IntPtr]::Zero)

# Accept only the one test-owned window. Never return other window titles or
# sample their pixels, and never change focus when the match is ambiguous.
$result = [ordered]@{ found = ($matches.Count -eq 1); foreground = $false; covered = $false; aligned = $false }
if ($matches.Count -eq 1) {
  $window = $matches[0]
  if ($Action -eq 'restore') {
    # SW_RESTORE is sent only to the one exact UUID-bearing test title above.
    # The operation is asynchronous; callers can observe until it completes.
    [void][PrismHostWindow]::ShowWindowAsync($window, 9)
  }
  $result.minimized = [PrismHostWindow]::IsIconic($window)
  if ($Action -eq 'sample' -and -not $result.minimized) {
    [void][PrismHostWindow]::SetForegroundWindow($window)
  }
  $rectangle = [PrismHostWindow+Rect]::new()
  if ([PrismHostWindow]::GetWindowRect($window, [ref]$rectangle)) {
    $result.rect = $rectangle
    $result.maximized = [PrismHostWindow]::IsZoomed($window)
    $monitor = [PrismHostWindow+MonitorInfo]::new()
    $monitor.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($monitor)
    if ([PrismHostWindow]::GetMonitorInfo([PrismHostWindow]::MonitorFromWindow($window, 2), [ref]$monitor)) {
      $result.workArea = $monitor.work
    }
    $result.foreground = ([PrismHostWindow]::GetForegroundWindow() -eq $window)
    $points = @()
    if ($Action -eq 'sample' -and -not $result.minimized -and $rectangle.right - $rectangle.left -gt 10 -and $rectangle.bottom - $rectangle.top -gt 10) {
      foreach ($coordinates in @(
        @(($rectangle.left + 4), ($rectangle.top + 4)),
        @(($rectangle.right - 5), ($rectangle.top + 4)),
        @(($rectangle.left + 4), ($rectangle.bottom - 5)),
        @(($rectangle.right - 5), ($rectangle.bottom - 5))
      )) {
        $point = [PrismHostWindow+Point]::new()
        $point.x = $coordinates[0]; $point.y = $coordinates[1]
        $points += $point
      }
      $result.ownedCorners = @($points | ForEach-Object {
        [PrismHostWindow]::GetAncestor([PrismHostWindow]::WindowFromPoint($_), 2) -eq $window
      })
      $result.covered = ($result.foreground -and @($result.ownedCorners | Where-Object { -not $_ }).Count -eq 0)
    }
    if ($result.covered) {
      $dc = [PrismHostWindow]::GetDC([IntPtr]::Zero)
      if ($dc -eq [IntPtr]::Zero) { throw 'Could not read the test window surface.' }
      try {
        $result.colors = @($points | ForEach-Object { [PrismHostWindow]::GetPixel($dc, $_.x, $_.y) })
        # COLORREF is BGR: the temporary opaque overlay is exactly #f013ab.
        $result.aligned = (@($result.colors | Where-Object { $_ -ne 11211760 }).Count -eq 0)
      } finally {
        [void][PrismHostWindow]::ReleaseDC([IntPtr]::Zero, $dc)
      }
    }
  }
}
ConvertTo-Json -InputObject $result -Depth 4 -Compress
