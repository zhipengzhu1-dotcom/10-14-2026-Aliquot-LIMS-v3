# CI runners

CI runs on self-hosted GitHub Actions runners in Docker on the owner's Mac, never on GitHub-hosted runners. `.github/workflows/ci.yml` sends its jobs to the runner labels `self-hosted` and `animated`. While no runner is online, a job waits in the queue.

The containers are Linux, so CI tests Aliquot on Linux only. Windows and macOS are not covered by CI.

## How it works

`scripts/animated-runner.sh start` starts two slots, `1` and `2`, so the Node 22.13.0 and Node 24 jobs of a run can run at once. Each slot is a loop on the Mac:

1. It asks GitHub for a just-in-time runner configuration with `gh api`. The configuration registers one ephemeral runner, `animated-runner-<slot>-<time>`, which takes one job and then deregisters.
2. It starts a fresh container, `animated-runner-<slot>`, with that configuration as an argument.
3. The job checks out the repo, installs its Node version, and runs `npm run check` and `npm test`.
4. When the job ends, the container exits and Docker removes it (`--rm`), with its workspace. The loop starts again at step 1.

The loop is the restart policy. A Docker restart policy restarts the same container, which keeps the last job's files and holds a registration that GitHub has already deleted.

The image is GitHub's stock `ghcr.io/actions/actions-runner`, pinned by digest for linux/arm64 in the script's `IMAGE` line. Aliquot's tests need only Node and its built-ins, so there is no Dockerfile. A slot pulls the image on its first pass if Docker does not have it. The jobs use no Docker of their own, so the container gets no Docker socket. The socket would give every job control of the Mac's Docker.

## Before the first start

You need:

- Docker Desktop running.
- The GitHub CLI signed in as an admin of `zhipengzhu1-dotcom/10-14-2026-Aliquot-LIMS-v3`. Check with `gh auth status`.

The registration comes from `gh api` at each pass of the loop and passes to the container as an argument. The script writes it to no file, and the runner masks it in the slot log. While its container runs, `ps` on the Mac and `docker inspect` show it, Docker keeps it in the container's configuration inside its VM disk, and the job can read it. That exposure is accepted because the registration admits one runner for one job, and the container's removal deletes it.

A job runs the pull request's code on the Mac. Its container cannot see another job's container, but it can reach services on the Mac through `host.docker.internal`, such as the public demo on port 3003. That exposure is accepted because the repo is private and every pull request comes from the owner or the owner's agents.

## The runner worktree

The runners run from their own worktree of this repo's `main`, at `~/Desktop/Claude/10. October 2026/aliquot-ci-runner`. Never run them from the live copy (see *The public demo* in `README.md`). It serves the public demo and is not a checkout of this repo, so its script registers runners on a retired repo, and this repo's jobs wait in the queue.

Make the worktree once, from any clone of this repo:

```sh
git fetch origin
git worktree add --detach ~/Desktop/Claude/10.\ October\ 2026/aliquot-ci-runner origin/main
```

To update it, stop the runners, move the worktree to the latest `main`, and start them again. Run the script from the worktree's top folder, because `status` and `start` find the repo a slot serves from the folder it runs in.

```sh
cd ~/Desktop/Claude/10.\ October\ 2026/aliquot-ci-runner
scripts/animated-runner.sh stop
git fetch && git checkout --detach origin/main
scripts/animated-runner.sh start
```

## Start the runners

Run this in the runner worktree:

```sh
scripts/animated-runner.sh start
```

Each slot registers its runner and starts its container. `start` then waits up to 90 seconds for a runner to come online on the repo. If none does, it exits 1 and points at the slot logs and Docker Desktop. The slots keep running after you close the terminal. They stop when the Mac restarts, so run `start` again after a restart. `start` refuses while the slots are still running, because a second loop would remove the first loop's container mid-job. The refusal names the folder the slots run from and the repo they serve, so run `stop` in that folder. While Docker Desktop is stopped, each slot waits and registers no runner.

Each slot runs under `caffeinate -i`, which holds off idle sleep while the slots run, on battery as well as on power. A sleeping Mac freezes the Docker VM and the runner inside it, and GitHub fails the job 10 minutes after the runner's last heartbeat. A closed lid, Sleep in the Apple menu and a flat battery still sleep the Mac, so run `stop` before any of them. `stop` also releases the hold.

## Check the runners

```sh
scripts/animated-runner.sh status
```

It prints one line for each runner registered to the repo, with its name, `online` or `offline`, and whether it is running a job. Then it says whether the slots keep the Mac awake. It exits 1 when no slot runs under `caffeinate`, for example when the slots are stopped. It also exits 1 in two other cases:

- A slot runs from a folder whose script serves another repo, such as the live copy. The message names the folder and that repo. Run `stop` in that folder, then `start` in the runner worktree.
- The slots run but no `animated-runner-*` runner is online on the repo. Each runner deregisters after its job and the next pass registers a new one, so `status` checks again for up to 30 seconds before it fails.

Each slot's log is in `~/Library/Logs/animated-runner/<slot>.log`, and `docker ps --filter name=animated-runner-` shows the containers.

## Stop the runners

```sh
scripts/animated-runner.sh stop
```

It stops the slot loops, removes the containers, and deletes the `animated-runner-*` registrations from the repo. A job that is running is cancelled, and GitHub shows it as failed. To let running jobs finish first, wait until `status` shows no runner as busy.

## Update the image

GitHub refuses a runner that is too far behind its latest release, so update the digest when a new runner version comes out.

1. Find the new arm64 digest:

   ```sh
   docker buildx imagetools inspect ghcr.io/actions/actions-runner:latest
   ```

   Copy the digest of the `linux/arm64` manifest into the `IMAGE` line of `scripts/animated-runner.sh`, and set the tag to the runner version it holds:

   ```sh
   docker run --rm ghcr.io/actions/actions-runner@<digest> ./config.sh --version | grep -x '[0-9.]*'
   ```

2. Push the change to `main`, then update the runner worktree as *The runner worktree* says. Each slot pulls the new image on its first pass.

## Beside other projects' runners

The Mac's Docker also runs other projects' runners. This set shares no name with them: its containers, runners, label and log folder all start with `animated`, and the script matches only its own `animated-runner.sh slot` processes, so its `start`, `stop` and `status` never see or stop another set. All sets share the Mac's Docker VM and its memory.
