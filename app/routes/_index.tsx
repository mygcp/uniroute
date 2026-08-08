import { redirect } from "react-router";
import type { Route } from "./+types/_index";

export function loader() {
  return redirect("/home");
}

export default function Index() {
  return null;
}