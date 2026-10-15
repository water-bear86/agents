"use client";
import { usePathname } from "next/navigation";

const links = [
  ["/", "Live"],
  ["/world", "World"],
  ["/leaderboard", "Rankings"],
  ["/create", "Create"],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {links.map(([href, label]) => (
        <a key={href} href={href} aria-current={(href === "/" ? path === "/" : path.startsWith(href)) ? "page" : undefined}>{label}</a>
      ))}
    </nav>
  );
}
