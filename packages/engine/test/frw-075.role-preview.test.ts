/**
 * FRW-075 in the editing core, in Node.js (lane w4): the author previews the document as a
 * participant who holds only one role. The real authority of backend-mock serves the document, so
 * "no commit is submitted" is read from the service, not from the core's own count.
 */
import { MockService } from '@docedit/backend-mock';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { RULE_FIELD_IDS as ID, ruleDocument } from './frw-023-fixture.ts';
import { FIELD_IDS, fieldsDocument } from './frw-fields-fixture.ts';
import { join, microtask, posOf, until } from './support.ts';

/** The fields document with a rule that hides the e-mail from whoever holds the landlord role. */
function roleRuleDocument(): ReturnType<typeof fieldsDocument> {
  const envelope = fieldsDocument() as unknown as {
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  const defs = envelope.doc.content.find((n) => n.type === 'defs')!;
  defs.content.push({
    type: 'rule_def',
    attrs: {
      id: 'r_landlord',
      when: { role: 'role_landlord' },
      then: [{ hide: ['tenant.email'] }],
    },
  });
  return envelope as unknown as ReturnType<typeof fieldsDocument>;
}

async function author() {
  const service = new MockService({ presence: false });
  const docId = service.createDocument(roleRuleDocument());
  const a = await join(service, docId, 'ann', 'owner');
  await until(() => a.core.permissions.get() !== null, 'the access arrives');
  return { service, docId, ...a };
}

describe('the document as a role sees it (FRW-075 criterion 1)', () => {
  it('locks the body, makes the role’s fields fillable and the other roles’ not', async () => {
    const { service, core, detach } = await author();
    try {
      expect(core.mode.get().effective).toBe('edit');
      expect(core.startRolePreview('role_tenant')).toBe(true);
      expect(core.rolePreview.get()).toBe('role_tenant');
      expect(core.mode.get()).toEqual({ requested: 'fill', effective: 'fill' });
      expect(core.readOnly).toBe(true);
      expect(core.permissions.get()?.fill).toMatchObject({ roles: ['role_tenant'], active: true });
      expect(core.fieldFillable(FIELD_IDS.name)).toBe(true);
      expect(core.fieldFillable(FIELD_IDS.landlord)).toBe(false);
      // The body is read-only: typing is refused.
      expect(core.canEdit('body')).toBe(false);
    } finally {
      detach();
      await service.dispose();
    }
  });

  it('switches to another role and lists that role’s fields as fillable', async () => {
    const { service, core, detach } = await author();
    try {
      core.startRolePreview('role_tenant');
      expect(core.startRolePreview('role_landlord')).toBe(true);
      expect(core.rolePreview.get()).toBe('role_landlord');
      expect(core.fieldFillable(FIELD_IDS.landlord)).toBe(true);
      expect(core.fieldFillable(FIELD_IDS.name)).toBe(false);
    } finally {
      detach();
      await service.dispose();
    }
  });

  it('evaluates the rules with the previewed role for the role operand', async () => {
    const { service, core, detach } = await author();
    try {
      // As the author, who holds no fill role, the rule does not hide the e-mail.
      expect(core.fieldRuleState(FIELD_IDS.email)).toMatchObject({ visible: true });
      core.startRolePreview('role_tenant');
      expect(core.fieldRuleState(FIELD_IDS.email)).toMatchObject({ visible: true });
      core.startRolePreview('role_landlord');
      expect(core.fieldRuleState(FIELD_IDS.email)).toMatchObject({ visible: false });
      core.endRolePreview();
      expect(core.fieldRuleState(FIELD_IDS.email)).toMatchObject({ visible: true });
    } finally {
      detach();
      await service.dispose();
    }
  });

  it('refuses a role the document does not define', async () => {
    const { service, core, detach } = await author();
    try {
      expect(core.startRolePreview('role_nobody')).toBe(false);
      expect(core.rolePreview.get()).toBeNull();
      expect(core.mode.get().effective).toBe('edit');
      expect(core.endRolePreview()).toBe(false);
    } finally {
      detach();
      await service.dispose();
    }
  });
});

describe('values entered in the preview (FRW-075 criterion 2)', () => {
  it('shows them, sends no commit, and leaves the document’s values as they were', async () => {
    const { service, docId, core, detach, backend } = await author();
    try {
      const seq = (await backend.sync.loadContent(docId)).seq;
      const stored = JSON.stringify((await backend.sync.loadContent(docId)).doc);
      core.startRolePreview('role_tenant');
      expect(core.enterFieldValue(FIELD_IDS.name, 'Ada').ok).toBe(true);
      expect(core.fieldValues()['tenant.name']).toBe('Ada');
      expect(core.fieldEntry(FIELD_IDS.name)?.value).toBe('Ada');
      // An entry that does not fit is shown with its problem, as in fill mode.
      expect(core.enterFieldValue(FIELD_IDS.amount, '-1').ok).toBe(true);
      expect(core.fieldEntry(FIELD_IDS.amount)?.problems.map((p) => p.code)).toEqual(['min']);
      // Nothing waits to be sent, and the service saw no commit.
      expect(core.syncSummary.get().queued).toBe(0);
      expect(core.saveState.get()).toBe('saved');
      await core.flush({ timeoutMs: 200 });
      const after = await backend.sync.loadContent(docId);
      expect(after.seq).toBe(seq);
      expect(JSON.stringify(after.doc)).toBe(stored);

      core.endRolePreview();
      expect(core.fieldValues()['tenant.name']).toBeNull();
      expect(core.fieldValues()['tenant.amount']).toBeNull();
      // The entry with the problem is not shown after the preview either.
      expect(core.fieldEntry(FIELD_IDS.amount)).toMatchObject({ value: null, problems: [] });
      expect(core.syncSummary.get().queued).toBe(0);
      expect((await backend.sync.loadContent(docId)).seq).toBe(seq);
      expect(core.getContent().doc).toEqual(after.doc);
    } finally {
      detach();
      await service.dispose();
    }
  });

  it('keeps the author’s own undo history out of the preview, and the preview out of it', async () => {
    const { service, core, detach } = await author();
    try {
      expect(core.queryCommand('undo').enabled).toBe(false);
      core.startRolePreview('role_tenant');
      core.enterFieldValue(FIELD_IDS.name, 'Ada');
      core.endRolePreview();
      expect(core.queryCommand('undo').enabled).toBe(false);
    } finally {
      detach();
      await service.dispose();
    }
  });

  it('does not report a preview entry as the person’s fill (de-field-change)', async () => {
    const { service, core, detach } = await author();
    try {
      const seen: string[] = [];
      core.onFieldChange((c) => seen.push(c.key));
      core.startRolePreview('role_tenant');
      core.enterFieldValue(FIELD_IDS.name, 'Ada');
      expect(seen).toEqual([]);
    } finally {
      detach();
      await service.dispose();
    }
  });

  it('keeps the entries while another person’s change arrives, and drops them at the end', async () => {
    const { service, docId, core, detach } = await author();
    const second = await join(service, docId, 'tom', 'owner');
    try {
      await until(() => second.core.permissions.get() !== null, 'the access arrives');
      core.startRolePreview('role_tenant');
      core.enterFieldValue(FIELD_IDS.name, 'Ada');
      // Tom changes the landlord's field; the commit reaches the author's core during the preview.
      expect(second.core.enterFieldValue(FIELD_IDS.landlord, 'Grace').ok).toBe(true);
      await second.core.flush({ timeoutMs: 2000 });
      await until(() => core.fieldValues()['landlord.name'] === 'Grace', 'the change reaches Ann');
      // The preview entry is still shown, and still not queued.
      expect(core.fieldValues()['tenant.name']).toBe('Ada');
      expect(core.syncSummary.get().queued).toBe(0);
      core.endRolePreview();
      expect(core.fieldValues()['tenant.name']).toBeNull();
      expect(core.fieldValues()['landlord.name']).toBe('Grace');
    } finally {
      second.detach();
      detach();
      await service.dispose();
    }
  });
});

describe('leaving the preview (FRW-075 criterion 3)', () => {
  it('returns the caret to where it was, and the mode and the access with it', async () => {
    const { service, core, detach } = await author();
    try {
      const i = internals(core);
      const at = posOf(i.state.doc, FIELD_IDS.paragraph) + 3;
      i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at)));
      const access = core.permissions.get();
      core.startRolePreview('role_tenant');
      // The author moves about in the preview; a second start keeps the first caret.
      i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + 2)));
      core.startRolePreview('role_landlord');
      expect(core.endRolePreview()).toBe(true);
      expect(i.state.selection.from).toBe(at);
      expect(i.state.selection.to).toBe(at);
      expect(core.rolePreview.get()).toBeNull();
      expect(core.mode.get()).toEqual({ requested: 'edit', effective: 'edit' });
      expect(core.permissions.get()).toEqual(access);
      expect(core.readOnly).toBe(false);
    } finally {
      detach();
      await service.dispose();
    }
  });

  it('applies an access that arrived during the preview once it ends', async () => {
    const { service, core, detach } = await author();
    try {
      const real = core.permissions.get()!;
      core.startRolePreview('role_tenant');
      core.setAccess({ ...real, rev: real.rev + 1, caps: ['view', 'comment'], scopes: {} });
      // The preview still shows the role's access.
      expect(core.permissions.get()?.fill?.roles).toEqual(['role_tenant']);
      core.endRolePreview();
      expect(core.permissions.get()?.caps).toEqual(['view', 'comment']);
      expect(core.mode.get().effective).toBe('view');
    } finally {
      detach();
      await service.dispose();
    }
  });
});

describe('without a service', () => {
  it('previews from a document alone and leaves it unchanged', () => {
    const core = new DocumentCore({ doc: ruleDocument(), schedule: microtask });
    const before = JSON.stringify(core.getContent());
    expect(core.startRolePreview('role_tenant')).toBe(true);
    core.enterFieldValue(ID.name, 'Ada');
    expect(core.fieldRuleState(ID.spouse)).toMatchObject({ visible: true });
    core.endRolePreview();
    expect(JSON.stringify(core.getContent())).toBe(before);
    expect(core.fieldRuleState(ID.spouse)).toMatchObject({ visible: false });
  });
});
