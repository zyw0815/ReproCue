#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'ReproCue: %s\n' "$1" >&2
  exit 1
}

branch=reprocue-pages
report_path="$REPROCUE_REPORT_PATH"
report_file="$REPROCUE_REPORT_FILE"
seed_directory="${REPROCUE_SEED_DIRECTORY:-}"
if [[ ! "$report_path" =~ ^reports/pr-[1-9][0-9]*/[a-f0-9]{40}/[1-9][0-9]*-[1-9][0-9]*/index\.html$ ]]; then
  fail 'Expected a PR-, commit-, and run-specific report path.'
fi
if [[ ! -f "$report_file" || -L "$report_file" || ! -s "$report_file" ]]; then
  fail 'Expected the prepared HTML report.'
fi

workspace="$(cd -- "$GITHUB_WORKSPACE" && pwd -P)"
snapshot="$(mktemp -d "$RUNNER_TEMP/reprocue-pages.XXXXXXXX")"
archive="$snapshot/archive"
ref="refs/heads/$branch"
if git -C "$workspace" ls-remote --exit-code origin "$ref" >/dev/null; then
  git -C "$workspace" fetch --depth=1 origin "$ref"
  git -C "$workspace" worktree add --detach "$archive" FETCH_HEAD
else
  if [[ "$?" != 2 ]]; then
    fail 'Could not read the Pages archive branch from origin.'
  fi
  git -C "$workspace" worktree add --detach --no-checkout "$archive" HEAD
  git -C "$archive" switch --orphan "$branch"
  if [[ -n "$seed_directory" ]]; then
    [[ "$seed_directory" != /* ]] || fail 'The seed directory must be relative to the default branch checkout.'
    seed="$(cd -- "$workspace/$seed_directory" && pwd -P)"
    [[ "$seed" == "$workspace/"* ]] || fail 'The seed directory must be inside the default branch checkout.'
    mkdir -p -- "$archive/site"
    cp -R -- "$seed/." "$archive/site/"
  fi
fi

site="$archive/site"
mkdir -p -- "$site"
if [[ -n "$(find "$site" ! -type d ! -type f -print -quit)" ]]; then
  fail 'The archived site must contain only directories and regular files.'
fi

destination="$site/$report_path"
if [[ -e "$destination" ]]; then
  cmp -s -- "$report_file" "$destination" || fail 'Different content is already archived at this report address.'
else
  mkdir -p -- "$(dirname -- "$destination")"
  cp -- "$report_file" "$destination"
fi

git -C "$archive" add --force -- site
if ! git -C "$archive" diff --cached --quiet; then
  git -C "$archive" -c user.name='github-actions[bot]' \
    -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit -m "Archive $report_path"
  git -C "$archive" push origin "HEAD:$ref"
fi
printf 'site-path=%s\n' "$site" >> "$GITHUB_OUTPUT"
