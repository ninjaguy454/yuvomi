/** Household-only Weather. A device never borrows its pairing parent's location. */
import * as db from '../db.js';
import { buildRouter } from '../routes/weather.js';
import { assertDeviceModule } from './device-content.js';
import { deviceRequestStillValid, normalizeDevicePreferences } from './devices.js';

// Separate from personal Weather: its cache can contain a member's city label,
// even when that member's coordinates happen to match the household's.
const householdWeather = buildRouter();

export function deviceWeather(req, res) {
  const principal = req.devicePrincipal;
  assertDeviceModule(principal, 'dashboard');
  if (principal.permissions?.widgets?.weather !== 'allow')
    return res.status(403).json({ error: 'Weather is not allowed on this display.' });
  if (!normalizeDevicePreferences(db.get(), principal.preferences).widgets.some(widget => widget.id === 'weather' && widget.visible))
    return res.json({ data: null });
  const forwarded = Object.create(req);
  forwarded.url = '/'; forwarded.authUserId = null; forwarded.session = {};
  // Retain language only. In particular, an OWM city query cannot select a
  // different location from the household's existing provider configuration.
  const lang = typeof req.query?.lang === 'string' && /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?$/i.test(req.query.lang) ? req.query.lang : undefined;
  Object.defineProperty(forwarded, 'query', { value: { lang } });
  const response = Object.create(res);
  response.json = body => {
    if (!deviceRequestStillValid(db.get(), req))
      return res.status(409).json({ error: 'The display access changed.', reason: 'device_context_changed' });
    return res.status(response.statusCode).json(body);
  };
  return householdWeather.handle(forwarded, response, () => res.status(403).json({ error: 'Weather request is not supported.' }));
}
