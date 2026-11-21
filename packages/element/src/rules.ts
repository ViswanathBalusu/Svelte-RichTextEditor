/**
 * The shell's rules port over the core (FRW-024; ui `RulesService`): the document's rules as
 * sentence parts, the fields they may name, and the builder's changes. Every change is the core's
 * `saveRuleParts` or `editRule`, a transaction on the definitions, so the region guard decides
 * (`defs` needs `structure`, 07 §4) and the change leaves as a commit.
 *
 * The list is read again when the core's revision moves and only replaced when it differs, so the
 * pane does not redraw for a change elsewhere in the document.
 */
import type { EditorCore } from '@docedit/engine';
import { loadParts } from '@docedit/engine/headless';
import type { RuleChangeResult, RuleItem, RulesService } from '@docedit/ui';

type Outcome = ReturnType<EditorCore['editRule']>;

function result(outcome: Outcome): RuleChangeResult {
  if (outcome.ok) return { ok: true };
  if (outcome.reason === 'invalid_rules')
    return {
      ok: false,
      reason: 'invalid_rules',
      problems: outcome.problems.map((p) => ({ message: p.message, keys: [...(p.keys ?? [])] })),
    };
  if (outcome.reason === 'rule_limit')
    return { ok: false, reason: 'rule_limit', limit: outcome.limit, message: outcome.message };
  return { ok: false, reason: outcome.reason };
}

export function rulesService(core: EditorCore): RulesService {
  let items: readonly RuleItem[] = [];
  let itemsKey = '[]';
  const readItems = (): readonly RuleItem[] => {
    const now = core.ruleItems() as readonly RuleItem[];
    const key = JSON.stringify(now);
    if (key !== itemsKey) {
      itemsKey = key;
      items = now;
    }
    return items;
  };
  let fields: readonly { key: string; label: string }[] = [];
  let fieldsKey = '[]';
  const readFields = (): readonly { key: string; label: string }[] => {
    const now = core.formFields().map((f) => ({ key: f.key, label: f.label }));
    const key = JSON.stringify(now);
    if (key !== fieldsKey) {
      fieldsKey = key;
      fields = now;
    }
    return fields;
  };
  // A rule that names nothing stands for "a rule": the check asks only whether the definitions may
  // be changed, and any other refusal means the user may.
  const canEdit = (): boolean => {
    const outcome = core.editRule(
      { op: 'save', rule: { id: core.nextRuleId(), when: true, then: [] } },
      true,
    );
    return outcome.ok || (outcome.reason !== 'read-only' && outcome.reason !== 'no-feature');
  };
  return {
    // The rules language loads with the pane (FND-008).
    prepare: () => loadParts(['rules']),
    rules: { get: readItems, subscribe: (listener) => core.revision.subscribe(listener) },
    fields: { get: readFields, subscribe: (listener) => core.revision.subscribe(listener) },
    canEdit: {
      get: canEdit,
      subscribe(listener) {
        const stops = [core.revision.subscribe(listener), core.permissions.subscribe(listener)];
        return () => {
          for (const stop of stops) stop();
        };
      },
    },
    nextId: () => core.nextRuleId(),
    save: (input) => result(core.saveRuleParts(input)),
    remove: (id) => result(core.editRule({ op: 'delete', id })),
    showField: (key) => core.focusFieldByKey(key),
  };
}
