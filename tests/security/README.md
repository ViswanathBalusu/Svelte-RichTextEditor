# Security proofs

Black-box tests for the threat model of 10 (PLAN-1a packet F and PLAN-1b packet F). Each test file proves one story's claim against the real service, room or component, and names the story it ticks. They run with the Node.js tests (`pnpm test`); tests that need the integration environment (`infra/test-env.ps1`) skip with a reason when it is down.
