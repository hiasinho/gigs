#!/bin/sh
# Installs the gig binary from GitHub releases (https://github.com/hiasinho/gigs/releases):
#
#   curl -fsSL https://raw.githubusercontent.com/hiasinho/gigs/main/install.sh | sh
#
# GIG_VERSION=v0.1.0 picks a release (default: the latest); GIG_INSTALL_DIR the directory
# (default: ~/.local/bin). The download is checked against the release's SHA256SUMS.
# Later updates: `gig upgrade`.
set -eu

repo="https://github.com/hiasinho/gigs/releases"
dir="${GIG_INSTALL_DIR:-$HOME/.local/bin}"

fail() { echo "install.sh: $*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "no gig release for $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "no gig release for $(uname -m)" ;;
esac
asset="gig-$os-$arch"

# The latest release's tag, from where /releases/latest redirects (no API rate limit).
version="${GIG_VERSION:-}"
if [ -z "$version" ]; then
  version="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$repo/latest")"
  version="${version##*/}"
  case "$version" in v*) ;; *) fail "could not find the latest release" ;; esac
fi

if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$1"; }
elif command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 "$1"; }
else fail "need sha256sum or shasum to check the download"; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset $version ..."
curl -fsSL -o "$tmp/$asset" "$repo/download/$version/$asset" || fail "no $asset in release $version"
curl -fsSL -o "$tmp/SHA256SUMS" "$repo/download/$version/SHA256SUMS" || fail "release $version has no SHA256SUMS"

want="$(awk -v a="$asset" '$2 == a || $2 == "*" a { print $1 }' "$tmp/SHA256SUMS")"
got="$(sha "$tmp/$asset" | awk '{ print $1 }')"
[ -n "$want" ] || fail "SHA256SUMS of $version has no entry for $asset"
[ "$got" = "$want" ] || fail "checksum mismatch for $asset (got $got, want $want); nothing installed"

mkdir -p "$dir"
chmod 755 "$tmp/$asset"
mv "$tmp/$asset" "$dir/gig"
echo "Installed $("$dir/gig" --version) to $dir/gig"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Note: $dir is not on your PATH. Add it, e.g.: export PATH=\"$dir:\$PATH\"" ;;
esac
