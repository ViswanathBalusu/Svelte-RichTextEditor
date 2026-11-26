/**
 * The `forms` part of the editing core (FND-008; ./parts.ts): the entries a person types into form
 * fields and the checks behind them (`field-entries.ts`, which reach `@docedit/rules` through
 * `@docedit/authority`). A document with no form field never loads it.
 *
 * The web view's drawing of the fields (`view/form-field-view.ts`) is loaded with it by the views
 * (`view/web.ts`), not here, so that the headless entry holds no DOM code (FE-121).
 */
export { FieldEntries } from './field-entries.ts';
