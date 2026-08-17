/* eslint-env node */
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  parsePublicHttpsUrl,
  resolvePublicHost,
  validatePublicHttpsUrl,
} from '../../../netlify/functions/_shared/safe-url.mjs';

const MAX_BROWSER_REQUESTS = 180;
const MAX_PROXY_TUNNELS = 80;
const MAX_TUNNEL_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_PROXY_BYTES = 80 * 1024 * 1024;
const MAX_COVER_BYTES = 3 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

function requiredEnvironment(name) {
  const value = String(process.env[name] || '');
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function validateSlug(value) {
  if (value.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error('The project slug is invalid.');
  }
  return value;
}

function validateRequestId(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('The capture request ID is invalid.');
  }
  return value;
}

function rejectTunnel(socket, status = '403 Forbidden') {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

function connectPinned(addresses, port) {
  return new Promise((resolve, reject) => {
    let index = 0;
    const errors = [];

    const tryNext = () => {
      if (index >= addresses.length) {
        reject(new Error(`No validated destination accepted the connection (${errors.length} attempts).`));
        return;
      }

      const destination = addresses[index];
      index += 1;
      const socket = net.connect({
        host: destination.address,
        port,
        family: destination.family,
      });
      const timeout = setTimeout(() => socket.destroy(new Error('Destination connection timed out.')), 10000);
      const handleError = (error) => {
        clearTimeout(timeout);
        errors.push(error);
        tryNext();
      };
      socket.once('error', handleError);
      socket.once('connect', () => {
        clearTimeout(timeout);
        socket.removeListener('error', handleError);
        socket.on('error', () => {});
        resolve(socket);
      });
    };

    tryNext();
  });
}

async function startPinnedHttpsProxy() {
  let tunnelCount = 0;
  let totalBytes = 0;

  const server = http.createServer((_request, response) => {
    response.writeHead(403, { Connection: 'close', 'Content-Type': 'text/plain' });
    response.end('Only validated HTTPS CONNECT tunnels are allowed.');
  });
  server.maxConnections = 64;

  server.on('connect', async (request, clientSocket, initialData) => {
    tunnelCount += 1;
    clientSocket.on('error', () => {});
    clientSocket.pause();
    if (tunnelCount > MAX_PROXY_TUNNELS) {
      rejectTunnel(clientSocket, '429 Too Many Requests');
      return;
    }

    let target;
    try {
      target = parsePublicHttpsUrl(`https://${request.url}/`);
      const parsedAuthority = new URL(`https://${request.url}/`);
      if (parsedAuthority.pathname !== '/' || parsedAuthority.search || parsedAuthority.hash) {
        throw new Error('Invalid CONNECT authority.');
      }
    } catch {
      rejectTunnel(clientSocket);
      return;
    }

    try {
      const addresses = await resolvePublicHost(target.hostname);
      const upstream = await connectPinned(addresses, 443);
      let tunnelBytes = 0;

      const countBytes = (chunk) => {
        tunnelBytes += chunk.length;
        totalBytes += chunk.length;
        if (tunnelBytes > MAX_TUNNEL_BYTES || totalBytes > MAX_TOTAL_PROXY_BYTES) {
          upstream.destroy(new Error('Capture network byte limit exceeded.'));
          clientSocket.destroy();
        }
      };

      upstream.on('error', () => clientSocket.destroy());
      upstream.on('data', countBytes);
      clientSocket.on('data', countBytes);
      upstream.setTimeout(20000, () => upstream.destroy(new Error('Tunnel timed out.')));

      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: portfolio-capture\r\n\r\n');
      if (initialData?.length) upstream.write(initialData);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      clientSocket.resume();
    } catch {
      rejectTunnel(clientSocket, '502 Bad Gateway');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the capture proxy.');

  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function pngToWebp(browser, pngBytes) {
  const context = await browser.newContext({
    javaScriptEnabled: true,
    serviceWorkers: 'block',
  });
  try {
    const page = await context.newPage();
    const encoded = pngBytes.toString('base64');
    const webp = await page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const drawing = canvas.getContext('2d', { alpha: false });
      drawing.drawImage(image, 0, 0);
      return canvas.toDataURL('image/webp', 0.84).split(',', 2)[1];
    }, encoded);
    return Buffer.from(webp, 'base64');
  } finally {
    await context.close();
  }
}

async function capture() {
  const slug = validateSlug(requiredEnvironment('CAPTURE_SLUG'));
  validateRequestId(requiredEnvironment('CAPTURE_REQUEST_ID'));
  const artifactDirectory = path.resolve(requiredEnvironment('CAPTURE_ARTIFACT_DIR'));
  const runtimeDirectory = path.resolve(requiredEnvironment('PLAYWRIGHT_RUNTIME_DIR'));
  const target = await validatePublicHttpsUrl(requiredEnvironment('CAPTURE_URL'));
  const requireFromRuntime = createRequire(path.join(runtimeDirectory, 'runtime.cjs'));
  const { chromium } = requireFromRuntime('playwright');

  await fs.mkdir(artifactDirectory, { recursive: true });
  const temporaryVideoDirectory = path.join(artifactDirectory, '.video');
  await fs.mkdir(temporaryVideoDirectory, { recursive: true });

  const proxy = await startPinnedHttpsProxy();
  let browser;
  try {
    browser = await chromium.launch({
      chromiumSandbox: true,
      headless: true,
      env: {
        HOME: process.env.HOME,
        LANG: process.env.LANG || 'C.UTF-8',
        PATH: process.env.PATH,
        TMPDIR: process.env.RUNNER_TEMP || '/tmp',
      },
      args: [
        `--proxy-server=http://127.0.0.1:${proxy.port}`,
        '--proxy-bypass-list=<-loopback>',
        '--disable-quic',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    });

    const context = await browser.newContext({
      acceptDownloads: false,
      bypassCSP: false,
      deviceScaleFactor: 1,
      extraHTTPHeaders: { 'DNT': '1' },
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      permissions: [],
      recordVideo: { dir: temporaryVideoDirectory, size: { width: 1280, height: 720 } },
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 900 },
    });

    let requestCount = 0;
    let mainNavigationCount = 0;
    let primaryPage = null;
    await context.route('**/*', async (route) => {
      requestCount += 1;
      const request = route.request();
      try {
        if (
          primaryPage
          && request.isNavigationRequest()
          && request.frame() === primaryPage.mainFrame()
        ) mainNavigationCount += 1;
        if (requestCount > MAX_BROWSER_REQUESTS || !['GET', 'HEAD'].includes(request.method())) {
          await route.abort('blockedbyclient');
          return;
        }
        if (mainNavigationCount > 6) {
          await route.abort('blockedbyclient');
          return;
        }
        parsePublicHttpsUrl(request.url());
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    if (typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket('**/*', (socket) => socket.close());
    }

    const page = await context.newPage();
    primaryPage = page;
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(15000);
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
    page.on('download', (download) => download.cancel().catch(() => {}));
    context.on('page', (openedPage) => {
      if (openedPage !== page) openedPage.close().catch(() => {});
    });

    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);
    await validatePublicHttpsUrl(page.url());
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);

    const pngCover = await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
      type: 'png',
    });
    const video = page.video();
    if (!video) throw new Error('Playwright did not start video recording.');

    const scrollHeight = await page.evaluate(() => Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
    ));
    const maximumScroll = Math.max(0, Math.min(scrollHeight - 900, 9000));
    const steps = 12;
    for (let index = 1; index <= steps; index += 1) {
      const top = Math.round((maximumScroll * index) / steps);
      await page.evaluate((position) => window.scrollTo({ top: position, behavior: 'smooth' }), top);
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(500);
    await context.close();

    const videoPath = path.join(artifactDirectory, 'walkthrough.webm');
    await video.saveAs(videoPath);
    const webpCover = await pngToWebp(browser, pngCover);
    const coverPath = path.join(artifactDirectory, 'cover.webp');
    await fs.writeFile(coverPath, webpCover, { flag: 'wx' });
    await fs.rm(temporaryVideoDirectory, { recursive: true, force: true });

    await validateFile(coverPath, 'cover');
    await validateFile(videoPath, 'video');
    console.log(`Captured validated media for ${slug}.`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await proxy.close().catch(() => {});
  }
}

function readEbmlVint(bytes, offset, stripMarker) {
  if (offset >= bytes.length || bytes[offset] === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (bytes[offset] & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = BigInt(stripMarker ? bytes[offset] & (mask - 1) : bytes[offset]);
  for (let index = 1; index < length; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return { length, value };
}

function hasWebmDocType(bytes) {
  if (bytes.length < 12 || !bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return false;
  }
  const headerSize = readEbmlVint(bytes, 4, true);
  if (!headerSize || headerSize.value > 4096n) return false;
  const headerStart = 4 + headerSize.length;
  const headerEnd = headerStart + Number(headerSize.value);
  if (headerEnd > bytes.length) return false;

  let offset = headerStart;
  while (offset < headerEnd) {
    const id = readEbmlVint(bytes, offset, false);
    if (!id || id.length > 4) return false;
    offset += id.length;
    const size = readEbmlVint(bytes, offset, true);
    if (!size) return false;
    offset += size.length;
    if (size.value > BigInt(headerEnd - offset)) return false;
    const dataLength = Number(size.value);
    if (id.value === 0x4282n) {
      return dataLength === 4 && bytes.subarray(offset, offset + 4).toString('ascii') === 'webm';
    }
    offset += dataLength;
  }
  return false;
}

async function validateFile(filePath, type) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`The ${type} artifact is not a regular file.`);
  const maximum = type === 'cover' ? MAX_COVER_BYTES : MAX_VIDEO_BYTES;
  if (stat.size < 32 || stat.size > maximum) throw new Error(`The ${type} artifact has an invalid size.`);

  const handle = await fs.open(filePath, 'r');
  try {
    const signature = Buffer.alloc(Math.min(4096, stat.size));
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (type === 'cover') {
      if (
        bytesRead < 12
        || signature.subarray(0, 4).toString('ascii') !== 'RIFF'
        || signature.subarray(8, 12).toString('ascii') !== 'WEBP'
        || signature.readUInt32LE(4) + 8 !== stat.size
      ) throw new Error('The cover artifact is not WebP.');
    } else if (!hasWebmDocType(signature.subarray(0, bytesRead))) {
      throw new Error('The walkthrough artifact is not WebM.');
    }
  } finally {
    await handle.close();
  }
}

async function copyValidated(source, destination) {
  await validateFile(source, destination.endsWith('.webp') ? 'cover' : 'video');
  const temporary = `${destination}.tmp-${process.pid}`;
  await fs.copyFile(source, temporary);
  await fs.rename(temporary, destination);
}

async function stage() {
  const slug = validateSlug(requiredEnvironment('CAPTURE_SLUG'));
  const requestId = validateRequestId(requiredEnvironment('CAPTURE_REQUEST_ID'));
  const artifactDirectory = path.resolve(requiredEnvironment('CAPTURE_ARTIFACT_DIR'));
  const repositoryRoot = path.resolve(requiredEnvironment('GITHUB_WORKSPACE'));
  const uploadRoot = path.join(repositoryRoot, 'public', 'portfolio', 'uploads');
  const destinationDirectory = path.resolve(uploadRoot, slug, 'captures', requestId);
  if (!destinationDirectory.startsWith(`${uploadRoot}${path.sep}`)) {
    throw new Error('The capture destination escaped the upload root.');
  }

  const realArtifactDirectory = await fs.realpath(artifactDirectory);
  const coverSource = await fs.realpath(path.join(artifactDirectory, 'cover.webp'));
  const videoSource = await fs.realpath(path.join(artifactDirectory, 'walkthrough.webm'));
  for (const source of [coverSource, videoSource]) {
    if (!source.startsWith(`${realArtifactDirectory}${path.sep}`)) {
      throw new Error('An artifact path escaped its download directory.');
    }
  }

  await fs.mkdir(destinationDirectory, { recursive: true });
  await copyValidated(coverSource, path.join(destinationDirectory, 'cover.webp'));
  await copyValidated(videoSource, path.join(destinationDirectory, 'walkthrough.webm'));
  console.log(`Staged validated media for ${slug}.`);
}

const mode = process.argv[2];
if (mode === 'capture') await capture();
else if (mode === 'stage') await stage();
else throw new Error('Use capture or stage mode.');
