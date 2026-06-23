const COMBINING_OR_INVISIBLE_CHARACTERS = /[\p{M}\p{Cf}\p{Cc}\p{Cs}]/gu;
const ASCII_ALPHANUMERIC = /^[A-Z0-9]$/;

const CONFUSABLE_ASCII_MAP = new Map([
  ['Ε', 'E'],
  ['Е', 'E'],
  ['ε', 'E'],
  ['е', 'E'],
  ['Τ', 'T'],
  ['Т', 'T'],
  ['τ', 'T'],
  ['т', 'T'],
  ['Η', 'H'],
  ['Н', 'H'],
  ['һ', 'H'],
  ['н', 'H']
]);

export function normalizeAddress(address) {
  return typeof address === 'string' ? address.trim().toLowerCase() : null;
}

export function buildAsciiSkeleton(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value
    .normalize('NFKD')
    .replace(COMBINING_OR_INVISIBLE_CHARACTERS, '')
    .trim()
    .toUpperCase();

  if (!normalizedValue) {
    return null;
  }

  let skeleton = '';

  for (const character of normalizedValue) {
    const mappedCharacter = CONFUSABLE_ASCII_MAP.get(character) ?? character;

    if (ASCII_ALPHANUMERIC.test(mappedCharacter)) {
      skeleton += mappedCharacter;
    }
  }

  return skeleton || null;
}
