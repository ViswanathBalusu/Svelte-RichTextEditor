-- phase: expand
-- rollback: drop table tenant_fonts; no release before this one reads it, and /tenant-fonts then
--   answers 500 until the release is rolled back too. The font files stay in object storage under
--   tenants/{tenant}/fonts/ until a later release removes them.

-- Fonts a tenant adds (BE-048; 02 section 6; 09 section 5; owner decisions 62, 94 and 95).
-- One row per font file of a tenant: its hash (the file's name under tenants/{tenant}/fonts/), the
-- family and face found in the file, the licence declaration and the server-use flag the
-- administrator set. The file itself is not here. A tenant has a hash once and a family and face
-- once, so a second file for the same face is refused rather than silently replacing the first.

create table tenant_fonts (
  tenant_id uuid not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  family text not null check (char_length(family) between 1 and 100),
  style text not null check (style in ('regular', 'bold', 'italic', 'boldItalic')),
  weight int not null check (weight in (400, 700)),
  italic boolean not null,
  format text not null check (format in ('truetype', 'opentype', 'woff2')),
  bytes bigint not null check (bytes >= 1),
  licence text not null check (char_length(licence) between 1 and 200),
  server_use boolean not null,
  added_by text not null check (char_length(added_by) between 1 and 255),
  added_at timestamptz not null default now(),
  primary key (tenant_id, sha256)
);

create unique index tenant_fonts_face on tenant_fonts (tenant_id, lower(family), style);

select docedit_protect('tenant_fonts');

grant select, insert, delete on tenant_fonts to docedit_app;
