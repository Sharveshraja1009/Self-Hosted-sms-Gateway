import { describe, expect, it } from 'vitest';

import { segment } from '../src/domain/message.js';

/**
 * SMS segmentation.
 *
 * This is the function that decides what the carrier bills you for, so it gets
 * its own suite. Every case below is a real support ticket waiting to happen:
 * "why was a 90-character message charged as three?"
 */
describe('segment()', () => {
  describe('GSM-7', () => {
    it('counts a plain ASCII message as one part', () => {
      expect(segment('Hello there')).toEqual({ partCount: 1, isUnicode: false, encodedLength: 11 });
    });

    it('fits exactly 160 characters into a single part', () => {
      const body = 'a'.repeat(160);
      expect(segment(body)).toMatchObject({ partCount: 1, isUnicode: false });
    });

    it('splits at 161 - and the parts are 153, not 160', () => {
      // The concatenation header eats 7 septets of every part. A naive
      // ceil(length / 160) says 2 parts for 320 chars; the radio says 3.
      expect(segment('a'.repeat(161))).toMatchObject({ partCount: 2 });
      expect(segment('a'.repeat(306))).toMatchObject({ partCount: 2 }); // 2 x 153
      expect(segment('a'.repeat(307))).toMatchObject({ partCount: 3 });
    });

    it('charges two septets for an extended character', () => {
      // '€' is in the GSM-7 extension table: escape byte + character.
      expect(segment('€')).toEqual({ partCount: 1, isUnicode: false, encodedLength: 2 });

      // 80 euro signs = 160 septets = still one part, despite being 80 characters.
      expect(segment('€'.repeat(80))).toMatchObject({ partCount: 1, encodedLength: 160 });
      expect(segment('€'.repeat(81))).toMatchObject({ partCount: 2 });
    });

    it('treats an empty body as one part, not zero', () => {
      // Guards against a `ceil(0/160) = 0` bug that would report a free SMS.
      expect(segment('')).toMatchObject({ partCount: 1 });
    });
  });

  describe('UCS-2', () => {
    it('flips the whole message to Unicode for a single non-GSM character', () => {
      // THE classic bug: a curly apostrophe pasted from Word. Visually identical
      // to ', but it collapses the limit from 160 to 70 and triples the bill.
      const straight = segment("It's fine".padEnd(150, '.'));
      const curly = segment('It’s fine'.padEnd(150, '.'));

      expect(straight).toMatchObject({ isUnicode: false, partCount: 1 });
      expect(curly).toMatchObject({ isUnicode: true, partCount: 3 });
    });

    it('fits 70 UCS-2 characters into one part and splits at 71', () => {
      expect(segment('д'.repeat(70))).toMatchObject({ partCount: 1, isUnicode: true });
      expect(segment('д'.repeat(71))).toMatchObject({ partCount: 2, isUnicode: true });
      expect(segment('д'.repeat(134))).toMatchObject({ partCount: 2 }); // 2 x 67
      expect(segment('д'.repeat(135))).toMatchObject({ partCount: 3 });
    });

    it('counts an emoji as TWO units, because the radio counts UTF-16 code units', () => {
      // '😀' is a surrogate pair. Iterating codepoints would count it as 1 and
      // under-report the part count on any emoji-heavy message.
      expect(segment('😀')).toMatchObject({ isUnicode: true, encodedLength: 2, partCount: 1 });

      // 35 emoji = 70 code units = the exact single-part boundary.
      expect(segment('😀'.repeat(35))).toMatchObject({ encodedLength: 70, partCount: 1 });
      expect(segment('😀'.repeat(36))).toMatchObject({ encodedLength: 72, partCount: 2 });
    });

    it('handles Devanagari, which this gateway will see constantly', () => {
      expect(segment('नमस्ते')).toMatchObject({ isUnicode: true, partCount: 1 });
    });
  });
});
