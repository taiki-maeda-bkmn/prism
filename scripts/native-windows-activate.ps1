param(
    [Parameter(Mandatory = $true)]
    [string] $ReleaseId,
    [string] $InstallDirectory
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if (-not $InstallDirectory) { $InstallDirectory = $PSScriptRoot }
if ($ReleaseId -notmatch '^[A-Za-z0-9-]+$') { throw 'Invalid native release identifier.' }
$InstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
$marker = Get-Content -LiteralPath (Join-Path $InstallDirectory 'prism-native-install.json') -Raw | ConvertFrom-Json
if ($marker.application -cne 'Prism' -or $marker.format -ne 1) { throw 'This is not a Prism native installation.' }
$releaseDirectory = Join-Path (Join-Path $InstallDirectory 'releases') $ReleaseId
$release = Get-Content -LiteralPath (Join-Path $releaseDirectory 'release.json') -Raw | ConvertFrom-Json
if ($release.application -cne 'Prism' -or $release.format -ne 1 -or $release.id -cne $ReleaseId -or $release.platform -cne 'win32') { throw 'The selected release is incomplete.' }
$launcher = Join-Path $releaseDirectory 'scripts\native-windows-launch.ps1'
$icon = Join-Path $releaseDirectory 'prism.ico'
foreach ($relative in @('package.json', 'release.json', 'scripts\native-windows-launch.ps1', 'scripts\start-markdown.mjs',
    'scripts\desktop-session.mjs', 'scripts\electron-launch.mjs', 'prism.ico', 'node_modules\electron\path.txt',
    'node_modules\electron\dist\electron.exe', 'dist\main.cjs', 'dist\preload.cjs', 'dist\renderer\index.html')) {
    $required = Join-Path $releaseDirectory $relative
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing release file: $required" }
}

$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Prism.lnk'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Prism.lnk'
$description = 'Prism native Windows launcher (managed by Prism)'
$backupDirectory = Join-Path (Join-Path $InstallDirectory 'shortcut-backups') ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$shell = New-Object -ComObject WScript.Shell
$originals = @{}
$temporary = @{}
$promoted = @()
$active = Join-Path $InstallDirectory 'active.json'
$activeTemporary = Join-Path $InstallDirectory ('active-' + [guid]::NewGuid().ToString('N') + '.json')

try {
    # Validate both destinations before changing either. A previous WSLg
    # launcher is backed up, and unrelated user shortcuts are never replaced.
    foreach ($shortcutPath in @($desktop, $startMenu)) {
        if (Test-Path -LiteralPath $shortcutPath) {
            if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw "Not a shortcut file: $shortcutPath" }
            $existing = $shell.CreateShortcut($shortcutPath)
            try {
                $targetName = [IO.Path]::GetFileName($existing.TargetPath)
                $managedWSL = $targetName -ieq 'wslg.exe' -and $existing.Description -ceq 'Prism launcher (managed by Prism)'
                $managedNative = $targetName -ieq 'powershell.exe' -and $existing.Description -ceq $description
                if (-not ($managedWSL -or $managedNative)) { throw "Refusing to replace an unmanaged shortcut: $shortcutPath" }
            } finally { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($existing) }
        }
    }
    [void] [IO.Directory]::CreateDirectory($backupDirectory)
    foreach ($entry in @(@('desktop', $desktop), @('start-menu', $startMenu))) {
        $shortcutPath = $entry[1]
        [void] [IO.Directory]::CreateDirectory((Split-Path -Parent $shortcutPath))
        if (Test-Path -LiteralPath $shortcutPath) {
            $backup = Join-Path $backupDirectory ($entry[0] + '-Prism.lnk')
            Copy-Item -LiteralPath $shortcutPath -Destination $backup
            $originals[$shortcutPath] = $backup
        }
        $pending = Join-Path (Split-Path -Parent $shortcutPath) ('Prism-' + [guid]::NewGuid().ToString('N') + '.lnk')
        $temporary[$shortcutPath] = $pending
        $shortcut = $shell.CreateShortcut($pending)
        try {
            $shortcut.TargetPath = $powershell
            # Windows filesystem names cannot contain a double quote.
            $shortcut.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '"'
            $shortcut.WorkingDirectory = $releaseDirectory
            $shortcut.WindowStyle = 7
            $shortcut.Description = $description
            $shortcut.IconLocation = $icon + ',0'
            $shortcut.Save()
        } finally { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    }
    $selection = @{ application = 'Prism'; format = 1; releaseId = $ReleaseId; shortcutBackup = $backupDirectory } | ConvertTo-Json
    [IO.File]::WriteAllText($activeTemporary, $selection, (New-Object System.Text.UTF8Encoding($false)))
    foreach ($shortcutPath in @($desktop, $startMenu)) {
        if (Test-Path -LiteralPath $shortcutPath) { [IO.File]::Replace($temporary[$shortcutPath], $shortcutPath, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary[$shortcutPath], $shortcutPath) }
        $promoted += $shortcutPath
    }
    if (Test-Path -LiteralPath $active) { [IO.File]::Replace($activeTemporary, $active, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($activeTemporary, $active) }
} catch {
    foreach ($shortcutPath in $promoted) {
        if ($originals.ContainsKey($shortcutPath)) { Copy-Item -LiteralPath $originals[$shortcutPath] -Destination $shortcutPath -Force }
        else { Remove-Item -LiteralPath $shortcutPath -Force }
    }
    throw
} finally {
    foreach ($pending in $temporary.Values) { if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force } }
    if (Test-Path -LiteralPath $activeTemporary) { Remove-Item -LiteralPath $activeTemporary -Force }
    [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}
[pscustomobject]@{ release = $releaseDirectory; desktop = $desktop; startMenu = $startMenu; shortcutBackup = $backupDirectory } | ConvertTo-Json -Compress
