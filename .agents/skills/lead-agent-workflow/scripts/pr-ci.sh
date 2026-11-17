#!/usr/bin/env bash
# Current-head verdict, including external checks. Requires authenticated gh and jq.
# Usage: pr-ci.sh PR --policy FILE [--wait [minutes]]
# Exit: 0 GREEN/MERGED, 1 RED, 2 unavailable, 3 PENDING, 4 ERROR.
set -euo pipefail

pr=${1:?usage: pr-ci.sh PR --policy FILE [--wait [minutes]]}
shift
wait=0 timeout_min=45 policy=${PR_CI_POLICY:-}
while (($#)); do
  case $1 in
    --policy) policy=${2:?--policy needs a file}; shift 2;;
    --wait)
      wait=1; shift
      if (($#)) && [[ $1 != --* ]]; then timeout_min=$1; shift; fi;;
    *) echo "ERROR unknown option: $1"; exit 4;;
  esac
done
[[ $timeout_min =~ ^[1-9][0-9]*$ && -f $policy ]] || { echo 'ERROR policy file and positive timeout required'; exit 4; }
if ! jq -e '
  type == "object" and
  (.expected | type == "array" and length > 0 and all(.[]; type == "string" and length > 0)) and
  (.allow_skipped | type == "array" and all(.[]; type == "string" and length > 0)) and
  (.expected | length == (unique | length)) and
  (.allow_skipped | length == (unique | length))
' "$policy" >/dev/null; then echo 'ERROR invalid policy'; exit 4; fi

classify() {
  jq -er --slurpfile policy "$policy" '
    $policy[0] as $p |
    if type != "array" then error("checks must be an array")
    elif any(.[]; (.name | type != "string" or length == 0) or
                   (.bucket | IN("pass", "fail", "pending", "cancel", "skipping") | not))
      then error("invalid check record")
    elif (map(.name) | length != (unique | length)) then error("ambiguous check names: " +
      ([group_by(.name)[] | select(length > 1) | .[] |
        "\(.name) source=\(.source // "unknown") app=\(.app_id // "unknown") id=\(.check_id // "unknown") \(.link // "")"] | join(" | ")))
    elif any(.[]; .bucket == "fail" or .bucket == "cancel") then
      "RED " + ([.[] | select(.bucket == "fail" or .bucket == "cancel") |
        "\(.name)=\(.bucket) \(.link // "")"] | join(" | "))
    elif any(.[]; .bucket == "pending") then "PENDING"
    elif ($p.expected - map(.name) | length) > 0 then
      "NO_RUN missing=" + ($p.expected - map(.name) | join(","))
    elif any(.[]; .bucket == "skipping" and (.name as $name | $p.allow_skipped | index($name) | not))
      then "NO_RUN unapproved-skips=" + ([.[] | select(.bucket == "skipping") | .name] | join(","))
    else "GREEN" end'
}

if [[ ${PR_CI_CLASSIFY_ONLY:-} ]]; then
  classify || { echo ERROR; exit 4; }
  exit 0
fi

read_info() {
  gh pr view "$pr" --json state,isDraft,mergeable,headRefOid |
    jq -ec 'select((.state | IN("OPEN", "CLOSED", "MERGED")) and
                  (.isDraft | type == "boolean") and
                  (.mergeable | IN("MERGEABLE", "CONFLICTING", "UNKNOWN")) and
                  (.headRefOid | test("^[0-9a-f]{40}$")))'
}

verdict() {
  local info sha after runs statuses checks result
  info=$(read_info) || { echo 'ERROR PR query'; return; }
  sha=$(jq -r .headRefOid <<<"$info")
  case $(jq -r .state <<<"$info") in
    MERGED) echo "MERGED head=$sha"; return;;
    CLOSED) echo "CLOSED head=$sha"; return;;
  esac
  [[ $(jq -r .isDraft <<<"$info") == true ]] && { echo "DRAFT head=$sha"; return; }
  [[ $(jq -r .mergeable <<<"$info") == CONFLICTING ]] && { echo "DIRTY head=$sha"; return; }
  [[ $(jq -r .mergeable <<<"$info") == UNKNOWN ]] && { echo "PENDING mergeability head=$sha"; return; }
  # REST failures remain errors. Paginate so an external status cannot hide beyond the first page.
  runs=$(gh api --paginate --slurp "repos/{owner}/{repo}/commits/$sha/check-runs?filter=latest&per_page=100") || {
    echo "ERROR check-runs query head=$sha"; return;
  }
  statuses=$(gh api --paginate --slurp "repos/{owner}/{repo}/commits/$sha/status?per_page=100") || {
    echo "ERROR status query head=$sha"; return;
  }
  checks=$(jq -ecn --argjson runs "$runs" --argjson statuses "$statuses" '
    if ($runs | type != "array" or length == 0 or any(.[]; .check_runs | type != "array")) or
       ($statuses | type != "array" or length == 0 or any(.[]; .statuses | type != "array")) then
      error("invalid API response") else
    [ $runs[].check_runs[] |
      {name: .name, link: .html_url, source: "check-run", app_id: .app.id, check_id: .id,
       bucket: (if .status != "completed" then
                  if (.status | IN("queued", "in_progress", "waiting", "pending", "requested")) then "pending"
                  else "unknown" end
                elif .conclusion == "success" then "pass"
                elif .conclusion == "skipped" then "skipping"
                elif .conclusion == "cancelled" then "cancel"
                elif (.conclusion | IN("failure", "timed_out", "action_required", "startup_failure", "stale")) then "fail"
                else "unknown" end)} ] +
    [ $statuses[].statuses[] |
      {name: .context, link: .target_url, source: "commit-status",
       bucket: (if .state == "success" then "pass" elif .state == "pending" then "pending"
                elif (.state | IN("failure", "error")) then "fail" else "unknown" end)} ] end') || {
    echo "ERROR malformed checks head=$sha"; return;
  }
  result=$(classify <<<"$checks") || { echo "ERROR classify head=$sha"; return; }
  after=$(read_info) || { echo "ERROR final PR query head=$sha"; return; }
  if [[ $(jq -r .headRefOid <<<"$after") != "$sha" ]]; then
    echo "PENDING head-changed old=$sha head=$(jq -r .headRefOid <<<"$after")"; return
  fi
  if [[ $info != "$after" ]]; then
    echo "PENDING PR-state-changed head=$sha"; return
  fi
  echo "$result head=$sha"
}

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
