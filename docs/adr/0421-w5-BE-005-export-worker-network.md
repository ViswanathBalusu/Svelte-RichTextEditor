# ADR 0421: The network of the export worker in the demo stack (proposed)

Status: proposed. Lane w5, story BE-005; it also concerns UX-091 criterion 2. The lane decides
nothing here. Owner decision 60 ([owner decisions](../owner-decisions-2026-11-15.md)) answers the
question "Network of the export worker: the host's or none" with "None". The closing paragraph of the
same file lists two points of BE-005 as not settled, what "the export worker container" means and
whether `stack.ps1` counts as the compose file, and says to use the built behaviour meanwhile. This
record says what the built behaviour is, why decision 60 cannot simply be switched on, and what the
owner is asked.

## Context

The demo stack (`apps/reference-host/compose.json`) has two things that do export work.

1. The export worker process (`services/export-worker/src/main.ts`, the compose service
   `export-worker`). It claims `export` and `preview` jobs from the queue in PostgreSQL, reads the
   content of the job's `seq` from the database and the object store, converts it, starts one
   container for the compile through the machine's Podman socket, and writes the outputs to the
   object store. Its compose service has `network_mode: host`.
2. The compile container (`services/export-worker/src/sandbox.ts`, the image of the compose service
   `export-sandbox`). One per job, removed when the job ends, with `--network=none`, a read-only
   root, no capabilities and a non-root user. The bundle goes in on standard input and the outputs
   come back on standard output.

The specification describes both. 09 §9.5: "Stateless workers pull from the queue". 09 §9.3 rule 6:
a worker holds "a write-only, per-job upload location". 09 §9.3 rule 3: "Each job runs in its own
single-use sandbox ... with no network". So the worker of the specification reaches a queue and a
store, and the sandbox reaches nothing. BE-005 criterion 4 says "the export worker container ... has
no network access" and does not say which of the two it means; nor does UX-091 criterion 2.

The question put to the owner offered "the host's or none". The compile container already had none,
so the question was about the worker process, and the answer was "None".

## What is built

Unchanged by this record: the worker process has the network of its host, and the compile container
has none. On this development machine `stack.ps1` starts the worker as a local Node.js process, so
the only export container that exists while the stack runs is the compile container.

## Two readings of decision 60

A. The container in which a job is compiled has no network. The stack does this today.

B. The worker process has no network either. The stack does not do this: under Compose the
   `export-worker` service has the host's network, and under `stack.ps1` it is a process of the host.

Reading A alone would leave the answer "None" without effect, because nothing would change. So the
lane takes it that the owner asked for B, and does not tick criterion 4 on reading A.

## What reading B takes

A container without a network interface can use only what is mounted into it, which for a service
means Unix sockets.

- PostgreSQL offers one. A volume shared with the `postgres` service for `/var/run/postgresql`, and a
  database URL that names the socket directory, would do.
- Podman offers one, and the compose file already mounts it.
- The object store is not reached that way today. The compose file gives the gateway a TCP address
  (`VGW_PORT`), and `S3ObjectStore` sends its requests with `fetch`, which takes no socket path. It
  would take a relay that listens on a Unix socket and passes requests to the gateway, and a
  transport in the adapter that sends over a socket path.

The other way is to have no worker process at all: `startService({ jobHandlers })` already lets the
document service run the export handlers itself. The stack would then have no export process with a
network. The cost is that the converter runs in the process that hosts the rooms, which 06 §1 keeps
free of such work, and that the worker's own checks (the queue proof of EXP-067) are no longer
exercised by the demo.

Either way the result has to be run before it is believed: a worker container started with no
network that claims a job, compiles it in its own sandbox and stores the PDF. This machine cannot
run that. Its Podman is a WSL machine; the Node.js services of the stack run as processes because
Compose cannot pass `--cgroups=disabled` there, the demo image `localhost/docedit-demo-node:dev` has
never been built, and a worker inside a container could not apply the sandbox's cgroup limits (on
this machine they are applied by running Podman inside the machine through `podman machine ssh`,
the route of `DOCEDIT_PODMAN_MACHINE` in `services/export-worker/src/container.ts`). It needs a Linux
host with Podman and a Compose provider.

## Proposal

1. Leave the stack as built until it can be run where reading B can be shown. Do not change the
   compose file to a definition nobody has started.
2. For reading B, prefer the worker with sockets only over moving the handlers into the document
   service: it keeps the worker of 09 §9.5 and gives it less than it has now, where the other way
   gives the room host more to do.
3. BE-005 criterion 4 and UX-091 criterion 2 stay unticked until then. What is known today is in the
   Evidence of BE-005: the compile container has no network.

## Questions for the owner

1. Does "None" mean the compile container (reading A, as built) or the worker process as well
   (reading B)? If A, criterion 4 can be ticked on an inspection of the compile container of a
   running stack.
2. May a Compose provider for Podman be installed (part E of
   [the blockers list](../owner-blockers-2026-11-17.md))? Without one, criterion 1 of BE-005 rests on
   whether a start through `stack.ps1` counts as starting the compose file, which is the second
   unsettled point.
