type Props = {
  content: string;
  streaming: boolean;
  done: boolean;
  error: string;
};

export function StreamingResponse({ content, streaming, done, error }: Props) {
  return (
    <div className="min-h-[200px] rounded-lg bg-gray-50 p-4">
      {error ? (
        <pre className="whitespace-pre-wrap text-sm text-red-600">{error}</pre>
      ) : content ? (
        <>
          <p className="whitespace-pre-wrap text-sm text-gray-800">{content}</p>
          {streaming ? (
            <span className="mt-1 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
          ) : null}
        </>
      ) : (
        <p className="text-sm text-gray-400">
          {streaming ? "Streaming..." : "Response akan tampil di sini."}
        </p>
      )}
      {done && !error ? (
        <p className="mt-2 text-xs text-green-600">Selesai.</p>
      ) : null}
    </div>
  );
}