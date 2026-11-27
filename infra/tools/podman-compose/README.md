# podman-compose, pinned (BE-005, BE-007)

`podman compose` needs a Compose provider. The owner approved podman-compose from PyPI on 2026-11-27
(decision 230 of `docs/owner-decisions-2026-11-26.md`, with the download approval of that day).

- Version 1.6.0, with python-dotenv 1.2.4 and pyyaml 6.0.4. `requirements.txt` holds the SHA-256 of
  each file, and pip is run with `--require-hashes`, so a changed file fails the install.
- Source: https://pypi.org/project/podman-compose/1.6.0/ (GPL-2.0-only; developers and CI run it, nothing
  of it is shipped or linked).
- Sizes: podman_compose-1.6.0-py3-none-any.whl 53722 bytes; python_dotenv-1.2.4-py3-none-any.whl 23266
  bytes; pyyaml-6.0.4 161819 bytes (CPython 3.11, win_amd64) or 819491 bytes (CPython 3.14, manylinux x86_64).

## Install

On Linux or macOS, or in a Podman machine:

    python3 -m venv ~/podman-compose && ~/podman-compose/bin/python -m pip install --require-hashes --no-deps -r requirements.txt

On Windows, `install.ps1` does the same into `.venv` here (ignored by git). Windows is not a place to
run it, though: podman-compose 1.6.0 takes a path with a drive letter for a Git URL, and then gives
`podman build` no `-f` (`is_context_git_url`). Run it inside the Podman machine, where the repository is
under `/mnt/<drive>/`.

## Starting the demo stack in a WSL Podman machine

Compose cannot pass `--cgroups=disabled`, which that machine needs, but podman-compose can:

    podman-compose --in-pod=false --podman-run-args=--cgroups=disabled -p <project> \
      -f apps/reference-host/compose.json --env-file <your env file> up -d --build

- Without `--in-pod=false` the pod's cgroup cannot be created.
- The services read their ports and credentials from `DOCEDIT_DEMO_ENV_FILE` (the compose file's
  `env_file`; default `apps/reference-host/stack/.env.example`). Give both `--env-file` and
  `DOCEDIT_DEMO_ENV_FILE` the same file when you change a port or the project name, or the services
  run on the defaults.
- The export worker starts its compile containers through a Podman socket. The machine's own
  socket gives the sandbox the default mounts of the machine (`/run/secrets`), which the worker refuses.
  Start a second service and point `DOCEDIT_DEMO_PODMAN_SOCKET` at it:

      podman --cgroup-manager=cgroupfs --default-mounts-file /dev/null system service --time=0 unix:///run/podman-w5.sock
      chgrp 10 /run/podman-w5.sock; chmod 660 /run/podman-w5.sock

  and put `DOCEDIT_CONTAINER_CGROUPS=disabled` in the env file (the machine has no cgroup controllers).
  The worker container joins the socket's group with `DOCEDIT_DEMO_PODMAN_SOCKET_GID` (default 10, the
  machine's `wheel`).
- Starting the stack a second time while it runs, or after `down`, can fail on a one-shot dependency
  ("container state improper"); `down -v` and a fresh `up` work.
