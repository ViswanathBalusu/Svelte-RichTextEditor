/**
 * PRO-082 criterion 3 (lane V-PRO-069-085): a manifest key the component does not know is ignored
 * (PRO-005). The host's array is read by ExtensionHost.sync and checkManifest; neither reports an
 * unknown key, neither copies it into what the extension sees, and an extension with unknown keys
 * still loads.
 */
import { describe, expect, it } from 'vitest';
import { ExtensionHost, checkManifest, type ExtensionReport } from '../src/extensions/host.ts';

describe('PRO-082 criterion 3: unknown manifest keys are ignored', () => {
  it('checkManifest keeps only the fields the editor reads', () => {
    const checked = checkManifest(
      {
        id: 'ext.notes',
        name: '  Notes  ',
        apiVersion: ' 1 ',
        icon: 'future-field',
        permissions: { everything: true },
        nested: { a: [1, 2, 3] },
      },
      1,
    );
    expect(checked).toEqual({
      ok: true,
      manifest: { id: 'ext.notes', name: 'Notes', apiVersion: '1' },
    });
  });

  it('an extension with unknown keys is activated and reports nothing', () => {
    const reports: ExtensionReport[] = [];
    const seen: unknown[] = [];
    const host = new ExtensionHost<{ id: string }>({
      apiVersions: ['1'],
      createApi: (id) => ({ id }),
      onError: (r) => reports.push(r),
    });
    host.sync([
      {
        manifest: { id: 'ext.notes', name: 'Notes', apiVersion: '1', unknown: 'x', extra: 1 },
        activate: (api: { id: string }) => seen.push(api),
        unknownEntryKey: true,
      },
    ]);
    expect(reports).toEqual([]);
    expect(host.active()).toEqual(['ext.notes']);
    expect(seen).toEqual([{ id: 'ext.notes' }]);
  });

  it('unknown keys do not rescue an entry that is invalid in a known field', () => {
    const reports: ExtensionReport[] = [];
    const host = new ExtensionHost<unknown>({
      apiVersions: ['1'],
      createApi: () => ({}),
      onError: (r) => reports.push(r),
    });
    host.sync([
      {
        manifest: { id: 'Bad Id', name: 'Bad', apiVersion: '1', icon: 'known-to-nobody' },
        activate: () => {},
      },
    ]);
    expect(host.active()).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reason: 'invalid-manifest', fatal: false });
  });
});
