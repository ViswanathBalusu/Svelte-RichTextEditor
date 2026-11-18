/**
 * WASM-001 criterion 6: the repository layout of 01 §6 names the folder that holds the crates and
 * the package that builds them. Reads the specification; needs no build.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const spec = readFileSync(new URL('docs/spec/01-architecture.md', root), 'utf8');
const layout = spec.slice(spec.indexOf('## 6. Repository and package layout'));

describe('the repository layout of 01 §6 (WASM-001 criterion 6)', () => {
  it('lists crates/ and packages/layout-kernel, and both exist', () => {
    expect(layout).toMatch(/^ {2}layout-kernel\/ /m);
    expect(layout).toMatch(/^crates\/ /m);
    expect(existsSync(new URL('crates/Cargo.toml', root))).toBe(true);
    expect(existsSync(new URL('crates/layout-kernel/Cargo.toml', root))).toBe(true);
    expect(existsSync(new URL('packages/layout-kernel/package.json', root))).toBe(true);
  });

  it('pins the toolchain and forbids unsafe code in every crate of the workspace', () => {
    expect(readFileSync(new URL('crates/rust-toolchain.toml', root), 'utf8')).toMatch(
      /channel = "\d+\.\d+\.\d+"/,
    );
    expect(readFileSync(new URL('crates/Cargo.toml', root), 'utf8')).toMatch(
      /\[workspace\.lints\.rust\]\s+unsafe_code = "forbid"/,
    );
    expect(readFileSync(new URL('crates/layout-kernel/Cargo.toml', root), 'utf8')).toMatch(
      /\[lints\]\s+workspace = true/,
    );
    expect(readFileSync(new URL('crates/layout-kernel/src/lib.rs', root), 'utf8')).toContain(
      '#![forbid(unsafe_code)]',
    );
  });
});
