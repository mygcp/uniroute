import { Outlet } from "react-router";

export function meta() {
  return [{ title: "Logs — UniRoute" }];
}

export default function Logs() {
  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">Logs</h1>
      <Outlet />
    </div>
  );
}