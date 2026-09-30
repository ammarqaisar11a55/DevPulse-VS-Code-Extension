/** Characters used in pairing keys: no 0/O, 1/I/L to avoid transcription mistakes. */
export const PAIRING_KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUPS = 3;
const GROUP_LENGTH = 4;

/**
 * Normalizes a typed pairing key exactly like the server: case-insensitive, spaces and dashes
 * ignored, with or without the "DP" prefix. Returns `DP-XXXX-XXXX-XXXX` or null.
 */
export function normalizePairingKey(input: string): string | null {
  let compact = input.toUpperCase().replace(/[\s-]/g, '');
  if (compact.startsWith('DP')) compact = compact.slice(2);
  if (compact.length !== GROUPS * GROUP_LENGTH) return null;
  for (const char of compact) if (!PAIRING_KEY_ALPHABET.includes(char)) return null;
  const groups = compact.match(new RegExp(`.{${GROUP_LENGTH}}`, 'g')) ?? [];
  return `DP-${groups.join('-')}`;
}
