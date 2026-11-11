import { NextResponse } from "next/server";
import { mkLogger, mkReqId, safeErr } from "~~/utils/recovery/logger";
import { rateLimit } from "~~/utils/recovery/rateLimit";
import { requireAddress, requireObject } from "~~/utils/recovery/validation";
import { fetchZerionScanData } from "~~/utils/recovery/zerion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const reqId = mkReqId();
  const log = mkLogger("scan", reqId);
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const rl = rateLimit({ key: `scan:${ip}`, limit: 20, windowMs: 60_000 });
    if (!rl.ok) {
      log.warn("rate limited");
      return NextResponse.json({ error: "Rate limited", reqId }, { status: 429 });
    }

    const body = requireObject(await req.json().catch(() => ({})));
    const compromisedAddress = requireAddress(body.compromisedAddress, "compromisedAddress");
    const chainIds = Array.isArray(body.chainIds)
      ? body.chainIds.filter((x): x is number => typeof x === "number")
      : undefined;

    log.info("request", { compromisedAddress, chainIds: chainIds ?? "all" });

    const { assets, positionsView, nfts } = await fetchZerionScanData({ compromisedAddress, chainIds });

    log.info("scan ok", {
      compromisedAddress,
      assetsCount: Array.isArray(assets) ? assets.length : null,
      nftsCount: Array.isArray(nfts) ? nfts.length : null,
    });

    return NextResponse.json({
      compromisedAddress,
      assets,
      positionsView,
      nfts,
      manualSchema: {
        standard: ["erc20", "erc721", "erc1155"],
        fields: ["chainId", "standard", "contract", "tokenId?", "amount?"],
        notes: "For MVP, amounts/tokenIds are treated as raw integer strings. Use manual add for local assets.",
      },
    });
  } catch (e) {
    const se = safeErr(e);
    log.error("fatal", se);
    const message = e instanceof Error ? e.message : "Bad request";
    const name = e instanceof Error ? e.name : "";
    const status =
      name === "TimeoutError" || name === "AbortError" ? 504 : /^Zerion .* error \d+/.test(message) ? 502 : 400;
    return NextResponse.json({ error: message, reqId }, { status });
  }
}
