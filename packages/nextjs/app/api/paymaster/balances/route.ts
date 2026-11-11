import { NextResponse } from "next/server";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getPaymasterBalanceState } from "~~/utils/recovery/paymasterRebalance";
import { rateLimit } from "~~/utils/recovery/rateLimit";
import { requireHex } from "~~/utils/recovery/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const rl = rateLimit({ key: `paymaster.balances:get:${ip}`, limit: 60, windowMs: 60_000 });
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
    const message = e instanceof Error ? e.message : "Bad request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
