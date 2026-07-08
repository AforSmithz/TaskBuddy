"use client";

import { useEffect } from "react";

/**
 * Stamps the browser's LOCAL "now" (calendar day + minutes since local midnight) into the
 * `tb_local_now` cookie so the server's rolling-horizon read/roll paths can sharpen the intra-day
 * frozen zone (S3c-4). This is the S2 timezone-gotcha resolution: the client knows its own offset,
 * so it captures local time here rather than letting the server re-derive it from a UTC instant
 * (which would be wrong by the user's offset). Renders nothing.
 *
 * Refreshed on mount and each minute so `minutesSinceMidnight` stays current and the zone
 * re-freezes across midnight: a stale / next-day cookie fails the server's `date !== anchor` guard
 * and falls back to date-granular churn (byte-identical to S3c-1). The cookie is a plain,
 * non-sensitive timing hint (`SameSite=Lax`, short `Max-Age`, not `httpOnly` so the client can
 * write it); it never carries a probability. The first server render of a session predates this
 * write and is date-granular (no-regret); every later navigation / mutation reads the fresh value.
 */
export function LocalNowBeacon() {
  useEffect(() => {
    const write = () => {
      const now = new Date();
      const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
      const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const minutes = now.getHours() * 60 + now.getMinutes();
      document.cookie = `tb_local_now=${date}|${minutes}; path=/; max-age=7200; samesite=lax`;
    };
    write();
    const id = setInterval(write, 60_000);
    return () => clearInterval(id);
  }, []);
  return null;
}
