param(
    [string]$Version = "1.0.18"
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$projectPath = Join-Path $repositoryRoot "collector\PulseDeck\PulseDeck.csproj"
$artifactsRoot = Join-Path $repositoryRoot "artifacts"
$publishPath = Join-Path $artifactsRoot "publish"
$releasePath = Join-Path $artifactsRoot "release"
$stagePath = Join-Path $artifactsRoot "installer-stage"
$portableArchive = Join-Path $releasePath "PulseDeck-v$Version-win-x64.zip"
$setupPath = Join-Path $releasePath "PulseDeck-Setup-v$Version.exe"
$sedPath = Join-Path $artifactsRoot "PulseDeck-$Version.sed"

foreach ($path in @($publishPath, $releasePath, $stagePath)) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
}

foreach ($releaseFile in @($portableArchive, $setupPath)) {
    if (Test-Path -LiteralPath $releaseFile) {
        Remove-Item -LiteralPath $releaseFile -Force
    }
}

dotnet publish $projectPath `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:DebugType=None `
    -p:DebugSymbols=false `
    -o $publishPath

if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE"
}

# The tray icon is loaded as a normal file at runtime, so keep it next to the executable.
Copy-Item -LiteralPath (Join-Path (Split-Path $projectPath) "tray-icon.ico") -Destination $publishPath -Force

Compress-Archive -Path (Join-Path $publishPath "*") -DestinationPath $portableArchive -Force
Copy-Item -LiteralPath $portableArchive -Destination (Join-Path $stagePath "PulseDeck.zip") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "install.cmd") -Destination $stagePath -Force

$stageWithSlash = $stagePath.TrimEnd('\') + '\'
$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$setupPath
FriendlyName=Pulse Deck $Version
AppLaunched=install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=install.cmd
UserQuietInstCmd=install.cmd
SourceFiles=SourceFiles

[Strings]
FILE0="install.cmd"
FILE1="PulseDeck.zip"

[SourceFiles]
SourceFiles0=$stageWithSlash

[SourceFiles0]
%FILE0%=
%FILE1%=
"@

Set-Content -LiteralPath $sedPath -Value $sed -Encoding Unicode
$iexpressProcess = Start-Process `
    -FilePath "$env:SystemRoot\System32\iexpress.exe" `
    -ArgumentList @("/N", "/Q", $sedPath) `
    -WindowStyle Hidden `
    -Wait `
    -PassThru

if ($iexpressProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $setupPath)) {
    throw "IExpress failed to create the installer"
}

Get-FileHash -Algorithm SHA256 -LiteralPath $portableArchive, $setupPath |
    ForEach-Object { "{0}  {1}" -f $_.Hash.ToLowerInvariant(), (Split-Path -Leaf $_.Path) } |
    Set-Content -LiteralPath (Join-Path $releasePath "SHA256SUMS.txt") -Encoding utf8

Write-Host "Release files created in $releasePath"
