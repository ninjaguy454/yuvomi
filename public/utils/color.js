/**
 * Neutraler Ersatz-Avatarhintergrund, wenn ein Benutzer keine eigene Farbe hat.
 * Als konkreter Hex nötig, weil getReadableTextColor die Luminanz berechnet —
 * eine CSS-Variable ließe sich hier nicht auswerten. Einzige Quelle der Wahrheit
 * für alle Avatar-Renderer (neutrales Systemgrau, farbtonlos).
 */
export const AVATAR_FALLBACK_COLOR = '#8E8E93';

/**
 * Die Farben, die ein Objekt ohne Bild bekommt - Mitglieder seit jeher, und
 * seit #469 auch die Kacheln der Schnellzugriffe.
 *
 * SIE STEHT HIER UND NICHT MEHR IN admin-family.js, weil sie ab jetzt zwei
 * Aufrufer hat. Eine zweite Palette daneben hätte ausgesehen wie eine
 * Entscheidung und wäre eine Abschrift gewesen: eine Kachel neben einem
 * Mitgliedsbild spricht dieselbe Sprache oder sie fällt auf. Die Kalenderfarben
 * bleiben davon unberührt - sie beantworten eine andere Frage (#856) und teilen
 * mit dieser Liste bewusst keinen Wert.
 */
export const AVATAR_COLORS = ['#007AFF', '#34C759', '#FF9500', '#FF3B30', '#AF52DE', '#FF2D55'];

/**
 * Returns the design-system text token with the stronger WCAG contrast
 * against an arbitrary six-digit hex background.
 */
export function getReadableTextColor(background) {
  const rgb = parseHexColor(background);
  if (!rgb) return 'var(--color-text-primary)';

  const luminance = relativeLuminance(rgb);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;

  return whiteContrast >= blackContrast
    ? 'var(--color-text-on-accent)'
    : 'var(--color-ink-on-bright)';
}

function parseHexColor(value) {
  const match = String(value || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;

  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
}

function relativeLuminance([red, green, blue]) {
  const linearize = (channel) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * linearize(red)
    + 0.7152 * linearize(green)
    + 0.0722 * linearize(blue);
}
