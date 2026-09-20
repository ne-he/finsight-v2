/**
 * Paragraph-aware chunking with overlap, ported from FinSight v1.
 *
 * The non-obvious part is the interaction between the two split paths, and it
 * is worth keeping the history because it cost real retrieval accuracy:
 *
 *   - Paragraphs are packed greedily until they reach `size`.
 *   - A single paragraph longer than `size` falls back to a sliding window that
 *     steps by `size - overlap`, so consecutive windows already share text.
 *   - A later stitching pass prepends the previous chunk's tail to each chunk.
 *
 * Originally the stitching pass ran over every chunk, so windowed chunks
 * received the overlap twice and opened with a verbatim copy of their own first
 * `overlap` characters. On the v1 corpus that was 532 of 947 chunks and 123,381
 * characters, 11.0% of the text, all of it embedded, keyword indexed, and spent
 * as context on every query.
 *
 * The obvious fix, dropping the stride so the stitching alone provides overlap,
 * was measured and rejected: retrieval hit-rate fell from 16/16 to 14/16 and
 * both losses were comparison questions. Overlapping windows are what keep a
 * fact near a boundary whole inside the next window. So the stride stays and
 * the stitching yields instead, skipping any chunk that already overlaps its
 * predecessor. That is what `windowed` tracks below.
 */

import type { Section } from "./sections";
import { splitIntoSections } from "./sections";

export interface FilingMetadata {
  ticker: string;
  company: string;
  fiscalYear: string;
  sourceUrl: string;
  filingType?: string;
}

export interface Chunk {
  chunkId: string;
  text: string;
  ticker: string;
  company: string;
  fiscalYear: string;
  section: string;
  sourceUrl: string;
  ordinal: number;
}

/**
 * Split one block of text into overlapping chunks.
 *
 * Exported for the tests that pin the overlap behaviour described above.
 */
export function splitLong(input: string, size: number, overlap: number): string[] {
  const text = input.trim();
  if (text.length === 0) return [];
  if (text.length <= size) return [text];

  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  /** True where a chunk already carries its overlap, so stitching must skip it. */
  const windowed: boolean[] = [];
  let buffer = "";

  for (const para of paragraphs) {
    if (buffer.length + para.length + 2 <= size) {
      buffer = `${buffer}\n\n${para}`.trim();
      continue;
    }
    if (buffer.length > 0) {
      chunks.push(buffer);
      windowed.push(false);
    }
    if (para.length <= size) {
      buffer = para;
    } else {
      const stride = Math.max(1, size - overlap);
      for (let i = 0; i < para.length; i += stride) {
        chunks.push(para.slice(i, i + size));
        windowed.push(true);
      }
      buffer = "";
    }
  }
  if (buffer.length > 0) {
    chunks.push(buffer);
    windowed.push(false);
  }

  if (overlap > 0 && chunks.length > 1) {
    // Read from `chunks`, write to `stitched`, so each chunk sees its ORIGINAL
    // predecessor rather than an already stitched one.
    const stitched = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
      if (windowed[i]) {
        stitched.push(chunks[i]);
      } else {
        stitched.push(`${chunks[i - 1].slice(-overlap)}\n${chunks[i]}`.trim());
      }
    }
    return stitched;
  }
  return chunks;
}

/**
 * Chunk one filing, carrying full provenance onto every chunk.
 *
 * `chunkId` is deterministic so re-ingesting the same filing updates rows in
 * place instead of duplicating them.
 */
export function chunkFiling(
  text: string,
  meta: FilingMetadata,
  size: number,
  overlap: number,
): Chunk[] {
  const ticker = meta.ticker.toUpperCase();
  const chunks: Chunk[] = [];
  let ordinal = 0;

  for (const section of splitIntoSections(text)) {
    const pieces = splitLong(section.body, size, overlap);
    pieces.forEach((piece, i) => {
      chunks.push({
        chunkId: `${ticker}_FY${meta.fiscalYear}::${section.name}::${i}`,
        text: piece,
        ticker,
        company: meta.company,
        fiscalYear: meta.fiscalYear,
        section: section.name,
        sourceUrl: meta.sourceUrl,
        ordinal: ordinal++,
      });
    });
  }
  return chunks;
}

/** Re-exported so callers can chunk a pre-split section list. */
export type { Section };
