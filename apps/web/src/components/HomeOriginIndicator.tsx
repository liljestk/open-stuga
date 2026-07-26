import { House as HouseIcon } from "lucide-react";
import type { House } from "@climate-twin/contracts";
import { StugubyMark } from "./StugubyMark";

export type HomeOriginScope = Pick<House, "stuguby">;

export function isRemoteHome(home: HomeOriginScope | undefined): boolean {
  return Boolean(
    home?.stuguby
    && home.stuguby.ownership === "shared"
    && home.stuguby.syncState !== "detached",
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
      {remote ? <StugubyMark className="home-origin-mark" /> : <HouseIcon size={13} aria-hidden="true" />}
      <span>{label}</span>
    </span>
  );
}
