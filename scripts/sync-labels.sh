#!/bin/sh
# Creates or updates the repo labels listed in .github/labels.tsv (name<TAB>color<TAB>description).
# Labels not in the file are left alone. Needs `gh` with write access to the repo.
set -eu
while IFS="$(printf '\t')" read -r name color description; do
  gh label create "$name" --color "$color" --description "$description" --force
done < "$(dirname "$0")/../.github/labels.tsv"
