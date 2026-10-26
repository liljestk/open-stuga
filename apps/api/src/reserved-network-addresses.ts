import { BlockList, isIP } from "node:net";

// Outbound endpoints that the operator configures (electricity prices, Tapo
// history) must not reach private, loopback, link-local, shared, benchmark,
// documentation, multicast or reserved networks. Node's BlockList also matches
// IPv4-mapped IPv6 forms such as ::ffff:10.0.0.1 against the IPv4 entries.
const RESERVED_NETWORK_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) RESERVED_NETWORK_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001:2::", 48],
  ["2001:10::", 28], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) RESERVED_NETWORK_ADDRESSES.addSubnet(network, prefix, "ipv6");

/** True for a literal IP address outside every reserved range; false for hostnames. */
export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  return family > 0 && !RESERVED_NETWORK_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}
