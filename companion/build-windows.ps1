param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'),
    [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
$companionRoot = $PSScriptRoot
$buildDirectory = Join-Path $companionRoot 'build/windows'
$null = New-Item -ItemType Directory -Force -Path $OutputDirectory, $buildDirectory
$resolvedOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path
& $Python -m PyInstaller --noconfirm --clean --onefile --windowed `
    --name StudytterCompanion `
    --distpath $resolvedOutput `
    --workpath (Join-Path $buildDirectory 'work') `
    --specpath $buildDirectory `
    (Join-Path $companionRoot 'app.py')
if ($LASTEXITCODE -ne 0) { throw 'Windows executable build failed.' }
$archiveDirectory = Join-Path $buildDirectory 'StudytterCompanion-Windows-x86_64'
$null = New-Item -ItemType Directory -Force -Path $archiveDirectory
Copy-Item -LiteralPath (Join-Path $resolvedOutput 'StudytterCompanion.exe') -Destination $archiveDirectory -Force
Copy-Item -LiteralPath (Join-Path $companionRoot 'README.md'), (Join-Path $companionRoot 'sample-package.json') -Destination $archiveDirectory -Force
Compress-Archive -LiteralPath $archiveDirectory -DestinationPath (Join-Path $resolvedOutput 'StudytterCompanion-Windows-x86_64.zip') -Force
Write-Output "Built Windows executable and ZIP in $resolvedOutput"
