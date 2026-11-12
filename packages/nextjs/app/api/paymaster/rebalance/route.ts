import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getPaymasterBalanceState, rebalancePaymasterAcross } from "~~/utils/recovery/paymasterRebalance";
import { rateLimit } from "~~/utils/recovery/rateLimit";
import { requireHex, requireObject } from "~~/utils/recovery/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// POST may bridge/sweep sequentially with receipt waits; give it the full Pro (non-Fluid) budget.
export const maxDuration = 300;

function mkLogPrefix(reqId: string) {
  return `[hwr.paymaster.rebalance ${reqId}]`;
}

function safeErr(e: any) {
  return {
    name: typeof e?.name === "string" ? e.name : null,
    code: e?.code ?? e?.cause?.code ?? null,
    shortMessage: typeof e?.shortMessage === "string" ? e.shortMessage : null,
    message: typeof e?.message === "string" ? e.message : String(e),
  };
}

export async function GET(req: Request) {
  const reqId = (() => {
    try {
      return randomUUID();
    } catch {
      return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    }
  })();
  const logp = mkLogPrefix(reqId);

  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const rl = rateLimit({ key: `paymaster.rebalance:get:${ip}`, limit: 30, windowMs: 60_000 });
    if (!rl.ok) return NextResponse.json({ error: "Rate limited" }, { status: 429 });

    const pk = process.env.PAYMASTER_PRIVATE_KEY;
    if (!pk) return NextResponse.json({ error: "Missing PAYMASTER_PRIVATE_KEY on server." }, { status: 500 });
    const paymasterAccount = privateKeyToAccount(requireHex(pk, "PAYMASTER_PRIVATE_KEY"));

    const chains = await getPaymasterBalanceState({
      paymasterAddress: paymasterAccount.address as Address,
    });

    return NextResponse.json(
      JSON.parse(
        JSON.stringify(
          {
            ok: chains.every(c => c.ok),
            paymaster: paymasterAccount.address,
            chains,
          },
          (_k, v) => (typeof v === "bigint" ? v.toString() : v),
        ),
      ),
    );
  } catch (e: any) {
    console.error(logp, "fatal", safeErr(e));
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bad request" }, { status: 400 });
  }
}

export async function POST(req: Request) {
  const reqId = (() => {
    try {
      return randomUUID();
    } catch {
      return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    }
  })();
  const logp = mkLogPrefix(reqId);

  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const rl = rateLimit({ key: `paymaster.rebalance:post:${ip}`, limit: 10, windowMs: 60_000 });
    if (!rl.ok) return NextResponse.json({ error: "Rate limited" }, { status: 429 });

    const body = requireObject(await req.json().catch(() => ({})));
    const execute = Boolean((body as any).execute);

    const pk = process.env.PAYMASTER_PRIVATE_KEY;
    if (!pk) return NextResponse.json({ error: "Missing PAYMASTER_PRIVATE_KEY on server." }, { status: 500 });
    const paymasterAccount = privateKeyToAccount(requireHex(pk, "PAYMASTER_PRIVATE_KEY"));
    const chainIdsOverride = Array.isArray((body as any).chainIds)
      ? (body as any).chainIds.map((x: any) => Number(x)).filter((x: any) => Number.isFinite(x))
      : undefined;

    const rebalance = await rebalancePaymasterAcross({
      paymasterAccount,
      execute,
      chainIds: chainIdsOverride,
    });
    return NextResponse.json(rebalance);
  } catch (e: any) {
    console.error(logp, "fatal", safeErr(e));
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bad request" }, { status: 400 });
  }
}
