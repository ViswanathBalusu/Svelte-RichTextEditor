/** Codecs of the real-time plane (05 §4): text frames with validation, chunks, binary frames. */
export {
  FrameCodec,
  FrameError,
  depCodec,
  utf8Length,
  type DecodeOptions,
  type DecodeResult,
  type Receiver,
} from './frame.ts';
export { ShapeValidator, type Violation } from './validate.ts';
export { checkProblem, type ProblemInput, type ProblemSurface } from './problem.ts';
export {
  Reassembler,
  chunkMessage,
  needsChunking,
  type ChunkPayload,
  type ReassemblyResult,
} from './chunk.ts';
export { decodeBinaryFrame, encodeBinaryFrame, type BinaryFrame } from './binary.ts';
