import { expect } from 'chai';
import http from 'http';
import finalhandler from 'finalhandler';
import serveStatic from 'serve-static';
import fs from 'fs-extra';
import scrape from 'website-scraper';
import PuppeteerPlugin from '../lib/index.js';

const directory = './test/tmp';
const SERVE_WEBSITE_PORT = 4567;

describe('Puppeteer plugin test', () => {
	let result, content, server;

	before('start webserver', () => server = startWebserver(SERVE_WEBSITE_PORT));
	after('stop webserver', () => server.close());

	describe('Dynamic content', () => {
		before('scrape website', async () => {
			result = await scrape({
				urls: [`http://localhost:${SERVE_WEBSITE_PORT}`],
				directory: directory,
				plugins: [ new PuppeteerPlugin({
					scrollToBottom: { timeout: 50, viewportN: 10 }
				}) ]
			});
		});
		before('get content from file', () => {
			content = fs.readFileSync(`${directory}/${result[0].filename}`).toString();
		});
		after('delete dir', () => fs.removeSync(directory));

		it('should have 1 item in result array', () => {
			expect(result.length).eql(1);
		});

		it('should render dymanic website', async () => {
			expect(content).to.contain('<div id="root">Hello world from JS!</div>');
		});

		it('should render special characters correctly', async () => {
			expect(content).to.contain('<div id="special-characters-test">7년 동안 한국에서 살았어요. Слава Україні!</div>');
		});
	});

	// Regression test for https://github.com/website-scraper/website-scraper-puppeteer/issues/115
	// The page js rotates the session cookie; the rotated cookie must be used
	// for subsequent requests instead of the initially configured one.
	// Runs with the default (unlimited) requestConcurrency: page renders
	// must not overlap with each other or with in-flight plain requests.
	describe('Session cookie rotated by page js', () => {
		const SESSION_SERVER_PORT = 4568;
		let sessionServer, files;

		before('start session webserver', () => sessionServer = startSessionRotatingWebserver(SESSION_SERVER_PORT));
		after('stop session webserver', () => sessionServer.close());

		before('scrape website', async () => {
			await scrape({
				urls: [`http://localhost:${SESSION_SERVER_PORT}/`],
				directory: directory,
				recursive: true,
				request: {
					headers: { Cookie: 'session=token-1' }
				},
				urlFilter: url => url.startsWith(`http://localhost:${SESSION_SERVER_PORT}`),
				plugins: [ new PuppeteerPlugin({
					// wait for the session-rotating fetch() to complete before the page is closed
					gotoOptions: { waitUntil: 'networkidle0' }
				}) ]
			});
		});
		before('get content from files', () => {
			files = {};
			for (const name of ['index', 'page2', 'page3', 'page4', 'page5']) {
				files[name] = fs.readFileSync(`${directory}/${name}.html`).toString();
			}
		});
		after('delete dir', () => fs.removeSync(directory));

		it('should stay logged in on the first page', () => {
			expect(files.index).to.contain('LOGGED-IN');
		});

		it('should stay logged in on subsequent pages', () => {
			for (const name of ['page2', 'page3', 'page4', 'page5']) {
				expect(files[name], name).to.contain('LOGGED-IN');
			}
		});

		it('should never present a stale token', () => {
			expect(sessionServer.sessionDestroyed).to.eql(false);
		});

		it('should use the rotated cookie for subsequent website-scraper requests', () => {
			const scraperRequests = sessionServer.requestLog.filter(request => request.url === '/page2.html' && !request.fromBrowser);
			expect(scraperRequests).to.have.lengthOf(1);
			expect(scraperRequests[0].cookie).to.eql('session=token-2');
		});
	});

	// got follows redirects internally, so cookies set on intermediate hops
	// are only visible through the cookie jar - not in the final response.
	describe('Cookie set on a redirect hop', () => {
		const REDIRECT_SERVER_PORT = 4569;
		let redirectServer, homeContent;

		before('start redirecting webserver', () => redirectServer = startRedirectingWebserver(REDIRECT_SERVER_PORT));
		after('stop redirecting webserver', () => redirectServer.close());

		before('scrape website', async () => {
			await scrape({
				urls: [`http://localhost:${REDIRECT_SERVER_PORT}/`],
				directory: directory,
				request: {
					headers: { Cookie: 'session=token-1' }
				},
				plugins: [ new PuppeteerPlugin() ]
			});
		});
		before('get content from file', () => {
			homeContent = fs.readFileSync(`${directory}/index.html`).toString();
		});
		after('delete dir', () => fs.removeSync(directory));

		it('should send the configured cookie to the redirecting url', () => {
			const requests = redirectServer.requestLog.filter(request => request.url === '/' && !request.fromBrowser);
			expect(requests).to.have.lengthOf(1);
			expect(requests[0].cookie).to.eql('session=token-1');
		});

		it('should send the cookie set by the redirect to the redirect target', () => {
			const requests = redirectServer.requestLog.filter(request => request.url === '/home.html' && !request.fromBrowser);
			expect(requests).to.have.lengthOf(1);
			expect(requests[0].cookie).to.eql('session=token-2');
		});

		it('should render the redirect target in puppeteer with the cookie set by the redirect', () => {
			expect(homeContent).to.contain('<h1>session=token-2</h1>');
		});

		it('should ignore a cookie rejected by the browser', () => {
			// the scrape completed (see before hook) despite the __Secure- cookie
			// sent over http, and the valid cookie was kept
			expect(homeContent).to.contain('<h1>session=token-2</h1>');
		});
	});

	describe('exclusiveRendering: false', () => {
		let plainResult, plainContent;

		before('scrape website', async () => {
			plainResult = await scrape({
				urls: [`http://localhost:${SERVE_WEBSITE_PORT}`],
				directory: directory,
				plugins: [ new PuppeteerPlugin({ exclusiveRendering: false }) ]
			});
		});
		before('get content from file', () => {
			plainContent = fs.readFileSync(`${directory}/${plainResult[0].filename}`).toString();
		});
		after('delete dir', () => fs.removeSync(directory));

		it('should render dynamic website without the render lock', () => {
			expect(plainContent).to.contain('<div id="root">Hello world from JS!</div>');
		});
	});

	describe('CJK content with charset only in meta tag', () => {
		let cjkResult, cjkContent;

		before('scrape website', async () => {
			cjkResult = await scrape({
				urls: [`http://localhost:${SERVE_WEBSITE_PORT}/cjk.html`],
				directory: directory,
				plugins: [ new PuppeteerPlugin() ]
			});
		});
		before('get content from file', () => {
			cjkContent = fs.readFileSync(`${directory}/${cjkResult[0].filename}`).toString();
		});
		after('delete dir', () => fs.removeSync(directory));

		// Regression test for https://github.com/website-scraper/website-scraper-puppeteer/pull/103
		// Saving the page as a binary string corrupted these characters on disk.
		it('should save CJK characters without corruption', () => {
			expect(cjkContent).to.contain('<div id="cjk-characters-test">磁致伸缩位移传感器 影响大跨度桥梁施工控制的因素</div>');
		});
	});

	// Regression tests for request headers leaking between resources: the
	// headers of the most recent request were stored globally, so concurrent
	// page renders reused them, and setExtraHTTPHeaders passed them to every
	// request made by the page - including cross-origin subresources.
	// Headers must be scoped to their resource: only the page navigation
	// itself and its same-origin redirects may use them.
	describe('Per-resource request headers', () => {
		const ORIGIN_A_PORT = 4570;
		const ORIGIN_B_PORT = 4571;
		const originA = `http://localhost:${ORIGIN_A_PORT}`;
		const originB = `http://localhost:${ORIGIN_B_PORT}`;
		let authServer, cdnServer;

		before('start dual-origin webservers', () => {
			authServer = startAuthWebserver(ORIGIN_A_PORT, originB);
			cdnServer = startCdnWebserver(ORIGIN_B_PORT);
		});
		after('stop dual-origin webservers', () => {
			authServer.close();
			cdnServer.close();
		});

		describe('Concurrent pages with different credentials', () => {
			let files;

			before('clear request logs', () => {
				authServer.requestLog.length = 0;
				cdnServer.requestLog.length = 0;
			});
			before('scrape website', async () => {
				await scrape({
					// member and guest are discovered from the index page, so
					// they are requested and rendered concurrently
					urls: [`${originA}/`],
					directory: directory,
					recursive: true,
					plugins: [
						// sets a different Authorization header per resource,
						// like a plugin refreshing an expiring token would
						new PerResourceHeadersPlugin(resource =>
							resource.url.endsWith('/member') ? {authorization: 'Bearer member-token'} : {}),
						// render concurrently, so the renders race if headers were shared
						new PuppeteerPlugin({ exclusiveRendering: false })
					]
				});
			});
			before('get content from files', () => {
				files = {
					member: fs.readFileSync(`${directory}/member.html`).toString(),
					guest: fs.readFileSync(`${directory}/guest.html`).toString()
				};
			});
			after('delete dir', () => fs.removeSync(directory));

			it('should render each page with its own headers', () => {
				expect(files.member).to.contain('auth:Bearer member-token');
				expect(files.guest).to.contain('auth:none');
				expect(files.guest).to.not.contain('member-token');
			});

			it('should send the Authorization header with the page navigation itself', () => {
				const navigations = authServer.requestLog.filter(request => request.url === '/member' && request.fromBrowser);
				expect(navigations).to.have.lengthOf(1);
				expect(navigations[0].authorization).to.eql('Bearer member-token');
			});

			it('should not send the Authorization header with the guest page navigation', () => {
				const navigations = authServer.requestLog.filter(request => request.url === '/guest' && request.fromBrowser);
				expect(navigations).to.have.lengthOf(1);
				expect(navigations[0].authorization).to.eql(null);
			});

			it('should not leak the Authorization header to cross-origin subresources', () => {
				const requests = cdnServer.requestLog.filter(request => request.url === '/tracker.png' && request.fromBrowser);
				expect(requests.length).to.be.greaterThan(0);
				requests.forEach(request => expect(request.authorization).to.eql(null));
			});

			it('should not send the Authorization header to same-origin subresources', () => {
				const requests = authServer.requestLog.filter(request => request.url === '/pixel.png' && request.fromBrowser);
				expect(requests.length).to.be.greaterThan(0);
				requests.forEach(request => expect(request.authorization).to.eql(null));
			});
		});

		describe('Redirects', () => {
			let files;

			before('clear request logs', () => {
				authServer.requestLog.length = 0;
				cdnServer.requestLog.length = 0;
			});
			before('scrape website', async () => {
				await scrape({
					urls: [
						{ url: `${originA}/redirect-member`, filename: 'redirect-member.html' },
						{ url: `${originA}/redirect-cross`, filename: 'redirect-cross.html' }
					],
					directory: directory,
					request: {
						headers: { authorization: 'Bearer member-token' }
					},
					plugins: [ new PuppeteerPlugin() ]
				});
			});
			before('get content from files', () => {
				files = {
					redirectMember: fs.readFileSync(`${directory}/redirect-member.html`).toString(),
					redirectCross: fs.readFileSync(`${directory}/redirect-cross.html`).toString()
				};
			});
			after('delete dir', () => fs.removeSync(directory));

			it('should keep the headers on a same-origin redirect', () => {
				expect(files.redirectMember).to.contain('auth:Bearer member-token');
			});

			it('should send the headers on the same-origin redirect hop', () => {
				const requests = authServer.requestLog.filter(request => request.url === '/member' && !request.fromBrowser);
				expect(requests).to.have.lengthOf(1);
				expect(requests[0].authorization).to.eql('Bearer member-token');
			});

			it('should drop the headers on a cross-origin redirect', () => {
				expect(files.redirectCross).to.contain('auth:none');
				expect(files.redirectCross).to.not.contain('member-token');
			});

			it('should not send the headers to the cross-origin redirect target', () => {
				const requests = cdnServer.requestLog.filter(request => request.url === '/landing');
				expect(requests.length).to.be.greaterThan(0);
				requests.forEach(request => expect(request.authorization).to.eql(null));
			});
		});

		describe('Retry after a failed request', () => {
			let flakyContent;

			before('clear request logs', () => {
				authServer.requestLog.length = 0;
				cdnServer.requestLog.length = 0;
			});
			before('scrape website', async () => {
				await scrape({
					urls: [{ url: `${originA}/flaky`, filename: 'flaky.html' }],
					directory: directory,
					request: {
						headers: { authorization: 'Bearer member-token' }
					},
					plugins: [ new PuppeteerPlugin() ]
				});
			});
			before('get content from file', () => {
				flakyContent = fs.readFileSync(`${directory}/flaky.html`).toString();
			});
			after('delete dir', () => fs.removeSync(directory));

			it('should render the retried resource with its headers', () => {
				expect(flakyContent).to.contain('auth:Bearer member-token');
			});

			it('should have retried the failed request', () => {
				const requests = authServer.requestLog.filter(request => request.url === '/flaky' && !request.fromBrowser);
				expect(requests).to.have.lengthOf(2);
			});
		});
	});
});

// Simulates a website which rotates the session cookie via an ajax call
// (like WordPress heartbeat / WooCommerce fragments do). Rotation invalidates
// the previous token, and presenting a stale token destroys the whole session
// (like WordPress security plugins do on suspected session hijacking).
// Pages link to each other so that sibling pages get requested concurrently:
// index -> page2, page3; page2 -> page4; page3 -> page5.
function startSessionRotatingWebserver (port) {
	const validTokens = new Set(['token-1']);
	const seenTokens = new Set(['token-1']);
	let tokenCounter = 1;
	const requestLog = [];
	const links = {
		'/': ['/page2.html', '/page3.html'],
		'/page2.html': ['/page4.html'],
		'/page3.html': ['/page5.html']
	};

	const server = http.createServer((req, res) => {
		if (req.url === '/favicon.ico') {
			// requested by Chrome in parallel with the page's own requests, not session-related
			res.writeHead(404).end();
			return;
		}
		// Every request takes a while to be processed, so requests sent concurrently
		// (by a page render or by website-scraper) overlap and a rotation triggered
		// by one of them lands before the others are validated.
		setTimeout(() => handle(req, res), 100);
	});

	function handle (req, res) {
		const fromBrowser = (req.headers['user-agent'] || '').includes('HeadlessChrome');
		const tokenMatch = (req.headers.cookie || '').match(/session=([^;]+)/);
		const token = tokenMatch ? tokenMatch[1] : null;

		requestLog.push({
			url: req.url,
			cookie: req.headers.cookie || null,
			// requests made by the puppeteer page vs by website-scraper itself
			fromBrowser
		});

		if (token && seenTokens.has(token) && !validTokens.has(token)) {
			validTokens.clear(); // stale token reuse -> destroy session
			server.sessionDestroyed = true;
		}
		const loggedIn = token && validTokens.has(token);

		if (req.url === '/refresh') {
			if (loggedIn) {
				validTokens.delete(token);
				const newToken = `token-${++tokenCounter}`;
				validTokens.add(newToken);
				seenTokens.add(newToken);
				res.setHeader('Set-Cookie', `session=${newToken}; Path=/`);
			}
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ ok: loggedIn }));
			return;
		}

		res.setHeader('Content-Type', 'text/html');
		const status = loggedIn ? 'LOGGED-IN' : 'LOGGED-OUT';
		const anchors = (links[req.url] || []).map(href => `<a href="${href}">${href}</a>`).join('');
		res.end(`<html><body><h1>${status}</h1>
			${anchors}
			<script>fetch('/refresh');</script>
		</body></html>`);
	}

	server.requestLog = requestLog;
	server.sessionDestroyed = false;
	return server.listen(port);
}

// Simulates a website which sets a new session cookie while redirecting
// (like login flows do): GET / -> 302 Location: /home.html + Set-Cookie.
function startRedirectingWebserver (port) {
	const requestLog = [];

	const server = http.createServer((req, res) => {
		requestLog.push({
			url: req.url,
			cookie: req.headers.cookie || null,
			fromBrowser: (req.headers['user-agent'] || '').includes('HeadlessChrome')
		});

		if (req.url === '/') {
			res.writeHead(302, { 'Location': '/home.html', 'Set-Cookie': 'session=token-2; Path=/' });
			res.end();
			return;
		}

		res.setHeader('Content-Type', 'text/html');
		// __Secure- prefixed cookies must have the Secure attribute, Chrome rejects this one
		res.setHeader('Set-Cookie', '__Secure-tracking=1; Path=/');
		res.end(`<html><body><h1>${req.headers.cookie || 'no cookie'}</h1></body></html>`);
	});

	server.requestLog = requestLog;
	return server.listen(port);
}

function startWebserver (port = 3000) {
	const serve = serveStatic('./test/mock', {'index': ['index.html']});
	const server = http.createServer(function onRequest (req, res) {
		// Serve the CJK page the same way as the website from #103: utf-8 is
		// declared only in the html <meta> tag, not in the Content-Type header.
		if (req.url === '/cjk.html') {
			res.setHeader('Content-Type', 'text/html');
			res.end(fs.readFileSync('./test/mock/cjk.html'));
			return;
		}
		serve(req, res, finalhandler(req, res));
	});

	return server.listen(port);
}

// Adds per-resource request headers, like a plugin which refreshes an
// expiring auth token before each request would. Must be registered
// before PuppeteerPlugin so the puppeteer plugin sees the final headers.
class PerResourceHeadersPlugin {
	constructor (headersFor) {
		this.headersFor = headersFor;
	}

	apply (registerAction) {
		registerAction('beforeRequest', ({resource, requestOptions}) => ({
			requestOptions: Object.assign({}, requestOptions, {
				headers: Object.assign({}, requestOptions.headers, this.headersFor(resource))
			})
		}));
	}
}

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// Origin A of the dual-origin test site. Echoes the Authorization header
// into the html, so the saved page shows which credentials the browser
// (or got) presented. The member page embeds a same-origin and a
// cross-origin image to probe header inheritance by subresources.
function startAuthWebserver (port, originB) {
	const requestLog = [];
	let flakyHits = 0;

	const server = http.createServer((req, res) => {
		// got never sends Fetch Metadata headers, the browser always does
		const fromBrowser = Boolean(req.headers['sec-fetch-dest']);
		requestLog.push({
			url: req.url,
			authorization: req.headers.authorization || null,
			fromBrowser
		});

		if (req.url === '/favicon.ico') {
			res.writeHead(404).end();
			return;
		}

		// fails the first request with a dropped connection, so got retries it
		if (req.url === '/flaky' && flakyHits++ === 0) {
			req.socket.destroy();
			return;
		}

		if (req.url === '/redirect-member') {
			res.writeHead(302, { Location: '/member' }).end();
			return;
		}
		if (req.url === '/redirect-cross') {
			res.writeHead(302, { Location: `${originB}/landing` }).end();
			return;
		}

		// respond slowly, so concurrent requests and renders overlap
		setTimeout(() => {
			if (req.url === '/pixel.png') {
				res.writeHead(200, { 'Content-Type': 'image/png' }).end(PIXEL);
				return;
			}
			res.setHeader('Content-Type', 'text/html');
			if (req.url === '/') {
				res.end('<html><body><a href="/member">member</a><a href="/guest">guest</a></body></html>');
				return;
			}
			const images = req.url === '/member'
				? `<img src="${originB}/tracker.png"><img src="/pixel.png">`
				: '';
			res.end(`<html><body><h1>auth:${req.headers.authorization || 'none'}</h1>${images}</body></html>`);
		}, 100);
	});

	server.requestLog = requestLog;
	return server.listen(port);
}

// Origin B of the dual-origin test site: a "third party" which must never
// receive origin A's credentials.
function startCdnWebserver (port) {
	const requestLog = [];

	const server = http.createServer((req, res) => {
		requestLog.push({
			url: req.url,
			authorization: req.headers.authorization || null,
			fromBrowser: Boolean(req.headers['sec-fetch-dest'])
		});

		if (req.url === '/tracker.png') {
			res.writeHead(200, { 'Content-Type': 'image/png' }).end(PIXEL);
			return;
		}
		res.setHeader('Content-Type', 'text/html');
		res.end(`<html><body><h1>auth:${req.headers.authorization || 'none'}</h1></body></html>`);
	});

	server.requestLog = requestLog;
	return server.listen(port);
}
