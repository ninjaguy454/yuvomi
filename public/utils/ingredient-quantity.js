export function parseQuantity(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const unicodeFractions = {
    '¼': 1 / 4,
    '½': 1 / 2,
    '¾': 3 / 4,
    '⅐': 1 / 7,
    '⅑': 1 / 9,
    '⅒': 1 / 10,
    '⅓': 1 / 3,
    '⅔': 2 / 3,
    '⅕': 1 / 5,
    '⅖': 2 / 5,
    '⅗': 3 / 5,
    '⅘': 4 / 5,
    '⅙': 1 / 6,
    '⅚': 5 / 6,
    '⅛': 1 / 8,
    '⅜': 3 / 8,
    '⅝': 5 / 8,
    '⅞': 7 / 8,
  };
  const unicode = raw.match(/^([+-]?)(\d*)\s*([¼-¾⅐-⅞])\s*(.*)$/);
  if (unicode) {
    const fraction = unicodeFractions[unicode[3]];
    const whole = unicode[2] ? Number(unicode[2]) : 0;
    const amount = (unicode[1] === '-' ? -1 : 1) * (whole + fraction);
    const unit = unicode[4].trim().replace(/\s+/g, ' ').toLowerCase();
    return { amount, unit };
  }

  const mixedFraction = raw.match(/^([+-]?\d+)\s+(\d+)\/(\d+)\s*(.*)$/);
  if (mixedFraction && Number(mixedFraction[3]) !== 0) {
    const whole = Number(mixedFraction[1]);
    const fraction = Number(mixedFraction[2]) / Number(mixedFraction[3]);
    const amount = whole < 0 ? whole - fraction : whole + fraction;
    const unit = mixedFraction[4].trim().replace(/\s+/g, ' ').toLowerCase();
    return { amount, unit };
  }

  const fraction = raw.match(/^([+-]?)(\d+)\/(\d+)\s*(.*)$/);
  if (fraction && Number(fraction[3]) !== 0) {
    const amount = (fraction[1] === '-' ? -1 : 1) * (Number(fraction[2]) / Number(fraction[3]));
    const unit = fraction[4].trim().replace(/\s+/g, ' ').toLowerCase();
    return { amount, unit };
  }

  const match = raw.match(/^([+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+))\s*(.*)$/);
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].trim().replace(/\s+/g, ' ').toLowerCase();
  return { amount, unit };
}
