import { useRef, useState } from "react";

type Usage = {
	prompt_tokens?: number;
	completion_tokens?: number;
};

export function useStreaming() {
	const [response, setResponse] = useState("");
	const [usage, setUsage] = useState<Usage | null>(null);
	const [streaming, setStreaming] = useState(false);
	const [done, setDone] = useState(false);
	const [error, setError] = useState("");
	const abortRef = useRef<AbortController | null>(null);

	const send = async (
		model: string,
		prompt: string,
		stream: boolean,
		systemPrompt?: string,
		apiKey?: string,
	) => {
		abortRef.current = new AbortController();
		setStreaming(true);
		setResponse("");
		setUsage(null);
		setError("");
		setDone(false);

		try {
			const res = await fetch("/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				},
				body: JSON.stringify({
					model,
					messages: [
						...(systemPrompt
							? [{ role: "system" as const, content: systemPrompt }]
							: []),
						{ role: "user" as const, content: prompt },
					],
					stream,
				}),
				signal: abortRef.current.signal,
			});

			if (!res.ok) {
				const text = await res.text();
				setError(text);
				setStreaming(false);
				return;
			}

			if (!stream || !res.body) {
				const json = (await res.json()) as {
					choices?: { message?: { content?: string } }[];
					usage?: Usage;
				};
				setResponse(
					json.choices?.[0]?.message?.content ?? JSON.stringify(json),
				);
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
						setDone(true);
						break;
					}
					try {
						const parsed = JSON.parse(data) as {
							choices?: { delta?: { content?: string } }[];
							usage?: Usage;
						};
						const delta = parsed.choices?.[0]?.delta?.content ?? "";
						if (delta) setResponse((prev) => prev + delta);
						if (parsed.usage) setUsage(parsed.usage);
					} catch {
						/* skip malformed */
					}
				}
			}
			setStreaming(false);
			setDone(true);
		} catch (err) {
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

	return { response, usage, streaming, done, error, send, stop };
}
