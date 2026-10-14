#!/usr/bin/env bash
# Tests verify-updater-manifest.sh against stub `curl` and `minisign`
# binaries: no network, no real signatures.
#
# The property under test: the script only fetches a manifest URL that is an
# asset of this repository on github.com or api.github.com, and sends the
# token only to the API form. Every other URL fails the run before any
# request is made.
#
# Usage: bash .github/scripts/verify-updater-manifest.test.sh   (from the repo root)
# Needs: bash, jq, base64.
set -euo pipefail

script="$PWD/.github/scripts/verify-updater-manifest.sh"
repo=ABCrimson/Swarm
version=1.2.3
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

mkdir "$work/bin"
cat >"$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
# Records one line per argument, then writes a fake artifact to the -o path.
printf '%s\n' "$@" >>"$STUB_LOG"
printf -- '--call--\n' >>"$STUB_LOG"
while (($#)); do
  [[ $1 == -o ]] && : >"$2"
  shift
done
STUB
printf '#!/usr/bin/env bash\nexit 0\n' >"$work/bin/minisign"
chmod +x "$work/bin/curl" "$work/bin/minisign"

# A minisig whose trusted comment binds the version, base64-encoded the way
# latest.json carries it.
signature=$(printf 'untrusted comment: t\nRWQ=\ntrusted comment: ts:1\tversion:%s\nRWQ=\n' "$version" | base64 -w0)

# manifest <windows-url> <other-url>: all four platforms, the windows entry
# uses the first URL.
manifest() {
  jq -n --arg v "$version" --arg sig "$signature" --arg win "$1" --arg other "$2" '{
    version: $v,
    platforms: {
      "windows-x86_64": {url: $win, signature: $sig},
      "darwin-aarch64": {url: $other, signature: $sig},
      "darwin-x86_64": {url: $other, signature: $sig},
      "linux-x86_64": {url: $other, signature: $sig}
    }
  }' >"$work/latest.json"
}

# run <name>: runs the script with the stubs first on PATH; sets $code and
# leaves the output in $work/out and the curl calls in $work/curl.log.
run() {
  : >"$work/curl.log"
  code=0
  STUB_LOG="$work/curl.log" PATH="$work/bin:$PATH" GH_TOKEN=secret-token \
    bash "$script" "$work/latest.json" "$version" >"$work/out" 2>&1 || code=$?
}

check() {
  local name=$1 ok=$2
  if [[ $ok == yes ]]; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    sed 's/^/     | /' "$work/out" "$work/curl.log"
    failures=$((failures + 1))
  fi
}

good_api="https://api.github.com/repos/$repo/releases/assets/123456"
good_download="https://github.com/$repo/releases/download/v$version/Swarm_1.2.3_x64.AppImage.tar.gz"

export GITHUB_REPOSITORY=$repo

rejected=(
  "https://evil.example/x"
  "http://github.com/$repo/releases/download/v$version/a.tar.gz"
  "http://api.github.com/repos/$repo/releases/assets/1"
  "https://github.com.evil.example/$repo/releases/download/v$version/a.tar.gz"
  "https://api.github.com.evil.example/repos/$repo/releases/assets/1"
  "https://github.com@evil.example/$repo/releases/download/v$version/a.tar.gz"
  "https://api.github.com@evil.example/repos/$repo/releases/assets/1"
  "https://api.github.com:8443/repos/$repo/releases/assets/1"
  "https://github.com/other/repo/releases/download/v$version/a.tar.gz"
  "https://api.github.com/repos/other/repo/releases/assets/1"
  "https://api.github.com/repos/$repo-fork/releases/assets/1"
  "https://api.github.com/repos/$repo/releases/assets/1/../../../../../../x"
  "https://api.github.com/repos/$repo/releases/assets/abc"
  "https://api.github.com/repos/$repo/releases/assets/1?x=1"
  "https://github.com/$repo/releases/download/../../../other/repo/a.tar.gz"
  "https://github.com/$repo/releases/download/v$version/%2e%2e/a.tar.gz"
  "https://github.com/$repo/archive/main.tar.gz"
  "https://objects.githubusercontent.com/github-production-release-asset/1"
  "https://release-assets.githubusercontent.com/x"
  "file:///etc/passwd"
  ""
)
for url in "${rejected[@]}"; do
  manifest "$url" "$good_api"
  run
  ok=no
  if ((code != 0)) && ! grep -q . "$work/curl.log" && grep -q '^::error::' "$work/out"; then ok=yes; fi
  check "rejects before any request: '$url'" "$ok"
done

manifest "$good_api" "$good_api"
run
ok=no
if ((code == 0)) && [[ $(grep -c -x -- '--call--' "$work/curl.log") == 4 ]] &&
  grep -qx "Authorization: Bearer secret-token" "$work/curl.log" &&
  grep -qx "$good_api" "$work/curl.log"; then ok=yes; fi
check "fetches an API asset URL of this repository with the token" "$ok"

manifest "$good_download" "$good_api"
run
# Split the log per call; the github.com call must carry no Authorization header.
ok=no
first_call=$(sed -n '1,/^--call--$/p' "$work/curl.log")
if ((code == 0)) && grep -qx "$good_download" <<<"$first_call" && ! grep -qi 'authorization' <<<"$first_call"; then ok=yes; fi
check "fetches a github.com download URL without the token" "$ok"

manifest "$good_api" "$good_api"
run
ok=no
if grep -qx -- '--proto' "$work/curl.log" && grep -qx -- '=https' "$work/curl.log" &&
  grep -qx -- '--proto-redir' "$work/curl.log" && ! grep -qx -- '--location-trusted' "$work/curl.log"; then ok=yes; fi
check "pins https for requests and redirects, never --location-trusted" "$ok"

manifest "$good_api" "$good_api"
code=0
env -u GITHUB_REPOSITORY STUB_LOG="$work/curl.log" PATH="$work/bin:$PATH" GH_TOKEN=secret-token \
  bash "$script" "$work/latest.json" "$version" >"$work/out" 2>&1 || code=$?
ok=no
if ((code != 0)) && grep -q 'GITHUB_REPOSITORY' "$work/out"; then ok=yes; fi
check "fails when GITHUB_REPOSITORY is unset" "$ok"

if ((failures)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
