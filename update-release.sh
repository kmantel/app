#!/usr/bin/env bash
if [[ -f "$HOME/.bashrc" ]]; then
    source "$HOME/.bashrc"
fi

USAGE="Usage: "$(basename "$0")" [-l list versions][-v <version>][-h]"

if [ $# -eq 0 ]; then
    echo "$USAGE"
    exit 0
fi

update_prefix="update"
latest_web=""

while getopts "lv:h" opt; do
  case $opt in
    l)
        git tag | grep @standardnotes/web | sort -V
        exit 0
        ;;
    v)
        latest_web="$OPTARG"
        ;;
    h)
        echo "$USAGE"
        exit 0
        ;;
    :)
        echo "option requires an argument -- $OPTARG"
        echo "$USAGE"
        exit 1
        ;;
    \?)
        echo "Invalid option -$OPTARG" >&2
        echo "$USAGE"
        exit 1
        ;;
  esac
done


if [[ -n "$latest_web" ]]; then
    latest_web="$latest_web"
else
    latest_web=$(git tag | grep @standardnotes/web | sort -V | tail -n 1)
fi
version_branch="$update_prefix-$(echo "$latest_web" | sed -r 's;.*@(.*);\1;')"

base_branch="$(git rev-parse --abbrev-ref HEAD)"
echo "Updating to $version_branch from $base_branch"

git checkout -b "$version_branch" 2>/dev/null
if (( $? )); then
    git checkout "$version_branch"
    git reset --hard "$base_branch"
fi
git rebase "$latest_web"
if (( $? )); then
    exit 1
fi
git push --set-upstream origin
