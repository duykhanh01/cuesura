#!/usr/bin/env bash
# Print one CI verdict for a PR's head commit: GREEN RED PENDING NO_RUN DIRTY DRAFT MERGED CLOSED.
# Requires: gh (authenticated) and jq.
# Usage: pr-ci.sh <pr> [--wait [timeout_min]]   (run inside the repo, or set GH_REPO)
# Exit: 0 GREEN/MERGED, 1 RED, 2 NO_RUN/DIRTY/DRAFT/CLOSED, 3 still PENDING at timeout, 4 error.
set -euo pipefail

pr=${1:?usage: pr-ci.sh <pr> [--wait [timeout_min]]}
wait=0 timeout_min=45
if [[ ${2:-} == --wait ]]; then wait=1; timeout_min=${3:-45}; fi

# Checks with an empty workflow are external statuses (e.g. secret scanners); they pass even when
# no Actions run happened, so in a repo with active workflows they cannot prove CI ran.
classify() {
  jq -r --argjson wf "${1:-0}" '
    def actions: map(select(.workflow != ""));
    if length == 0 then "NO_RUN"
    elif any(.[]; .bucket == "pending") then "PENDING"
    elif any(.[]; .bucket == "fail") then
      "RED " + ([.[] | select(.bucket == "fail") | "\(.name) \(.link)"] | join(" | "))
    elif (actions | length) == 0 and $wf == 0 then "GREEN"
    elif any(actions[]; .bucket == "pass") then "GREEN"
    else "NO_RUN " + ([actions[] | "\(.name)=\(.bucket)"] | join(" "))
    end'
}

verdict() {
  local info sha checks
  info=$(gh pr view "$pr" --json state,isDraft,mergeable,headRefOid) || { echo ERROR; return; }
  sha=$(jq -r '.headRefOid[0:7]' <<<"$info")
  case $(jq -r '.state' <<<"$info") in
    MERGED) echo "MERGED head=$sha"; return;;
    CLOSED) echo "CLOSED head=$sha"; return;;
  esac
  [[ $(jq -r .isDraft <<<"$info") == true ]] && { echo "DRAFT head=$sha"; return; }
  [[ $(jq -r .mergeable <<<"$info") == CONFLICTING ]] && { echo "DIRTY head=$sha"; return; }
  # `gh pr checks` exits non-zero for pending, failing or missing checks; only its JSON matters.
  checks=$(gh pr checks "$pr" --json name,bucket,workflow,link 2>/dev/null || true)
  echo "$(classify "$workflows" <<<"${checks:-[]}") head=$sha"
}

[[ ${PR_CI_CLASSIFY_ONLY:-} ]] && { classify "$PR_CI_CLASSIFY_ONLY"; exit; }

workflows=$(gh api 'repos/{owner}/{repo}/actions/workflows' \
  --jq '[.workflows[] | select(.state == "active")] | length' 2>/dev/null || echo 0)

deadline=$(( $(date +%s) + timeout_min * 60 ))
while :; do
  v=$(verdict)
  [[ $wait == 1 && $v == PENDING* && $(date +%s) -lt $deadline ]] || break
  sleep 30
done
echo "PR #$pr $v"
case ${v%% *} in
  GREEN|MERGED) exit 0;;
  RED) exit 1;;
  PENDING) exit 3;;
  ERROR) exit 4;;
  *) exit 2;;
esac
