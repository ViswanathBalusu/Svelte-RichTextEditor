/**
 * Regions, grants and fields in the shell (PRM-026, PRM-027, PRM-033, PRM-035, PRM-036; FRW-072,
 * FRW-076, FRW-077, FRW-078) and the export dialog (UX-101; UX-104 criterion 4).
 */
import { expect, focusSurface, focused, open, test } from './helpers.ts';

const REGIONS = [
  {
    id: 'r1',
    title: 'Terms',
    policy: 'restricted' as const,
    order: 0,
    state: 'draft' as const,
    editors: { roles: ['owner'], principals: ['user:u1', 'group:legal'] },
  },
  {
    id: 'r2',
    title: 'Annex',
    policy: 'inherit' as const,
    order: 1,
    state: 'draft' as const,
    editors: { roles: ['editor', 'owner'], principals: [] },
  },
  { id: 'r3', title: null, policy: 'confidential' as const, order: 2, state: 'draft' as const },
];
const READER = {
  rev: 3,
  docRole: 'editor',
  caps: ['view', 'comment', 'suggest', 'edit', 'structure'],
  scopes: {
    body: ['view', 'comment', 'suggest', 'edit'],
    'region:r1': ['view', 'comment'],
    'region:r2': ['view', 'comment', 'suggest', 'edit'],
    'region:r3': [],
  },
};
const OWNER = { ...READER, docRole: 'owner', caps: [...READER.caps, 'manage'] };

test.describe('regions the user cannot edit (PRM-026)', () => {
  test('gives the core the words for each lock indicator, with names from the host', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, regions: REGIONS, permissions: READER });
    await expect
      .poll(async () => (await h.regionLabels())?.['r1']?.description)
      .toBe('It can be edited by Ada Lovelace and Group, and by document owners.');
    const labels = (await h.regionLabels())!;
    expect(labels['r1']!.indicator).toBe('Read-only');
    // A region the user may edit has no indicator; a hidden one names nobody (ADR 0019).
    expect(labels['r2']).toBeUndefined();
    expect(labels['r3']!.description).toBe('You do not have access to this part of the document.');
    // Permission changes update the words without a reload.
    await h.setPermissions({
      ...READER,
      scopes: { ...READER.scopes, 'region:r1': ['view', 'comment', 'suggest', 'edit'] },
    });
    await expect.poll(async () => (await h.regionLabels())?.['r1']).toBeUndefined();
  });

  test('tells assistive technology when the caret enters one, and who can edit it', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, regions: REGIONS, permissions: READER });
    await h.frames(2);
    await h.moveTo(
      { scope: 'region:r1', caps: ['view', 'comment'], limit: 'region' },
      { scope: 'region', region: 'Terms' },
    );
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText(
      'Terms: you cannot edit this part. It can be edited by Ada Lovelace and Group, and by document owners.',
    );
  });
});

test.describe('the next part I can edit (PRM-027)', () => {
  test('is a command that moves on, and is not enabled when there is none', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: READER,
      toolbar: 'full',
    });
    await page.getByRole('tab', { name: 'Review' }).click();
    const next = page
      .getByRole('tabpanel')
      .locator('[data-command-id="navigate.nextEditableRegion"]');
    await expect(next).toHaveText('Next part I can edit');
    await next.focus();
    await page.keyboard.press('Enter');
    expect(await h.named()).toEqual([['nextEditableRegion', null]]);
    expect((await h.selection()).region).toBe('Annex');
    expect(await h.state('navigate.nextEditableRegion')).toMatchObject({ enabled: false });
    await expect(next).toHaveAttribute('aria-disabled', 'true');
    await expect(next).toHaveAccessibleDescription('There is no further part you can edit.');
    // A permission change makes another region editable: the state follows.
    await h.moveTo(
      { scope: 'body', caps: ['view', 'comment', 'suggest', 'edit'], limit: null },
      { scope: 'body', region: null },
    );
    await h.setPermissions({
      ...READER,
      scopes: { ...READER.scopes, 'region:r1': ['view', 'comment', 'suggest', 'edit'] },
    });
    await h.setUndo(0, 0);
    await expect(next).not.toHaveAttribute('aria-disabled');
  });
});

test.describe('mark blocks as a region (PRM-033)', () => {
  test('asks for a title in a dialog and announces the result', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: [],
      permissions: READER,
      toolbar: 'full',
      selection: { empty: false },
    });
    await page.getByRole('tab', { name: 'Insert' }).click();
    const button = page.getByRole('tabpanel').locator('[data-command-id="insert.region"]');
    await button.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Make a region' });
    await expect(dialog).toBeVisible();
    expect(await dialog.getAttribute('part')).toBe('dialog');
    await page.keyboard.press('Enter');
    await expect(dialog.getByText('Enter a title.')).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Title of the region' }).fill('Payment terms');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    expect(await h.named()).toEqual([['markRegion', { title: 'Payment terms' }]]);
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText('Region made.');
    await expect(button).toBeFocused();
  });

  test('is disabled with the reason inside a region and at the limit', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: READER,
      selection: { empty: false },
    });
    await h.moveTo(
      { scope: 'region:r2', caps: ['view', 'comment', 'suggest', 'edit'], limit: null },
      { scope: 'region', region: 'Annex', empty: false },
    );
    await h.frames(2);
    expect(await h.state('insert.region')).toMatchObject({
      enabled: false,
      reasonKey: 'reason.query.nested',
    });
    await h.moveTo(
      { scope: 'body', caps: ['view', 'comment', 'suggest', 'edit'], limit: null },
      { scope: 'body', region: null, empty: false },
    );
    await h.setRegionLimit(3);
    await h.setUndo(0, 0);
    expect(await h.state('insert.region')).toMatchObject({
      enabled: false,
      reasonKey: 'reason.query.regionLimit',
    });
  });
});

test.describe('the permissions pane (PRM-032, PRM-035, PRM-036)', () => {
  test('lists the regions as the reader may see them, with who can edit each', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: READER,
      grants: [],
    });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    const items = pane.locator('[data-region]');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('Terms');
    await expect(items.nth(0)).toContainText('Draft');
    await expect(items.nth(0)).toContainText(
      'It can be edited by Ada Lovelace and Group, and by document owners.',
    );
    await expect(items.nth(2)).toContainText('A part hidden from you');
    await expect(items.nth(2)).not.toContainText('It can be edited');
    // Without manage, no grant controls; the policy cannot be changed, and the pane says why.
    await items.nth(0).getByRole('button').click();
    await expect(pane.getByRole('button', { name: 'Give a role' })).toHaveCount(0);
    // The fieldset is disabled, and so is each of its radios (Playwright reads disabled on controls).
    await expect(pane.getByRole('radio', { name: 'Only the people named here' })).toBeDisabled();
    await expect(
      pane.getByRole('radio', { name: 'Document editors and the people named here' }),
    ).toBeDisabled();
    await expect(pane).toContainText(
      'Only people who manage the document can change who may edit.',
    );
  });

  test('gives a role to someone found in the host’s directory, saved with If-Match', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: OWNER,
      grants: [{ region: 'r1', principal: 'user:u1', role: 'editor' }],
    });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    const grant = pane.locator('.de-grant[data-principal="user:u1"]');
    await expect(grant).toContainText('Ada Lovelace');
    await expect(grant.locator('.de-role')).toHaveText('Editor');
    await expect(grant.locator('.de-role-mark')).toHaveAttribute('data-role', 'editor');
    const search = pane.getByRole('combobox', { name: 'Find a person or group' });
    // "l" matches one user ("Ada Lovelace") and one group ("Legal team"); "Grace Hopper" has no "l".
    await search.fill('l');
    const options = pane
      .getByRole('listbox', { name: 'People and groups found' })
      .getByRole('option');
    await expect(options).toHaveText([/Ada Lovelace/, /Legal team/]);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(search).toHaveValue('Legal team');
    await pane.getByRole('combobox', { name: 'Role' }).selectOption('commenter');
    await pane.getByRole('button', { name: 'Save' }).click();
    await expect(pane.locator('[data-status="permissions"]')).toHaveText('Permissions saved.');
    const saves = await h.grantSaves();
    expect(saves).toHaveLength(1);
    expect(saves[0]!.etag).toBe('"g1"');
    expect(saves[0]!.grants).toEqual([
      { region: 'r1', principal: 'user:u1', role: 'editor' },
      { region: 'r1', principal: 'group:legal', role: 'commenter' },
    ]);
    await expect(pane.locator('.de-grant[data-principal="group:legal"]')).toContainText(
      'Legal team',
    );
  });

  test('reloads and says so when someone else saved first; nothing is overwritten', async ({
    page,
  }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: OWNER,
      grants: [{ region: 'r1', principal: 'user:u1', role: 'editor' }],
    });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    await h.conflictNextGrantSave();
    await pane.getByRole('button', { name: 'Remove the role of Ada Lovelace' }).click();
    await expect(pane.locator('[data-status="permissions"]')).toHaveText(
      'Someone else changed the permissions first. The current ones are shown; nothing of yours was saved.',
    );
    await expect(pane.locator('.de-grant[data-principal="user:u1"]')).toBeVisible();
    await expect(pane.locator('.de-grant[data-principal="user:u9"]')).toContainText('Hedy Lamarr');
  });

  test('shows when each grant ends, as a date (PRM-035, criterion 1)', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: OWNER,
      grants: [
        {
          region: 'r1',
          principal: 'user:u1',
          role: 'editor',
          expiresAt: '2026-12-31T12:00:00.000Z',
        },
      ],
    });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await pane.locator('[data-region="r1"]').getByRole('button').click();
    const grant = pane.locator('.de-grant[data-principal="user:u1"]');
    await expect(grant.locator('.de-role')).toHaveText('Editor');
    await expect(grant).toContainText('31 Dec 2026');
  });

  test('explains the policies in plain words and sets one with a commit', async ({ page }) => {
    const h = await open(page, {
      extended: true,
      regions: REGIONS,
      permissions: OWNER,
      grants: [],
    });
    await h.exec('view.permissions');
    const pane = page.locator('.de-pane[data-pane="permissions"]');
    await pane.locator('[data-region="r2"]').getByRole('button').click();
    const inherit = pane.getByRole('radio', { name: 'Document editors and the people named here' });
    await expect(inherit).toHaveAccessibleDescription(
      'Document editors and owners can edit this region, and so can the people given a role on it here.',
    );
    const restricted = pane.getByRole('radio', { name: 'Only the people named here' });
    await expect(restricted).toHaveAccessibleDescription(
      'Only the people given a role here, and document owners, can edit this region. Other document editors can view and comment. A role cannot be given to everyone on a region like this.',
    );
    await restricted.check();
    expect(await h.named()).toEqual([['setRegionPolicy', { region: 'r2', policy: 'restricted' }]]);
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText('Who may edit changed.');
  });
});

test.describe('fields (FRW-072, FRW-076, FRW-077, FRW-078)', () => {
  test('the palette offers the kinds of this release, through the registry', async ({ page }) => {
    let h = await open(page, { extended: true, toolbar: 'full' });
    await page.getByRole('tab', { name: 'Insert' }).click();
    const kinds = page.getByRole('tabpanel').locator('[data-command-id^="insert.field."]');
    await expect(kinds).toHaveText([
      'Text field',
      'Number field',
      'Date field',
      'Checkbox',
      'Choice field',
    ]);
    await kinds.first().click();
    expect(await h.named()).toEqual([['insertField', { kind: 'text' }]]);
    h = await open(page, { extended: true, toolbar: 'full', features: ['sign', 'rules'] });
    await page.getByRole('tab', { name: 'Insert' }).click();
    await expect(
      page.getByRole('tabpanel').locator('[data-command-id^="insert.field."]'),
    ).toHaveCount(9);
    // In a sub-editor, at the limit, and without edit, the commands say why.
    await h.setPanel('footnote');
    await h.setUndo(0, 0);
    expect(await h.state('insert.field.text')).toMatchObject({
      enabled: false,
      reasonKey: 'reason.query.subeditor',
    });
    await h.setPanel(null);
    await h.setAccess({
      scope: 'story:hdr1',
      caps: ['view', 'comment', 'suggest', 'edit'],
      limit: null,
    });
    expect(await h.state('insert.field.date')).toMatchObject({
      enabled: false,
      reasonKey: 'reason.query.subeditor',
    });
    await h.setAccess({ scope: 'body', caps: ['view', 'comment', 'suggest', 'edit'], limit: null });
    await h.setFieldLimit(0);
    expect(await h.state('insert.field.text')).toMatchObject({
      enabled: false,
      reasonKey: 'reason.query.fieldLimit',
    });
    await h.setAccess({ scope: 'body', caps: ['view'], limit: 'role' });
    expect(await h.state('insert.field.text')).toMatchObject({
      enabled: false,
      reasonKey: 'reason.access.view',
    });
  });

  const FILL = {
    active: true,
    fields: [
      { id: 'f1', label: 'Name', required: true, filled: true, invalid: null },
      { id: 'f2', label: 'Date of birth', required: true, filled: false, invalid: null },
      { id: 'f3', label: 'Amount', required: true, filled: true, invalid: 'range' },
      { id: 'f4', label: 'Notes', required: false, filled: false, invalid: null },
    ],
  };

  test('the bar counts what is filled and moves to the next field to fill', async ({ page }) => {
    const h = await open(page, { extended: true, fill: FILL });
    const bar = page.getByRole('region', { name: 'Filling in' });
    await expect(bar.locator('[data-status="fill-progress"]')).toHaveText(
      '1 of 3 required fields filled',
    );
    await bar.getByRole('button', { name: 'Next field to fill' }).click();
    expect(await h.callsOf('focusField')).toEqual([['f2']]);
    await h.setFill({ active: false, inactive: 'waiting', fields: FILL.fields });
    await expect(bar).toContainText('It is not your turn yet. Your fields open when it is.');
    await expect(bar.getByRole('button')).toHaveCount(0);
  });

  test('the summary lists what is left, with links, and agrees with the bar', async ({ page }) => {
    const h = await open(page, { extended: true, fill: FILL });
    const bar = page.getByRole('region', { name: 'Filling in' });
    await bar.getByRole('button', { name: 'What is left' }).click();
    const pane = page.locator('.de-pane[data-pane="fill"]');
    const left = pane.locator('[data-field]');
    await expect(left).toHaveCount(2);
    await expect(left.nth(0)).toContainText('Date of birth');
    await expect(left.nth(0)).toContainText('Required, not filled');
    await expect(left.nth(1)).toContainText('Out of the allowed range');
    await expect(pane.locator('[data-status="fill-progress"]')).toHaveText(
      '1 of 3 required fields filled',
    );
    await left.nth(1).getByRole('button').click();
    expect(await h.callsOf('focusField')).toEqual([['f3']]);
    // Once every field is filled and valid, the list empties and Finish runs finishFill.
    await h.setFill({
      active: true,
      fields: FILL.fields.map((f) => ({ ...f, filled: true, invalid: null })),
    });
    await expect(left).toHaveCount(0);
    await expect(pane.locator('[data-status="fill-left"]')).toHaveText('Nothing is left to fill.');
    await bar.getByRole('button', { name: 'Finish' }).click();
    expect(await h.named()).toEqual([['finishFill', null]]);
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText('You have finished.');
  });

  test('an invalid optional field is listed but not counted, and the bar says it counts required fields (FRW-078 criterion 4)', async ({
    page,
  }) => {
    const fields = [
      ...FILL.fields,
      { id: 'f5', label: 'Phone', required: false, filled: true, invalid: 'format' },
    ];
    await open(page, { extended: true, fill: { active: true, fields } });
    const bar = page.getByRole('region', { name: 'Filling in' });
    await bar.getByRole('button', { name: 'What is left' }).click();
    const pane = page.locator('.de-pane[data-pane="fill"]');
    // The list holds every problem: two required fields and the optional one.
    await expect(pane.locator('[data-field]')).toHaveCount(3);
    await expect(pane.locator('[data-field]').nth(2)).toContainText('Phone');
    // The counter counts required fields only, and its text says so, in the bar and in the pane.
    await expect(bar.locator('[data-status="fill-progress"]')).toHaveText(
      '1 of 3 required fields filled',
    );
    await expect(pane.locator('[data-status="fill-progress"]')).toHaveText(
      '1 of 3 required fields filled',
    );
  });

  test('finishing with a required field empty opens the summary and does not finish (FRW-078)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, fill: FILL });
    const bar = page.getByRole('region', { name: 'Filling in' });
    const pane = page.locator('.de-pane[data-pane="fill"]');
    await expect(pane).toHaveCount(0);
    // "Date of birth" is required and empty, and "Amount" is out of range.
    await bar.getByRole('button', { name: 'Finish' }).click();
    await expect(pane).toBeVisible();
    await expect(bar.getByRole('button', { name: 'What is left' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const left = pane.locator('[data-field]');
    await expect(left).toHaveCount(2);
    await expect(left.nth(0)).toContainText('Date of birth');
    await expect(left.nth(0)).toContainText('Required, not filled');
    await expect(left.nth(1)).toContainText('Amount');
    await expect(left.nth(1)).toContainText('Out of the allowed range');
    // finishFill is not run, and nothing announces that the participant has finished.
    expect(await h.named()).toEqual([]);
    await expect(page.locator('.de-shell > [role="status"]')).not.toHaveText('You have finished.');
    // The links in the summary opened this way go to their fields too.
    await left.nth(0).getByRole('button').click();
    expect(await h.callsOf('focusField')).toEqual([['f2']]);
  });

  const ROLES = {
    active: true,
    roles: ['role_tenant'],
    fields: [
      {
        id: 'm1',
        label: 'Income',
        required: true,
        filled: false,
        invalid: null,
        assignee: 'role_tenant',
        role: { name: 'Tenant', color: '#0d47a1', order: 0 },
      },
      {
        id: 'o1',
        label: 'Landlord name',
        required: true,
        filled: false,
        invalid: null,
        assignee: 'role_landlord',
        role: { name: 'Landlord', color: '#b71c1c', order: 1 },
      },
      {
        id: 'n1',
        label: 'Reference',
        required: true,
        filled: false,
        invalid: null,
        assignee: null,
      },
    ],
  };

  test('marks my fields as mine and keeps other roles’ and unassigned fields read-only (FRW-077)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, fill: ROLES });
    const bar = page.getByRole('region', { name: 'Filling in' });
    // Only my field counts and is the next one; the others are not mine to fill.
    await expect(bar.locator('[data-status="fill-progress"]')).toHaveText(
      '0 of 1 required field filled',
    );
    await bar.getByRole('button', { name: 'Next field to fill' }).click();
    expect(await h.callsOf('focusField')).toEqual([['m1']]);
    await bar.getByRole('button', { name: 'What is left' }).click();
    const pane = page.locator('.de-pane[data-pane="fill"]');
    await expect(pane.locator('[data-field]')).toHaveCount(1);
    const rows = pane.getByRole('list', { name: 'Fields in this document' }).getByRole('listitem');
    await expect(rows).toHaveCount(3);

    const mine = pane.locator('[data-field-row="m1"]');
    await expect(mine).toHaveAttribute('data-ownership', 'mine');
    await expect(mine).toHaveAttribute('data-read-only', 'false');
    await expect(mine.locator('[data-marker]')).toHaveText('Yours');
    await expect(mine.locator('[data-state="read-only"]')).toHaveCount(0);
    await expect(mine.getByRole('button')).toHaveAccessibleName('Income, Tenant, yours to fill in');
    await expect(mine.locator('.de-role-icon')).toHaveAttribute('data-icon', 'circle');

    const other = pane.locator('[data-field-row="o1"]');
    await expect(other).toHaveAttribute('data-ownership', 'other');
    await expect(other).toHaveAttribute('data-read-only', 'true');
    await expect(other.locator('[data-marker]')).toHaveText('Landlord');
    await expect(other.locator('[data-state="read-only"]')).toHaveText('Read-only');
    await expect(other.getByRole('button')).toHaveAccessibleName(
      'Landlord name, Landlord, not yours to fill in',
    );
    const icon = other.locator('.de-role-icon');
    await expect(icon).toHaveAttribute('data-icon', 'square');
    await expect(icon).toHaveCSS('color', 'rgb(183, 28, 28)');

    const none = pane.locator('[data-field-row="n1"]');
    await expect(none).toHaveAttribute('data-ownership', 'none');
    await expect(none).toHaveAttribute('data-read-only', 'true');
    await expect(none.locator('[data-marker]')).toHaveText('No role');
    await expect(none.locator('[data-state="read-only"]')).toHaveText('Read-only');
    await expect(none.locator('.de-role-icon')).toHaveCount(0);
    await expect(none.getByRole('button')).toHaveAccessibleName(
      'Reference, not assigned to a role, not yours to fill in',
    );

    // While it is not my turn, my field is read-only too.
    await h.setFill({ ...ROLES, active: false, inactive: 'waiting' });
    await expect(mine).toHaveAttribute('data-read-only', 'true');
    await expect(mine.locator('[data-state="read-only"]')).toHaveText('Read-only');
  });
});

test.describe('the export dialog (UX-101)', () => {
  test('offers the announced targets and the options, follows the job and can cancel it', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await focusSurface(page);
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio')).toHaveCount(4);
    await expect(dialog.getByRole('radio', { name: 'PDF' })).toBeChecked();
    await dialog.getByRole('radio', { name: 'Final' }).check();
    await dialog.getByRole('combobox', { name: 'Accessibility tagging' }).selectOption('draft');
    await dialog.getByRole('button', { name: 'Export' }).click();
    await expect(dialog.locator('[data-status="export"]')).toHaveText('Waiting to start');
    expect(await h.exportRequests()).toEqual([
      { target: 'pdf', options: { profile: 'final', tagging: 'draft', fields: 'flatten' } },
    ]);
    await h.updateExport('job1', { state: 'compiling', progress: 40 });
    await expect(dialog.locator('[data-status="export"]')).toHaveText('Typesetting');
    await expect(dialog.getByRole('progressbar', { name: 'Export progress' })).toHaveAttribute(
      'value',
      '40',
    );
    await dialog.getByRole('button', { name: 'Cancel the export' }).click();
    expect(await h.exportCancelled()).toEqual(['job1']);
    await expect(dialog.locator('[data-status="export"]')).toHaveText('Cancelled');
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText(
      'The export was cancelled.',
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await focused(page)).className).toContain('de-editing-surface');
  });

  test('shows the result and goes from a diagnostic to its block; severities are words', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, features: ['exports'], projected: true });
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog).toContainText(
      'Parts of the document hidden from you are left out of the export.',
    );
    await dialog.getByRole('button', { name: 'Export' }).click();
    await h.updateExport('job1', {
      state: 'completed',
      progress: 100,
      result: { url: '/assets/result.pdf', pages: 12, converged: false },
      diagnostics: [
        {
          severity: 'warning',
          code: 'tabs.approximate',
          blockId: 'p7',
          message: 'A tab stop was approximated.',
        },
        {
          severity: 'error',
          code: 'math.failed',
          blockId: 'gone',
          message: 'An equation could not be set.',
        },
      ],
    });
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText(
      'The export has finished.',
    );
    await expect(dialog.getByRole('link', { name: 'Open the result' })).toHaveAttribute(
      'href',
      '/assets/result.pdf',
    );
    await expect(dialog).toContainText('12 pages');
    await expect(dialog).toContainText('Page references may still change');
    const diagnostics = dialog.getByRole('list', { name: 'Problems found' }).getByRole('button');
    // The severity is a word of its own; the spacing between it and the message is the layout's.
    await expect(diagnostics).toHaveText([
      /Warning\s*A tab stop was approximated\./,
      /Error\s*An equation could not be set\./,
    ]);
    await diagnostics.nth(1).click();
    await expect(dialog.getByText('That part is no longer in the document.')).toBeVisible();
    await diagnostics.nth(0).click();
    await expect(dialog).toHaveCount(0);
    expect(await h.callsOf('selectBlock')).toEqual([['gone'], ['p7']]);
  });

  test('announces a failure, and says when the job could not start', async ({ page }) => {
    const h = await open(page, { extended: true, features: ['exports'] });
    await h.exec('document.export');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await h.failNextExport();
    await dialog.getByRole('button', { name: 'Export' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('The export could not be started.');
    await dialog.getByRole('button', { name: 'Export' }).click();
    // Wait until the dialog follows the job (the cancel control shows while it runs), so that the
    // failure is seen as a change and announced.
    await expect(dialog.getByRole('button', { name: 'Cancel the export' })).toBeVisible();
    // The refused request counts as a request but starts no job, so the job that runs is job2.
    await h.updateExport('job2', {
      state: 'failed',
      error: { code: 'internal', message: 'The compiler stopped.' },
    });
    await expect(page.locator('.de-shell > [role="status"]')).toHaveText('The export failed.');
    await expect(dialog).toContainText('The compiler stopped.');
  });
});
