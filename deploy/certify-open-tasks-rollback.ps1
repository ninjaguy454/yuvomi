param(
  [string]$Phase2Image = 'yuvomi:notes-canvas-test-79feabad',
  [string]$CandidateImage = 'yuvomi:open-tasks-test-06887f89',
  [Parameter(Mandatory=$true)][string]$FallbackImage
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$certRoot = Join-Path $repoRoot ('.qa\rollback-' + [guid]::NewGuid().ToString('N'))
if (-not [IO.Path]::GetFullPath($certRoot).StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar)) { throw 'Fixture path escaped repository.' }
New-Item -ItemType Directory -Path $certRoot | Out-Null
$testRoot = Join-Path $repoRoot 'test'
$images = @{}
foreach ($imageTag in @($Phase2Image,$CandidateImage,$FallbackImage)) {
  $imageInfo = & docker image inspect $imageTag --format '{{json .}}'
  if ($LASTEXITCODE -ne 0) { throw "Missing local image: $imageTag" }
  $imageObject = $imageInfo | ConvertFrom-Json
  $images[$imageTag] = @{id=$imageObject.Id; revision=$imageObject.Config.Labels.'org.opencontainers.image.revision'}
}
$steps = @(@{stage='seed'; image=$Phase2Image}, @{stage='upgrade'; image=$CandidateImage}, @{stage='phase2-probe'; image=$Phase2Image}, @{stage='fallback'; image=$FallbackImage}, @{stage='return'; image=$CandidateImage})
foreach ($step in $steps) {
  $log = Join-Path $certRoot ($step.stage + '.log')
  & docker run --rm --network none --mount "type=bind,source=$testRoot,target=/app/test,readonly" --mount "type=bind,source=$certRoot,target=/cert" -w /app --entrypoint node $step.image --experimental-sqlite test/helpers/task-acceptance-rollback.mjs $step.stage *> $log
  if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $log -Tail 30; throw "Certification failed at $($step.stage)" }
  Get-Content -LiteralPath (Join-Path $certRoot ($step.stage + '-result.json')) -Raw
}
@{images=$images; steps=$steps; synthetic=$true; noLiveMounts=$true; result='passed'; path=$certRoot} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $certRoot 'manifest.json')
Write-Output "CERTIFICATION_EVIDENCE=$certRoot"
