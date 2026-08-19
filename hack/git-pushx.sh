#!/usr/bin/env bash
# Push as whichever GitHub account owns this repo's remote, then switch back.
#
# gh's git credential helper follows the *active* account, so pushing to a repo
# owned by a different signed-in account fails — and because the repo is
# private, GitHub answers 404 rather than 403, so the error reads "Repository
# not found" instead of "wrong account".
#
# The switch back runs on every exit path, including a failed push and Ctrl-C.
# Leaving the wrong account active is exactly the confusion this avoids.
#
# Usage: git pushx [any git push arguments]
set -uo pipefail

host=github.com
remote=${GIT_PUSHX_REMOTE:-origin}

url=$(git remote get-url "$remote" 2>/dev/null) || {
	echo "pushx: no remote named '$remote'" >&2
	exit 1
}

# Owner from either https://github.com/<owner>/<repo> or git@github.com:<owner>/<repo>
owner=$(printf '%s\n' "$url" | sed -E 's#^[^:]+://([^@]*@)?[^/]+/##; s#^[^:]+:##; s#/.*$##')
if [ -z "$owner" ]; then
	echo "pushx: could not read an owner from $url" >&2
	exit 1
fi

previous=$(gh auth status --active --json hosts --jq ".hosts[\"$host\"][0].login" 2>/dev/null || true)

restore() {
	if [ -n "$previous" ] && [ "$previous" != "$owner" ]; then
		gh auth switch --hostname "$host" --user "$previous" >/dev/null 2>&1 ||
			echo "pushx: could not switch back to $previous — run: gh auth switch --user $previous" >&2
	fi
}

if [ -n "$previous" ] && [ "$previous" != "$owner" ]; then
	if ! gh auth switch --hostname "$host" --user "$owner" >/dev/null 2>&1; then
		echo "pushx: not signed in as $owner — run: gh auth login --user $owner" >&2
		exit 1
	fi
	trap restore EXIT INT TERM
	echo "pushx: pushing as $owner (was $previous)" >&2
fi

git push "$@"
