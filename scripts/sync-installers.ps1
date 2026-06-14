# Sync the latest J.A.R.V.I.S. installers from GitHub Releases into the Google
# Drive "Jarvis/Installers" folder, so any computer (even one without Jarvis yet)
# can install the latest straight from Drive. Designed to run daily via Task
# Scheduler on one "hub" machine that has the gh CLI authenticated + Google Drive.
#
# Only downloads when the latest release version differs from what is already in
# Drive (a .version marker), so it does not re-pull ~600 MB every day.

param(
  [string]$Repo = "michael1977/jarvis-desktop"
)
$ErrorActionPreference = "Stop"

# Locate the Google Drive "My Drive\Jarvis" folder (scan drive letters, then home).
$base = $null
foreach ($d in [char[]](68..90)) {            # D..Z
  $p = "${d}:\My Drive\Jarvis"
  if (Test-Path $p) { $base = $p; break }
}
if (-not $base) {
  $cand = Join-Path $env:USERPROFILE "My Drive\Jarvis"
  if (Test-Path $cand) { $base = $cand }
}
if (-not $base) { Write-Output "Google Drive Jarvis folder not found - is Drive mounted?"; exit 0 }

$dest = Join-Path $base "Installers"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Latest release tag from GitHub (uses gh auth, works for private repos).
$tag = (& gh release view --repo $Repo --json tagName --jq ".tagName" 2>$null)
if (-not $tag) { Write-Output "Could not query latest release (is gh authenticated?)"; exit 0 }
$tag = $tag.Trim()

$marker = Join-Path $dest ".version"
$current = if (Test-Path $marker) { (Get-Content $marker -Raw).Trim() } else { "" }
if ($current -eq $tag) { Write-Output "Installers already up to date ($tag)"; exit 0 }

Write-Output "New release $tag - downloading installers to $dest ..."
& gh release download $tag --repo $Repo --pattern "*.exe" --dir $dest --clobber
& gh release download $tag --repo $Repo --pattern "*.dmg" --dir $dest --clobber

# Prune installers left over from older versions (filenames contain the version).
$ver = $tag.TrimStart('v')
Get-ChildItem $dest -File |
  Where-Object { ($_.Extension -in '.exe', '.dmg') -and ($_.Name -notlike "*$ver*") } |
  Remove-Item -Force -ErrorAction SilentlyContinue

# Only mark the version complete once BOTH Windows (.exe) and Mac (.dmg) installers
# are present, so a partially-published release is retried on the next run.
$exe = @(Get-ChildItem $dest -File | Where-Object { $_.Extension -eq '.exe' -and $_.Name -like "*$ver*" })
$dmg = @(Get-ChildItem $dest -File | Where-Object { $_.Extension -eq '.dmg' -and $_.Name -like "*$ver*" })
if ($exe.Count -gt 0 -and $dmg.Count -gt 0) {
  Set-Content -Path $marker -Value $tag -Encoding ascii
  Write-Output "Done - $tag synced to Drive ($($exe.Count) Windows, $($dmg.Count) Mac)."
} else {
  Write-Output "Release $tag only partially published (exe=$($exe.Count) dmg=$($dmg.Count)); will retry next run."
}
