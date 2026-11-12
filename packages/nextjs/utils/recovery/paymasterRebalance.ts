import type { Account, Address, Hex } from "viem";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther } from "viem";
import scaffoldConfig from "~~/scaffold.config";
import { jsonSafe } from "~~/utils/recovery/jsonSafe";
import { requireAddress } from "~~/utils/recovery/validation";
import { getChain, getRpcUrl, getViemFallbackRpcUrl } from "~~/utils/recovery/viemServer";

const SPOKEPOOL_V3_ABI = parseAbi([
  "function depositV3(address depositor,address recipient,address inputToken,address outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,address exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message) payable",
]);

// Important: Node fetch has no default timeout; one bad/slow RPC can hang the whole endpoint.
const RPC_TIMEOUT_MS = 10_000;

const DEFAULT_ACROSS_API_BASE = "https://app.across.to/api";

function acrossApiBase(): string {
  return (process.env.ACROSS_API_BASE || DEFAULT_ACROSS_API_BASE).replace(/\/+$/, "");
}

function httpTransport(rpcUrl: string) {
  // viem http transport supports `timeout` but types can lag behind across versions.
  return http(rpcUrl, { timeout: RPC_TIMEOUT_MS } as any);
}

async function rpcJson<T>(rpcUrl: string, body: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`RPC returned non-JSON (${res.status}): ${text.slice(0, 80)}`);
    }
    if (!res.ok) {
      throw new Error(`RPC HTTP ${res.status}: ${JSON.stringify(json)?.slice?.(0, 200) ?? ""}`);
    }
    return json as T;
  } finally {
    clearTimeout(t);
  }
}

async function rpcGetBalanceWei(rpcUrl: string, address: Address): Promise<bigint> {
  const json = await rpcJson<any>(
    rpcUrl,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [address, "latest"],
    },
    RPC_TIMEOUT_MS,
  );
  if (json?.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  const result = json?.result;
  if (typeof result !== "string" || !result.startsWith("0x")) throw new Error("RPC missing result");
  return BigInt(result);
}

async function acrossGet(path: string, params: Record<string, string>) {
  const base = acrossApiBase();
  const url = new URL(`${base}${path.startsWith("/") ? "" : "/"}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  // Keep the abort timer alive through the body read, not just the headers.
  const { res, text } = await (async () => {
    const res = await fetch(url.toString(), { method: "GET", signal: controller.signal });
    return { res, text: await res.text() };
  })().finally(() => clearTimeout(t));
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = typeof json?.message === "string" ? json.message : text || `HTTP ${res.status}`;
    throw new Error(`Across GET ${path} failed: ${msg}`);
  }
  return json;
}

async function getAcrossNativeRoute(params: {
  originChainId: number;
  destinationChainId: number;
}): Promise<{ originToken: Address; destinationToken: Address }> {
  const routes = (await acrossGet("/available-routes", {
    originChainId: String(params.originChainId),
    destinationChainId: String(params.destinationChainId),
  })) as any[];
  const match = (Array.isArray(routes) ? routes : []).find(r => r && r.isNative === true);
  const originToken = requireAddress(match?.originToken, "across.available-routes.originToken");
  const destinationToken = requireAddress(match?.destinationToken, "across.available-routes.destinationToken");
  return { originToken, destinationToken };
}

async function getAcrossSuggestedFees(params: {
  originChainId: number;
  destinationChainId: number;
  inputToken: Address;
  outputToken: Address;
  amount: bigint;
  recipient: Address;
}) {
  return await acrossGet("/suggested-fees", {
    inputToken: params.inputToken,
    outputToken: params.outputToken,
    originChainId: String(params.originChainId),
    destinationChainId: String(params.destinationChainId),
    amount: params.amount.toString(),
    recipient: params.recipient,
  });
}

function parseBigintFromUnknown(v: unknown): bigint | null {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.floor(v));
    if (typeof v === "string" && v.trim()) return BigInt(v.trim());
    return null;
  } catch {
    return null;
  }
}

function parseTargetsWei(): { defaultTargetWei: bigint; perChainTargetWei: Record<number, bigint> } {
  const perChainTargetWei: Record<number, bigint> = {};

  const defaultWeiRaw = process.env.PAYMASTER_TARGET_WEI;
  const defaultEthRaw = process.env.PAYMASTER_TARGET_ETH;
  const defaultTargetWei =
    (defaultWeiRaw && defaultWeiRaw.trim() ? parseBigintFromUnknown(defaultWeiRaw) : null) ??
    (defaultEthRaw && defaultEthRaw.trim() ? parseEther(defaultEthRaw.trim() as `${number}`) : null);

  if (typeof defaultTargetWei !== "bigint" || defaultTargetWei < 0n) {
    throw new Error("Missing/invalid PAYMASTER_TARGET_WEI or PAYMASTER_TARGET_ETH on server.");
  }

  const weiJsonRaw = process.env.PAYMASTER_TARGETS_WEI_JSON;
  const ethJsonRaw = process.env.PAYMASTER_TARGETS_ETH_JSON;

  const applyJson = (raw: string, kind: "wei" | "eth") => {
    let obj: any = null;
    // Strip surrounding matching quotes: hosting dashboards (unlike dotenv) don't
    // strip the quotes shown in .env.example, so the literal value can be `'{...}'`.
    let text = raw.trim();
    if (
      text.length >= 2 &&
      ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))
    ) {
      text = text.slice(1, -1).trim();
    }
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON in PAYMASTER_TARGETS_${kind.toUpperCase()}_JSON`);
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error(`Expected JSON object in PAYMASTER_TARGETS_${kind.toUpperCase()}_JSON`);
    }
    for (const [k, v] of Object.entries(obj)) {
      const chainId = Number(k);
      if (!Number.isFinite(chainId)) continue;
      const target =
        kind === "wei"
          ? parseBigintFromUnknown(v)
          : typeof v === "string" && v.trim()
            ? parseEther(v.trim() as `${number}`)
            : null;
      if (typeof target === "bigint" && target >= 0n) perChainTargetWei[chainId] = target;
    }
  };

  if (typeof ethJsonRaw === "string" && ethJsonRaw.trim()) applyJson(ethJsonRaw, "eth");
  if (typeof weiJsonRaw === "string" && weiJsonRaw.trim()) applyJson(weiJsonRaw, "wei");

  return { defaultTargetWei, perChainTargetWei };
}

function getSupportedChainIds(): number[] {
  return (scaffoldConfig.targetNetworks ?? [])
    .map(n => n.id)
    .filter((id): id is number => typeof id === "number" && Number.isFinite(id))
    .sort((a, b) => a - b);
}

function safeErr(e: any) {
  return {
    name: typeof e?.name === "string" ? e.name : null,
    code: e?.code ?? e?.cause?.code ?? null,
    shortMessage: typeof e?.shortMessage === "string" ? e.shortMessage : null,
    message: typeof e?.message === "string" ? e.message : String(e),
  };
}

export async function getPaymasterBalanceState(params: { paymasterAddress: Address; chainIds?: number[] }): Promise<
  Array<{
    chainId: number;
    rpcUrl: string;
    ok: boolean;
    balanceWei: bigint | null;
    targetWei: bigint;
    minWei: bigint;
    belowMin: boolean | null;
    error?: any;
  }>
> {
  const { defaultTargetWei, perChainTargetWei } = parseTargetsWei();
  const chainIds = (params.chainIds?.length ? params.chainIds : getSupportedChainIds()).sort((a, b) => a - b);

  return await Promise.all(
    chainIds.map(async chainId => {
      const targetWei = perChainTargetWei[chainId] ?? defaultTargetWei;
      const minWei = targetWei / 4n; // minimum is 1/4 target
      const primaryRpcUrl = getRpcUrl(chainId);

      const tryRead = async (rpcUrl: string) => {
        // Use direct JSON-RPC instead of a client to guarantee timeout behavior.
        return await rpcGetBalanceWei(rpcUrl, params.paymasterAddress);
      };

      try {
        const balanceWei = await tryRead(primaryRpcUrl);
        return {
          chainId,
          rpcUrl: primaryRpcUrl,
          ok: true,
          balanceWei,
          targetWei,
          minWei,
          belowMin: balanceWei < minWei,
        };
      } catch (e: any) {
        const msg = String(e?.message ?? "");
        const shouldFallback = primaryRpcUrl.includes("alchemy.com") || /is not valid JSON|Unexpected token/i.test(msg);
        const fallbackRpcUrl = shouldFallback ? getViemFallbackRpcUrl(chainId) : null;
        if (fallbackRpcUrl && fallbackRpcUrl !== primaryRpcUrl) {
          try {
            const balanceWei = await tryRead(fallbackRpcUrl);
            return {
              chainId,
              rpcUrl: fallbackRpcUrl,
              ok: true,
              balanceWei,
              targetWei,
              minWei,
              belowMin: balanceWei < minWei,
            };
          } catch (e2: any) {
            return {
              chainId,
              rpcUrl: fallbackRpcUrl,
              ok: false,
              balanceWei: null,
              targetWei,
              minWei,
              belowMin: null,
              error: safeErr(e2),
            };
          }
        }
        return {
          chainId,
          rpcUrl: primaryRpcUrl,
          ok: false,
          balanceWei: null,
          targetWei,
          minWei,
          belowMin: null,
          error: safeErr(e),
        };
      }
    }),
  );
}

export async function rebalancePaymasterAcross(params: {
  paymasterAccount: Account;
  execute: boolean;
  chainIds?: number[];
}) {
  const sweepTo = process.env.PAYMASTER_SWEEP_ADDRESS;
  if (!sweepTo) throw new Error("Missing PAYMASTER_SWEEP_ADDRESS on server.");
  const sweepAddress = requireAddress(sweepTo, "PAYMASTER_SWEEP_ADDRESS");

  const chainIds = (params.chainIds?.length ? params.chainIds : getSupportedChainIds()).sort((a, b) => a - b);

  const gasBufferBpsRaw = process.env.PAYMASTER_SWEEP_GAS_BUFFER_BPS;
  const gasBufferBps = (() => {
    const n = gasBufferBpsRaw && gasBufferBpsRaw.trim() ? Number(gasBufferBpsRaw) : 2000; // +20%
    if (!Number.isFinite(n) || n < 0) return 2000;
    return Math.floor(n);
  })();

  const maxBridgeOpsRaw = process.env.PAYMASTER_REBALANCE_MAX_BRIDGES;
  const maxBridgeOps =
    maxBridgeOpsRaw && maxBridgeOpsRaw.trim() ? Math.max(0, Math.min(25, Number(maxBridgeOpsRaw))) : 10;

  const results: Record<number, any> = {};
  const bridges: any[] = [];

  const state = await getPaymasterBalanceState({
    paymasterAddress: params.paymasterAccount.address as Address,
    chainIds,
  });
  const stateOk = state.filter(s => s.ok && typeof s.balanceWei === "bigint") as Array<
    Omit<(typeof state)[number], "balanceWei" | "belowMin"> & { balanceWei: bigint; belowMin: boolean }
  >;

  // Bridge only when a chain falls below min; top up to target.
  if (params.execute) {
    let ops = 0;
    while (ops < maxBridgeOps) {
      const deficits = stateOk
        .filter(s => s.belowMin)
        .map(s => ({ ...s, needWei: s.targetWei - s.balanceWei }))
        .filter(s => s.needWei > 0n)
        .sort((a, b) => (a.needWei > b.needWei ? -1 : a.needWei < b.needWei ? 1 : 0));
      const dst = deficits[0];
      if (!dst) break;

      const sources = stateOk
        .map(s => {
          // Source must remain above its own minimum after contributing.
          const reserveWei = s.minWei;
          const availWei = s.balanceWei > reserveWei ? s.balanceWei - reserveWei : 0n;
          return { ...s, reserveWei, availWei };
        })
        .filter(s => s.chainId !== dst.chainId && s.availWei > 0n)
        .sort((a, b) => (a.availWei > b.availWei ? -1 : a.availWei < b.availWei ? 1 : 0));
      const src = sources[0];
      if (!src) break;

      const amountWei = dst.needWei <= src.availWei ? dst.needWei : src.availWei;
      if (amountWei <= 0n) break;

      const srcChain = getChain(src.chainId, src.rpcUrl);
      const srcPublic = createPublicClient({ chain: srcChain, transport: httpTransport(src.rpcUrl) });
      const srcWallet = createWalletClient({
        chain: srcChain,
        transport: httpTransport(src.rpcUrl),
        account: params.paymasterAccount,
      });

      const route = await getAcrossNativeRoute({ originChainId: src.chainId, destinationChainId: dst.chainId });
      const fees = await getAcrossSuggestedFees({
        originChainId: src.chainId,
        destinationChainId: dst.chainId,
        inputToken: route.originToken,
        outputToken: route.destinationToken,
        amount: amountWei,
        recipient: params.paymasterAccount.address as Address,
      });

      const spokePoolAddress = requireAddress(fees?.spokePoolAddress, "across.suggested-fees.spokePoolAddress");
      const outputAmount = BigInt(String(fees?.outputAmount));
      const exclusiveRelayer =
        fees?.exclusiveRelayer && String(fees.exclusiveRelayer) !== "0x0000000000000000000000000000000000000000"
          ? requireAddress(fees.exclusiveRelayer, "across.suggested-fees.exclusiveRelayer")
          : ("0x0000000000000000000000000000000000000000" as Address);
      const quoteTimestamp = Number(fees?.timestamp);
      const fillDeadline = Number(fees?.fillDeadline);
      const exclusivityDeadline = Number(fees?.exclusivityDeadline ?? 0);

      if (!Number.isFinite(quoteTimestamp) || !Number.isFinite(fillDeadline) || outputAmount <= 0n) {
        throw new Error("Across suggested-fees response missing timestamp/fillDeadline/outputAmount");
      }

      const depositTxHash = (await srcWallet.writeContract({
        address: spokePoolAddress,
        abi: SPOKEPOOL_V3_ABI,
        functionName: "depositV3",
        args: [
          params.paymasterAccount.address as Address,
          params.paymasterAccount.address as Address,
          route.originToken,
          route.destinationToken,
          amountWei,
          outputAmount,
          BigInt(dst.chainId),
          exclusiveRelayer,
          quoteTimestamp as any,
          fillDeadline as any,
          exclusivityDeadline as any,
          "0x",
        ],
        value: amountWei,
      })) as Hex;
      await srcPublic.waitForTransactionReceipt({ hash: depositTxHash, timeout: 60_000 });

      let status: any = null;
      try {
        status = await acrossGet("/deposit/status", { depositTxnRef: depositTxHash });
      } catch {
        status = null;
      }

      bridges.push(
        jsonSafe({
          fromChainId: src.chainId,
          toChainId: dst.chainId,
          amountWei,
          outputAmount,
          spokePoolAddress,
          depositTxHash,
          status,
        }),
      );

      // Update local state (best-effort).
      const srcIdx = stateOk.findIndex(s => s.chainId === src.chainId);
      const dstIdx = stateOk.findIndex(s => s.chainId === dst.chainId);
      if (srcIdx >= 0) stateOk[srcIdx].balanceWei -= amountWei;
      if (dstIdx >= 0) stateOk[dstIdx].balanceWei += outputAmount;
      if (srcIdx >= 0) stateOk[srcIdx].belowMin = stateOk[srcIdx].balanceWei < stateOk[srcIdx].minWei;
      if (dstIdx >= 0) stateOk[dstIdx].belowMin = stateOk[dstIdx].balanceWei < stateOk[dstIdx].minWei;

      ops += 1;
    }
  }

  // Sweep: intentionally loose. Only sweep if meaningfully above target+buffer.
  for (const s of stateOk) {
    try {
      const chain = getChain(s.chainId, s.rpcUrl);
      const publicClient = createPublicClient({ chain, transport: httpTransport(s.rpcUrl) });
      const paymasterWallet = createWalletClient({
        chain,
        transport: httpTransport(s.rpcUrl),
        account: params.paymasterAccount,
      });

      const balanceBeforeWei = await publicClient.getBalance({ address: params.paymasterAccount.address as Address });
      const targetWei = s.targetWei;
      const sweepBufferWei = targetWei / 20n; // 5% buffer above target

      let sweepTxHash: Hex | null = null;
      if (balanceBeforeWei > targetWei) {
        const fees = await publicClient.estimateFeesPerGas().catch(() => null);
        const maxFeePerGas = fees?.maxFeePerGas ?? (await publicClient.getGasPrice());
        const maxPriorityFeePerGas = fees?.maxPriorityFeePerGas ?? 0n;
        const gas = 21_000n;
        const txCost = (gas * maxFeePerGas * BigInt(10_000 + gasBufferBps)) / 10_000n;

        const sweepToWei = targetWei + sweepBufferWei;
        const maxSweepValue = balanceBeforeWei > sweepToWei + txCost ? balanceBeforeWei - sweepToWei - txCost : 0n;
        // Extra dust guard: don't sweep unless it's at least 5% of target.
        const dustMinWei = targetWei / 20n;

        if (maxSweepValue > dustMinWei && params.execute) {
          sweepTxHash = await paymasterWallet.sendTransaction({
            to: sweepAddress,
            value: maxSweepValue,
            gas,
            maxFeePerGas,
            maxPriorityFeePerGas,
          });
          await publicClient.waitForTransactionReceipt({ hash: sweepTxHash, timeout: 60_000 });
        }
      }

      const balanceAfterWei = await publicClient.getBalance({ address: params.paymasterAccount.address as Address });
      results[s.chainId] = jsonSafe({
        ok: true,
        chainId: s.chainId,
        rpcUrl: s.rpcUrl,
        paymaster: params.paymasterAccount.address,
        sweepAddress,
        execute: params.execute,
        targetWei,
        minWei: s.minWei,
        balanceBeforeWei,
        balanceAfterWei,
        sweepTxHash,
      });
    } catch (e: any) {
      results[s.chainId] = { ok: false, chainId: s.chainId, error: safeErr(e) };
    }
  }

  return jsonSafe({
    ok: state.every(s => s.ok) && Object.values(results).every((r: any) => r?.ok),
    paymaster: params.paymasterAccount.address,
    sweepAddress,
    balances: state,
    bridges,
    results,
  });
}
