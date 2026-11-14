/**
 * Images in the bundle by content hash (09 §2; EXP-014). Only assets the job lists for this
 * document are used, and only when they are `ready`; each file is written once to `assets/`,
 * named `<sha256>.<extension>` whatever its identifier, however often the document uses it.
 * SVG never reaches the compile: the asset worker converts it to PDF on upload (BE-043, BE-045).
 */
import { diag, type Ctx } from './context.ts';
import { assetFile, type Tex } from './emit.ts';

export function assetRef(ctx: Ctx, assetId: unknown, blockId: string | null): Tex | null {
  if (typeof assetId !== 'string' || !Object.hasOwn(ctx.assets, assetId)) {
    diag(
      ctx,
      'warning',
      'asset_not_attached',
      blockId,
      'a picture refers to an asset this job does not list; a placeholder is printed',
    );
    return null;
  }
  const a = ctx.assets[assetId]!;
  if ((a.status ?? 'ready') !== 'ready') {
    diag(
      ctx,
      'warning',
      'asset_not_ready',
      blockId,
      'a picture refers to an asset that is not ready; a placeholder is printed',
    );
    return null;
  }
  const file = assetFile(a.sha256, a.mediaType);
  if (!file) {
    diag(
      ctx,
      'warning',
      'asset_type_unsupported',
      blockId,
      'a picture has a media type the typesetter does not place (PNG, JPEG and PDF are); a placeholder is printed',
    );
    return null;
  }
  if (!ctx.assetFiles.has(file)) ctx.assetFiles.set(file, a.bytes ?? null);
  return file;
}
