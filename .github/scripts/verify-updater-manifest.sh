#!/usr/bin/env bash
# Verifies a release's updater manifest (latest.json) the way an installed
# app will consume it.
#
# - The manifest announces <version> and serves the four platform keys the
#   app's updater asks for.
# - Every entry's artifact, downloaded from the URL the updater will use,
#   verifies with minisign against the updater public key the app ships
#   (src-tauri/tauri.conf.json `plugins.updater.pubkey`).
# - Every signed trusted comment ends in `version:<version>`, the binding
#   `requireSignedVersion` enforces on download (the Tauri CLI writes it
#   when it signs; a hand-signed artifact without `--app-version` lacks it).
# - With ATTESTATION_REPO set, every artifact also carries a build
#   provenance attestation from that repository (`gh attestation verify`).
#
# Usage: verify-updater-manifest.sh <latest.json> <version>
# Env:   GH_TOKEN          token that can read the (draft) release's assets
#        ATTESTATION_REPO  owner/repo whose attestations must cover each artifact
# Needs: bash, curl, jq, minisign, base64 (and gh with ATTESTATION_REPO).
set -euo pipefail

manifest=$1
version=$2
workdir=$(mktemp -d)
status=0

fail() {
  echo "::error::$*"
  status=1
}

jq -r '.plugins.updater.pubkey' src-tauri/tauri.conf.json | base64 -d >"$workdir/updater.pub"

announced=$(jq -r '.version' "$manifest")
[[ $announced == "$version" ]] || fail "latest.json announces version $announced, expected $version"

for key in windows-x86_64 darwin-aarch64 darwin-x86_64 linux-x86_64; do
  jq -e --arg key "$key" '.platforms[$key]' "$manifest" >/dev/null ||
    fail "latest.json is missing the $key platform"
done

while IFS=$'\t' read -r key url signature; do
  artifact="$workdir/$key"
  printf '%s' "$signature" | base64 -d >"$artifact.minisig"
  # API asset URLs redirect to storage; curl drops the token on that hop.
  curl -fsSL --retry 3 -H "Authorization: Bearer ${GH_TOKEN:-}" \
    -H "Accept: application/octet-stream" -o "$artifact" "$url"
  if ! minisign -Vq -p "$workdir/updater.pub" -m "$artifact" -x "$artifact.minisig"; then
    fail "$key: the signature does not verify against the app's updater public key"
    continue
  fi
  comment=$(sed -n 's/^trusted comment: //p' "$artifact.minisig")
  if [[ $comment != *$'\t'"version:$version" ]]; then
    fail "$key: the signed trusted comment does not bind version:$version ($comment)"
    continue
  fi
  if [[ -n ${ATTESTATION_REPO:-} ]] &&
    ! gh attestation verify "$artifact" --repo "$ATTESTATION_REPO" >/dev/null; then
    fail "$key: no valid build provenance attestation from $ATTESTATION_REPO"
    continue
  fi
  echo "$key: signature, version:$version${ATTESTATION_REPO:+ and provenance} verified"
done < <(jq -r '.platforms | to_entries[] | [.key, .value.url, .value.signature] | @tsv' "$manifest")

exit "$status"
