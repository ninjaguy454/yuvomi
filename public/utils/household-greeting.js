import { t } from '../i18n.js';

// The name is household configuration, never a device label or a member fallback.
// Return plain text; rendering callers must escape it or use textContent.
export function householdGreeting(familyName) {
  const name = typeof familyName === 'string' ? familyName.trim() : '';
  if (!name) return t('pairedDisplay.greetingGeneric');
  return t(/\bfamily\b/i.test(name) ? 'pairedDisplay.greetingNamed' : 'pairedDisplay.greetingFamily', { name });
}
