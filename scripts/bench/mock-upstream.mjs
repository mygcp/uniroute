// Deterministic OpenAI-compatible SSE mock upstream for gateway benchmarks:
// fixed frame count/pacing including leading empty deltas.
//
// Run: node scripts/bench/mock-upstream.mjs
// Env: BENCH_PORT (default 8791), BENCH_EMPTY (default 100),
//      BENCH_FRAMES (default 300), BENCH_PACE_MS (default 4)
import { createServer } from "node:http";

const PORT = Number(process.env.BENCH_PORT ?? 8791);
const EMPTY_FRAMES = Number(process.env.BENCH_EMPTY ?? 100);
const FRAMES = Number(process.env.BENCH_FRAMES ?? 300);
const PACE_MS = Number(process.env.BENCH_PACE_MS ?? 4);

createServer((req, res) => {
	if (!req.url?.includes("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
	});
	const frames = [
		{ choices: [{ delta: { role: "assistant" }, index: 0 }] },
	];
	for (let i = 0; i < EMPTY_FRAMES; i++) {
		frames.push({ choices: [{ delta: { content: "" }, index: 0 }] });
	}
	for (let i = 0; i < FRAMES; i++) {
		frames.push({ choices: [{ delta: { content: `tok${i} ` }, index: 0 }] });
	}
	frames.push({
		choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
		usage: {
			prompt_tokens: 10,
			completion_tokens: FRAMES,
			total_tokens: FRAMES + 10,
		},
	});

	let i = 0;
	const timer = setInterval(() => {
		if (i < frames.length) {
			res.write(`data: ${JSON.stringify(frames[i])}\n\n`);
			i++;
			return;
		}
		clearInterval(timer);
		res.write("data: [DONE]\n\n");
		res.end();
	}, PACE_MS);
	req.on("close", () => clearInterval(timer));
}).listen(PORT, () =>
	console.log(`bench mock upstream on http://127.0.0.1:${PORT}`),
);
