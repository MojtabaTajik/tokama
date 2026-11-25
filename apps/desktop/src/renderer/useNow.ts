// The time now, moved on every second while `active`: for live timers. Still while not active, so
// a finished item's screen does not render again for nothing.
import { useEffect, useState } from "react";

export function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
