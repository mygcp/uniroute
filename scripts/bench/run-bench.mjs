// Streaming gateway benchmark: compare direct mock upstream vs through gateway
// across N alternating pairs, then report median latency.
//
// Run (with mock upstream + bench provider registered + server restarted):
//   node scripts/bench/mock-upstream.mjs &
//   node scripts/bench/register-bench-provider.mjs
//   BASE=http://localhost:5173 PASSWORD=CHANGEME node scripts/bench/run-bench.mjs
//
// Env: BASE, PASSWORD, MODEL (default bench-test), PAIRS (default 7),
//      DIRECT (default http://127.0.0.1:8791)
const BASE = process.env.BASE ?? "http://localhost:5173";
const PASSWORD = process.env.PASSWORD ?? "CHANGEME";
const MODEL = process.env.MODEL ?? "bench-test";
const PAIRS = Number(process.env.PAIRS ?? 7);
const DIRECT = process.env.DIRECT ?? "http://127.0.0.1:8791";

// 1) Sign in for a session cookie.
const loginRes = await fetch(`${BASE}/login`, {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({ password: PASSWORD }),
	redirect: "manual",
});
const setCookie = loginRes.headers.get("set-cookie");
if (!setCookie) {
	console.error("login failed: check PASSWORD/BASE.");
	process.exit(1);
}
const cookie = setCookie.split(";")[0];

const body = JSON.stringify({
	model: MODEL,
	stream: true,
	max_tokens: 500,
	messages: [{ role: "user", content: "hi" }],
});

async function once(base, pathPrefix, headers) {
	const t0 = performance.now();
	const res = await fetch(`${base}${pathPrefix}/chat/completions`, {
		method: "POST",
		headers,
		body,
	});
	if (!res.ok) {
		return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
	}
	const reader = res.body.getReader();
	let ttft = null;
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (ttft === null && value.length) {
			// First byte containing a data frame (excluding keep-alive comments).
			ttft = performance.now() - t0;
		}
		bytes += value.length;
	}
	return { ttft, total: performance.now() - t0, bytes };
}

const d = [];
const g = [];
for (let i = 0; i < PAIRS; i++) {
	await new Promise((r) => setTimeout(r, 200));
	const dr = await once(DIRECT, "", {
		"content-type": "application/json",
	});
	const gr = await once(BASE, "/v1", {
		"content-type": "application/json",
		cookie,
	});
	if (!dr || dr.error) console.log(`direct${i}: ${dr?.error ?? "ok"}`);
	if (!gr || gr.error) console.log(`gateway${i}: ${gr?.error ?? "ok"}`);
	if (dr && !dr.error) d.push(dr);
	if (gr && !gr.error) g.push(gr);
}

const med = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
if (d.length === 0 || g.length === 0) {
	console.error("no valid pairs: check mock/server.");
	process.exit(1);
}
const mt = med(d.map((r) => r.ttft));
const gt = med(g.map((r) => r.ttft));
const mo = med(d.map((r) => r.total));
const go = med(g.map((r) => r.total));
console.log(`\n=== median ${Math.min(d.length, g.length)} pairs (model: ${MODEL}) ===`);
console.log(`direct : ttft=${mt.toFixed(1)}ms total=${mo.toFixed(1)}ms bytes=${d[0].bytes}`);
console.log(`gateway: ttft=${gt.toFixed(1)}ms total=${go.toFixed(1)}ms bytes=${g[0].bytes}`);
console.log(
	`overhead: total=+${(go - mo).toFixed(1)}ms (${(((go - mo) / mo) * 100).toFixed(2)}%)`,
);
console.log(
	"note: gateway ttft excludes filtered empty frames; compare total and bytes for throughput.",
);
