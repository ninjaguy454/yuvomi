import { api } from '/api.js';
import { setMemberLabels, clearMemberLabels, memberLabelSnapshot, sameMemberLabelContext } from './member-label.js';

/** Refresh before a route renders. The response contains computed age, never DOB.
 * A failed request leaves ordinary names usable, without retaining stale identity.
 */
export async function loadMemberLabels() {
  const captured = memberLabelSnapshot();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await api.get('/auth/member-labels', { signal: controller.signal });
    setMemberLabels(response?.data || [], captured);
  } catch {
    if (sameMemberLabelContext(captured)) clearMemberLabels();
  } finally { clearTimeout(timeout); }
}
