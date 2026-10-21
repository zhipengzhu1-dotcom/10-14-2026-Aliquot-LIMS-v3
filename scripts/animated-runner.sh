#!/usr/bin/env bash
# CI's runners in Docker on the owner's Mac (docs/ci-runner.md). Each pass of a slot registers a just-in-time runner
# that takes one job in a fresh container and then deregisters, so no job sees another job's workspace.
# The registration comes from gh api at each pass and lives only in the container's arguments, never in a file.
# Every name here starts with animated-runner, so start, stop and status never touch another project's runners.
set -euo pipefail
REPO=zhipengzhu1-dotcom/10-14-2026-Aliquot-LIMS-v3
IMAGE=ghcr.io/actions/actions-runner:2.337.0@sha256:f5a0d9a3d857315f2aed7075a02a29f46927ad198221c3b1c66585ae9fe36c0d
SLOTS=(1 2)
LOGS="$HOME/Library/Logs/animated-runner"

# One line per running slot process: its pid, the script it runs, and that script's REPO.
slots() {
  local pid script
  for pid in $(pgrep -f 'animated-runner\.sh slot' || true); do
    script=$(ps -o args= -p "$pid" 2>/dev/null | sed -nE 's/^(caffeinate -i )?([^ ]*bash )?(.*animated-runner\.sh) slot [0-9]+$/\3/p' || true)
    [[ -n $script ]] || continue
    # start launches the slots as "$0", so a relative path is relative to the folder start ran in.
    [[ $script == /* ]] || script="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)/$script"
    # A slot's short-lived children, and other commands that mention the pattern, match too. Only a real script is a slot.
    [[ -f $script ]] || continue
    printf '%s\t%s\t%s\n' "$pid" "$script" "$(sed -n 's/^REPO=//p' "$script" 2>/dev/null)"
  done
}

runner_online() {
  local deadline=$((SECONDS + $1))
  until [[ -n $(gh api --paginate "repos/$REPO/actions/runners" \
    --jq '.runners[] | select((.name | startswith("animated-runner-")) and .status == "online") | .name') ]]; do
    ((SECONDS < deadline)) || return 1
    sleep 5
  done
}

case "${1:-}" in
  slot)
    SLOT=${2:?usage: scripts/animated-runner.sh slot 1|2}
    while true; do
      docker rm -f "animated-runner-$SLOT" >/dev/null 2>&1 || true
      # Docker stopped or image missing: wait here, so no runner registers that cannot start.
      docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null || { sleep 30; continue; }
      # runner_group_id 1 is the repo's Default runner group.
      CONFIG=$(gh api -X POST "repos/$REPO/actions/runners/generate-jitconfig" -f name="animated-runner-$SLOT-$(date +%s)" \
        -F runner_group_id=1 -f 'labels[]=self-hosted' -f 'labels[]=Linux' -f 'labels[]=ARM64' -f 'labels[]=animated' \
        --jq .encoded_jit_config) || { sleep 30; continue; }
      docker run --rm --name "animated-runner-$SLOT" "$IMAGE" ./run.sh --jitconfig "$CONFIG" || sleep 30
    done
    ;;
  start)
    # A second loop for a slot would remove the first loop's container mid-job.
    if pgrep -f 'animated-runner\.sh slot' >/dev/null; then
      echo "The slots are already running. Stop them first with the script that runs them:" >&2
      slots | cut -f2,3 | sort -u | awk -F'\t' '{ print "  \"" $1 "\" stop   (serves " ($2 == "" ? "no repo" : $2) ")" }' >&2
      exit 1
    fi
    mkdir -p "$LOGS"
    for n in "${SLOTS[@]}"; do
      # caffeinate holds off idle sleep while the slot runs. A sleeping Mac freezes the runner, and GitHub fails its job.
      nohup caffeinate -i "$0" slot "$n" >>"$LOGS/$n.log" 2>&1 &
    done
    runner_online 90 || { echo "No animated-runner came online on $REPO within 90 s. The slots keep trying, and a first image pull can take longer. Read the slot logs in $LOGS and check that Docker Desktop runs." >&2; exit 1; }
    ;;
  stop)
    # Removing a container mid-job fails that job, and GitHub then refuses to delete its runner.
    if [[ ${2:-} != --force ]]; then
      busy=$(gh api --paginate "repos/$REPO/actions/runners" \
        --jq '.runners[] | select((.name | startswith("animated-runner-")) and .busy) | .name') ||
        { echo "Could not read the runners on $REPO, so stop cannot tell whether a job runs. Run stop --force to stop anyway." >&2; exit 1; }
      if [[ -n $busy ]]; then
        echo "A job is running on $(echo $busy), and stop would fail it. Wait until status shows no runner as busy, or run stop --force." >&2
        exit 1
      fi
    fi
    pkill -f 'animated-runner\.sh slot' || true
    for n in "${SLOTS[@]}"; do docker rm -f "animated-runner-$n" >/dev/null 2>&1 || true; done
    gh api --paginate "repos/$REPO/actions/runners" --jq '.runners[] | select(.name | startswith("animated-runner-")) | .id' |
      while read -r id; do gh api -X DELETE "repos/$REPO/actions/runners/$id" || echo "runner $id not deleted" >&2; done
    ;;
  status)
    gh api --paginate "repos/$REPO/actions/runners" --jq '.runners[] | [.name, .status, .busy] | @tsv'
    if pgrep -f '^caffeinate -i .*animated-runner\.sh slot' >/dev/null; then echo "The slots keep the Mac awake."
    else echo "No slot keeps the Mac awake. Run stop, then start." >&2; exit 1; fi
    wrong=$(slots | awk -F'\t' -v repo="$REPO" '$3 != repo' | cut -f2,3 | sort -u)
    if [[ -n $wrong ]]; then
      while IFS=$'\t' read -r script repo; do
        echo "The slots run $script, which serves ${repo:-no repo}, not $REPO. Run \"$script\" stop, then start from the runner worktree (docs/ci-runner.md)." >&2
      done <<<"$wrong"
      exit 1
    fi
    # A JIT runner deregisters after its job and the next pass registers a new one, so a few seconds without one is normal.
    runner_online 30 || { echo "The slots run but no animated-runner is online on $REPO. Read the slot logs in $LOGS." >&2; exit 1; }
    ;;
  *) echo "usage: scripts/animated-runner.sh start|status|stop [--force]|slot 1|2" >&2; exit 2 ;;
esac
