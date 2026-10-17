param(
    [Parameter(Mandatory = $true)]
    [string] $ConfigBase64
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $config = $utf8.GetString([Convert]::FromBase64String($ConfigBase64)) | ConvertFrom-Json
} catch {
    throw 'The shortcut configuration must be base64-encoded UTF-8 JSON.'
}

foreach ($name in @('app', 'distro', 'launcherPath', 'iconPath')) {
    $value = $config.$name
    if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value) -or $value -match '[\x00-\x1f\x7f]') {
        throw "The shortcut configuration requires a valid $name string."
    }
}
switch -CaseSensitive ($config.app) {
    'markdown' { $applicationName = 'Prism'; $iconName = 'prism.ico' }
    'pdf' { $applicationName = 'Prism PDF'; $iconName = 'prism-pdf.ico' }
    default { throw 'Choose the markdown or pdf launcher.' }
}
if (-not $config.launcherPath.StartsWith('/')) {
    throw 'launcherPath must be an absolute Linux path.'
}
if (-not (Test-Path -LiteralPath $config.iconPath -PathType Leaf)) {
    throw "The $applicationName icon was not found at '$($config.iconPath)'."
}

function Quote-WindowsArgument([string] $Value) {
    $builder = New-Object System.Text.StringBuilder
    [void] $builder.Append([char] 34)
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char] 92) {
            $slashes++
            continue
        }
        if ($character -eq [char] 34) {
            [void] $builder.Append([char] 92, 2 * $slashes + 1)
            [void] $builder.Append([char] 34)
        } else {
            [void] $builder.Append([char] 92, $slashes)
            [void] $builder.Append($character)
        }
        $slashes = 0
    }
    [void] $builder.Append([char] 92, 2 * $slashes)
    [void] $builder.Append([char] 34)
    return $builder.ToString()
}

$wslg = $null
foreach ($candidate in @(
    (Join-Path $env:ProgramFiles 'WSL\wslg.exe'),
    (Join-Path $env:WINDIR 'System32\wslg.exe')
)) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $wslg = $candidate
        break
    }
}
if (-not $wslg) {
    $command = Get-Command wslg.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { $wslg = $command.Source }
}
if (-not $wslg) {
    throw 'WSLg was not found. Install or update Windows Subsystem for Linux with GUI support before creating these shortcuts.'
}

# WSLg does not unquote distribution names; its positional GUID supports all names.
$registrations = @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' |
    ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
    Where-Object { $_.DistributionName -ceq $config.distro })
$distributionId = [guid]::Empty
if ($registrations.Count -ne 1 -or -not [guid]::TryParse([string] $registrations[0].PSChildName, [ref] $distributionId)) {
    throw "Could not find a unique registered WSL distribution named '$($config.distro)' for the current Windows user."
}

$desktopDirectory = [Environment]::GetFolderPath('Desktop')
$programsDirectory = [Environment]::GetFolderPath('Programs')
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $desktopDirectory -or -not $programsDirectory -or -not $localAppData) {
    throw 'Windows did not provide the current user Desktop, Start Menu, or local application-data folder.'
}
$desktop = Join-Path $desktopDirectory ($applicationName + '.lnk')
$startMenu = Join-Path $programsDirectory ($applicationName + '.lnk')
$iconDirectory = Join-Path $localAppData $applicationName
$icon = Join-Path $iconDirectory $iconName
# WSLg supports --shell-type none, not wsl.exe's --exec. No-shell mode gives the
# Linux path Windows argv quoting without expanding shell symbols in the path.
$arguments = $distributionId.ToString('B') + ' --shell-type none -- /bin/sh ' + (Quote-WindowsArgument $config.launcherPath)
$managedDescription = "$applicationName launcher (managed by Prism)"
$shell = New-Object -ComObject WScript.Shell

try {
    # Check both destinations before changing either shortcut or its icon.
    foreach ($shortcutPath in @($desktop, $startMenu)) {
        if (Test-Path -LiteralPath $shortcutPath) {
            if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
                throw "Cannot replace '$shortcutPath': it is not a shortcut file."
            }
            $existing = $shell.CreateShortcut($shortcutPath)
            try {
                if ([IO.Path]::GetFileName($existing.TargetPath) -ine 'wslg.exe' -or $existing.Description -cne $managedDescription) {
                    throw "Refusing to replace '$shortcutPath' because it is not a managed $applicationName shortcut."
                }
            } finally {
                [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($existing)
            }
        }
    }

    foreach ($directory in @($desktopDirectory, $programsDirectory, $iconDirectory)) {
        [void] [IO.Directory]::CreateDirectory($directory)
    }
    if ([IO.Path]::GetFullPath($config.iconPath) -ine [IO.Path]::GetFullPath($icon)) {
        Copy-Item -LiteralPath $config.iconPath -Destination $icon -Force
    }
    foreach ($shortcutPath in @($desktop, $startMenu)) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        try {
            $shortcut.TargetPath = $wslg
            $shortcut.Arguments = $arguments
            $shortcut.WorkingDirectory = Join-Path $env:WINDIR 'System32'
            $shortcut.WindowStyle = 7
            $shortcut.Description = $managedDescription
            $shortcut.IconLocation = $icon + ',0'
            $shortcut.Save()
        } finally {
            [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
        }
    }
} finally {
    [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}

[pscustomobject]@{ desktop = $desktop; startMenu = $startMenu; icon = $icon } | ConvertTo-Json -Compress
