import { useBreath } from "./breath.js";

/** The breathing dot before a working card's status word. */
export function LiveDot() {
  const breath = useBreath();
  return <span className="live-dot" style={breath} aria-hidden="true" />;
}
