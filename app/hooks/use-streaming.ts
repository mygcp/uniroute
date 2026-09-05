import { useCallback, useRef, useState } from "react";

type Usage = {
	prompt_tokens?: number;
	completion_tokens?: number;
};

export type ChatTurn = { role: "user" | "assistant"; content: string };

/**
 * Streaming chat hook dengan update ber-batching rAF: delta SSE diakumulasi
 * di ref dan di-flush maksimal sekali per frame — jauh lebih halus daripada
 * setState per chunk (yang memicu render puluhan kali per detik).
 */
export function useStreaming() {
	const [response, setResponse] = useState("");
	const [thinking, setThinking] = useState("");
	const [usage, setUsage] = useState<Usage | null>(null);
	const [streaming, setStreaming] = useState(false);
	const [done, setDone] = useState(false);
	const [error, setError] = useState("");
	// True bila stream tutup tanpa [DONE] (upstream putus tengah jalan).
	// response tetap berisi potongan yang sudah diterima — UI bisa commit
	// sebagai turn normal + tawarkan "Lanjutkan".
	const [truncated, setTruncated] = useState(false);
	const [autoContinued, setAutoContinued] = useState(0);
	const abortRef = useRef<AbortController | null>(null);

	// Buffer delta + jadwal flush per frame (fallback timer saat tab hidden).
	const bufRef = useRef("");
	const thinkBufRef = useRef("");
	const rafRef = useRef<number | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const clearSchedule = () => {
		if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
		if (timerRef.current != null) clearTimeout(timerRef.current);
		rafRef.current = null;
		timerRef.current = null;
	};
	const flush = useCallback(() => {
		clearSchedule();
		if (bufRef.current !== "") {
			const chunk = bufRef.current;
			bufRef.current = "";
			setResponse((prev) => prev + chunk);
		}
		if (thinkBufRef.current !== "") {
			const chunk = thinkBufRef.current;
			thinkBufRef.current = "";
			setThinking((prev) => prev + chunk);
		}
	}, []);

	const schedule = useCallback(() => {
		if (rafRef.current != null || timerRef.current != null) return;
		if (typeof document !== "undefined" && document.hidden) {
			// rAF berhenti saat tab hidden — pakai timer agar stream tetap jalan.
			timerRef.current = setTimeout(flush, 32);
		} else {
			rafRef.current = requestAnimationFrame(flush);
		}
	}, [flush]);

	const send = async (
		model: string,
		prompt: string,
		useStream = true,
		opts?: {
			history?: ChatTurn[];
			systemPrompt?: string;
			apiKey?: string;
		},
	) => {
		abortRef.current = new AbortController();
		setStreaming(true);
		setResponse("");
		setThinking("");
		setUsage(null);
		setError("");
		setDone(false);
		setTruncated(false);
		setAutoContinued(0);
		bufRef.current = "";
		thinkBufRef.current = "";

		const baseMessages = [
			...(opts?.systemPrompt
				? [{ role: "system" as const, content: opts.systemPrompt }]
				: []),
			...(opts?.history ?? []),
			{ role: "user" as const, content: prompt },
		];

		// Satu request stream → { sawDone, sawDisconnect, aborted, httpError }.
		// Delta diakumulasi ke bufRef (di-flush per frame) + accum lokal agar
		// resume tinggal menyambung tanpa me-reset response.
		const runOnce = async (
			messages: { role: string; content: string }[],
			accum: { text: string },
		): Promise<{ sawDone: boolean; sawDisconnect: boolean; aborted: boolean; httpError: string | null }> => {
			let sawDone = false;
			let sawDisconnect = false;
			try {
				const res = await fetch("/v1/chat/completions", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(opts?.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
					},
					body: JSON.stringify({ model, messages, stream: useStream }),
					signal: abortRef.current!.signal,
				});

				if (!res.ok) {
					const text = await res.text();
					flush();
					return { sawDone: false, sawDisconnect: false, aborted: false, httpError: text };
				}

				if (!useStream || !res.body) {
					const json = (await res.json()) as {
						choices?: {
							message?: {
								content?: string;
								reasoning_content?: string;
								reasoning?: string;
							};
						}[];
						usage?: Usage;
					};
					const full =
						json.choices?.[0]?.message?.content ?? JSON.stringify(json);
					accum.text += full;
					bufRef.current += full;
					thinkBufRef.current +=
						json.choices?.[0]?.message?.reasoning_content ??
						json.choices?.[0]?.message?.reasoning ??
						"";
					flush();
					setUsage(json.usage ?? null);
					return { sawDone: true, sawDisconnect: false, aborted: false, httpError: null };
				}

				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buf = "";
				for (;;) {
					const { done: readerDone, value } = await reader.read();
					if (readerDone) break;
					buf += decoder.decode(value, { stream: true });
					const lines = buf.split("\n");
					buf = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.startsWith("data:")) continue;
						const data = line.slice(5).trim();
						if (data === "[DONE]") {
							sawDone = true;
							break;
						}
						try {
							const parsed = JSON.parse(data) as {
								choices?: {
									delta?: {
										content?: string;
										reasoning_content?: string;
										reasoning?: string;
									};
								}[];
								error?: { code?: string; message?: string };
								usage?: Usage;
							};
							if (parsed.error?.code === "upstream_disconnect") {
								sawDisconnect = true;
								continue;
							}
							const delta = parsed.choices?.[0]?.delta?.content ?? "";
							if (delta) {
								accum.text += delta;
								bufRef.current += delta;
								schedule();
							}
							const think =
								parsed.choices?.[0]?.delta?.reasoning_content ??
								parsed.choices?.[0]?.delta?.reasoning ??
								"";
							if (think) {
								thinkBufRef.current += think;
								schedule();
							}
							if (parsed.usage) setUsage(parsed.usage);
						} catch {
							/* skip malformed */
						}
					}
					if (sawDone) break;
				}
				flush();
				return { sawDone, sawDisconnect, aborted: false, httpError: null };
			} catch (err) {
				flush();
				if (err instanceof DOMException && err.name === "AbortError") {
					return { sawDone: false, sawDisconnect: false, aborted: true, httpError: null };
				}
				// Network error tengah jalan = truncation bila sudah ada delta.
				return { sawDone: false, sawDisconnect: true, aborted: false, httpError: null };
			}
		};

		// Percobaan awal + auto-lanjut (model+provider SAMA — model string
		// tidak diubah, termasuk prefix provider bila ada). Resume memakai
		// trailing assistant prefill berisi potongan, tanpa mengulang output.
		const MAX_AUTO_CONTINUE = 2;
		let messages: { role: string; content: string }[] = baseMessages;
		const accum = { text: "" };
		let continued = 0;
		for (let attempt = 0; attempt <= MAX_AUTO_CONTINUE; attempt += 1) {
			const r = await runOnce(messages, accum);
			if (r.aborted) {
				setStreaming(false);
				setDone(true);
				return;
			}
			if (r.httpError) {
				setError(r.httpError);
				setStreaming(false);
				setDone(false);
				setTruncated(false);
				return;
			}
			if (r.sawDone) {
				flush();
				setStreaming(false);
				setDone(true);
				setTruncated(false);
				setAutoContinued(continued);
				return;
			}
			// Truncation: lanjut otomatis bila ada potongan & sisa kuota.
			if (accum.text.trim() !== "" && attempt < MAX_AUTO_CONTINUE) {
				continued += 1;
				setAutoContinued(continued);
				await new Promise((res) => setTimeout(res, 600 * 2 ** attempt));
				if (abortRef.current?.signal.aborted) {
					setStreaming(false);
					setDone(true);
					return;
				}
				messages = [
					...messages,
					{ role: "assistant", content: accum.text },
				];
				continue;
			}
			// Potongan habis / kosong: tandai truncated, response dipertahankan.
			flush();
			setStreaming(false);
			setDone(false);
			setTruncated(accum.text.trim() !== "");
			setAutoContinued(continued);
			if (accum.text.trim() === "") {
				setError(r.sawDisconnect ? "upstream_disconnect" : "stream terputus");
			}
			return;
		}
	};

	const stop = () => {
		abortRef.current?.abort();
	};

	return { response, thinking, usage, streaming, done, truncated, autoContinued, error, send, stop };
}
