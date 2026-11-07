# fix-encoding.ps1
#
# WHY: the DSH write tool runs in a process the local encryption driver treats as
# an "encrypting" app, so files it writes land on disk wrapped. Some programs
# (python, MSBuild, some editors) then read ciphertext, while PowerShell/.NET
# decrypts transparently.
#
# FIX: read each text file through PowerShell (plaintext) and write it back with
# UTF8 without BOM. Afterwards ordinary tools can read the file.
#
# USAGE:
#   powershell -ExecutionPolicy Bypass -File tools\fix-encoding.ps1
#   powershell -ExecutionPolicy Bypass -File tools\fix-encoding.ps1 -Root D:\some\dir
#
# Run this after any agent session that wrote or edited files.

param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$utf8 = New-Object System.Text.UTF8Encoding($false)

$patterns = @(
    '*.ts', '*.js', '*.json', '*.md', '*.py', '*.rs', '*.cs',
    '*.cpp', '*.c', '*.h', '*.toml', '*.yml', '*.yaml', '*.csproj', '*.ps1'
)

$skipRegex = '\\node_modules\\|\\target\\|\\obj\\|\\bin\\|\\.git\\|__pycache__'

$fixed = 0
$unreadable = 0

foreach ($pattern in $patterns) {
    $files = Get-ChildItem -Path $Root -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue
    foreach ($f in $files) {
        if ($f.FullName -match $skipRegex) { continue }
        try {
            $text = Get-Content $f.FullName -Raw -Encoding UTF8 -ErrorAction Stop
            if ($null -eq $text) { continue }
            [System.IO.File]::WriteAllText($f.FullName, $text, $utf8)
            $fixed++
        } catch {
            Write-Host ("  UNREADABLE: " + $f.FullName)
            $unreadable++
        }
    }
}

Write-Host ""
Write-Host ("fixed      : " + $fixed)
Write-Host ("unreadable : " + $unreadable)
Write-Host ""
Write-Host "Now open any file in your editor to confirm."
