param(
    [string]$WorkbookPath,
    [string]$StagingBase
)

$ErrorActionPreference = 'Stop'

function Resolve-CanonicalAbsoluteDirectoryPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -cne $Value.Trim()) {
        throw "The $Description must be a nonblank path without surrounding whitespace."
    }
    if ($Value -notmatch '^[A-Za-z]:\\') {
        throw "The $Description must be an absolute drive-rooted Windows path."
    }
    if (
        $Value.Contains('/') -or
        $Value.Substring(2).Contains(':') -or
        $Value -match '["<>|?*%~]' -or
        $Value -match '(^|\\)\.{1,2}(\\|$)' -or
        $Value -match '(^|\\)[^\\]*[. ](\\|$)' -or
        $Value -match '\\\\'
    ) {
        throw "The $Description contains invalid or ambiguous path syntax."
    }

    $normalized = [System.IO.Path]::GetFullPath($Value).TrimEnd('\')
    $comparableInput = $Value.TrimEnd('\')

    if (-not $normalized.Equals(
        $comparableInput,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "The $Description is not in canonical form."
    }

    return $normalized
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = Split-Path -Parent $repoRoot
$approvedStagingBase = Resolve-CanonicalAbsoluteDirectoryPath `
    (Join-Path $repoRoot 'test-artifacts\workbook-export-staging') `
    'approved staging root'

if (-not $WorkbookPath) {
    $WorkbookPath = Join-Path $workspaceRoot '_private_workbooks\Family Age Grading Table v2.0 CLEAN RESTORE 20260616 CODEX WORKING COPY.xlsm'
}
if (-not $StagingBase) {
    $StagingBase = $approvedStagingBase
}

$WorkbookPath = [System.IO.Path]::GetFullPath($WorkbookPath)
$StagingBase = Resolve-CanonicalAbsoluteDirectoryPath $StagingBase 'staging root'

if (-not $StagingBase.Equals(
    $approvedStagingBase,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw "The staging root must equal the approved repository staging root: $approvedStagingBase"
}

$repoPrefix = $repoRoot.TrimEnd('\') + '\'
$stagingPrefix = $StagingBase.TrimEnd('\') + '\'

if (-not (Test-Path -LiteralPath $WorkbookPath -PathType Leaf)) {
    throw "Private workbook not found: $WorkbookPath"
}
if ([System.IO.Path]::GetExtension($WorkbookPath) -ne '.xlsm') {
    throw 'The workbook must be a macro-enabled .xlsm file.'
}
if ($WorkbookPath.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The private source-of-truth workbook must remain outside the Git repository.'
}

New-Item -ItemType Directory -Force -Path $StagingBase | Out-Null

$runName = 'run-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
$stagedRoot = [System.IO.Path]::GetFullPath((Join-Path $StagingBase $runName))
$stagedParent = Split-Path -Parent $stagedRoot

if (-not $stagedParent.Equals(
    $StagingBase,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'Calculated staged export path escaped the approved staging directory.'
}
if (Test-Path -LiteralPath $stagedRoot) {
    throw "Fresh staged export path already exists: $stagedRoot"
}

$excel = $null
$workbook = $null
$succeeded = $false

try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.AutomationSecurity = 1
    $workbook = $excel.Workbooks.Open($WorkbookPath, 0, $false)

    $macroName = "'$($workbook.Name)'!CrownStandardsExport.ExportWebsiteDataIncludingCrownStandardsForAutomation"
    $failure = [string]$excel.Run($macroName, $stagedRoot)

    if ($failure) {
        throw $failure
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stagedRoot 'data\export_manifest.csv') -PathType Leaf)) {
        throw 'Workbook reported success without writing the staged export manifest.'
    }

    $workbook.Save()
    $succeeded = $true
    Write-Output "STAGED_EXPORT_ROOT=$stagedRoot"
} finally {
    if ($workbook) {
        $workbook.Close($false)
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($workbook)
    }
    if ($excel) {
        $excel.Quit()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()

    if (-not $succeeded -and (Test-Path -LiteralPath $stagedRoot)) {
        $resolvedFailurePath = [System.IO.Path]::GetFullPath($stagedRoot)

        if ($resolvedFailurePath.StartsWith($stagingPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedFailurePath -Recurse -Force
        }
    }
}
