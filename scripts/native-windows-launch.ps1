param(
    [string] $ReleaseDirectory,
    [string] $LogDirectory
)

$ErrorActionPreference = 'Stop'
$process = $null
$stdoutLog = $null
$stderrLog = $null

function Quote-WindowsArgument([string] $Value) {
    # CommandLineToArgvW quoting, including quotes and trailing backslashes.
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

try {
    if (-not $ReleaseDirectory) { $ReleaseDirectory = Split-Path -Parent $PSScriptRoot }
    $ReleaseDirectory = [IO.Path]::GetFullPath($ReleaseDirectory)
    $release = Get-Content -LiteralPath (Join-Path $ReleaseDirectory 'release.json') -Raw | ConvertFrom-Json
    if ($release.application -cne 'Prism' -or $release.format -ne 1 -or $release.platform -cne 'win32') {
        throw 'This folder is not a complete native Windows Prism release.'
    }
    $electron = Join-Path $ReleaseDirectory 'node_modules\electron\dist\electron.exe'
    $wrapper = Join-Path $ReleaseDirectory 'scripts\start-markdown.mjs'
    foreach ($required in @($electron, $wrapper, (Join-Path $ReleaseDirectory 'dist\main.cjs'))) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Prism installation is incomplete: $required" }
    }
    if (-not $LogDirectory) {
        $installationRoot = Split-Path -Parent (Split-Path -Parent $ReleaseDirectory)
        $LogDirectory = Join-Path $installationRoot 'logs'
    }
    [void] [IO.Directory]::CreateDirectory($LogDirectory)
    $session = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $stdoutLog = Join-Path $LogDirectory ($session + '.stdout.log')
    $stderrLog = Join-Path $LogDirectory ($session + '.stderr.log')
    # Reuse Electron's bundled Node, so the installed shortcut needs neither
    # WSL nor a global Node installation. start-markdown removes this variable
    # from its GUI child and waits for that child's actual process exit.
    $previousNodeMode = $env:ELECTRON_RUN_AS_NODE
    try {
        $env:ELECTRON_RUN_AS_NODE = '1'
        $process = Start-Process -FilePath $electron -ArgumentList (Quote-WindowsArgument $wrapper) `
            -WorkingDirectory $ReleaseDirectory -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
        # Retain the handle before waiting; no Start-Process -Wait, which also
        # waits for descendants that may have inherited Chromium pipe handles.
        $null = $process.Handle
        $process.WaitForExit()
        $exitCode = $process.ExitCode
    } finally {
        if ($null -eq $previousNodeMode) { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
        else { $env:ELECTRON_RUN_AS_NODE = $previousNodeMode }
    }
    if ($exitCode -ne 0) { throw "Prism closed unexpectedly (exit $exitCode). Launch Prism again to retry." }
    exit 0
} catch {
    $message = $_.Exception.Message
    if ($stderrLog) { $message += "`r`n`r`nStartup log: $stderrLog" }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void] [Windows.Forms.MessageBox]::Show($message, 'Prism could not open', 'OK', 'Error')
    } catch {
        [Console]::Error.WriteLine($message)
    }
    exit 1
} finally {
    if ($process) { $process.Dispose() }
}
