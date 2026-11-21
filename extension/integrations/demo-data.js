// Demo props. This file exists so that everything fake lives in one place.
//
// The browser cannot read the Wi-Fi SSID. When the native helper is not
// installed (or when we are on stage and it misbehaves), the panel uses these
// names so the switch flow still shows a before/after. Never used when the
// helper answers.

export const DEMO_NETWORKS = ["freewifi-epfl", "iPhone di Tommaso"];

// Applied once after a simulated switch, so the comparison badge is visible.
export const DEMO_SPEED_BOOST = 2.2;

export function nextDemoNetwork(current) {
  const index = DEMO_NETWORKS.indexOf(current);
  return DEMO_NETWORKS[(index + 1) % DEMO_NETWORKS.length];
}
