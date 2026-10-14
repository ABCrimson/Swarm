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
# - Every URL is checked against an allowlist before the first request, so
#   latest.json cannot make the script send the token to another host or
#   repository (see `manifest_url_kind`).
# - With ATTESTATION_REPO set, every artifact also carries a build
#   provenance attestation from that repository (`gh attestation verify`).
#
# Usage: verify-updater-manifest.sh <latest.json> <version>
# Env:   GITHUB_REPOSITORY owner/repo whose assets the manifest may name (required)
#        GH_TOKEN          token that can read the (draft) release's assets; sent
#                          only to api.github.com URLs of that repository
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

repo=${GITHUB_REPOSITORY:-}
if [[ ! $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "::error::GITHUB_REPOSITORY must be owner/repo, got '$repo'"
  exit 1
fi

# Classifies a manifest URL. Prints "api" for
#   https://api.github.com/repos/<repo>/releases/assets/<id>
# (what tauri-action writes: GITHUB_API_URL + the asset id, for draft and
# published releases alike), "download" for
#   https://github.com/<repo>/releases/download/<tag>/<asset>
# and fails for anything else. The comparison is a literal prefix match, so
# userinfo (`github.com@evil`), ports, lookalike hosts and other repositories
# never match; the remainder admits no `?`, `#`, `%` or dot-only segment, so
# neither a query nor a `..` that curl would normalise out of the repository.
manifest_url_kind() {
  local url=$1 rest
  local api_prefix="https://api.github.com/repos/$repo/releases/assets/"
  local download_prefix="https://github.com/$repo/releases/download/"
  if [[ $url == "$api_prefix"* ]]; then
    rest=${url#"$api_prefix"}
    [[ $rest =~ ^[0-9]+$ ]] && echo api
  elif [[ $url == "$download_prefix"* ]]; then
    rest=${url#"$download_prefix"}
    [[ $rest =~ ^[A-Za-z0-9._+~-]+/[A-Za-z0-9._+~-]+$ && ! $rest =~ (^|/)\.+(/|$) ]] && echo download
  else
    return 1
  fi
}

jq -r '.plugins.updater.pubkey' src-tauri/tauri.conf.json | base64 -d >"$workdir/updater.pub"

announced=$(jq -r '.version' "$manifest")
[[ $announced == "$version" ]] || fail "latest.json announces version $announced, expected $version"

for key in windows-x86_64 darwin-aarch64 darwin-x86_64 linux-x86_64; do
  jq -e --arg key "$key" '.platforms[$key]' "$manifest" >/dev/null ||
    fail "latest.json is missing the $key platform"
done

# Validate every URL before fetching any: a bad entry must not cost the
# remaining entries a request, and must never reach curl with the token.
while IFS=$'\t' read -r key url _; do
  manifest_url_kind "$url" >/dev/null ||
    fail "$key: the manifest URL '$url' is not an asset of $repo on github.com or api.github.com"
done < <(jq -r '.platforms | to_entries[] | [.key, .value.url, .value.signature] | @tsv' "$manifest")
((status == 0)) || exit 1

while IFS=$'\t' read -r key url signature; do
  artifact="$workdir/$key"
  printf '%s' "$signature" | base64 -d >"$artifact.minisig"
  # Only the API form takes the token. https only, for the request and every
  # redirect hop; no --location-trusted, so curl drops the Authorization
  # header on the redirect to storage (a different host).
  auth=()
  if [[ $(manifest_url_kind "$url") == api && -n ${GH_TOKEN:-} ]]; then
    auth=(-H "Authorization: Bearer $GH_TOKEN")
  fi
  curl -fsSL --retry 3 --proto '=https' --proto-redir '=https' "${auth[@]}" \
    -H "Accept: application/octet-stream" -o "$artifact" -- "$url"
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
