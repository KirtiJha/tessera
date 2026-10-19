/**
 * One-line installers for the machine that runs Claude Code. Each script is
 * served with this server's own address baked in, so the person pastes one
 * line and nothing else. The scripts need only what every machine has (curl or
 * wget and tar on macOS and Linux; PowerShell 5+ on Windows): if Node 20+ is
 * not installed they fetch a private copy into ~/.tessera that touches nothing
 * else on the machine.
 */

/** The Node release fetched when the machine has none. Pinned so the install is reproducible. */
export const NODE_VERSION = "v22.12.0";

export function installSh(serverUrl: string): string {
  return `#!/bin/sh
# Tessera reporter installer for macOS and Linux.
#   curl -fsSL ${serverUrl}/install.sh | sh -s -- --code ABCD-EFGH
# Options: --code <enrolment code> | --token <device token>, --label <name>, --server <url>.
# Env: TESSERA_CODE, TESSERA_TOKEN, TESSERA_LABEL, TESSERA_HOME, TESSERA_NODE_VERSION.
set -eu

SERVER="${serverUrl}"
CODE="\${TESSERA_CODE:-}"
TOKEN="\${TESSERA_TOKEN:-}"
LABEL="\${TESSERA_LABEL:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --code) CODE="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    *) printf 'Unknown option: %s\\n' "$1" >&2; exit 2 ;;
  esac
done
SERVER=$(printf '%s' "$SERVER" | sed 's:/*$::')
TDIR="\${TESSERA_HOME:-$HOME/.tessera}"
mkdir -p "$TDIR/bin"

say() { printf '%s\\n' "$*"; }
fail() { printf 'tessera: %s\\n' "$*" >&2; exit 1; }
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else fail "curl or wget is needed to download files"; fi
}

# 1. Node 20 or newer: the one on PATH, a private copy from an earlier run, or a fresh private copy.
NODE=""
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -ge 20 ] 2>/dev/null; then NODE=$(command -v node); else say "Node $(node -v 2>/dev/null) is older than 20; using a private copy instead."; fi
fi
if [ -z "$NODE" ] && [ -x "$TDIR/node/bin/node" ]; then NODE="$TDIR/node/bin/node"; fi
if [ -z "$NODE" ]; then
  os=$(uname -s); arch=$(uname -m)
  case "$os" in Darwin) plat=darwin ;; Linux) plat=linux ;; *) fail "unsupported system $os; install Node 20+ from https://nodejs.org and run this again" ;; esac
  case "$arch" in arm64|aarch64) a=arm64 ;; x86_64|amd64) a=x64 ;; *) fail "unsupported CPU $arch; install Node 20+ from https://nodejs.org and run this again" ;; esac
  ver="\${TESSERA_NODE_VERSION:-${NODE_VERSION}}"
  say "Node 20+ not found. Downloading a private copy ($ver) into $TDIR/node; nothing else on this machine changes."
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t tessera)
  fetch "https://nodejs.org/dist/$ver/node-$ver-$plat-$a.tar.gz" "$tmp/node.tgz" || fail "could not download Node from nodejs.org; install Node 20+ yourself and run this again"
  rm -rf "$TDIR/node"; mkdir -p "$TDIR/node"
  tar -xzf "$tmp/node.tgz" -C "$TDIR/node" --strip-components=1
  rm -rf "$tmp"
  NODE="$TDIR/node/bin/node"
fi

# 2. The reporter, from this server, so the version always matches it.
BIN="$TDIR/bin/tessera-reporter.mjs"
fetch "$SERVER/downloads/tessera-reporter.mjs" "$BIN.tmp" || fail "could not download the reporter from $SERVER"
mv "$BIN.tmp" "$BIN"; chmod 755 "$BIN"

# 3. Enrol, unless this machine already is.
if [ -n "$TOKEN" ]; then
  "$NODE" "$BIN" enrol --server "$SERVER" --token "$TOKEN" \${LABEL:+--label "$LABEL"}
elif [ -n "$CODE" ]; then
  "$NODE" "$BIN" enrol --server "$SERVER" --code "$CODE" \${LABEL:+--label "$LABEL"}
elif [ -f "$TDIR/config.json" ]; then
  say "Already enrolled; keeping this machine's device token."
else
  fail "no enrolment code. Get one on the Devices page, then run: curl -fsSL $SERVER/install.sh | sh -s -- --code <code>"
fi

# 4. Hooks into Claude Code, then a self-check.
"$NODE" "$BIN" install
"$NODE" "$BIN" doctor
say ""
say "Done. Start a Claude Code session; it appears on your Tessera wall within seconds."
say "Later: \\"$NODE\\" \\"$BIN\\" doctor | status | uninstall"
`;
}

export function installPs1(serverUrl: string): string {
  return `# Tessera reporter installer for Windows (PowerShell 5.1 or newer).
#   $env:TESSERA_CODE = "ABCD-EFGH"; irm ${serverUrl}/install.ps1 | iex
# Env: TESSERA_CODE or TESSERA_TOKEN, TESSERA_LABEL, TESSERA_SERVER, TESSERA_HOME, TESSERA_NODE_VERSION.
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Server = if ($env:TESSERA_SERVER) { $env:TESSERA_SERVER.TrimEnd("/") } else { "${serverUrl}" }
$Code = $env:TESSERA_CODE
$Token = $env:TESSERA_TOKEN
$Label = $env:TESSERA_LABEL
$TDir = if ($env:TESSERA_HOME) { $env:TESSERA_HOME } else { Join-Path $HOME ".tessera" }
New-Item -ItemType Directory -Force -Path (Join-Path $TDir "bin") | Out-Null

# throw, not exit: this script usually runs through "irm | iex", where exit would close the terminal window.
function Fail($msg) { throw "tessera: $msg" }

# 1. Node 20 or newer: the one on PATH, a private copy from an earlier run, or a fresh private copy.
$Node = $null
$found = Get-Command node.exe -ErrorAction SilentlyContinue
if ($found) {
  try { $major = [int](& $found.Source -p "process.versions.node.split('.')[0]") } catch { $major = 0 }
  if ($major -ge 20) { $Node = $found.Source } else { Write-Host "Node $(& $found.Source -v) is older than 20; using a private copy instead." }
}
$Private = Join-Path $TDir "node\\node.exe"
if (-not $Node -and (Test-Path $Private)) { $Node = $Private }
if (-not $Node) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $ver = if ($env:TESSERA_NODE_VERSION) { $env:TESSERA_NODE_VERSION } else { "${NODE_VERSION}" }
  Write-Host "Node 20+ not found. Downloading a private copy ($ver) into $TDir\\node; nothing else on this machine changes."
  $zip = Join-Path $env:TEMP "tessera-node.zip"
  $tmp = Join-Path $env:TEMP "tessera-node-extract"
  try { Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$ver/node-$ver-win-$arch.zip" -OutFile $zip } catch { Fail "could not download Node from nodejs.org; install Node 20+ from https://nodejs.org and run this again" }
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $dest = Join-Path $TDir "node"
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item (Join-Path $tmp "node-$ver-win-$arch") $dest
  Remove-Item -Force $zip; Remove-Item -Recurse -Force $tmp
  $Node = $Private
}

# 2. The reporter, from this server, so the version always matches it.
$Bin = Join-Path $TDir "bin\\tessera-reporter.mjs"
try { Invoke-WebRequest -UseBasicParsing -Uri "$Server/downloads/tessera-reporter.mjs" -OutFile "$Bin.tmp" } catch { Fail "could not download the reporter from $Server" }
Move-Item -Force "$Bin.tmp" $Bin

# 3. Enrol, unless this machine already is.
$labelArgs = @(); if ($Label) { $labelArgs = @("--label", $Label) }
if ($Token) { & $Node $Bin enrol --server $Server --token $Token @labelArgs }
elseif ($Code) { & $Node $Bin enrol --server $Server --code $Code @labelArgs }
elseif (Test-Path (Join-Path $TDir "config.json")) { Write-Host "Already enrolled; keeping this machine's device token." }
else { Fail "no enrolment code. Get one on the Devices page, then run: \`$env:TESSERA_CODE = 'ABCD-EFGH'; irm $Server/install.ps1 | iex" }
if ($LASTEXITCODE) { Fail "enrolment failed (exit $LASTEXITCODE)" }

# 4. Hooks into Claude Code, then a self-check.
& $Node $Bin install
if ($LASTEXITCODE) { Fail "installing the hooks failed (exit $LASTEXITCODE)" }
& $Node $Bin doctor
Write-Host ""
Write-Host "Done. Start a Claude Code session; it appears on your Tessera wall within seconds."
Write-Host "Later: & '$Node' '$Bin' doctor | status | uninstall"
`;
}
