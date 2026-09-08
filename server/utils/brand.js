/** Display branding only. Persisted keys, integration identities and file paths stay stable. */
export { DEFAULT_APP_NAME as APP_NAME, displayAppName } from '../../public/utils/branding.js';

const BRAND_ASSETS = new Set([
  'favicon.ico', 'icons/vidamia-mark.svg', 'icons/favicon-16.png', 'icons/favicon-32.png',
  // Previous app styles may request this alias while an installed PWA updates.
  'icons/ordoma-mark.svg',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png', 'icons/notification-badge.png',
]);

/** Deployment assets must revalidate even on Windows, where Express supplies backslashes. */
export function isBrandAsset(filePath) {
  const normalized = String(filePath).replaceAll('\\', '/');
  const marker = normalized.lastIndexOf('/public/');
  return marker >= 0 && BRAND_ASSETS.has(normalized.slice(marker + '/public/'.length));
}
