#!/bin/bash
# A draft release has no public asset URL. On candidate branches, independently
# rebuild it and pass the verified bytes through the installer's resume path.
set -euo pipefail
umask 077

[[ ${GITHUB_ACTIONS:-} == true && -n ${DEFAULT_BRANCH:-} ]]
[[ ${GITHUB_REF:-} != "refs/heads/$DEFAULT_BRANCH" ]]
[[ ! -e "$HOME/.local/bin/mosaic" ]]

read_version() {
  sed -nE "s/^my \\\$version = '(0\\.1\\.0-beta\\.[0-9]+)';$/\\1/p" "$1"
}
read_digest() {
  sed -nE "s/^my \\\$archive_sha = '([0-9a-f]{64})';$/\\1/p" "$1"
}
version=$(read_version install.sh)
digest=$(read_digest install.sh)
[[ -n $version && -n $digest ]]
asset="mosaic-beta-$version-darwin-arm64.tar.gz"
release_base="https://github.com/TanujBuilds/Mosaic/releases/download"
status=$(curl -q -sSLI --retry 2 --max-time 60 -o /dev/null -w '%{http_code}' "$release_base/v$version/$asset")
case "$status" in
  200) echo "Published archive available. Testing its public download."; exit 0 ;;
  404) ;;
  *) echo "Could not determine release availability (HTTP $status)." >&2; exit 1 ;;
esac

stage=$(mktemp -d /private/tmp/mosaic-candidate.XXXXXXXX)
trap 'rm -rf "$stage"' EXIT
git fetch --quiet --no-tags --depth=1 origin "refs/heads/$DEFAULT_BRANCH"
git show FETCH_HEAD:install.sh > "$stage/public-installer"
base_version=$(read_version "$stage/public-installer")
base_digest=$(read_digest "$stage/public-installer")
[[ -n $base_version && -n $base_digest && $base_version != "$version" ]]
base_name="mosaic-beta-$base_version-darwin-arm64"
curl -q -fsSL --retry 3 --max-time 300 "$release_base/v$base_version/$base_name.tar.gz" -o "$stage/input.tar.gz"
(cd "$stage" && echo "$base_digest  input.tar.gz" | shasum -a 256 -c -)
runtime="$stage/$base_name/payload/runtime"
tar -xpf "$stage/input.tar.gz" -C "$stage" "$base_name/payload/runtime/bin/node" "$base_name/payload/runtime/NODE-LICENSE" "$base_name/payload/runtime/check-artifact"

(
  umask 022
  npm ci --ignore-scripts --no-audit --no-fund
  node scripts/package-beta.mjs --version "$version" --output "$stage/pack" --offline \
    --node "$runtime/bin/node" --node-license "$runtime/NODE-LICENSE" --check-artifact "$runtime/check-artifact"
)
(cd "$stage/pack" && echo "$digest  $asset" | shasum -a 256 -c -)
cache="$HOME/Library/Caches/Mosaic Beta Installer"
mkdir -p "$cache"
[[ ! -e "$cache/$asset.part" ]]
install -m 600 "$stage/pack/$asset" "$cache/$asset.part"
echo "Testing installation of the exact staged candidate. Public download awaits publication."
