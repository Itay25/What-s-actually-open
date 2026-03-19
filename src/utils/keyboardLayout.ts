/**
 * Maps English keyboard layout to Hebrew keyboard layout.
 */
const enToHeMap: Record<string, string> = {
  'q': '/',
  'w': "'",
  'e': 'ק',
  'r': 'ר',
  't': 'א',
  'y': 'ט',
  'u': 'ו',
  'i': 'ן',
  'o': 'ם',
  'p': 'פ',
  '[': ']',
  ']': '[',
  'a': 'ש',
  's': 'ד',
  'd': 'ג',
  'f': 'כ',
  'g': 'ע',
  'h': 'י',
  'j': 'ח',
  'k': 'ל',
  'l': 'ך',
  ';': 'ף',
  "'": ',',
  'z': 'ז',
  'x': 'ס',
  'c': 'ב',
  'v': 'ה',
  'b': 'נ',
  'n': 'מ',
  'm': 'צ',
  ',': 'ת',
  '.': 'ץ',
  '/': '.',
  ' ': ' ',
};

/**
 * Converts a string typed in English layout to its Hebrew layout equivalent.
 * Only converts characters that have a mapping.
 */
export function convertEnToHeLayout(text: string): string {
  return text
    .toLowerCase()
    .split('')
    .map(char => enToHeMap[char] || char)
    .join('');
}

/**
 * Checks if a string contains any English letters.
 */
export function hasEnglishLetters(text: string): boolean {
  return /[a-z]/i.test(text);
}
