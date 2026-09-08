$ErrorActionPreference = 'Stop'
$companionRoot = $PSScriptRoot
$runtime = Join-Path $companionRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $runtime)) {
    python -m venv (Join-Path $companionRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 or newer is required.' }
}
& $runtime -m pip install -r (Join-Path $companionRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
& $runtime (Join-Path $companionRoot 'app.py')
