export function meta() {
  return [{ title: "Login" }];
}

export default function Login() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <form className="flex flex-col gap-3">
        <h1 className="text-xl font-bold">UniRoute</h1>
        <p>Login placeholder (Fase 4)</p>
        <input
          type="password"
          placeholder="Password"
          className="border border-gray-300 rounded px-3 py-2"
        />
        <button type="submit">Login</button>
      </form>
    </main>
  );
}