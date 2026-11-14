/**
 * `@docedit/tck`: the DEP conformance kit (05 §11; R6). Given a discovery URL, a service credential
 * and the state of the server's test-mode switch, it creates its own documents and users, runs the
 * profiles whose features the server announces, and reports every scenario with its result.
 *
 *   const report = await runKit({ discovery: 'https://docs.example.com', credential, testMode: false });
 *   console.log(renderText(report));
 *
 * The kit speaks DEP itself, with the protocol package's codec and definition only: it imports no
 * code of the component and reaches the server only through its public interfaces (PRO-108).
 */
export { runKit, runScenario, notApplicable, unmetNeeds, KIT_VERSION } from './runner.ts';
export { resolveConfig, discoveryUrl, type KitConfig, type ResolvedConfig } from './config.ts';
export { bootstrap, BootstrapError, ScenarioContext, type Target } from './context.ts';
export {
  renderText,
  type KitReport,
  type ProfileResult,
  type ScenarioResult,
  type Outcome,
} from './report.ts';
export { PROFILES, CORE } from './profiles/index.ts';
export type { Coverage, Needs, ProfileDef, ProfileRequirement, ScenarioDef } from './scenario.ts';
export { KitFailure, KitSkip } from './assert.ts';
export { Wire, type WireOptions } from './wire.ts';
export { Http, ServiceClient, type GrantSpec, type HttpResponse } from './rest.ts';
export { portHarness, type BackendFactory } from './harness.ts';
