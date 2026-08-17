import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_URL_LENGTH = 2048;
const DNS_TIMEOUT_MS = 5000;

const blockedIpv4 = new net.BlockList();
[
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].forEach(([address, prefix]) => blockedIpv4.addSubnet(address, prefix, 'ipv4'));

const globalIpv6 = new net.BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');

const blockedIpv6 = new net.BlockList();
[
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
].forEach(([address, prefix]) => blockedIpv6.addSubnet(address, prefix, 'ipv6'));

export class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function withTimeout(promise, milliseconds, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new UnsafeUrlError(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function normalizedHostname(url) {
  const raw = url.hostname.toLowerCase().replace(/\.$/, '');
  return raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
}

function validateHostname(hostname) {
  if (!hostname || hostname.length > 253) {
    throw new UnsafeUrlError('The URL hostname is invalid.');
  }

  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.home')
    || hostname.endsWith('.lan')
  ) {
    throw new UnsafeUrlError('Private and local hostnames are not allowed.');
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily && !isPublicAddress(hostname, literalFamily)) {
    throw new UnsafeUrlError('Private, reserved, and non-routable addresses are not allowed.');
  }

  if (!literalFamily) {
    const labels = hostname.split('.');
    if (
      labels.length < 2
      || labels.some((label) => (
        !label
        || label.length > 63
        || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
      ))
    ) {
      throw new UnsafeUrlError('The URL must use a valid public hostname.');
    }
  }
}

export function isPublicAddress(address, family = net.isIP(address)) {
  const cleanAddress = String(address).split('%', 1)[0];
  const detectedFamily = Number(family) || net.isIP(cleanAddress);

  if (detectedFamily === 4) {
    return !blockedIpv4.check(cleanAddress, 'ipv4');
  }

  if (detectedFamily === 6) {
    return globalIpv6.check(cleanAddress, 'ipv6')
      && !blockedIpv6.check(cleanAddress, 'ipv6');
  }

  return false;
}

export function parsePublicHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new UnsafeUrlError('Enter an HTTPS URL no longer than 2,048 characters.');
  }

  // eslint-disable-next-line no-control-regex -- URL controls must be rejected explicitly.
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new UnsafeUrlError('The URL contains invalid whitespace or control characters.');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UnsafeUrlError('Enter a valid HTTPS URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new UnsafeUrlError('Only HTTPS URLs are allowed.');
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError('URLs containing credentials are not allowed.');
  }
  if (parsed.port && parsed.port !== '443') {
    throw new UnsafeUrlError('Only the standard HTTPS port is allowed.');
  }
  if (parsed.search) {
    throw new UnsafeUrlError('Use a public project URL without query parameters.');
  }

  const hostname = normalizedHostname(parsed);
  validateHostname(hostname);
  parsed.hash = '';

  return { hostname, url: parsed.toString() };
}

export async function resolvePublicHost(hostname) {
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (!isPublicAddress(hostname, literalFamily)) {
      throw new UnsafeUrlError('Private, reserved, and non-routable addresses are not allowed.');
    }
    return [{ address: hostname, family: literalFamily }];
  }

  let addresses;
  try {
    addresses = await withTimeout(
      dns.lookup(hostname, { all: true, verbatim: true }),
      DNS_TIMEOUT_MS,
      'DNS resolution timed out.',
    );
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw error;
    throw new UnsafeUrlError('The hostname could not be resolved.');
  }

  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 32) {
    throw new UnsafeUrlError('The hostname did not resolve to a usable public address.');
  }
  if (addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
    throw new UnsafeUrlError('The hostname resolves to a private or reserved address.');
  }

  return addresses.map(({ address, family }) => ({ address, family: Number(family) }));
}

export async function validatePublicHttpsUrl(value) {
  const parsed = parsePublicHttpsUrl(value);
  const addresses = await resolvePublicHost(parsed.hostname);
  return { ...parsed, addresses };
}
