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
		bufRef.current = "";
		thinkBufRef.current = "";

		const messages = [
			...(opts?.systemPrompt
				? [{ role: "system" as const, content: opts.systemPrompt }]
				: []),
			...(opts?.history ?? []),
			{ role: "user" as const, content: prompt },
		];

		try {
			const res = await fetch("/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(opts?.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
				},
				body: JSON.stringify({ model, messages, stream: useStream }),
				signal: abortRef.current.signal,
			});

			if (!res.ok) {
				const text = await res.text();
				flush();
				setError(text);
				setStreaming(false);
				return;
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
				bufRef.current =
					json.choices?.[0]?.message?.content ?? JSON.stringify(json);
				thinkBufRef.current =
					json.choices?.[0]?.message?.reasoning_content ??
					json.choices?.[0]?.message?.reasoning ??
					"";
				flush();
				setUsage(json.usage ?? null);
				setDone(true);
				setStreaming(false);
				return;
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
						flush();
						setDone(true);
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
							usage?: Usage;
						};
						const delta = parsed.choices?.[0]?.delta?.content ?? "";
						if (delta) {
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
			}
			flush();
			setStreaming(false);
			setDone(true);
		} catch (err) {
			flush();
			if (err instanceof DOMException && err.name === "AbortError") {
				setStreaming(false);
				setDone(true);
				return;
			}
			setError(err instanceof Error ? err.message : String(err));
			setStreaming(false);
		}
	};

	const stop = () => {
		abortRef.current?.abort();
	};

	return { response, thinking, usage, streaming, done, error, send, stop };
}
