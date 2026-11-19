param(
  [Parameter(Mandatory)] [string]$InputDirectory,
  [Parameter(Mandatory)] [string]$BuildDirectory
)
$ErrorActionPreference = 'Stop'
$probe = (Resolve-Path 'scripts/qualification/catalog-reads/probe.mjs').Path
$archive = Join-Path $InputDirectory 'catalog.tgz'
$disk = Join-Path $env:RUNNER_TEMP ('aw-catalog-remount-' + [guid]::NewGuid() + '.vhdx')
$commands = "$disk.create.txt"
$used = [IO.DriveInfo]::GetDrives().Name
$letter = [char[]](82..90) | Where-Object { "$($_):\" -notin $used } | Select-Object -First 1
if (!$letter) { throw 'No unused drive letter for the Catalog experiment.' }

try {
  @(
    ('create vdisk file="' + $disk + '" maximum=128 type=expandable'),
    ('select vdisk file="' + $disk + '"'),
    'attach vdisk',
    'create partition primary',
    'format fs=ntfs quick label=AWCATALOG',
    "assign letter=$letter"
  ) | Set-Content -LiteralPath $commands -Encoding ascii
  diskpart.exe /s $commands
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the disposable experiment VHD.' }
  $volume = Get-DiskImage -ImagePath $disk | Get-Disk | Get-Partition | Get-Volume |
    Where-Object { $_.DriveLetter -eq $letter -and $_.FileSystemLabel -eq 'AWCATALOG' }
  if (!$volume) { throw 'The assigned drive does not belong to the experiment VHD.' }
  $drive = "$($volume.DriveLetter):\"
  $tar = Join-Path $env:SystemRoot 'System32/tar.exe'
  Push-Location -LiteralPath $drive
  try {
    & $tar -xzf $archive
    if ($LASTEXITCODE -ne 0) { throw 'Cannot extract the Catalog into the isolated VHD.' }
  } finally {
    Pop-Location
  }
  Dismount-DiskImage -ImagePath $disk
  if ((Get-DiskImage -ImagePath $disk).Attached) { throw 'The disposable VHD remained attached.' }

  foreach ($variant in @('serial', 'four', 'eight')) {
    Mount-DiskImage -ImagePath $disk -Access ReadOnly | Out-Null
    $device = Get-DiskImage -ImagePath $disk | Get-Disk
    if (!$device.IsReadOnly) { throw 'The Catalog VHD did not mount read-only.' }
    $volume = $device | Get-Partition | Get-Volume |
      Where-Object { $_.DriveLetter -and $_.FileSystemLabel -eq 'AWCATALOG' }
    if (!$volume) { throw 'The remounted Catalog volume has no drive letter.' }
    $catalog = Join-Path "$($volume.DriveLetter):\" 'catalog'
    $root = Join-Path $BuildDirectory $variant
    $output = Join-Path $InputDirectory "$variant-remounted.json"
    node $probe --mode remounted-read --root $root --catalog $catalog --output $output
    if ($LASTEXITCODE -ne 0) { throw 'The remounted Catalog measurement failed.' }
    Dismount-DiskImage -ImagePath $disk
    if ((Get-DiskImage -ImagePath $disk).Attached) { throw 'The disposable VHD remained attached.' }
  }
} finally {
  if (Test-Path -LiteralPath $disk) {
    if ((Get-DiskImage -ImagePath $disk).Attached) {
      Dismount-DiskImage -ImagePath $disk
    }
    Remove-Item -LiteralPath $disk
  }
  if (Test-Path -LiteralPath $commands) { Remove-Item -LiteralPath $commands }
}
