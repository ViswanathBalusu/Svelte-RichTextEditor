// Not a test file, and no longer a sequence of its own (FE-063, fixer round 6): the register-then-wait
// sequence moved into product code (`worker-fonts.ts`, `measureHandler`), and the worker the editor
// starts is `measure-worker.ts`. This entry only loads that worker, for any caller that still names
// this path.
import './measure-worker.ts';
