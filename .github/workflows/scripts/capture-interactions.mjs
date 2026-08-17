const ALLOWED_TAGS = new Set(['button', 'summary']);
const ALLOWED_ROLES = new Set(['button', 'switch', 'tab']);
const DENIED_ACTIONS = /(?:^|\b)(?:accept|agree|allow|authorize|back|block|book|buy|call|checkout|clear|comment|confirm|connect|consent|create|delete|destroy|donate|download|email|erase|follow|grant|home|install|like|log\s*(?:in|out)|login|logout|message|new\s+chat|order|pay|post|publish|purchase|rate|register|remove|report|reserve|reset|save|send|share|sign\s*(?:in|out|up)|signin|signout|signup|submit|subscribe|tip|unfollow|upload|vote)(?:\b|$)/i;
const PREFERRED_ACTIONS = /^(?:(?:next|previous|prev)(?:\s+(?:slide|image|item|page|project|carousel))?|go\s+to\s+(?:slide|image|item|page|project)(?:\s+\d+)?|(?:open|show|hide|toggle|expand|collapse)\s+(?:the\s+)?(?:menu|navigation(?:\s+menu)?|sidebar|details|gallery|carousel|settings|theme|tour|information)|(?:play|pause|mute|unmute)(?:\s+(?:animation|video|preview))?|menu|settings|theme|(?:view|show)\s+(?:project\s+)?details)$/i;
const LOCAL_DISMISS_ACTIONS = /^(?:(?:close|cancel|dismiss)(?:\s+(?:dialog|modal|menu|navigation|sidebar|panel|overlay))?|not\s+now|maybe\s+later)$/i;
const MAX_CANDIDATES = 80;
export const MAX_GUIDED_CLICKS = 4;

function clean(value, maximum = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function normalizedCandidate(candidate) {
  const index = Number(candidate?.index);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CANDIDATES) return null;

  const tagName = clean(candidate?.tagName, 20).toLowerCase();
  const role = clean(candidate?.role, 20).toLowerCase();
  const type = clean(candidate?.type, 20).toLowerCase();
  if (!ALLOWED_TAGS.has(tagName) && !ALLOWED_ROLES.has(role)) return null;
  if (
    candidate?.visible !== true
    || candidate?.disabled === true
    || candidate?.ariaDisabled === true
    || candidate?.inert === true
    || candidate?.occluded === true
    || candidate?.formOwned === true
    || candidate?.anchorOwned === true
    || candidate?.hasHref === true
    || candidate?.downloadOwned === true
    || candidate?.contentEditable === true
    || ['file', 'reset', 'submit'].includes(type)
  ) return null;

  const actionLabels = [
    candidate?.text,
    candidate?.ariaLabel,
    candidate?.title,
  ].map((value) => clean(value)).filter(Boolean);
  const actionText = clean(actionLabels.join(' '), 260);
  if (!actionText || DENIED_ACTIONS.test(actionText)) return null;
  const preferredAction = actionLabels.some((label) => PREFERRED_ACTIONS.test(label));
  const localDismissal = actionLabels.some((label) => LOCAL_DISMISS_ACTIONS.test(label));

  const fingerprintLabels = [
    ...actionLabels,
    candidate?.name,
    candidate?.id,
    candidate?.className,
    candidate?.testId,
  ].map((value) => clean(value)).filter(Boolean);
  const semanticText = clean(fingerprintLabels.join(' '), 360);

  return {
    index,
    tagName,
    role,
    actionText,
    preferredAction,
    localDismissal,
    semanticText,
    text: clean(candidate?.ariaLabel || candidate?.text || candidate?.title || 'Control', 100),
    ariaExpanded: candidate?.ariaExpanded === 'true' || candidate?.ariaExpanded === 'false',
    ariaPressed: candidate?.ariaPressed === 'true' || candidate?.ariaPressed === 'false',
    ariaHasPopup: Boolean(clean(candidate?.ariaHasPopup, 30))
      && clean(candidate?.ariaHasPopup, 30).toLowerCase() !== 'false',
  };
}

export function describeSafeInteraction(candidate) {
  const normalized = normalizedCandidate(candidate);
  if (!normalized) return null;

  const presentationControl = normalized.tagName === 'summary'
    || normalized.role === 'tab'
    || normalized.role === 'switch'
    || normalized.ariaExpanded
    || normalized.ariaPressed
    || normalized.ariaHasPopup
    || normalized.preferredAction
    || normalized.localDismissal;
  if (!presentationControl) return null;

  let score = normalized.tagName === 'button' ? 1 : 4;
  if (normalized.role === 'tab' || normalized.role === 'switch') score += 6;
  if (normalized.ariaExpanded) score += 5;
  if (normalized.ariaPressed) score += 4;
  if (normalized.ariaHasPopup) score += 4;
  if (normalized.preferredAction) score += 5;
  if (normalized.text.length <= 80) score += 1;

  const fingerprint = [
    normalized.tagName,
    normalized.role,
    normalized.semanticText.toLowerCase(),
  ].join('|');
  return {
    index: normalized.index,
    fingerprint,
    score,
    text: normalized.text,
  };
}

export function selectSafeInteractions(candidates, {
  limit = MAX_GUIDED_CLICKS,
  seenFingerprints = new Set(),
} = {}) {
  if (!Array.isArray(candidates)) return [];
  const safeLimit = Math.max(0, Math.min(Number(limit) || 0, MAX_GUIDED_CLICKS));
  const seen = seenFingerprints instanceof Set ? seenFingerprints : new Set(seenFingerprints || []);
  const selectedFingerprints = new Set();

  return candidates
    .slice(0, MAX_CANDIDATES)
    .map(describeSafeInteraction)
    .filter((descriptor) => (
      descriptor
      && !seen.has(descriptor.fingerprint)
      && !selectedFingerprints.has(descriptor.fingerprint)
      && selectedFingerprints.add(descriptor.fingerprint)
    ))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, safeLimit);
}

export function isSameDocumentUrl(initialUrl, currentUrl) {
  try {
    const initial = new URL(initialUrl);
    const current = new URL(currentUrl);
    return initial.protocol === 'https:'
      && current.protocol === 'https:'
      && !initial.username
      && !initial.password
      && !current.username
      && !current.password
      && initial.origin === current.origin
      && initial.pathname === current.pathname
      && initial.search === current.search;
  } catch {
    return false;
  }
}
