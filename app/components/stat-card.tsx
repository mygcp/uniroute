type Props = {
  title: string;
  value: string | number;
  suffix?: string;
  accent?: string;
};

export function StatCard({ title, value, suffix, accent = "bg-blue-600" }: Props) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className={`mb-3 h-1 w-10 rounded-full ${accent}`} />
      <p className="text-sm text-gray-500 dark:text-gray-400">{title}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
        {value}
        {suffix ? <span className="ml-1 text-sm font-medium text-gray-400">{suffix}</span> : null}
      </p>
    </div>
  );
}