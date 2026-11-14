import { describe, expect, it } from 'vitest';
import { loadMigrations } from './migrate.ts';
import {
  TENANT_EXEMPT,
  createdTables,
  staleExemptions,
  tenantProblems,
  type GuardedMigration,
} from './tenant-guard.ts';

const ok = (name: string) =>
  `create table ${name} (\n  id uuid primary key,\n  tenant_id uuid not null\n);\n` +
  `select docedit_protect('${name}');\n`;

describe('tenant guard over the real migrations (BE-011 criterion 6)', () => {
  it('finds a tenant_id column and a docedit_protect call for every table the migrations create', async () => {
    const migrations = await loadMigrations();
    const created = migrations.flatMap((m) => createdTables(m.sql).map((t) => t.name));
    // The guard must see the tables, or it would pass with nothing to check.
    expect(created).toContain('documents');
    expect(created).toContain('doc_commits');
    expect(created).toContain('node_leases');
    expect(tenantProblems(migrations)).toEqual([]);
  });

  it('exempts only tables that really have no tenant_id column', async () => {
    const migrations = await loadMigrations();
    expect(staleExemptions(migrations)).toEqual([]);
    expect([...TENANT_EXEMPT]).toEqual(['node_leases']);
  });
});

describe('tenant guard on synthetic migrations', () => {
  it('accepts a table with tenant_id that is passed to docedit_protect', () => {
    expect(tenantProblems([{ version: '0100_a', sql: ok('widgets') }])).toEqual([]);
  });

  it('refuses a table created without a tenant_id column', () => {
    const sql =
      'create table widgets (\n  id uuid primary key\n);\n' +
      "select docedit_protect('widgets');\n";
    expect(tenantProblems([{ version: '0100_a', sql }])).toEqual([
      '0100_a: table widgets has no tenant_id column (BE-011)',
    ]);
  });

  it('refuses a table no migration passes to docedit_protect', () => {
    const sql = 'create table widgets (\n  id uuid primary key,\n  tenant_id uuid not null\n);\n';
    expect(tenantProblems([{ version: '0100_a', sql }])).toEqual([
      '0100_a: table widgets is not passed to docedit_protect (BE-011)',
    ]);
  });

  it('does not count a tenant_id mentioned in a comment, or a protect call in a comment', () => {
    const sql =
      "-- tenant_id uuid mentioned here, and docedit_protect('widgets') too\n" +
      'create table widgets (\n  id uuid primary key\n);\n';
    const problems = tenantProblems([{ version: '0100_a', sql }]);
    expect(problems).toContain('0100_a: table widgets has no tenant_id column (BE-011)');
    expect(problems).toContain('0100_a: table widgets is not passed to docedit_protect (BE-011)');
  });

  it('accepts a protect call in a later migration and a schema-qualified name', () => {
    const migrations: GuardedMigration[] = [
      { version: '0100_a', sql: 'create table public.widgets (\n  tenant_id uuid not null\n);\n' },
      { version: '0101_b', sql: "select docedit_protect('public.widgets');\n" },
    ];
    expect(tenantProblems(migrations)).toEqual([]);
  });

  it('reads the tenant column only from the table body, not from a later statement', () => {
    const sql =
      'create table widgets (\n  id uuid primary key\n);\n' +
      'create index widgets_by_t on widgets (tenant_id);\n' +
      "select docedit_protect('widgets');\n";
    expect(tenantProblems([{ version: '0100_a', sql }])).toEqual([
      '0100_a: table widgets has no tenant_id column (BE-011)',
    ]);
  });

  it('skips a table listed as exempt', () => {
    const sql = 'create table leases (\n  node text primary key\n);\n';
    expect(tenantProblems([{ version: '0100_a', sql }], new Set(['leases']))).toEqual([]);
  });

  it('reports an exemption that has a tenant_id column or no migration creating it', () => {
    const migrations: GuardedMigration[] = [{ version: '0100_a', sql: ok('widgets') }];
    expect(staleExemptions(migrations, new Set(['widgets']))).toEqual([
      'widgets is exempt from the tenant check but has a tenant_id column',
    ]);
    expect(staleExemptions(migrations, new Set(['gadgets']))).toEqual([
      'gadgets is exempt from the tenant check but no migration creates it',
    ]);
  });
});
