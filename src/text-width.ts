const ELLIPSIS = "…";
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const WIDE_EMOJI_COMPONENT_PATTERN =
  /[\p{Emoji_Presentation}\p{Regional_Indicator}\p{Emoji_Modifier}]|\u20e3/u;
const EXTENDED_PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;
const EMOJI_SEQUENCE_MARK_PATTERN = /[\ufe0f\u200d]/u;

function isCombiningCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function graphemeWidth(grapheme: string): number {
  if (
    WIDE_EMOJI_COMPONENT_PATTERN.test(grapheme) ||
    (EXTENDED_PICTOGRAPHIC_PATTERN.test(grapheme) &&
      EMOJI_SEQUENCE_MARK_PATTERN.test(grapheme))
  ) {
    return 2;
  }

  let columns = 0;
  // Iterate by code point, not by UTF-16 code unit, so multi-codepoint
  // graphemes (skin-tone emoji, flag sequences) are measured correctly.
  for (const codePoint of codePointsOf(grapheme)) {
    columns += codePointWidth(codePoint);
  }
  return columns;
}

function* codePointsOf(value: string): Generator<number> {
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    yield codePoint;
    index += codePoint > 0xffff ? 2 : 1;
  }
}

function codePointWidth(codePoint: number): number {
  if (
    codePoint === 0 ||
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint < 0xa0)
  ) {
    return 0;
  }
  if (codePoint === 0x200d || isCombiningCodePoint(codePoint)) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

export function textColumns(value: string): number {
  let columns = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    columns += graphemeWidth(segment);
  }
  return columns;
}

export function takeColumns(value: string, maxColumns: number): string {
  if (maxColumns <= 0) return "";

  let columns = 0;
  let result = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const width = graphemeWidth(segment);
    if (columns + width > maxColumns) break;
    columns += width;
    result += segment;
  }
  return result;
}

export function truncateToColumns(value: string, maxColumns: number): string {
  if (maxColumns <= 0) return "";
  if (textColumns(value) <= maxColumns) return value;
  if (maxColumns <= textColumns(ELLIPSIS)) return ELLIPSIS;

  const prefix = takeColumns(
    value,
    maxColumns - textColumns(ELLIPSIS),
  ).trimEnd();
  return `${prefix}${ELLIPSIS}`;
}
