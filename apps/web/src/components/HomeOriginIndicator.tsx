import { House as HouseIcon } from "lucide-react";
import type { House } from "@climate-twin/contracts";
import { StugbyMark } from "./StugbyMark";

export type HomeOriginScope = Pick<House, "stugby">;

export function isRemoteHome(home: HomeOriginScope | undefined): boolean {
  return Boolean(
    home?.stugby
    && home.stugby.ownership === "shared"
    && home.stugby.syncState !== "detached",
  );
}

export function HomeOriginIndicator({
  home,
  label,
}: {
  home: HomeOriginScope;
  label: string;
}) {
  const remote = isRemoteHome(home);
  return (
    <span className={`home-origin-indicator ${remote ? "remote" : "own"}`}>
      {remote ? <StugbyMark className="home-origin-mark" /> : <HouseIcon size={13} aria-hidden="true" />}
      <span>{label}</span>
    </span>
  );
}
