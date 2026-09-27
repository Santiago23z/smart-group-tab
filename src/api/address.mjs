// Which address to put in the QR a diner scans.
//
// Whatever address the phone opens is the one Wompi sends it back to after
// paying, and Wompi's firewall refuses the whole checkout when that address is
// an IP. The machine's mDNS name (`<name>.local`, what macOS reports) reaches
// the same server from any phone on the network and is accepted. A bare host
// name is not used: without mDNS behind it, a phone cannot resolve it.
export function reachableHost(hostname, lanIp) {
  return /\.local$/i.test(hostname ?? '') ? hostname : lanIp
}
