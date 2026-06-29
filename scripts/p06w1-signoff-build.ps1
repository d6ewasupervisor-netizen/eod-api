# P06W1 signoff build — Districts 1, 6, 8 from working tracker copies.
$ErrorActionPreference = 'Stop'

function Import-DotEnv($path) {
    if (-not (Test-Path $path)) { return }
    Get-Content $path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith('#')) { return }
        $i = $line.IndexOf('=')
        if ($i -lt 1) { return }
        $k = $line.Substring(0, $i).Trim()
        $v = $line.Substring($i + 1).Trim().Trim('"').Trim("'")
        if ($k) { Set-Item -Path "Env:$k" -Value $v }
    }
}

$TrackerRoot = 'C:/Users/tgaut/Downloads/p06w1 signoffs'
$IseCopy = Join-Path $TrackerRoot 'SUPER Tracker ISE V1.3 - P06W1 working copy.xlsm'
$BlitzCopy = Join-Path $TrackerRoot 'SUPER Tracker Blitz V1.3 - P06W1 working copy.xlsx'
$BuilderRoot = 'C:/Users/tgaut/flow-automation/signoff_builder/signoff-builder'
$ConfigPath = Join-Path $TrackerRoot 'p06w1-signoff-config.yaml'

Import-DotEnv 'C:/Users/tgaut/flow-automation/.env'
Import-DotEnv 'C:/Users/tgaut/flow-automation/report_extraction/.env'
Import-DotEnv 'C:/Users/tgaut/sas-auth/.env'
$env:SAS_AUTH_DIR = 'C:/Users/tgaut/sas-auth'

if (-not (Test-Path $IseCopy)) { throw "Missing ISE copy: $IseCopy" }
if (-not (Test-Path $BlitzCopy)) { throw "Missing Blitz copy: $BlitzCopy" }

$baseConfig = Get-Content (Join-Path $BuilderRoot 'config.yaml') -Raw
$patched = $baseConfig `
    -replace 'tracker_ise_path:.*', "tracker_ise_path: `"$($IseCopy -replace '\\','/')`"" `
    -replace 'tracker_blitz_path:.*', "tracker_blitz_path: `"$($BlitzCopy -replace '\\','/')`"" `
    -replace 'source_path:.*', "source_path: `"$($IseCopy -replace '\\','/')`""
Set-Content -Path $ConfigPath -Value $patched -Encoding UTF8

Set-Location $BuilderRoot
$results = @()
foreach ($district in 1, 6, 8) {
    Write-Host "=== Building P06W1 District $district ==="
    python -m signoff_builder.cli `
        --config $ConfigPath `
        --tracker $IseCopy `
        --scope district `
        --district $district `
        --output pdf `
        --export-pdf `
        --period 6 `
        --week 1 `
        --exclude-week P06W2 `
        --exclude-week P06W3 `
        --exclude-week P06W4 `
        --verbose
    if ($LASTEXITCODE -ne 0) { throw "District $district build failed with exit $LASTEXITCODE" }
    $results += "District $district: OK"
}
$results | ForEach-Object { Write-Host $_ }
Write-Host 'Done.'
