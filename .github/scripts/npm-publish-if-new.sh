#!/usr/bin/env bash
# Publish the package in the current directory unless its exact version is
# already on the registry.
#
# Usage: npm-publish-if-new.sh [tarball]
#   Name and version come from ./package.json. With no argument this runs a
#   plain `npm publish`; pass the .tgz from `pnpm pack` to publish that instead.
#
# npm refuses to publish the same version twice, so an interrupted release
# can only be finished by skipping what already went out. The registry
# lookup has three outcomes:
#   - prints the version             -> published, skip
#   - E404, or exit 0 with no output -> not published (newer npm exits 1 with
#                                       E404 for a missing version, older npm
#                                       exits 0 and prints nothing)
#   - any other failure              -> abort; a network or auth error must not
#                                       be read as "not published"
set -euo pipefail

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")

err_file=$(mktemp)
trap 'rm -f "$err_file"' EXIT

if published=$(npm view "$name@$version" version 2>"$err_file"); then
  if [ "$published" = "$version" ]; then
    echo "skip: $name@$version already published"
    exit 0
  fi
elif ! grep -q 'E404' "$err_file"; then
  cat "$err_file" >&2
  echo "error: could not check whether $name@$version is published" >&2
  exit 1
fi

echo "Publishing $name@$version..."
npm publish "$@" --access public --provenance
