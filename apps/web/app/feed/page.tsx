import { redirect } from "next/navigation";

// The feed now lives on the home page.
export default function Feed() {
  redirect("/");
}
