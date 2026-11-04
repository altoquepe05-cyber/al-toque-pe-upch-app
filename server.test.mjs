import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { composePrompt, createAlToqueServer, detectMenuIntent, getAssistantPersona, getLocalMenuAnswer, makeRiderSupportInstructions, selectMenuItem, shouldUseWebSearch, styleLocalAnswer } from './server.mjs';

async function createReelsTestServer(t, testDataDir, reelsDeletePassword = 'test-reels-delete-password') {
  const server = createAlToqueServer({
    ordersFile: join(testDataDir, 'orders.json'),
    reelsFile: join(testDataDir, 'reels.json'),
    reelsVideosDir: join(testDataDir, 'reels-videos'),
    reelsDeletePassword
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    await rm(testDataDir, { recursive: true, force: true });
  });
  return server;
}

async function createReelsTestDirectory() {
  return mkdtemp(join(process.cwd(), `.reels-test-${randomUUID()}-`));
}

test('serves the Reel watermark image as a public PNG asset', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/al-toque-reel-watermark.png`);
  const image = Buffer.from(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('ends a connected voice call after ten minutes', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  let currentTime = 1_700_000_000_000;
  const server = createAlToqueServer({
    ordersFile: join(testDataDir, 'orders.json'),
    reelsFile: join(testDataDir, 'reels.json'),
    reelsVideosDir: join(testDataDir, 'reels-videos'),
    now: () => currentTime
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(testDataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const callUrl = `${baseUrl}/api/orders/UPCH-CALL-TEST/call`;
  const postCallAction = (role, action) => fetch(callUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ role, action })
  });

  assert.equal((await postCallAction('customer', 'start')).status, 201);
  assert.equal((await postCallAction('rider', 'accept')).status, 200);
  currentTime += 10 * 60_000 - 1;
  let response = await fetch(`${callUrl}?role=customer&after=0`);
  assert.equal((await response.json()).call.status, 'connecting');

  currentTime += 1;
  response = await fetch(`${callUrl}?role=customer&after=0`);
  const expiredCall = await response.json();
  assert.equal(expiredCall.call.status, 'ended');
  assert.equal(expiredCall.call.endReason, 'timeout');
  assert.ok(expiredCall.signals.some((signal) => signal.type === 'timeout'));
  assert.equal((await postCallAction('customer', 'hangup')).status, 409);
});

test('sends an opt-in confirmation through Gmail OAuth without exposing provider credentials', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const requestedCalls = [];
  let gmailStatus = 200;
  const server = createAlToqueServer({
    ordersFile: join(testDataDir, 'orders.json'),
    reelsFile: join(testDataDir, 'reels.json'),
    reelsVideosDir: join(testDataDir, 'reels-videos'),
    gmailClientId: 'test-client-id',
    gmailClientSecret: 'test-client-secret',
    gmailRefreshToken: 'test-refresh-token',
    gmailUser: 'sender@gmail.com',
    fetchImpl: async (url, options) => {
      const requestUrl = new URL(url);
      requestedCalls.push({ url: requestUrl, options });
      if (requestUrl.hostname === 'oauth2.googleapis.com') {
        return new Response(JSON.stringify({ access_token: 'test-access-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const body = JSON.parse(options.body);
      const mimeMessage = Buffer.from(body.raw, 'base64url').toString('utf8');
      requestedCalls[requestedCalls.length - 1].body = body;
      requestedCalls[requestedCalls.length - 1].mimeMessage = mimeMessage;
      return new Response(JSON.stringify(gmailStatus === 200 ? { id: 'email-test-id' } : { error: { message: 'Provider error details' } }), {
        status: gmailStatus,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(testDataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const subscribe = (origin, email) => fetch(`${baseUrl}/api/marketing/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email })
  });
  const sentResponse = await subscribe(baseUrl, 'student@example.com');
  assert.equal(sentResponse.status, 200);
  assert.deepEqual(await sentResponse.json(), { sent: true });
  assert.equal(requestedCalls[0].url.href, 'https://oauth2.googleapis.com/token');
  assert.equal(requestedCalls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(requestedCalls[0].options.body).get('refresh_token'), 'test-refresh-token');
  assert.equal(requestedCalls[1].url.href, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(requestedCalls[1].options.headers.Authorization, 'Bearer test-access-token');
  assert.match(requestedCalls[1].mimeMessage, /From: Al Toque Pe <sender@gmail\.com>/);
  assert.match(requestedCalls[1].mimeMessage, /To: student@example\.com/);
  assert.match(requestedCalls[1].mimeMessage, /Subject: =\?UTF-8\?B\?/);
  const textPart = requestedCalls[1].mimeMessage.match(/Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/);
  assert.ok(textPart);
  assert.match(Buffer.from(textPart[1].replace(/\r\n/g, ''), 'base64').toString('utf8'), /Estás inscrito a Al Toque Pe/);
  assert.match(requestedCalls[1].mimeMessage, /Content-Type: text\/html; charset=UTF-8/);

  const invalidEmailResponse = await subscribe(baseUrl, 'not-an-email');
  assert.equal(invalidEmailResponse.status, 400);
  assert.equal(requestedCalls.length, 2);
  const crossOriginResponse = await subscribe('https://malicious.example', 'student@example.com');
  assert.equal(crossOriginResponse.status, 403);
  assert.equal(requestedCalls.length, 2);

  gmailStatus = 403;
  const providerFailureResponse = await subscribe(baseUrl, 'another-student@example.com');
  assert.equal(providerFailureResponse.status, 502);
  assert.match((await providerFailureResponse.json()).error, /No se pudo enviar el correo/);
});

test('registers marketing consent in HubSpot and adds the contact to the workflow list', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const requestedCalls = [];
  const server = createAlToqueServer({
    ordersFile: join(testDataDir, 'orders.json'),
    reelsFile: join(testDataDir, 'reels.json'),
    reelsVideosDir: join(testDataDir, 'reels-videos'),
    marketingProvider: 'hubspot',
    hubspotAccessToken: 'test-hubspot-token',
    hubspotListId: '9',
    hubspotSubscriptionId: '123',
    fetchImpl: async (url, options) => {
      const requestUrl = new URL(url);
      requestedCalls.push({ url: requestUrl, options });
      const responseBody = requestUrl.pathname === '/crm/v3/objects/contacts'
        ? { id: 'contact-123' }
        : {};
      return new Response(JSON.stringify(responseBody), {
        status: requestUrl.pathname === '/crm/v3/objects/contacts' ? 201 : 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(testDataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/marketing/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: 'student@example.com' })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { registered: true, provider: 'hubspot' });
  assert.equal(requestedCalls.length, 3);
  assert.equal(requestedCalls[0].url.href, 'https://api.hubapi.com/crm/v3/objects/contacts');
  assert.equal(requestedCalls[0].options.headers.Authorization, 'Bearer test-hubspot-token');
  assert.deepEqual(JSON.parse(requestedCalls[0].options.body), { properties: { email: 'student@example.com' } });
  assert.equal(requestedCalls[1].url.href, 'https://api.hubapi.com/communication-preferences/v4/statuses/student%40example.com');
  assert.equal(requestedCalls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requestedCalls[1].options.body), {
    subscriptionId: 123,
    statusState: 'SUBSCRIBED',
    legalBasis: 'CONSENT_WITH_NOTICE',
    legalBasisExplanation: 'The contact opted in through the Al Toque profile page.',
    channel: 'EMAIL'
  });
  assert.equal(requestedCalls[2].url.href, 'https://api.hubapi.com/crm/v3/lists/9/memberships/add');
  assert.deepEqual(JSON.parse(requestedCalls[2].options.body), ['contact-123']);
});

test('does not activate marketing opt-in when email delivery is not configured', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = createAlToqueServer({
    ordersFile: join(testDataDir, 'orders.json'),
    reelsFile: join(testDataDir, 'reels.json'),
    reelsVideosDir: join(testDataDir, 'reels-videos'),
    gmailClientId: '',
    gmailClientSecret: '',
    gmailRefreshToken: '',
    gmailUser: ''
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(testDataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/marketing/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: 'student@example.com' })
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /no está configurado/i);
});

test('streams the order guide video with byte-range support', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const video = await readFile(new URL('./pedido-instrucciones.mp4', import.meta.url));
  const response = await fetch(`${baseUrl}/pedido-instrucciones.mp4`, {
    headers: { Range: 'bytes=0-31' }
  });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-range'), `bytes 0-31/${video.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(0, 32));

  const invalidRangeResponse = await fetch(`${baseUrl}/pedido-instrucciones.mp4`, {
    headers: { Range: `bytes=${video.length}-` }
  });
  assert.equal(invalidRangeResponse.status, 416);
  assert.equal(invalidRangeResponse.headers.get('content-range'), `bytes */${video.length}`);
});

test('serves the looping order received animation as a public video asset', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const video = await readFile(new URL('./pedido-recibido.mp4', import.meta.url));
  const response = await fetch(`${baseUrl}/pedido-recibido.mp4`, {
    headers: { Range: 'bytes=0-31' }
  });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-range'), `bytes 0-31/${video.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(0, 32));
});

test('serves the bicycle order received animation as a public video asset', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const video = await readFile(new URL('./pedido-recibido-bicicleta.mp4', import.meta.url));
  const response = await fetch(`${baseUrl}/pedido-recibido-bicicleta.mp4`, {
    headers: { Range: 'bytes=0-31' }
  });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-range'), `bytes 0-31/${video.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(0, 32));
});

test('serves the walking order received animation as a public video asset', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const video = await readFile(new URL('./pedido-recibido-caminando.mp4', import.meta.url));
  const response = await fetch(`${baseUrl}/pedido-recibido-caminando.mp4`, {
    headers: { Range: 'bytes=0-31' }
  });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-range'), `bytes 0-31/${video.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(0, 32));
});

test('serves the transparent looping walking route character as an APNG image', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/caminante-ruta.png`);
  const image = Buffer.from(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(image.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  const animationControlOffset = image.indexOf(Buffer.from('acTL'));
  assert.ok(animationControlOffset > 0, 'the image should contain APNG animation control data');
  assert.equal(image.readUInt32BE(animationControlOffset + 8), 0, 'the animation should loop forever');
  assert.ok(image.length < 3_000_000, 'the preloaded character animation should stay compact');
});

test('preloads the order received animation when serving the application page', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<link rel="preload" href="\/pedido-recibido\.mp4" as="video" type="video\/mp4"\s*\/?>/);
  assert.match(html, /<link rel="preload" href="\/pedido-recibido-bicicleta\.mp4" as="video" type="video\/mp4"\s*\/?>/);
  assert.match(html, /<link rel="preload" href="\/pedido-recibido-caminando\.mp4" as="video" type="video\/mp4"\s*\/?>/);
  assert.match(html, /<link rel="preload" href="\/caminante-ruta\.png" as="image" type="image\/png"\s*\/?>/);
});

test('animates the home menu cards with a glowing outline and honors reduced motion', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /\.home-menu-card\s*\{[^}]*animation:\s*homeMenuCardGlow 5\.8s ease-in-out infinite;/);
  assert.match(html, /\.home-menu-card::after\s*\{[^}]*z-index:\s*0;[^}]*border:\s*1px solid rgba\(197, 164, 92, 0\.32\)/);
  assert.match(html, /\.home-menu-card > \* \{\s*position: relative;\s*z-index: 1;\s*\}/);
  assert.match(html, /\.home-menu-card-media\s*\{[^}]*margin:\s*-12px -2px 8px;[^}]*overflow:\s*visible;/);
  assert.match(html, /\.home-menu-card \.combo-card-image\s*\{[^}]*animation:\s*homeMenuImageEnter 520ms ease-out both;/);
  assert.match(html, /transform: translateY\(0\) scale\(1\.02\);/);
  assert.equal((html.match(/overflow-x-auto no-scrollbar py-3 -mx-4 px-4/g) || []).length, 2);
  assert.match(html, /\.home-menu-card:hover\s*\{[^}]*transform: translateY\(-3px\) scale\(1\.05\);/);
  assert.match(html, /\.home-menu-card:hover \.home-menu-card-image,\s*\.home-menu-card:hover \.combo-card-image\s*\{\s*transform: translateY\(0\) scale\(1\.1\);/);
  assert.ok(html.indexOf('.home-menu-card:hover .combo-card-image') > html.indexOf('.combo-card:hover .combo-card-image'),
    'home card hover styles should override the generic combo hover effects');
  assert.match(html, /className="home-menu-card min-w-\[220px\] bg-white/);
  assert.match(html, /className="home-menu-card combo-card min-w-\[220px\] bg-white/);
  assert.match(html, /prefers-reduced-motion: reduce\)\s*\{\s*\.home-menu-card,\s*\.home-menu-card::after,\s*\.home-menu-card-image\s*\{\s*animation: none !important;\s*transition: none !important;/);
});

test('animates the walking rider from the first blue point through the route to the destination', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /const DELIVERY_DURATION_MS = 300000;/);
  const routeMatch = html.match(/const WALKING_ROUTE_POINTS = \[([\s\S]*?)\];/);
  assert.ok(routeMatch, 'walking route waypoints should be defined');
  const routePoints = Array.from(routeMatch[1].matchAll(/\{ x: (\d+), y: (\d+) \}/g), (match) => ({
    x: Number(match[1]),
    y: Number(match[2])
  }));
  assert.deepEqual(routePoints[0], { x: 58, y: 72 }, 'the character should start at the first blue point near KOU-XIN');
  assert.deepEqual(routePoints.at(-1), { x: 44, y: 3 }, 'the character should finish at the destination end of the blue route');
  assert.ok(routePoints.length >= 18, 'the character should follow the visible route waypoints');
  assert.ok(routePoints.slice(1, 6).every((point, index) => (
    point.x < routePoints[index].x && point.y < routePoints[index].y
  )), 'the character should follow the first diagonal section of blue route points');
  assert.deepEqual(routePoints[6], { x: 38, y: 56 }, 'the character should pass through the visible route bend');
  assert.ok(routePoints.slice(7, 13).every((point, index) => (
    point.x > routePoints[index + 6].x && point.y < routePoints[index + 6].y
  )), 'the character should follow the blue route back up and to the right');
  assert.ok(routePoints.slice(13).every((point, index) => point.x < routePoints[index + 12].x && point.y < routePoints[index + 12].y),
    'the last route section should continue toward the destination marker');
  assert.match(html, /function getWalkingRoutePosition\(progress, routePoints = WALKING_ROUTE_POINTS\)/);
  assert.match(html, /function getWalkingGpsPosition\(location, routeOrigin, routeDestination, mapWidth, mapHeight\)/);
  const gpsPositionStart = html.indexOf('function getWalkingGpsPosition(');
  const gpsPositionEnd = html.indexOf('class LiveRouteMapErrorBoundary', gpsPositionStart);
  assert.ok(gpsPositionStart >= 0 && gpsPositionEnd > gpsPositionStart, 'GPS position projection should be defined');
  const gpsPositionSource = html.slice(gpsPositionStart, gpsPositionEnd).trim();
  const getWalkingGpsPosition = vm.runInNewContext(`(${gpsPositionSource})`);
  const originPosition = getWalkingGpsPosition(
    { latitude: -12.1348222, longitude: -77.0260012 },
    [-12.1348222, -77.0260012],
    [-12.1341675, -77.0260721],
    400,
    300
  );
  const destinationPosition = getWalkingGpsPosition(
    { latitude: -12.1341675, longitude: -77.0260721 },
    [-12.1348222, -77.0260012],
    [-12.1341675, -77.0260721],
    400,
    300
  );
  assert.ok(originPosition.y > destinationPosition.y, 'GPS projection should move north as the rider approaches the destination');
  assert.match(html, /if \(isGpsLocationActive\) return undefined;/);
  assert.match(html, /getWalkingGpsPosition\(\s*gpsLocation,\s*mapOrigin,\s*DELIVERY_ROUTE_END,\s*bounds\.width,\s*bounds\.height\s*\)/);
  assert.match(html, /style=\{\{ left: `\$\{walkingRoutePoints\[0\]\.x\}%`, top: `\$\{walkingRoutePoints\[0\]\.y\}%` \}\}/);
  assert.match(html, /walkingStartedAt=\{deliveryPhase === 'tracking' && assignedRider\?\.vehicle === 'Caminando'\s*\? deliveryStartedAtRef\.current\s*: null\}/);
  assert.match(html, /walking-route-character/);
  assert.match(html, /window\.requestAnimationFrame\(updatePosition\)/);
  assert.match(html, /window\.cancelAnimationFrame\(animationFrame\)/);
  assert.doesNotMatch(html, /setInterval\(updateProgress,\s*1000\)/);
  assert.match(html, /\.walking-route-locked\s+\.live-route-map-frame\s*\{\s*pointer-events:\s*none;/);
  assert.match(html, /isMapInteractionLocked\s*\?\s*' walking-route-locked'/);
  assert.match(html, /tabIndex=\{isMapInteractionLocked \? -1 : undefined\}/);
  assert.match(html, /Ruta fija a pie · 5 min/);
  assert.match(html, /allowMapInteraction \? 'Ruta a pie · 5 min' : 'Ruta fija a pie · 5 min'/);
  assert.match(html, /function LiveRouteMap\(\{\s*location,\s*className,\s*label,\s*walkingStartedAt = null,\s*allowMapInteraction = false,\s*walkingRoutePoints = WALKING_ROUTE_POINTS,\s*gpsLocation = null\s*\}\)/);
  assert.match(html, /walkingStartedAt=\{step === 1 && riderDetails\.vehicle === 'Caminando'\s*\?\s*activeOrder\?\.routeStartedAt \|\| activeOrder\?\.pickedUpAt\s*:\s*null\}/);
  assert.match(html, /label=\{`Ruta en vivo del pedido \$\{activeOrder\?\.id \|\| ''\}`\}\s*walkingStartedAt=\{step === 1 && riderDetails\.vehicle === 'Caminando'/);
  assert.match(html, /\.delivery-map \.walking-route-character\s*\{\s*width:\s*clamp\(56px, 16%, 70px\)/);
  assert.match(html, /\.rider-map \.walking-route-character\s*\{\s*width:\s*clamp\(56px, 16%, 70px\)/);
  assert.match(html, /\.rider-map \.walking-route-character\s*\{[^}]*transition:\s*left \.7s linear, top \.7s linear/);
  assert.match(html, /\.walking-route-character\s*\{[\s\S]*?width:\s*clamp\(34px, 12%, 48px\)/);
  assert.match(html, /walkingStartedAt=\{step === 1 && riderDetails\.vehicle === 'Caminando'[\s\S]{0,240}?allowMapInteraction\s*walkingRoutePoints=\{RIDER_WALKING_ROUTE_POINTS\}/);
  assert.match(html, /gpsLocation=\{riderDetails\.vehicle === 'Caminando' && gps\.status === 'active' \? gps : null\}/);
  assert.match(html, /function getWalkingRoutePosition\(progress, routePoints = WALKING_ROUTE_POINTS\)/);
  assert.match(html, /Date\.now\(\) - walkingStartedAt\) \/ DELIVERY_DURATION_MS/);
  assert.match(html, /isWalkingAnimationActive\s*\?\s*allowMapInteraction \? 'Ruta a pie · 5 min' : 'Ruta fija a pie · 5 min'/);
});

test('shows the matching order received animation for each assigned rider transport', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /const shouldShowArrivalVideo = isArrivalVisible && \['Moto', 'Bicicleta', 'Caminando'\]\.includes\(assignedRider\?\.vehicle\);/);
  assert.match(html, /const arrivalVideoSrc = assignedRider\?\.vehicle === 'Bicicleta'\s+\? '\/pedido-recibido-bicicleta\.mp4'\s+: assignedRider\?\.vehicle === 'Caminando'\s+\? '\/pedido-recibido-caminando\.mp4'\s+: '\/pedido-recibido\.mp4';/);
  assert.match(html, /\{shouldShowArrivalVideo && \(\s*<video\s+ref=\{arrivalVideoRef\}\s+src=\{arrivalVideoSrc\}/);
  assert.match(html, /if \(!shouldShowArrivalVideo \|\| !video\) return undefined;/);
});

test('unlocks VIP Gorritos at twenty points or twenty purchases and keeps the level for existing members', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /gorritosVip: savedProfile\.gorritosVip === true\s*\|\|\s*\(Number\.isInteger\(savedProfile\.gorritos\) && savedProfile\.gorritos >= 20\)\s*\|\|\s*\(Number\.isInteger\(savedProfile\.gorritosPurchaseCount\) && savedProfile\.gorritosPurchaseCount >= 20\)/);
  assert.match(html, /const isGorritosVip = profile\.gorritosVip === true \|\| points >= 20 \|\| purchaseCount >= 20;/);
  assert.match(html, /const alreadyVip = current\.gorritosVip === true \|\| currentPoints >= 20 \|\| completedPurchases >= 20;/);
  assert.match(html, /gorritosVip: alreadyVip \|\| nextBalance >= 20 \|\| nextPurchaseCount >= 20/);
  assert.match(html, /Alcanza 20 Gorritos o completa 20 compras participantes para desbloquearlo\./);
});

test('shares only public rider profile fields with customers and persists updates', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const driverId = 'rider-profile-sync-test';
  const profileUrl = `${baseUrl}/api/rider/profile?driverId=${encodeURIComponent(driverId)}`;
  const updateResponse = await fetch(profileUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      driverId,
      name: 'Armando actualizado',
      vehicle: 'Bicicleta',
      photo: 'data:image/jpeg;base64,dGVzdA==',
      dni: '12345678',
      identityPhoto: 'private-document'
    })
  });

  assert.equal(updateResponse.status, 200);
  const { profile: updatedProfile } = await updateResponse.json();
  assert.equal(updatedProfile.name, 'Armando actualizado');
  assert.equal(updatedProfile.vehicle, 'Bicicleta');
  assert.equal(updatedProfile.photo, 'data:image/jpeg;base64,dGVzdA==');
  assert.equal(Object.hasOwn(updatedProfile, 'dni'), false);
  assert.equal(Object.hasOwn(updatedProfile, 'identityPhoto'), false);

  const customerResponse = await fetch(profileUrl, { cache: 'no-store' });
  const { profile: customerProfile } = await customerResponse.json();
  assert.equal(customerProfile.name, 'Armando actualizado');
  assert.equal(customerProfile.vehicle, 'Bicicleta');
  assert.equal(customerProfile.photo, 'data:image/jpeg;base64,dGVzdA==');
  assert.equal(customerProfile.hasPublicProfile, true);
  const savedState = JSON.parse(await readFile(join(testDataDir, 'rider-profiles.json'), 'utf8'));
  assert.equal(savedState.profiles[0].name, 'Armando actualizado');

  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const restartedServer = await createReelsTestServer(t, testDataDir);
  const restartedBaseUrl = `http://127.0.0.1:${restartedServer.address().port}`;
  const restartedProfileUrl = `${restartedBaseUrl}/api/rider/profile?driverId=${encodeURIComponent(driverId)}`;
  const restartedCustomerResponse = await fetch(restartedProfileUrl, { cache: 'no-store' });
  const { profile: restartedCustomerProfile } = await restartedCustomerResponse.json();
  assert.equal(restartedCustomerProfile.name, 'Armando actualizado');
  assert.equal(restartedCustomerProfile.vehicle, 'Bicicleta');
  assert.equal(restartedCustomerProfile.photo, 'data:image/jpeg;base64,dGVzdA==');

  const crossOriginResponse = await fetch(restartedProfileUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://malicious.example' },
    body: JSON.stringify({ driverId, name: 'Otro nombre', vehicle: '', photo: null })
  });
  assert.equal(crossOriginResponse.status, 403);

  const invalidPhotoResponse = await fetch(restartedProfileUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: restartedBaseUrl },
    body: JSON.stringify({ driverId, name: 'Armando', vehicle: 'Moto', photo: 'data:image/png;base64,AA==' })
  });
  assert.equal(invalidPhotoResponse.status, 400);
});

test('serves the offline JavaScript and font assets from local paths', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const assets = [
    ['/vendor/tailwind.js', 'text/javascript; charset=utf-8'],
    ['/vendor/react.development.js', 'text/javascript; charset=utf-8'],
    ['/vendor/react-dom.development.js', 'text/javascript; charset=utf-8'],
    ['/vendor/babel.min.js', 'text/javascript; charset=utf-8'],
    ['/vendor/lucide.js', 'text/javascript; charset=utf-8'],
    ['/vendor/fonts.css', 'text/css; charset=utf-8'],
    ['/vendor/fonts/outfit-400.ttf', 'font/ttf'],
    ['/vendor/fonts/outfit-500.ttf', 'font/ttf'],
    ['/vendor/fonts/outfit-600.ttf', 'font/ttf'],
    ['/vendor/fonts/outfit-700.ttf', 'font/ttf'],
    ['/vendor/fonts/space-grotesk-600.ttf', 'font/ttf'],
    ['/vendor/fonts/space-grotesk-700.ttf', 'font/ttf']
  ];

  for (const [path, contentType] of assets) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    assert.equal(response.status, 200, `${path} should be served`);
    assert.equal(response.headers.get('content-type'), contentType);
    assert.ok(Number(response.headers.get('content-length')) > 0, `${path} should not be empty`);
  }
});

test('compresses large text assets when the client accepts gzip', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const response = await new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${server.address().port}/vendor/babel.min.js`, {
      headers: { 'accept-encoding': 'gzip' }
    }, resolve);
    request.once('error', reject);
  });
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  const compressed = Buffer.concat(chunks);
  const original = gunzipSync(compressed);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.equal(response.headers.vary, 'Accept-Encoding');
  assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.ok(compressed.length < original.length);
  assert.equal(Number(response.headers['content-length']), compressed.length);
});

test('serves the professor photo used in the October promotion window', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/promo-profesor-martin.png`);
  const cleanedResponse = await fetch(`http://127.0.0.1:${server.address().port}/promo-profesor-martin-limpio.png`);
  const referenceResponse = await fetch(`http://127.0.0.1:${server.address().port}/promo-profesor-martin-referencia.png`);
  const bannerResponse = await fetch(`http://127.0.0.1:${server.address().port}/promo-al-toque-banner.png`);
  const image = Buffer.from(await response.arrayBuffer());
  const cleanedImage = Buffer.from(await cleanedResponse.arrayBuffer());
  const referenceImage = Buffer.from(await referenceResponse.arrayBuffer());
  const bannerImage = Buffer.from(await bannerResponse.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(cleanedResponse.status, 200);
  assert.equal(cleanedResponse.headers.get('content-type'), 'image/png');
  assert.equal(cleanedImage.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.notDeepEqual(cleanedImage, image);
  assert.equal(referenceResponse.status, 200);
  assert.equal(referenceResponse.headers.get('content-type'), 'image/png');
  assert.equal(referenceImage.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bannerResponse.status, 200);
  assert.equal(bannerResponse.headers.get('content-type'), 'image/png');
  assert.equal(bannerImage.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('creates and updates standalone Reels profiles with validated public IDs and photos', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const profileId = randomUUID();
  const photo = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')}`;

  const createResponse = await fetch(`${baseUrl}/api/reels/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, name: '  Reels creator  ', photo })
  });
  assert.equal(createResponse.status, 201);
  assert.deepEqual((await createResponse.json()).profile, { profileId, name: 'Reels creator', photo });

  const updateResponse = await fetch(`${baseUrl}/api/reels/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, name: 'Creator updated' })
  });
  assert.equal(updateResponse.status, 200);
  assert.deepEqual((await updateResponse.json()).profile, { profileId, name: 'Creator updated', photo });

  const invalidIdResponse = await fetch(`${baseUrl}/api/reels/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: '../bad', name: 'Invalid' })
  });
  assert.equal(invalidIdResponse.status, 400);
  const invalidPhotoResponse = await fetch(`${baseUrl}/api/reels/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: randomUUID(), name: 'Invalid photo', photo: 'data:image/png;base64,Zm9v' })
  });
  assert.equal(invalidPhotoResponse.status, 400);
  const oversizedImage = Buffer.alloc(1024 * 1024 + 1);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedImage);
  const oversizedPhotoResponse = await fetch(`${baseUrl}/api/reels/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profileId: randomUUID(),
      name: 'Oversized photo',
      photo: `data:image/png;base64,${oversizedImage.toString('base64')}`
    })
  });
  assert.equal(oversizedPhotoResponse.status, 400);
});

test('accepts requests from localhost aliases when using the same local server port', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/reels/profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://localhost:${port}`
    },
    body: JSON.stringify({ profileId: randomUUID(), name: 'Alias ok' })
  });
  assert.equal(response.status, 201);
});

test('shares customer orders with riders when HTTPS terminates at the reverse proxy', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const postThroughProxy = (origin, body) => new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(body)),
        Host: 'app.altoque.test',
        Origin: origin,
        'X-Forwarded-Proto': 'https'
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(JSON.stringify(body));
  });
  const orderResponse = await postThroughProxy('https://app.altoque.test', {
    idempotencyKey: 'proxy-order-123456',
    customer: 'Cliente',
    items: [{ name: 'Lomo saltado', quantity: 1, price: 12 }],
    pickupPoint: 'Cafetería Central',
    paymentMethod: 'yape'
  });

  assert.equal(orderResponse.status, 201);
  const { order } = orderResponse.body;
  assert.equal(order.status, 'available');

  const riderQueueResponse = await fetch(`${baseUrl}/api/orders`);
  assert.equal(riderQueueResponse.status, 200);
  assert.deepEqual((await riderQueueResponse.json()).orders.map(({ id }) => id), [order.id]);

  const rejectedResponse = await postThroughProxy('https://attacker.example', {
    idempotencyKey: 'proxy-order-654321',
    customer: 'Origen ajeno',
    items: [{ name: 'Lomo saltado', quantity: 1, price: 12 }],
    pickupPoint: 'Cafetería Central',
    paymentMethod: 'yape'
  });
  assert.equal(rejectedResponse.status, 403);
});

test('loads the public feed for a valid first-time viewer before profile creation', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const newViewerId = randomUUID();

  const response = await fetch(`${baseUrl}/api/reels?profileId=${newViewerId}`);
  assert.equal(response.status, 200);
  const feed = await response.json();
  assert.deepEqual(feed, { posts: [], profiles: [] });

  const invalidResponse = await fetch(`${baseUrl}/api/reels?profileId=not-a-uuid`);
  assert.equal(invalidResponse.status, 400);
});

test('uploads validated video streams and serves them with byte-range support', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const mp4 = Buffer.from('000000186674797069736f6d00000000', 'hex');
  const upload = (contentType, body) => fetch(`${baseUrl}/api/reels/videos`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body
  });

  const unsupportedResponse = await upload('video/quicktime', mp4);
  assert.equal(unsupportedResponse.status, 400);
  const mismatchedResponse = await upload('video/webm', mp4);
  assert.equal(mismatchedResponse.status, 400);
  const invalidSignatureResponse = await upload('video/mp4', Buffer.from('not a video'));
  assert.equal(invalidSignatureResponse.status, 400);

  const uploadResponse = await upload('video/mp4', mp4);
  assert.equal(uploadResponse.status, 201);
  const { video } = await uploadResponse.json();
  assert.match(video.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(video.url, `/api/reels/videos/${video.id}`);
  assert.equal(video.mimeType, 'video/mp4');

  const rangeResponse = await fetch(`${baseUrl}${video.url}`, { headers: { Range: 'bytes=4-11' } });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get('content-type'), 'video/mp4');
  assert.equal(rangeResponse.headers.get('accept-ranges'), 'bytes');
  assert.equal(rangeResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(rangeResponse.headers.get('content-range'), `bytes 4-11/${mp4.length}`);
  assert.deepEqual(Buffer.from(await rangeResponse.arrayBuffer()), mp4.subarray(4, 12));
  assert.equal((await fetch(`${baseUrl}/api/reels/videos/%2e%2e%2fserver.mjs`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/reels/videos/${randomUUID()}`)).status, 404);
});

test('requires and persists image-rights consent when a Reel includes people', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const profileId = randomUUID();
  const jsonPost = (path, value) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });

  await jsonPost('/api/reels/profile', { profileId, name: 'Creator' });
  const uploadResponse = await fetch(`${baseUrl}/api/reels/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42])
  });
  assert.equal(uploadResponse.status, 201);
  const { video } = await uploadResponse.json();

  const missingConsentResponse = await jsonPost('/api/reels/posts', {
    profileId,
    videoId: video.id,
    caption: 'Person visible',
    hasPeople: true,
    imageRightsAccepted: false
  });
  assert.equal(missingConsentResponse.status, 400);

  const acceptedResponse = await jsonPost('/api/reels/posts', {
    profileId,
    videoId: video.id,
    caption: 'Person visible',
    hasPeople: true,
    imageRightsAccepted: true
  });
  assert.equal(acceptedResponse.status, 201);
  const { post } = await acceptedResponse.json();
  const savedReels = JSON.parse(await readFile(join(testDataDir, 'reels.json'), 'utf8'));
  const savedPost = savedReels.posts.find((item) => item.id === post.id);
  assert.equal(savedPost.hasPeople, true);
  assert.ok(Number.isFinite(new Date(savedPost.imageRightsAcceptedAt).getTime()));
});

test('shares Reels posts, likes and comments across profiles and server restarts', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  let server = await createReelsTestServer(t, testDataDir);
  const firstBaseUrl = `http://127.0.0.1:${server.address().port}`;
  const creatorId = randomUUID();
  const viewerId = randomUUID();
  const jsonPost = (path, value, baseUrl = firstBaseUrl) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  await jsonPost('/api/reels/profile', { profileId: creatorId, name: 'Creator' });
  await jsonPost('/api/reels/profile', { profileId: viewerId, name: 'Viewer' });

  const uploadResponse = await fetch(`${firstBaseUrl}/api/reels/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42])
  });
  assert.equal(uploadResponse.status, 201);
  const { video } = await uploadResponse.json();
  assert.equal(video.mimeType, 'video/webm');

  const createPostResponse = await jsonPost('/api/reels/posts', {
    profileId: creatorId,
    videoId: video.id,
    caption: 'First reel'
  });
  assert.equal(createPostResponse.status, 201);
  const { post } = await createPostResponse.json();
  assert.equal(post.profileName, 'Creator');
  assert.equal(post.likeCount, 0);
  assert.equal(post.likedByViewer, false);
  assert.equal(post.comments.length, 0);

  const firstLikeResponse = await jsonPost(`/api/reels/posts/${post.id}/like`, { profileId: viewerId });
  assert.equal((await firstLikeResponse.json()).post.likeCount, 1);
  const duplicateLikeResponse = await jsonPost(`/api/reels/posts/${post.id}/like`, { profileId: viewerId });
  assert.equal((await duplicateLikeResponse.json()).post.likeCount, 0);
  await jsonPost(`/api/reels/posts/${post.id}/like`, { profileId: creatorId });

  const commentResponse = await jsonPost(`/api/reels/posts/${post.id}/comments`, { profileId: viewerId, text: 'Nice video!' });
  assert.equal(commentResponse.status, 201);
  assert.equal((await commentResponse.json()).comment.profileName, 'Viewer');

  const feedResponse = await fetch(`${firstBaseUrl}/api/reels?profileId=${viewerId}`);
  assert.equal(feedResponse.status, 200);
  const feed = await feedResponse.json();
  assert.equal(feed.posts[0].id, post.id);
  assert.equal(feed.posts[0].likeCount, 1);
  assert.equal(feed.posts[0].likedByViewer, false);
  assert.deepEqual(feed.posts[0].comments.map(({ profileId, profileName, text }) => ({ profileId, profileName, text })), [
    { profileId: viewerId, profileName: 'Viewer', text: 'Nice video!' }
  ]);
  assert.equal(feed.profiles.length, 2);

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server = await createReelsTestServer(t, testDataDir);
  const restartedUrl = `http://127.0.0.1:${server.address().port}`;
  const restartedFeed = await fetch(`${restartedUrl}/api/reels?profileId=${creatorId}`);
  assert.equal(restartedFeed.status, 200);
  const persisted = await restartedFeed.json();
  assert.equal(persisted.posts[0].likeCount, 1);
  assert.equal(persisted.posts[0].likedByViewer, true);
  assert.equal(persisted.posts[0].comments[0].text, 'Nice video!');
  assert.equal((await fetch(`${restartedUrl}${video.url}`, { headers: { Range: 'bytes=0-3' } })).status, 206);
});

test('requires the deletion password and owner profile to remove a Reel', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const creatorId = randomUUID();
  const viewerId = randomUUID();

  await fetch(`${baseUrl}/api/reels/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: creatorId, name: 'Owner' })
  });
  await fetch(`${baseUrl}/api/reels/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: viewerId, name: 'Viewer' })
  });

  const uploadResponse = await fetch(`${baseUrl}/api/reels/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42])
  });
  assert.equal(uploadResponse.status, 201);
  const { video } = await uploadResponse.json();

  const createPostResponse = await fetch(`${baseUrl}/api/reels/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: creatorId, videoId: video.id, caption: 'Delete me' })
  });
  assert.equal(createPostResponse.status, 201);
  const { post } = await createPostResponse.json();

  const forbiddenDeleteResponse = await fetch(`${baseUrl}/api/reels/posts/${post.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: viewerId })
  });
  assert.equal(forbiddenDeleteResponse.status, 403);

  const missingPasswordResponse = await fetch(`${baseUrl}/api/reels/posts/${post.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: creatorId })
  });
  assert.equal(missingPasswordResponse.status, 403);

  const incorrectPasswordResponse = await fetch(`${baseUrl}/api/reels/posts/${post.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: creatorId, password: '0000' })
  });
  assert.equal(incorrectPasswordResponse.status, 403);

  const deleteResponse = await fetch(`${baseUrl}/api/reels/posts/${post.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: creatorId, password: 'test-reels-delete-password' })
  });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { deleted: true, postId: post.id });

  const feedResponse = await fetch(`${baseUrl}/api/reels?profileId=${creatorId}`);
  assert.equal(feedResponse.status, 200);
  const feed = await feedResponse.json();
  assert.deepEqual(feed.posts, []);
  assert.equal((await fetch(`${baseUrl}${video.url}`)).status, 404);
});

test('disables Reel deletion when the server password is not configured', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir, '');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const profileId = randomUUID();

  await fetch(`${baseUrl}/api/reels/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, name: 'Owner' })
  });
  const uploadResponse = await fetch(`${baseUrl}/api/reels/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42])
  });
  assert.equal(uploadResponse.status, 201);
  const { video } = await uploadResponse.json();
  const createPostResponse = await fetch(`${baseUrl}/api/reels/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, videoId: video.id, caption: 'Delete me' })
  });
  assert.equal(createPostResponse.status, 201);
  const { post } = await createPostResponse.json();

  const deleteResponse = await fetch(`${baseUrl}/api/reels/posts/${post.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, password: '' })
  });
  assert.equal(deleteResponse.status, 503);
  assert.equal((await deleteResponse.json()).error, 'La eliminación de Reels no está configurada en el servidor.');
});

test('rejects oversized Reels video requests before accepting their bodies', async (t) => {
  const testDataDir = await createReelsTestDirectory();
  const server = await createReelsTestServer(t, testDataDir);
  const address = server.address();
  const status = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: '/api/reels/videos',
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': 100 * 1024 * 1024 + 1 }
    }, (response) => {
      response.resume();
      response.once('end', () => {
        request.destroy();
        resolve(response.statusCode);
      });
    });
    request.on('error', (error) => {
      if (!request.destroyed) reject(error);
    });
    request.flushHeaders();
  });
  assert.equal(status, 413);
});

test('serves the public Gorritos sticker and sticker pack', async (t) => {
  const testDataDir = await mkdtemp(join(tmpdir(), 'altoque-audio-test-'));
  const server = createAlToqueServer({ ordersFile: join(testDataDir, 'orders.json') });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(testDataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const gorritosWelcomeStickerResponse = await fetch(`${baseUrl}/gorritos-welcome-hat.png`);
  assert.equal(gorritosWelcomeStickerResponse.status, 200);
  assert.equal(gorritosWelcomeStickerResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(
    Array.from(new Uint8Array(await gorritosWelcomeStickerResponse.arrayBuffer()).slice(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10]
  );

  for (let stickerId = 1; stickerId <= 25; stickerId += 1) {
    const stickerExtension = stickerId <= 8 ? 'webp' : 'png';
    const stickerResponse = await fetch(`${baseUrl}/sticker_${stickerId}.${stickerExtension}`);
    assert.equal(stickerResponse.status, 200, `sticker_${stickerId}.${stickerExtension} should be served`);
    assert.equal(stickerResponse.headers.get('content-type'), stickerId <= 8 ? 'image/webp' : 'image/png');
    assert.deepEqual(
      Array.from(new Uint8Array(await stickerResponse.arrayBuffer()).slice(0, stickerId <= 8 ? 4 : 8)),
      stickerId <= 8
        ? [82, 73, 70, 70]
        : [137, 80, 78, 71, 13, 10, 26, 10]
    );
  }

  const unknownTrack = await fetch(`${baseUrl}/music/not-allowed.mp3`);
  assert.equal(unknownTrack.status, 404);
});

test('understands a direct request for a drink', () => {
  assert.equal(detectMenuIntent('Recomiéndame una bebida, por favor'), 'bebidas');
  assert.equal(selectMenuItem('bebidas', 'Quiero algo para tomar').category, 'bebidas');
});

test('keeps a meal request among food and combo items', () => {
  assert.equal(detectMenuIntent('Quiero un plato para almorzar'), 'comida');
  assert.notEqual(selectMenuItem('comida', 'Quiero comer algo').category, 'bebidas');
});

test('matches specifically named products without crossing categories', () => {
  assert.equal(selectMenuItem('bebidas', 'Quiero Jugo de Maracuyá').id, '7');
  assert.equal(selectMenuItem('comida', 'Recomiéndame ceviche').id, '3');
  assert.equal(selectMenuItem('comida', 'Quiero el Combo Costeño').id, '8');
  assert.equal(selectMenuItem('comida', 'Quiero el Combo Marino').id, '9');
  assert.equal(selectMenuItem('bebidas', 'Quiero Agua San Luis').id, '10');
});

test('uses a reasonable general recommendation when the request has no category', () => {
  assert.equal(detectMenuIntent('¿Qué me recomiendas?'), 'cualquiera');
  assert.ok(selectMenuItem('cualquiera', '¿Qué me recomiendas?'));
  assert.equal(detectMenuIntent('Tengo S/ 15'), 'cualquiera');
  assert.equal(detectMenuIntent('¿A qué hora empieza el partido?'), 'ninguna');
  assert.equal(selectMenuItem('ninguna', '¿A qué hora empieza el partido?'), null);
});

test('resolves explicit exclusions to the requested category', () => {
  assert.equal(detectMenuIntent('No quiero bebida, prefiero un plato'), 'comida');
  assert.equal(detectMenuIntent('No quiero un plato, solo una bebida'), 'bebidas');
});

test('answers simple menu questions locally without requesting web search', () => {
  const drinks = getLocalMenuAnswer('¿Qué bebidas ofrecen hoy?');
  assert.match(drinks.reply, /Chicha Morada Natural/);
  assert.match(drinks.reply, /Jugo de Maracuyá/);
  assert.equal(drinks.dishId, null);
  assert.equal(shouldUseWebSearch('¿Qué bebidas ofrecen hoy?'), false);
  assert.equal(getLocalMenuAnswer('¿Qué incluye el Combo Fitness?').dishId, '5');
  assert.match(getLocalMenuAnswer('¿Qué incluye el Combo Costeño?').reply, /Agua San Luis 600ml/);
  assert.match(getLocalMenuAnswer('¿Qué incluye el Combo Marino?').reply, /Jugo de maracuyá 500ml/);
  assert.match(getLocalMenuAnswer('¿Qué bebidas ofrecen hoy?').reply, /Agua San Luis 600ml/);
  assert.equal(getLocalMenuAnswer('Quiero una bebida').intent, 'bebidas');
  assert.equal(getLocalMenuAnswer('Quiero un plato para almorzar').intent, 'comida');
});

test('reserves web search for current or complex questions', () => {
  assert.equal(shouldUseWebSearch('¿Cuál es el tipo de cambio actual?'), true);
  assert.equal(shouldUseWebSearch('Explica por qué cambia el clima y compara las causas principales'), true);
  assert.equal(shouldUseWebSearch('Hola, ¿cómo estás?'), false);
  assert.equal(shouldUseWebSearch('¿Qué incluye el Combo Fitness?'), false);
  assert.equal(getLocalMenuAnswer('¿Cuál es el origen histórico del ceviche?'), null);
  assert.equal(shouldUseWebSearch('¿Cuál es el origen histórico del ceviche?'), true);
});

test('uses one OpenAI-backed assistant with three distinct response personas', () => {
  const personas = ['ChatGPT', 'Copilot', 'Gemini'].map(getAssistantPersona);
  assert.equal(new Set(personas).size, 3);
  assert.match(getAssistantPersona('Copilot'), /práctico/);
  assert.match(getAssistantPersona('Gemini'), /creativo/);

  const response = 'El Jugo de Maracuyá cuesta S/3.50.';
  const styles = ['ChatGPT', 'Copilot', 'Gemini'].map((provider) => styleLocalAnswer(response, provider));
  assert.equal(new Set(styles).size, 3);
  assert.ok(styles.every((style) => style.includes(response)));
});

test('gives the rider support assistant empathetic, practical, and truthful guidance', () => {
  const instructions = makeRiderSupportInstructions();
  assert.match(instructions, /amabilidad, empatía y respeto/i);
  assert.match(instructions, /No inventes funciones/i);
  assert.match(instructions, /No solicites contraseñas/i);
  assert.match(instructions, /lugar seguro/i);
});

test('routes rider support questions to AI with the dedicated support instructions', async (t) => {
  const testDataDir = await mkdtemp(join(tmpdir(), 'altoque-rider-support-test-'));
  let requestedUrl;
  let requestedBody;
  const server = createAlToqueServer({
    ordersFile: join(testDataDir, 'orders.json'),
    openAIApiKey: 'test-openai-api-key',
    fetchImpl: async (url, options) => {
      requestedUrl = new URL(url);
      requestedBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ output_text: 'Siento que estés pasando por esto. Revisemos juntos qué puedes hacer.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(testDataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      provider: 'ChatGPT',
      assistantMode: 'rider-support',
      text: 'Mi pedido se está demorando y estoy preocupado.',
      history: [],
      memory: ''
    })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, 'Siento que estés pasando por esto. Revisemos juntos qué puedes hacer.');
  assert.equal(requestedUrl.origin, 'https://api.openai.com');
  assert.equal(requestedUrl.pathname, '/v1/responses');
  assert.equal(requestedBody.tools, undefined);
  assert.equal(requestedBody.input[0].role, 'developer');
  assert.match(requestedBody.input[0].content, /amabilidad, empatía y respeto/i);
  assert.match(requestedBody.input[0].content, /No inventes funciones/i);
  assert.match(requestedBody.input[1].content, /Mi pedido se está demorando y estoy preocupado/);
});

test('falls back to the local Keras model for rider support when OpenAI is unavailable', async (t) => {
  const testDataDir = await mkdtemp(join(tmpdir(), 'altoque-rider-support-fallback-test-'));
  const requestedCalls = [];
  const server = createAlToqueServer({
    ordersFile: join(testDataDir, 'orders.json'),
    openAIApiKey: 'test-openai-api-key',
    fetchImpl: async (url, options) => {
      const requestedUrl = new URL(url);
      requestedCalls.push({ requestedUrl, options });
      if (requestedUrl.hostname === 'api.openai.com') {
        return new Response(JSON.stringify({ error: { message: 'La cuota de OpenAI se agotó.' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({
        respuesta: 'Siento que estés pasando por esta demora. Revisa el estado y contacta a soporte con el número del pedido.'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(testDataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      provider: 'ChatGPT',
      assistantMode: 'rider-support',
      text: 'Mi pedido se demora, ¿qué hago?',
      history: [],
      memory: ''
    })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.engine, 'Keras local');
  assert.equal(payload.fallbackFrom, 'OpenAI API');
  assert.equal(payload.reply, 'Siento que estés pasando por esta demora. Revisa el estado y contacta a soporte con el número del pedido.');
  assert.equal(requestedCalls.length, 2);
  assert.equal(requestedCalls[0].requestedUrl.hostname, 'api.openai.com');
  assert.equal(requestedCalls[1].requestedUrl.hostname, '127.0.0.1');
  assert.equal(requestedCalls[1].requestedUrl.port, '5000');
  assert.equal(requestedCalls[1].requestedUrl.pathname, '/preguntar');
  assert.equal(requestedCalls[1].options.headers['Content-Type'], 'application/json');
  const kerasBody = JSON.parse(requestedCalls[1].options.body);
  assert.match(kerasBody.pregunta, /amabilidad, empatía y respeto/i);
  assert.match(kerasBody.pregunta, /Mi pedido se demora, ¿qué hago\?/);
});

test('keeps previous conversation context separate from assistant instructions', () => {
  const prompt = composePrompt(
    'Responde en español.',
    [{ sender: 'user', text: 'Prefiero opciones ligeras.' }],
    'Me gustan las bebidas naturales.',
    '¿Qué me recomiendas?',
    null,
    [{ name: 'Jugo de Maracuyá', quantity: 3 }, { name: 'Bowl de quinua', quantity: 1 }]
  );
  assert.equal(prompt[0].role, 'developer');
  assert.equal(prompt[1].role, 'user');
  assert.match(prompt[1].content, /bebidas naturales/);
  assert.match(prompt[1].content, /opciones ligeras/);
  assert.match(prompt[1].content, /¿Qué me recomiendas\?/);
  assert.match(prompt[1].content, /"Jugo de Maracuyá": 3/);
  assert.match(prompt[1].content, /"Bowl de quinua": 1/);
});

test('gives all three AI personas recent order history for direct purchase questions', async (t) => {
  const testDataDir = await mkdtemp(join(tmpdir(), 'altoque-order-history-ai-test-'));
  const requestedBodies = [];
  const server = createAlToqueServer({
    ordersFile: join(testDataDir, 'orders.json'),
    reelsFile: join(testDataDir, 'reels.json'),
    reelsVideosDir: join(testDataDir, 'reels-videos'),
    openAIApiKey: 'test-openai-api-key',
    fetchImpl: async (url, options) => {
      requestedBodies.push({ url: new URL(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        output_text: 'Según tus pedidos recientes, compras más Jugo de Maracuyá: 3 unidades.'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(testDataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const provider of ['ChatGPT', 'Copilot', 'Gemini']) {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({
        provider,
        text: 'Según mis recientes pedidos, ¿qué es lo que más compro?',
        history: [],
        memory: '',
        orderHistory: [
          { name: 'Jugo de Maracuyá', quantity: 3 },
          { name: 'Bowl de quinua', quantity: 1 }
        ]
      })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.reply, 'Según tus pedidos recientes, compras más Jugo de Maracuyá: 3 unidades.');
    assert.equal(payload.dishId, null);
  }

  assert.equal(requestedBodies.length, 3);
  for (const { url, body } of requestedBodies) {
    assert.equal(url.origin, 'https://api.openai.com');
    assert.match(body.input[0].content, /pregunta qué compra más, responde directamente/);
    assert.match(body.input[1].content, /Resumen de los productos comprados en los 10 pedidos guardados más recientes/);
    assert.match(body.input[1].content, /"Jugo de Maracuyá": 3/);
    assert.match(body.input[1].content, /"Bowl de quinua": 1/);
    assert.match(body.input[1].content, /Según mis recientes pedidos/);
    assert.doesNotMatch(body.input[0].content, /Recomienda únicamente este producto/);
  }
});

test('tells the AI not to invent purchase history when no orders are saved', async (t) => {
  const testDataDir = await mkdtemp(join(tmpdir(), 'altoque-empty-order-history-ai-test-'));
  let requestedBody;
  const server = createAlToqueServer({
    ordersFile: join(testDataDir, 'orders.json'),
    reelsFile: join(testDataDir, 'reels.json'),
    reelsVideosDir: join(testDataDir, 'reels-videos'),
    openAIApiKey: 'test-openai-api-key',
    fetchImpl: async (url, options) => {
      requestedBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ output_text: 'Todavía no tienes pedidos guardados para identificarlo.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(testDataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      provider: 'Gemini',
      text: 'Según mis recientes pedidos, ¿qué es lo que más compro?',
      history: [],
      memory: '',
      orderHistory: []
    })
  });
  assert.equal(response.status, 200);
  assert.match((await response.json()).reply, /no tienes pedidos guardados/i);
  assert.match(requestedBody.input[0].content, /no tiene pedidos guardados recientes disponibles/);
  assert.match(requestedBody.input[0].content, /no inventes compras/i);
});

test('omits personalized context when history and memory are disabled', () => {
  const prompt = composePrompt('Responde en español.', [], '', 'Hola', null);
  assert.equal(prompt[1].content, 'Mensaje actual:\nHola');
});

test('searches YouTube through the official API without exposing its key to the client', async (t) => {
  const testDataDir = await mkdtemp(join(tmpdir(), 'altoque-youtube-test-'));
  let requestedSearchUrl;
  let requestedVideosUrl;
  let upstreamStatus = 200;
  let verificationStatus = 200;
  let upstreamPayload = {
    nextPageToken: 'page-two',
    items: [
      { id: { videoId: 'video123' }, snippet: { title: 'Canción de prueba', channelTitle: 'Artista de prueba' } },
      { id: { videoId: 'private123' }, snippet: { title: 'Video privado', channelTitle: 'Canal privado' } },
      { id: { videoId: 'region123' }, snippet: { title: 'Video no disponible en Perú', channelTitle: 'Canal regional' } }
    ]
  };
  const verificationPayload = {
    items: [
      { id: 'video123', status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true }, contentDetails: {} },
      { id: 'private123', status: { privacyStatus: 'private', uploadStatus: 'processed', embeddable: true }, contentDetails: {} },
      { id: 'region123', status: { privacyStatus: 'public', uploadStatus: 'processed', embeddable: true }, contentDetails: { regionRestriction: { allowed: ['US'] } } }
    ]
  };
  const server = createAlToqueServer({
    ordersFile: join(testDataDir, 'orders.json'),
    youtubeApiKey: 'test-youtube-api-key',
    fetchImpl: async (url) => {
      const requestedUrl = new URL(url);
      if (requestedUrl.pathname === '/youtube/v3/videos') {
        requestedVideosUrl = requestedUrl;
        return new Response(JSON.stringify(verificationPayload), { status: verificationStatus, headers: { 'Content-Type': 'application/json' } });
      }
      requestedSearchUrl = requestedUrl;
      return new Response(JSON.stringify(upstreamPayload), { status: upstreamStatus, headers: { 'Content-Type': 'application/json' } });
    }
  });
  const unconfiguredServer = createAlToqueServer({
    ordersFile: join(testDataDir, 'unconfigured-orders.json'),
    youtubeApiKey: ''
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => {
    unconfiguredServer.once('error', reject);
    unconfiguredServer.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await Promise.all([server, unconfiguredServer].map((activeServer) => new Promise((resolve, reject) => {
      activeServer.close((error) => error ? reject(error) : resolve());
    })));
    await rm(testDataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const unconfiguredBaseUrl = `http://127.0.0.1:${unconfiguredServer.address().port}`;
  const unconfiguredResponse = await fetch(`${unconfiguredBaseUrl}/api/youtube/search?q=test`);
  assert.equal(unconfiguredResponse.status, 503);
  assert.match((await unconfiguredResponse.json()).error, /YOUTUBE_API_KEY/);

  const invalidResponse = await fetch(`${baseUrl}/api/youtube/search?q=`);
  assert.equal(invalidResponse.status, 400);

  const response = await fetch(`${baseUrl}/api/youtube/search?q=${encodeURIComponent('canción de prueba')}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    videos: [{
      id: 'video123',
      title: 'Canción de prueba',
      artist: 'Artista de prueba'
    }],
    nextPageToken: 'page-two'
  });
  assert.equal(requestedSearchUrl.origin, 'https://www.googleapis.com');
  assert.equal(requestedSearchUrl.pathname, '/youtube/v3/search');
  assert.equal(requestedSearchUrl.searchParams.get('q'), 'canción de prueba');
  assert.equal(requestedSearchUrl.searchParams.get('key'), 'test-youtube-api-key');
  assert.equal(requestedSearchUrl.searchParams.get('maxResults'), '50');
  assert.equal(requestedSearchUrl.searchParams.get('videoEmbeddable'), 'true');
  assert.equal(requestedSearchUrl.searchParams.get('regionCode'), 'PE');
  assert.equal(requestedVideosUrl.pathname, '/youtube/v3/videos');
  assert.equal(requestedVideosUrl.searchParams.get('part'), 'status,contentDetails');
  assert.equal(requestedVideosUrl.searchParams.get('id'), 'video123,private123,region123');

  await fetch(`${baseUrl}/api/youtube/search?q=test&pageToken=page-two`);
  assert.equal(requestedSearchUrl.searchParams.get('pageToken'), 'page-two');

  verificationStatus = 500;
  const verificationFailureResponse = await fetch(`${baseUrl}/api/youtube/search?q=test`);
  assert.equal(verificationFailureResponse.status, 502);
  assert.match((await verificationFailureResponse.json()).error, /verificar qué videos están disponibles/i);
  verificationStatus = 200;

  upstreamStatus = 400;
  upstreamPayload = {
    error: {
      status: 'INVALID_ARGUMENT',
      message: 'API key not valid. Please pass a valid API key.',
      errors: [{ reason: 'badRequest' }]
    }
  };
  const invalidKeyResponse = await fetch(`${baseUrl}/api/youtube/search?q=test`);
  assert.equal(invalidKeyResponse.status, 503);
  assert.match((await invalidKeyResponse.json()).error, /YOUTUBE_API_KEY.*inválida/i);
});

test('shares customer orders with the rider queue and enforces delivery transitions', async (t) => {
  const testDataDir = await mkdtemp(join(tmpdir(), 'altoque-server-test-'));
  const server = createAlToqueServer({ ordersFile: join(testDataDir, 'orders.json') });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(testDataDir, { recursive: true, force: true });
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const invalidLocationResponse = await fetch(`${baseUrl}/api/location/reverse?lat=91&lon=0`);
  assert.equal(invalidLocationResponse.status, 400);
  assert.match((await invalidLocationResponse.json()).error, /coordenadas/i);

  const orderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl
    },
    body: JSON.stringify({
      idempotencyKey: 'customer-checkout-123456',
      customer: 'Armando',
      items: [{
        name: 'Iced Protein Matcha',
        quantity: 2,
        price: 22,
        description: 'Bebida de matcha con proteína.',
        image: 'data:image/svg+xml;charset=UTF-8,%3Csvg%3E%3C%2Fsvg%3E'
      }],
      pickupPoint: 'Cafetería Central',
      paymentMethod: 'yape'
    })
  });
  assert.equal(orderResponse.status, 201);
  const { order } = await orderResponse.json();
  assert.equal(order.customer, 'Armando');
  assert.equal(order.total, 45);
  assert.equal(order.payout, 2);
  assert.equal(order.status, 'available');
  assert.equal(order.items[0].description, 'Bebida de matcha con proteína.');
  assert.equal(order.items[0].image, 'data:image/svg+xml;charset=UTF-8,%3Csvg%3E%3C%2Fsvg%3E');

  const retryResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl
    },
    body: JSON.stringify({
      idempotencyKey: 'customer-checkout-123456',
      customer: 'Armando',
      items: [{
        name: 'Iced Protein Matcha',
        quantity: 2,
        price: 22,
        description: 'Bebida de matcha con proteína.',
        image: 'data:image/svg+xml;charset=UTF-8,%3Csvg%3E%3C%2Fsvg%3E'
      }],
      pickupPoint: 'Cafetería Central',
      paymentMethod: 'yape'
    })
  });
  assert.equal(retryResponse.status, 200);
  assert.equal((await retryResponse.json()).order.id, order.id);

  const queueResponse = await fetch(`${baseUrl}/api/orders`);
  assert.equal(queueResponse.status, 200);
  assert.deepEqual((await queueResponse.json()).orders.map((item) => item.id), [order.id]);

  const pendingOrderResponse = await fetch(`${baseUrl}/api/orders/${order.id}`);
  assert.equal(pendingOrderResponse.status, 200);
  assert.equal((await pendingOrderResponse.json()).order.status, 'available');

  const postAction = (action, details = {}) => fetch(`${baseUrl}/api/orders/${order.id}/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl
    },
    body: JSON.stringify({ action, ...details })
  });
  const postRiderLocation = (details) => fetch(`${baseUrl}/api/orders/${order.id}/location`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl
    },
    body: JSON.stringify(details)
  });
  const reviewOrder = (rating, comment) => fetch(`${baseUrl}/api/orders/${order.id}/review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl
    },
    body: JSON.stringify({ rating, comment })
  });
  assert.equal((await reviewOrder(5, 'Muy amable')).status, 409);
  const acceptResponse = await postAction('accept', { driverId: 'rider-armando', driverName: 'Armando' });
  assert.equal(acceptResponse.status, 200);
  assert.equal((await acceptResponse.json()).order.driverName, 'Armando');
  const acceptedOrderResponse = await fetch(`${baseUrl}/api/orders/${order.id}`);
  assert.equal(acceptedOrderResponse.status, 200);
  assert.equal((await acceptedOrderResponse.json()).order.status, 'accepted');
  assert.equal((await postAction('deliver')).status, 409);
  assert.equal((await postRiderLocation({
    driverId: 'rider-armando',
    latitude: -12.1345,
    longitude: -77.026,
    accuracy: 10
  })).status, 409);

  const chatUrl = `${baseUrl}/api/orders/${order.id}/chat`;
  const customerMessage = {
    id: 'customer-message-123',
    type: 'text',
    text: 'Ya llegué',
    createdAt: Date.now()
  };
  const sendMessageResponse = await fetch(chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ role: 'customer', message: customerMessage })
  });
  assert.equal(sendMessageResponse.status, 201);

  const riderChatResponse = await fetch(`${chatUrl}?role=rider&after=0&read=1`);
  const riderChat = await riderChatResponse.json();
  assert.equal(riderChat.messages[0].text, 'Ya llegué');
  assert.equal(Number.isFinite(riderChat.messages[0].readAt), true);

  const customerChatResponse = await fetch(`${chatUrl}?role=customer&after=${customerMessage.createdAt}`);
  const customerChat = await customerChatResponse.json();
  assert.deepEqual(customerChat.receipts, [{ id: customerMessage.id, readAt: riderChat.messages[0].readAt }]);

  const sendAudioResponse = await fetch(chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      role: 'rider',
      message: {
        id: 'rider-audio-message-123',
        type: 'audio',
        text: '',
        createdAt: Date.now(),
        attachment: {
          name: 'Audio de prueba',
          mimeType: 'audio/webm;codecs=opus',
          data: 'data:audio/webm;codecs=opus;base64,AA=='
        }
      }
    })
  });
  assert.equal(sendAudioResponse.status, 201);

  const pickupResponse = await postAction('picked-up');
  assert.equal(pickupResponse.status, 200);
  const pickedUpOrder = (await pickupResponse.json()).order;
  assert.equal(pickedUpOrder.status, 'picked_up');
  assert.ok(Number.isFinite(pickedUpOrder.pickedUpAt));
  assert.equal((await postRiderLocation({
    driverId: 'another-rider',
    latitude: -12.1345,
    longitude: -77.026,
    accuracy: 10
  })).status, 403);
  assert.equal((await postRiderLocation({
    driverId: 'rider-armando',
    latitude: 91,
    longitude: -77.026,
    accuracy: 10
  })).status, 400);
  const locationResponse = await postRiderLocation({
    driverId: 'rider-armando',
    latitude: -12.1345,
    longitude: -77.026,
    accuracy: 10
  });
  assert.equal(locationResponse.status, 200);
  const { location } = await locationResponse.json();
  assert.equal(location.latitude, -12.1345);
  assert.equal(location.longitude, -77.026);
  assert.ok(Number.isFinite(location.updatedAt));
  const orderWithLocationResponse = await fetch(`${baseUrl}/api/orders/${order.id}`);
  assert.deepEqual((await orderWithLocationResponse.json()).location, location);
  assert.equal((await reviewOrder(5, 'Muy amable')).status, 409);
  const deliveryResponse = await postAction('deliver');
  assert.equal(deliveryResponse.status, 200);
  const deliveredOrder = (await deliveryResponse.json()).order;
  assert.equal(deliveredOrder.status, 'delivered');
  assert.ok(Number.isFinite(deliveredOrder.deliveredAt));
  assert.ok(deliveredOrder.deliveredAt >= pickedUpOrder.pickedUpAt);
  assert.equal((await postAction('deliver')).status, 409);
  const deliveredOrderResponse = await fetch(`${baseUrl}/api/orders/${order.id}`);
  assert.equal((await deliveredOrderResponse.json()).location, null);
  const reviewResponse = await reviewOrder(5, 'Muy amable y puntual');
  assert.equal(reviewResponse.status, 201);
  assert.equal((await reviewOrder(4, 'Otra opinión')).status, 409);
  const riderProfile = await (await fetch(`${baseUrl}/api/rider/profile?driverId=rider-armando`)).json();
  assert.equal(riderProfile.profile.name, 'Armando');
  assert.equal(riderProfile.profile.ratingAverage, 5);
  assert.equal(riderProfile.profile.reviewCount, 1);
  assert.equal(riderProfile.profile.reviews[0].comment, 'Muy amable y puntual');
  const orderDetails = await (await fetch(`${baseUrl}/api/orders/${order.id}`)).json();
  assert.equal(orderDetails.order.review.rating, 5);
  assert.equal((await postAction('accept')).status, 409);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/orders`)).json()).orders, []);

  for (const asset of ['splash-clean-reference.png', 'splash-warm-reference.png']) {
    assert.equal((await fetch(`${baseUrl}/${asset}`)).status, 200);
  }

  const audioTermsResponse = await fetch(`${baseUrl}/audiomack-player-terms.html`);
  assert.equal(audioTermsResponse.status, 200);
  assert.match(audioTermsResponse.headers.get('content-type'), /text\/html/);
  const audioTermsHtml = await audioTermsResponse.text();
  assert.match(audioTermsHtml, /Términos de uso del reproductor Audiomack/);
  assert.match(audioTermsHtml, /https:\/\/audiomack\.com\/about\/terms-of-service/);

  const coinResponse = await fetch(`${baseUrl}/Moneda%20Al%20Toque.html?coinEmbed=1`);
  assert.equal(coinResponse.status, 200);
  assert.match(coinResponse.headers.get('content-type'), /text\/html/);
  assert.equal(coinResponse.headers.get('x-frame-options'), 'SAMEORIGIN');
  const coinHtml = await coinResponse.text();
  assert.match(coinHtml, /coinEmbed/);
  const embeddedCoinBuilder = coinHtml.match(/function buildEmbeddedCoin\(onReady\)\s*\{([\s\S]*?)\r?\n  \}\r?\n\r?\n  function resize\(\)/)?.[1];
  assert.ok(embeddedCoinBuilder, 'embedded coin renderer should be defined');
  assert.match(embeddedCoinBuilder, /build\(\)/);
  assert.match(coinHtml, /var N = 2048/);
  assert.match(coinHtml, /neon: '#a51e2a'/);
  assert.match(coinHtml, /#45484d/);
  assert.match(coinHtml, /background-color: transparent !important/);
  assert.match(coinHtml, /renderer\.setClearAlpha\(0\)/);
  assert.match(coinHtml, /premultipliedAlpha: true/);
  assert.match(coinHtml, /preserveDrawingBuffer: true/);
  assert.match(coinHtml, /renderer\.setClearColor\(0x000000, 0\)/);
  assert.doesNotMatch(coinHtml, /coinColor/);

  for (const asset of ['coin-front-red.png']) {
    const photoResponse = await fetch(`${baseUrl}/${asset}`);
    assert.equal(photoResponse.status, 200);
    assert.match(photoResponse.headers.get('content-type'), /image\/png/);
    assert.ok((await photoResponse.arrayBuffer()).byteLength > 10_000);
  }
});

test('rejects rider-declined orders and allows cancellation until pickup', async (t) => {
  const testDataDir = await mkdtemp(join(tmpdir(), 'altoque-cancel-test-'));
  const expiredOrder = {
    id: 'UPCH-EXPIRED-ORDER',
    customer: 'Cliente UPCH',
    items: [{ name: 'Pedido vencido', quantity: 1, price: 10 }],
    pickupPoint: 'Cafetería Central',
    paymentMethod: 'yape',
    subtotal: 10,
    total: 11,
    payout: 1,
    status: 'available',
    createdAt: Date.now() - 60_001
  };
  const acceptedOrder = {
    ...expiredOrder,
    id: 'UPCH-ACCEPTED-ORDER',
    status: 'accepted',
    createdAt: Date.now() - 3_600_000,
    driverId: 'rider-1',
    driverName: 'Repartidor'
  };
  const pickedUpOrder = {
    ...acceptedOrder,
    id: 'UPCH-PICKED-UP-ORDER',
    status: 'picked_up',
    pickedUpAt: Date.now()
  };
  await writeFile(join(testDataDir, 'orders.json'), JSON.stringify({ orders: [expiredOrder, acceptedOrder, pickedUpOrder] }));
  const server = createAlToqueServer({ ordersFile: join(testDataDir, 'orders.json') });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(testDataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const postAction = (orderId, action, details = {}) => fetch(`${baseUrl}/api/orders/${orderId}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ action, ...details })
  });
  const createResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      customer: 'Cliente UPCH',
      items: [{ name: 'Pedido cancelable', quantity: 1, price: 10 }],
      pickupPoint: 'Cafetería Central',
      paymentMethod: 'yape'
    })
  });
  assert.equal(createResponse.status, 201);
  const { order } = await createResponse.json();

  const declineCreateResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      customer: 'Cliente UPCH',
      items: [{ name: 'Pedido rechazable', quantity: 1, price: 8 }],
      pickupPoint: 'Cafetería Central',
      paymentMethod: 'yape'
    })
  });
  assert.equal(declineCreateResponse.status, 201);
  const { order: declinedOrder } = await declineCreateResponse.json();
  const declineResponse = await postAction(declinedOrder.id, 'decline');
  assert.equal(declineResponse.status, 200);
  assert.equal((await declineResponse.json()).order.status, 'rejected');
  assert.equal((await postAction(declinedOrder.id, 'accept', { driverId: 'rider-1', driverName: 'Repartidor' })).status, 409);

  const cancellationResponse = await postAction(order.id, 'cancel');
  assert.equal(cancellationResponse.status, 200);
  assert.equal((await cancellationResponse.json()).order.status, 'cancelled');
  assert.equal((await postAction(order.id, 'accept', { driverId: 'rider-1', driverName: 'Repartidor' })).status, 409);

  const expiredCancellationResponse = await postAction(expiredOrder.id, 'cancel');
  assert.equal(expiredCancellationResponse.status, 409);
  assert.match((await expiredCancellationResponse.json()).error, /antes de que el repartidor confirme el recojo/i);

  const acceptedCancellationResponse = await postAction(acceptedOrder.id, 'cancel');
  assert.equal(acceptedCancellationResponse.status, 200);
  assert.equal((await acceptedCancellationResponse.json()).order.status, 'cancelled');
  assert.equal((await postAction(acceptedOrder.id, 'picked-up')).status, 409);

  const pickedUpCancellationResponse = await postAction(pickedUpOrder.id, 'cancel');
  assert.equal(pickedUpCancellationResponse.status, 409);
  assert.match((await pickedUpCancellationResponse.json()).error, /antes de que el repartidor confirme el recojo/i);
  const queueResponse = await fetch(`${baseUrl}/api/orders`);
  assert.deepEqual((await queueResponse.json()).orders.map(({ id }) => id), [expiredOrder.id]);

  const pageResponse = await fetch(`${baseUrl}/`);
  const html = await pageResponse.text();
  assert.match(html, /const canCancelOrder = orderStatus === 'accepted'/);
  assert.match(html, /Puedes cancelar si aún no se confirmó el recojo/);
  assert.match(html, /El pedido \$\{activeOrder\.id\} fue cancelado y se quitó de tu ruta/);
});

test('accepts Gorritos redemptions without a cash total or service fee', async (t) => {
  const testDataDir = await mkdtemp(join(tmpdir(), 'altoque-gorritos-test-'));
  const server = createAlToqueServer({ ordersFile: join(testDataDir, 'orders.json') });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(testDataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const submitRedemption = (details) => fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      customer: 'Armando',
      items: [{ id: '1', name: 'Lomo saltado', quantity: 1, price: 0 }],
      pickupPoint: 'Cafetería Central',
      paymentMethod: 'gorritos',
      gorritosSpent: 12,
      ...details
    })
  });

  const redemptionResponse = await submitRedemption({ idempotencyKey: 'gorritos-redeem-123456' });
  assert.equal(redemptionResponse.status, 201);
  const { order } = await redemptionResponse.json();
  assert.equal(order.paymentMethod, 'gorritos');
  assert.equal(order.gorritosSpent, 12);
  assert.equal(order.subtotal, 0);
  assert.equal(order.total, 0);
  assert.equal(order.items[0].id, '1');

  const retryResponse = await submitRedemption({ idempotencyKey: 'gorritos-redeem-123456' });
  assert.equal(retryResponse.status, 200);
  assert.equal((await retryResponse.json()).order.id, order.id);

  const cashChargeResponse = await submitRedemption({
    idempotencyKey: 'gorritos-cash-123456',
    items: [{ id: '1', name: 'Lomo saltado', quantity: 1, price: 12 }]
  });
  assert.equal(cashChargeResponse.status, 400);

  const missingPointsResponse = await submitRedemption({
    idempotencyKey: 'gorritos-points-123456',
    gorritosSpent: 0
  });
  assert.equal(missingPointsResponse.status, 400);

  const cashWithPointsResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({
      idempotencyKey: 'cash-with-gorritos-123456',
      items: [{ id: '1', name: 'Lomo saltado', quantity: 1, price: 12 }],
      pickupPoint: 'Cafetería Central',
      paymentMethod: 'efectivo',
      gorritosSpent: 12
    })
  });
  assert.equal(cashWithPointsResponse.status, 400);
});
