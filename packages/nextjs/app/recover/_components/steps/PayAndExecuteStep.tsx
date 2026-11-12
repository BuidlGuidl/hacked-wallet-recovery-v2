"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import type { AuthorizationsByChainId } from "../authorizations";
import type { RecoveryAsset } from "../types";
import { Address, AddressInput, EtherInput } from "@scaffold-ui/components";
import type { Address as AddressType, Hex } from "viem";
import { encodeFunctionData, formatEther, formatUnits, getAddress, parseAbi, parseEther } from "viem";
import * as viemChains from "viem/chains";
import { useAccount, useSendTransaction, useSwitchChain, useWaitForTransactionReceipt } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { enabledChains } from "~~/services/web3/wagmiConfig";
import { wagmiConfig } from "~~/services/web3/wagmiConfig";
import { tryGetDelegateForChain } from "~~/utils/recovery/calls";
import { safeJsonStringify } from "~~/utils/recovery/jsonSafe";
import { sign7702Authorization } from "~~/utils/recovery/viem7702";
import type { ZerionNftView, ZerionPositionsView, ZerionPositionsViewRow } from "~~/utils/recovery/zerion";
import { type ChainWithAttributes, NETWORKS_EXTRA_DATA, getTargetNetworkById } from "~~/utils/scaffold-eth/networks";

function chainIconSrc(chainId: number): string {
  return `/chains/${chainId}.svg`;
}

function asBigInt(v: unknown): bigint | null {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.floor(v));
    if (typeof v === "string" && v.trim()) return BigInt(v);
    return null;
  } catch {
    return null;
  }
}

const viemChainsById = (() => {
  const m = new Map<number, viemChains.Chain>();
  for (const v of Object.values(viemChains)) {
    if (v && typeof v === "object" && "id" in v) m.set((v as viemChains.Chain).id, v as viemChains.Chain);
  }
  return m;
})();

function chainWithAttributes(chainId: number): ChainWithAttributes | null {
  const base = viemChainsById.get(chainId);
  if (!base) return null;
  return { ...base, ...(NETWORKS_EXTRA_DATA[chainId] ?? {}) };
}

function fmtUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function usdFromMicros(v: unknown): number | null {
  try {
    if (typeof v === "number" && Number.isFinite(v)) return v / 1_000_000;
    if (typeof v === "bigint") return Number(v) / 1_000_000;
    if (typeof v === "string" && v.trim()) return Number(BigInt(v)) / 1_000_000;
    return null;
  } catch {
    return null;
  }
}

function fmtTokenAmount(amount: number | null, symbol: string): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const abs = Math.abs(amount);
  const digits = abs >= 1 ? 4 : abs >= 0.01 ? 6 : abs >= 0.0001 ? 8 : 12;
  return `${amount.toFixed(digits)} ${symbol}`;
}

function isPaymasterFundingError(msg: string | null | undefined): boolean {
  if (typeof msg !== "string") return false;
  return Boolean(
    /paymaster has 0 balance|cannot sponsor transactions|insufficient funds|sender does not have enough funds|funds for gas/i.test(
      msg,
    ),
  );
}

type PaymentAssetChoice =
  | { kind: "native"; symbol?: string; valueUsd?: number | null }
  | { kind: "erc20"; address: AddressType; symbol?: string; name?: string; valueUsd?: number | null };

type ZerionScanResponse = {
  positionsView: {
    groups: Array<{
      rows: Array<{
        chainId?: number;
        standard?: "native" | "erc20";
        kind?: "wallet" | "deposit" | "loan" | "reward" | "other";
        isVerified?: boolean;
        tokenSymbol?: string;
        tokenName?: string;
        tokenIconUrl?: string;
        contract?: AddressType;
        valueUsd?: number;
      }>;
    }>;
  } | null;
};

type PayableNetworkOption = {
  chainId: number;
  chainName: string;
  asset: PaymentAssetChoice;
};

type PaymentMatrixRow = {
  key: string;
  symbol: string;
  name?: string;
  kind: "native" | "erc20";
  iconUrl?: string;
  balanceUsd: number;
  networks: PayableNetworkOption[];
};

export function PayAndExecuteStep(props: {
  compromisedAddress: AddressType;
  compromisedPrivateKey: Hex;
  assets: RecoveryAsset[];
  positionsView: ZerionPositionsView | null;
  nfts: ZerionNftView[];
  quote: any;
  onQuote: (quote: any) => void;
  onExecute: (result: { result: any; executedAssets: RecoveryAsset[] }) => void;
  onBack: () => void;
}) {
  const { address: connected, chain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const DEFAULT_REFILL_WEI = useMemo(() => parseEther("0.001"), []);
  const REFILL_MIN_BUFFER_WEI = useMemo(() => parseEther("0.00001"), []);

  const [stage, setStage] = useState<"destination" | "pay">("destination");
  const [paymentAssetChoice, setPaymentAssetChoice] = useState<PaymentAssetChoice>({
    kind: "native",
    symbol: chain?.nativeCurrency?.symbol,
  });
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [paymentModalBusy, setPaymentModalBusy] = useState(false);
  const [paymentModalError, setPaymentModalError] = useState<string | null>(null);
  const [paymentMatrixRows, setPaymentMatrixRows] = useState<PaymentMatrixRow[]>([]);
  const paymentMatrixLoadSeqRef = useRef(0);

  const [recoveryAddressInput, setRecoveryAddressInput] = useState<string>(connected ?? "");
  const [recoveryAddressEdited, setRecoveryAddressEdited] = useState(false);
  useEffect(() => {
    if (recoveryAddressEdited) return;
    setRecoveryAddressInput(connected ?? "");
  }, [connected, recoveryAddressEdited]);

  const recoveryAddress = useMemo(() => {
    try {
      return recoveryAddressInput?.trim() ? (getAddress(recoveryAddressInput.trim()) as AddressType) : undefined;
    } catch {
      return undefined;
    }
  }, [recoveryAddressInput]);

  const selectedChainIds = useMemo(() => {
    const ids = new Set<number>();
    for (const a of props.assets) ids.add(a.chainId);
    return Array.from(ids).sort((a, b) => a - b);
  }, [props.assets]);

  const signAuthorizations = async (chainIdsOverride?: number[]): Promise<AuthorizationsByChainId> => {
    const chainIdsToSign = Array.isArray(chainIdsOverride) ? chainIdsOverride : selectedChainIds;
    const results = await Promise.all(
      chainIdsToSign.map(async chainId => {
        const delegateAddress = tryGetDelegateForChain(chainId)?.address;
        if (!delegateAddress)
          throw new Error(`UniversalRecoveryDelegate address not configured for chainId=${chainId}.`);
        const publicClient = getPublicClient(wagmiConfig as any, { chainId });
        if (!publicClient) throw new Error(`No public client available for chainId=${chainId}.`);
        const nonce = Number(
          await publicClient.getTransactionCount({ address: props.compromisedAddress, blockTag: "pending" }),
        );
        const signed = (await sign7702Authorization({
          privateKey: props.compromisedPrivateKey,
          chainId,
          nonce,
          contractAddress: delegateAddress,
        })) as any;

        const vBig = typeof signed.v === "string" ? BigInt(signed.v) : BigInt(signed.v);
        const yParityBig =
          typeof signed.yParity !== "undefined"
            ? typeof signed.yParity === "string"
              ? BigInt(signed.yParity)
              : BigInt(signed.yParity)
            : vBig === 27n || vBig === 28n
              ? vBig - 27n
              : vBig;
        if (yParityBig !== 0n && yParityBig !== 1n) {
          throw new Error(
            `Invalid signature parity for chainId=${chainId}. Expected yParity 0/1, got ${yParityBig.toString()}`,
          );
        }

        return [
          chainId,
          {
            address: signed.address,
            chainId: signed.chainId,
            nonce: signed.nonce,
            r: signed.r,
            s: signed.s,
            yParity: Number(yParityBig) as 0 | 1,
            v: vBig,
          },
        ] as const;
      }),
    );
    return Object.fromEntries(results);
  };

  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const fetchQuote = async (opts?: {
    paymentChainId?: number;
    paymentAsset?: PaymentAssetChoice;
  }): Promise<any | null> => {
    if (!recoveryAddress) return null;
    setQuoteBusy(true);
    setQuoteError(null);
    try {
      const auths = await signAuthorizations();
      const paymentAssetToUse = opts?.paymentAsset ?? paymentAssetChoice;
      const paymentChainIdToUse = typeof opts?.paymentChainId === "number" ? opts.paymentChainId : chain?.id;
      const res = await fetch("/api/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: safeJsonStringify({
          safeAddress: recoveryAddress,
          assets: props.assets,
          authorizationsByChainId: auths,
          paymentChainId: paymentChainIdToUse,
          paymentAsset:
            paymentAssetToUse.kind === "erc20"
              ? { kind: "erc20", address: paymentAssetToUse.address }
              : { kind: "native" },
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      props.onQuote(json);
      return json;
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : "Failed to fetch quote");
      return null;
    } finally {
      setQuoteBusy(false);
    }
  };

  useEffect(() => {
    if (stage !== "pay") return;
    if (recoveryAddress && props.assets.length) fetchQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const quote = props.quote;
  const paymaster = quote?.paymaster as AddressType | undefined;
  const paymentChainId = chain?.id;

  const quoteExecutableAssets = (quote?.quote?.executableAssets as RecoveryAsset[] | undefined) ?? undefined;
  const quoteAssetStatuses =
    (quote?.quote?.assetStatuses as
      | Array<{ index: number; ok: boolean; error: string | null; revert?: any | null }>
      | undefined) ?? undefined;

  const assetsForExecution = useMemo(() => {
    return Array.isArray(quoteExecutableAssets) ? quoteExecutableAssets : props.assets;
  }, [quoteExecutableAssets, props.assets]);

  const hasRecoverableAssets = assetsForExecution.length > 0;

  const executionChainIds = useMemo(() => {
    const ids = new Set<number>();
    for (const a of assetsForExecution) ids.add(a.chainId);
    return Array.from(ids).sort((a, b) => a - b);
  }, [assetsForExecution]);

  const fungibleMetaByKey = useMemo(() => {
    const m = new Map<string, ZerionPositionsViewRow>();
    for (const g of props.positionsView?.groups ?? []) {
      for (const r of g.rows ?? []) {
        if (!r) continue;
        const chainId = typeof r.chainId === "number" ? r.chainId : Number(r.chainId);
        if (!Number.isFinite(chainId)) continue;
        const std = r.standard;
        if (std === "native") {
          m.set(`native:${chainId}`, r);
        } else if (std === "erc20" && r.contract) {
          m.set(`erc20:${chainId}:${r.contract.toLowerCase()}`, r);
        }
      }
    }
    return m;
  }, [props.positionsView]);

  const nftMetaByKey = useMemo(() => {
    const m = new Map<string, ZerionNftView>();
    for (const n of props.nfts ?? []) {
      const chainId = typeof n.chainId === "number" ? n.chainId : Number(n.chainId);
      if (!Number.isFinite(chainId)) continue;
      m.set(`nft:${chainId}:${n.contract.toLowerCase()}:${n.tokenId}`, n);
    }
    return m;
  }, [props.nfts]);

  const [onchainMetaByKey, setOnchainMetaByKey] = useState<Record<string, { name?: string; symbol?: string }>>({});
  const onchainMetaKey = (chainId: number, addr: string) => `${chainId}:${addr.toLowerCase()}`;

  useEffect(() => {
    // Best-effort onchain fallback for names/symbols when scan metadata is missing.
    // Keep this bounded: only fetch for assets we plan to execute and only if not already known.
    const run = async () => {
      const toFetch: Array<{ chainId: number; address: AddressType; kind: "erc20" | "nft" }> = [];
      for (const a of assetsForExecution) {
        const chainId = a.chainId;
        if (!Number.isFinite(chainId)) continue;
        if (a.standard === "erc20") {
          const key = onchainMetaKey(chainId, a.contract);
          if (fungibleMetaByKey.has(`erc20:${chainId}:${a.contract.toLowerCase()}`)) continue;
          if (onchainMetaByKey[key]) continue;
          toFetch.push({ chainId, address: a.contract, kind: "erc20" });
        } else if (a.standard === "erc721" || a.standard === "erc1155") {
          const key = onchainMetaKey(chainId, a.contract);
          const nftKey = `nft:${chainId}:${a.contract.toLowerCase()}:${a.tokenId ?? ""}`;
          if (nftMetaByKey.has(nftKey)) continue;
          if (onchainMetaByKey[key]) continue;
          toFetch.push({ chainId, address: a.contract, kind: "nft" });
        }
      }

      // De-dupe
      const seen = new Set<string>();
      const uniq = toFetch.filter(x => {
        const k = onchainMetaKey(x.chainId, x.address);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (!uniq.length) return;

      const erc20MetaAbi = parseAbi([
        "function name() view returns (string)",
        "function symbol() view returns (string)",
      ]);
      const nftNameAbi = parseAbi(["function name() view returns (string)"]);

      const updates: Record<string, { name?: string; symbol?: string }> = {};
      await Promise.all(
        uniq.map(async x => {
          const key = onchainMetaKey(x.chainId, x.address);
          try {
            const publicClient = getPublicClient(wagmiConfig as any, { chainId: x.chainId });
            if (!publicClient) return;
            if (x.kind === "erc20") {
              const [name, symbol] = await Promise.all([
                publicClient
                  .readContract({ address: x.address, abi: erc20MetaAbi, functionName: "name" })
                  .catch(() => null),
                publicClient
                  .readContract({ address: x.address, abi: erc20MetaAbi, functionName: "symbol" })
                  .catch(() => null),
              ]);
              updates[key] = {
                name: typeof name === "string" ? name : undefined,
                symbol: typeof symbol === "string" ? symbol : undefined,
              };
            } else {
              const name = await publicClient
                .readContract({ address: x.address, abi: nftNameAbi, functionName: "name" })
                .catch(() => null);
              updates[key] = { name: typeof name === "string" ? name : undefined };
            }
          } catch {
            // ignore
          }
        }),
      );

      if (Object.keys(updates).length) {
        setOnchainMetaByKey(prev => ({ ...prev, ...updates }));
      }
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetsForExecution, fungibleMetaByKey, nftMetaByKey]);

  const failingAssets = useMemo(() => {
    if (!Array.isArray(quoteAssetStatuses)) return [];
    const statusesByIndex = new Map<number, any>();
    for (const s of quoteAssetStatuses) {
      const idx = typeof s?.index === "number" ? s.index : Number(s?.index);
      if (!Number.isFinite(idx)) continue;
      statusesByIndex.set(idx, s);
    }
    return props.assets
      .map((a, i) => ({ asset: a, status: statusesByIndex.get(i) }))
      .filter(x => x.status && x.status.ok === false);
  }, [quoteAssetStatuses, props.assets]);

  const describeAsset = (asset: RecoveryAsset) => {
    const meta = chainWithAttributes(asset.chainId);
    const chainName = meta?.name ?? `Chain ${asset.chainId}`;
    if (asset.standard === "native") {
      const symbol = meta?.nativeCurrency?.symbol ?? "ETH";
      const key = `native:${asset.chainId}`;
      const z = fungibleMetaByKey.get(key);
      return {
        chainName,
        title: symbol,
        subtitle: z?.tokenName ? z.tokenName : "Native token",
      };
    }

    if (asset.standard === "customcall") {
      const sig = (asset as any).functionSignature ? String((asset as any).functionSignature).trim() : "";
      const dataHex = (asset as any).dataHex ? String((asset as any).dataHex).trim() : "";
      return {
        chainName,
        title: "Custom call",
        subtitle: sig || (dataHex ? "raw tx" : null),
      };
    }

    if (asset.standard === "erc20") {
      const key = `erc20:${asset.chainId}:${asset.contract.toLowerCase()}`;
      const z = fungibleMetaByKey.get(key);
      const oc = onchainMetaByKey[onchainMetaKey(asset.chainId, asset.contract)] ?? {};
      const symbol = z?.tokenSymbol || oc.symbol || "Token";
      const name = z?.tokenName || oc.name;
      return { chainName, title: symbol, subtitle: name ?? null };
    }

    const nftKey = `nft:${asset.chainId}:${asset.contract.toLowerCase()}:${asset.tokenId ?? ""}`;
    const n = nftMetaByKey.get(nftKey);
    const oc = onchainMetaByKey[onchainMetaKey(asset.chainId, asset.contract)] ?? {};
    const title = n?.name || `#${asset.tokenId ?? "?"}`;
    const subtitle = n?.collectionName || oc.name || "NFT";
    return { chainName, title, subtitle };
  };

  const paymasterHasAnyFunds = useMemo(() => {
    return Boolean(
      (quote?.chains ?? []).some((c: any) => {
        const bal = asBigInt(c?.paymasterBalanceWei);
        return typeof bal === "bigint" && bal > 0n;
      }),
    );
  }, [quote]);

  const totalUsd = useMemo(() => usdFromMicros(quote?.quote?.totalUsdMicros), [quote]);
  const totalUsdText = useMemo(() => fmtUsd(totalUsd), [totalUsd]);

  const sendTx = useSendTransaction();
  const paymentReceipt = useWaitForTransactionReceipt({ hash: sendTx.data });

  const refillTx = useSendTransaction();
  const refillReceipt = useWaitForTransactionReceipt({ hash: refillTx.data });
  const lastAutoRefillTxHashRef = useRef<Hex | null>(null);

  const [execBusy, setExecBusy] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const lastAutoExecutedPaymentTxHashRef = useRef<Hex | null>(null);

  const canPay = Boolean(
    connected && paymaster && hasRecoverableAssets && typeof totalUsd === "number" && totalUsd > 0,
  );
  const canExecute = Boolean(paymentChainId && sendTx.data && paymentReceipt.data?.status === "success");

  type EstimateRow = {
    kind: "chain";
    id: string;
    chainId: number | null;
    chainName: string;
    assetCountOriginal: number;
    assetCountExecutable: number;
    symbol: string | null;
    gasNative: number | null;
    gasCostWei: bigint | null;
    usd: number | null;
    paymasterBalWei: bigint | null;
    error: string | null;
    rpcUrl: string | null;
    revertName: string | null;
    revertSummary: string | null;
  };

  const [expandedChainIds, setExpandedChainIds] = useState<Record<number, boolean>>({});

  const estimateRows = useMemo(() => {
    const rows: EstimateRow[] = (quote?.chains ?? []).map((c: any) => {
      const chainId = typeof c?.chainId === "number" ? c.chainId : Number(c?.chainId);
      const assetCountOriginal = typeof c?.assetCount === "number" ? c.assetCount : Number(c?.assetCount ?? 0);
      const assetCountExecutableRaw =
        typeof c?.executableAssetCount === "number" ? c.executableAssetCount : Number(c?.executableAssetCount ?? NaN);
      const assetCountExecutable = Number.isFinite(assetCountExecutableRaw)
        ? assetCountExecutableRaw
        : assetCountOriginal;
      const gasCostWei = asBigInt(c?.quote?.gasCostWei);
      const err = typeof c?.error === "string" ? c.error : null;
      const rpcUrl = typeof c?.rpcUrl === "string" ? c.rpcUrl : null;
      const balWei = asBigInt(c?.paymasterBalanceWei);
      const revertName = typeof c?.revert?.decoded?.errorName === "string" ? c.revert.decoded.errorName : null;
      const revertSummary = typeof c?.revert?.summary === "string" ? c.revert.summary : null;

      const meta = Number.isFinite(chainId) ? chainWithAttributes(chainId) : null;
      const chainName = meta?.name ?? (Number.isFinite(chainId) ? `Chain ${chainId}` : "Unknown chain");
      const symbol = meta?.nativeCurrency?.symbol ?? "ETH";
      const decimals = meta?.nativeCurrency?.decimals ?? 18;

      const markupBpsRaw = quote?.quote?.markupBps;
      const markupBpsNum = typeof markupBpsRaw === "number" ? markupBpsRaw : Number(markupBpsRaw ?? 0);
      const markupBps = Number.isFinite(markupBpsNum) && markupBpsNum >= 0 ? Math.floor(markupBpsNum) : 0;

      // Display the per-chain gas estimate including the markup for gas cost movement.
      const gasCostWeiForDisplay =
        typeof gasCostWei === "bigint" ? (gasCostWei * BigInt(10_000 + markupBps) + 9_999n) / 10_000n : null;

      const gasNative =
        gasCostWeiForDisplay != null
          ? (() => {
              try {
                return Number(formatUnits(gasCostWeiForDisplay, decimals));
              } catch {
                return null;
              }
            })()
          : null;
      const usdMicros = Number.isFinite(chainId) ? (quote?.quote?.gasCostUsdMicrosByChainId ?? {})[chainId] : undefined;
      const usd = usdFromMicros(usdMicros);

      return {
        kind: "chain",
        id: `chain:${Number.isFinite(chainId) ? chainId : -1}`,
        chainId: Number.isFinite(chainId) ? chainId : null,
        chainName,
        assetCountOriginal: Number.isFinite(assetCountOriginal) ? assetCountOriginal : 0,
        assetCountExecutable: Number.isFinite(assetCountExecutable) ? assetCountExecutable : 0,
        symbol,
        gasNative,
        gasCostWei,
        usd,
        paymasterBalWei: balWei,
        error: err,
        rpcUrl,
        revertName,
        revertSummary,
      };
    });

    const totalUsd = usdFromMicros(quote?.quote?.totalUsdMicros);
    const totalUsdKnown = typeof totalUsd === "number";

    return { rows, totalUsd: totalUsdKnown ? totalUsd : null };
  }, [quote]);

  const estimateRowByChainId = useMemo(() => {
    const m = new Map<number, EstimateRow>();
    for (const r of estimateRows.rows) {
      if (r.kind === "chain" && typeof r.chainId === "number") m.set(r.chainId, r);
    }
    return m;
  }, [estimateRows.rows]);

  const computeRecommendedPaymasterRefillWei = useCallback(
    (r: EstimateRow | null | undefined): bigint | null => {
      if (!r || r.kind !== "chain") return null;
      const bal = r.paymasterBalWei;
      const gas = r.gasCostWei;
      if (typeof bal === "bigint" && typeof gas === "bigint") {
        if (bal >= gas) return null;
        const shortfall = gas - bal;
        const buffer = shortfall / 20n; // +5%
        return shortfall + buffer + REFILL_MIN_BUFFER_WEI;
      }
      if (typeof bal === "bigint" && bal === 0n) return DEFAULT_REFILL_WEI;
      if (isPaymasterFundingError(r.error)) return DEFAULT_REFILL_WEI;
      return null;
    },
    [DEFAULT_REFILL_WEI, REFILL_MIN_BUFFER_WEI],
  );

  const [refillModalOpen, setRefillModalOpen] = useState(false);
  const [refillModalBusy, setRefillModalBusy] = useState(false);
  const [refillModalError, setRefillModalError] = useState<string | null>(null);
  const [refillChainId, setRefillChainId] = useState<number | null>(null);
  const [refillAmountEth, setRefillAmountEth] = useState<string>("0.001");

  const refillModalChainName = useMemo(() => {
    if (typeof refillChainId !== "number") return null;
    return chainWithAttributes(refillChainId)?.name ?? `Chain ${refillChainId}`;
  }, [refillChainId]);

  const refillSuggested = useMemo(() => {
    if (typeof refillChainId !== "number") return null;
    const r = estimateRowByChainId.get(refillChainId);
    const suggestedWei = computeRecommendedPaymasterRefillWei(r);
    if (typeof suggestedWei !== "bigint") return null;
    const sym = chainWithAttributes(refillChainId)?.nativeCurrency?.symbol ?? "ETH";
    return { suggestedWei, sym };
  }, [computeRecommendedPaymasterRefillWei, estimateRowByChainId, refillChainId]);

  const openRefillModal = (chainId: number) => {
    const r = estimateRowByChainId.get(chainId);
    const suggestedWei = computeRecommendedPaymasterRefillWei(r);
    const suggestedEth = (() => {
      if (typeof suggestedWei !== "bigint") return "0.001";
      try {
        return formatEther(suggestedWei);
      } catch {
        return "0.001";
      }
    })();
    setRefillChainId(chainId);
    setRefillAmountEth(suggestedEth);
    setRefillModalError(null);
    setRefillModalOpen(true);
  };

  const renderRefillButtonForEstimateRow = (r: EstimateRow) => {
    if (r.kind !== "chain") return null;
    if (typeof r.chainId !== "number") return null;
    if (!paymaster) return null;
    const suggestedWei = computeRecommendedPaymasterRefillWei(r);
    if (typeof suggestedWei !== "bigint") return null;
    return (
      <div className="mt-1">
        <button
          className="btn btn-warning btn-xs rounded-full"
          type="button"
          onClick={() => openRefillModal(r.chainId as number)}
          disabled={quoteBusy}
        >
          Refill paymaster
        </button>
      </div>
    );
  };

  const refillWei = useMemo(() => {
    try {
      return parseEther((refillAmountEth || "0") as `${number}`);
    } catch {
      return 0n;
    }
  }, [refillAmountEth]);

  const submitRefill = async () => {
    if (!connected) {
      setRefillModalError("Connect a wallet first.");
      return;
    }
    if (!paymaster) {
      setRefillModalError("Missing paymaster address. Refresh quote and try again.");
      return;
    }
    if (!refillChainId || !Number.isFinite(refillChainId)) {
      setRefillModalError("Missing target chain.");
      return;
    }
    if (refillWei <= 0n) {
      setRefillModalError("Enter an amount greater than 0.");
      return;
    }
    setRefillModalBusy(true);
    setRefillModalError(null);
    try {
      if (switchChainAsync && chain?.id !== refillChainId) {
        await switchChainAsync({ chainId: refillChainId });
      }
      const pc = getPublicClient(wagmiConfig as any, { chainId: refillChainId });
      if (!pc) throw new Error("No public client available on this network.");
      const bal = await pc.getBalance({ address: connected });
      if (bal < refillWei) throw new Error("Insufficient native balance to fund the paymaster on this chain.");
      refillTx.sendTransaction({ to: paymaster, value: refillWei });
    } catch (e) {
      setRefillModalError(e instanceof Error ? e.message : "Failed to send refill transaction.");
    } finally {
      setRefillModalBusy(false);
    }
  };

  useEffect(() => {
    if (!refillTx.data) return;
    if (lastAutoRefillTxHashRef.current === refillTx.data) return;
    if (refillReceipt.data?.status !== "success") return;
    lastAutoRefillTxHashRef.current = refillTx.data as Hex;
    setRefillModalOpen(false);
    // After funding, refresh the quote so assets become executable.
    fetchQuote().catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refillTx.data, refillReceipt.data?.status]);

  const loadPaymentMatrix = async () => {
    if (!connected) return;
    if (!hasRecoverableAssets) {
      setPaymentModalError("No recoverable assets remain. Remove failing assets or add other assets to recover.");
      setPaymentMatrixRows([]);
      return;
    }
    const seq = (paymentMatrixLoadSeqRef.current += 1);
    const totalUsdNumber = usdFromMicros(quote?.quote?.totalUsdMicros);
    if (typeof totalUsdNumber !== "number" || !Number.isFinite(totalUsdNumber) || totalUsdNumber <= 0) {
      setPaymentModalError("Missing quote total. Refresh quote and try again.");
      return;
    }

    setPaymentModalBusy(true);
    setPaymentModalError(null);

    try {
      // Zerion is the source of truth for what the paying wallet holds, including USD valuations.
      // We consider any fungible position whose Zerion `valueUsd` can cover the fee.
      const scanRes = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // omit chainIds so Zerion returns all networks
        body: safeJsonStringify({ compromisedAddress: connected }),
      });
      if (!scanRes.ok) throw new Error(await scanRes.text());
      const scan = (await scanRes.json()) as ZerionScanResponse;
      const scanRows =
        scan?.positionsView?.groups?.flatMap(g => (Array.isArray(g?.rows) ? g.rows : []))?.filter(Boolean) ?? [];

      // Build matrix rows: group by symbol, and only include networks where Zerion valueUsd covers the fee.
      // NOTE: Actual token amounts/balances are checked at click-time via /api/quote + onchain balanceOf.
      const rowsByKey = new Map<string, PaymentMatrixRow>();
      const enabledChainIds = new Set(enabledChains.map(c => c.id));

      for (const r of scanRows) {
        const cid = typeof r?.chainId === "number" ? r.chainId : Number(r?.chainId);
        if (!Number.isFinite(cid)) continue;
        if (!enabledChainIds.has(cid)) continue; // only show chains the dapp can actually switch/transact on
        if (r?.isVerified === false) continue;
        if (r?.standard !== "native" && r?.standard !== "erc20") continue;
        // First principles: "pay with whatever is in their wallet" → only wallet positions are actually spendable.
        if (r?.kind && r.kind !== "wallet") continue;
        const v = typeof r?.valueUsd === "number" && Number.isFinite(r.valueUsd) ? r.valueUsd : 0;
        if (v < totalUsdNumber) continue;

        const meta = chainWithAttributes(cid);
        const chainName = meta?.name ?? `Chain ${cid}`;

        if (r.standard === "native") {
          const symbol = r.tokenSymbol || meta?.nativeCurrency?.symbol || "Native";
          const key = `native:${symbol}`;
          const row = rowsByKey.get(key) ?? {
            key,
            symbol,
            kind: "native",
            iconUrl: r.tokenIconUrl,
            balanceUsd: 0,
            networks: [],
          };
          row.balanceUsd += v;
          row.networks.push({
            chainId: cid,
            chainName,
            asset: { kind: "native", symbol, valueUsd: v },
          });
          rowsByKey.set(key, row);
        } else {
          if (!r.contract || !r.tokenSymbol) continue;
          const symbol = r.tokenSymbol;
          const key = `erc20:${symbol}`;
          const row = rowsByKey.get(key) ?? {
            key,
            symbol,
            name: r.tokenName,
            kind: "erc20",
            iconUrl: r.tokenIconUrl,
            balanceUsd: 0,
            networks: [],
          };
          row.balanceUsd += v;
          row.networks.push({
            chainId: cid,
            chainName,
            asset: { kind: "erc20", address: r.contract, symbol, name: r.tokenName, valueUsd: v },
          });
          rowsByKey.set(key, row);
        }
      }

      const rows = Array.from(rowsByKey.values())
        .filter(r => r.networks.length)
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
      // Only apply the latest load result (prevents earlier slow calls from overwriting newer data).
      if (paymentMatrixLoadSeqRef.current === seq) setPaymentMatrixRows(rows);
    } catch (e) {
      // Keep previous results if we had any; show error for the refresh.
      if (paymentMatrixLoadSeqRef.current === seq) {
        setPaymentModalError(e instanceof Error ? e.message : "Failed to load payment options");
      }
    } finally {
      if (paymentMatrixLoadSeqRef.current === seq) setPaymentModalBusy(false);
    }
  };

  const payWithSelection = async (chainIdToPayOn: number, asset: PaymentAssetChoice) => {
    if (!connected) return;
    if (!hasRecoverableAssets) {
      setPaymentModalError("No recoverable assets remain. Remove failing assets or add other assets to recover.");
      return;
    }
    setPaymentModalBusy(true);
    setPaymentModalError(null);
    try {
      if (switchChainAsync && chain?.id !== chainIdToPayOn) {
        await switchChainAsync({ chainId: chainIdToPayOn });
      }

      const q = await fetchQuote({ paymentChainId: chainIdToPayOn, paymentAsset: asset });
      if (!q) throw new Error("Failed to fetch quote.");

      const pm = q?.paymaster as AddressType | undefined;
      if (!pm) throw new Error("Missing paymaster address.");

      const kind = (q?.quote?.paymentAsset?.kind as "native" | "erc20" | undefined) ?? "native";
      const dueWei = asBigInt(q?.quote?.totalDueWei);
      const dueToken = asBigInt(q?.quote?.totalDueTokenUnits);

      const pc = getPublicClient(wagmiConfig as any, { chainId: chainIdToPayOn });
      if (!pc) throw new Error("No public client available on this network.");

      if (kind === "native") {
        if (!dueWei || dueWei <= 0n) throw new Error("Missing native total due.");
        const bal = await pc.getBalance({ address: connected });
        if (bal < dueWei) throw new Error("Insufficient native balance to pay the fee.");
        sendTx.sendTransaction({ to: pm, value: dueWei });
      } else {
        if (asset.kind !== "erc20") throw new Error("Selected asset must be an ERC-20.");
        if (!dueToken || dueToken <= 0n) throw new Error("Missing token total due.");
        const erc20Abi = parseAbi([
          "function balanceOf(address) view returns (uint256)",
          "function transfer(address to,uint256 value) returns (bool)",
        ]);
        const bal = (await pc.readContract({
          address: asset.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [connected],
        })) as bigint;
        if (bal < dueToken) throw new Error("Insufficient token balance to pay the fee.");
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [pm, dueToken],
        });
        sendTx.sendTransaction({ to: asset.address, data, value: 0n });
      }

      setPaymentAssetChoice(asset);
      setPaymentModalOpen(false);
    } catch (e) {
      setPaymentModalError(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setPaymentModalBusy(false);
    }
  };

  const execute = async () => {
    if (!recoveryAddress || !sendTx.data || !paymentChainId) return;
    if (!assetsForExecution.length) {
      setExecError("No recoverable assets remain. Remove failing assets or add other assets to recover.");
      return;
    }
    setExecBusy(true);
    setExecError(null);
    try {
      // Only sign/send authorizations for chains that still have executable assets.
      const authsAll = await signAuthorizations(executionChainIds);
      const body = {
        safeAddress: recoveryAddress,
        assets: assetsForExecution,
        authorizationsByChainId: authsAll,
        paymentTxHash: sendTx.data as Hex,
        paymentChainId,
        quotePayload: quote?.quote?.quotePayload,
        quoteSig: quote?.quote?.quoteSig,
      };
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: safeJsonStringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      props.onExecute({ result: json, executedAssets: assetsForExecution });
    } catch (e) {
      setExecError(e instanceof Error ? e.message : "Execute failed");
    } finally {
      setExecBusy(false);
    }
  };

  useEffect(() => {
    // Auto-execute immediately after the payment is confirmed.
    // Guard to ensure we only attempt once per payment tx hash.
    if (!canExecute) return;
    if (execBusy) return;
    if (execError) return; // user can hit retry manually
    const paymentTxHash = sendTx.data as Hex | undefined;
    if (!paymentTxHash) return;
    if (lastAutoExecutedPaymentTxHashRef.current === paymentTxHash) return;
    lastAutoExecutedPaymentTxHashRef.current = paymentTxHash;
    execute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canExecute, sendTx.data, execBusy, execError]);

  const canContinueToPay = Boolean(connected && recoveryAddress);

  return (
    <div className="bg-base-100 rounded-3xl p-5 sm:p-8 border border-base-300 space-y-6">
      <div>
        <h2 className="text-2xl font-bold m-0">Pay fee + execute (paymaster)</h2>
        <p className="mt-2 text-sm text-neutral">
          Your connected wallet can&apos;t broadcast EIP-7702 transactions directly. Instead, you pay gas fees in the
          token of your choice from your safe wallet and our server broadcasts the EIP-7702 recovery transactions on
          every network.
        </p>
      </div>

      {stage === "destination" ? (
        <>
          <div className="rounded-2xl border border-base-300 p-4 space-y-2">
            <div className="text-sm font-semibold">1) Connect a wallet to pay fees</div>
            <div className="text-sm">
              {connected ? (
                <>
                  <Address address={connected} />
                  <span className="ml-2 text-xs text-neutral">({chain?.name ?? "Unknown network"})</span>
                </>
              ) : (
                <span className="text-neutral">Not connected</span>
              )}
            </div>
            <div className="text-xs text-neutral">
              You can pay on any network. We’ll use the connected wallet as the default recovery destination.
            </div>
          </div>

          <div className="rounded-2xl border border-base-300 p-4 space-y-2">
            <div className="text-sm font-semibold">2) Choose recovery destination</div>
            <AddressInput
              placeholder="0x…"
              value={recoveryAddressInput}
              onChange={v => {
                setRecoveryAddressInput(v);
                setRecoveryAddressEdited(true);
              }}
            />
            {recoveryAddress ? (
              <div className="text-xs text-neutral">
                Destination: <Address address={recoveryAddress} />
              </div>
            ) : recoveryAddressInput.trim() ? (
              <div className="text-xs text-warning">Enter a valid address.</div>
            ) : (
              <div className="text-xs text-neutral">Defaults to your connected wallet.</div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="relative rounded-2xl border border-base-300 p-4 space-y-3">
            <div>
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">Fee estimate</div>
                <button
                  className="btn btn-ghost btn-xs rounded-full"
                  onClick={() => fetchQuote()}
                  disabled={quoteBusy || !recoveryAddress}
                >
                  {quoteBusy ? <span className="loading loading-spinner loading-xs" /> : null}
                  Refresh
                </button>
              </div>

              {quoteError ? <div className="text-sm text-error break-words">{quoteError}</div> : null}

              <div className="text-xs text-neutral">
                Recovery destination: <Address address={recoveryAddress} />
              </div>

              {quote ? (
                <div className="space-y-3">
                  {failingAssets.length ? (
                    <div className="rounded-2xl border border-warning/30 bg-warning/10 p-3 space-y-2">
                      <div className="text-sm font-semibold text-warning">
                        {failingAssets.length} asset{failingAssets.length === 1 ? "" : "s"}{" "}
                        {failingAssets.every(x => isPaymasterFundingError(x.status?.error))
                          ? failingAssets.length === 1
                            ? "needs paymaster funding"
                            : "need paymaster funding"
                          : "will be skipped (would fail)"}
                      </div>
                      <div className="space-y-1">
                        {failingAssets.map((x, i) => (
                          <div key={i} className="text-xs text-neutral break-words">
                            {(() => {
                              const d = describeAsset(x.asset);
                              return (
                                <>
                                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <span className="font-semibold">{d.chainName}</span>
                                    <span className="font-mono uppercase opacity-70">{x.asset.standard}</span>
                                    <span className="font-semibold">{d.title}</span>
                                    {d.subtitle ? <span className="opacity-70">({d.subtitle})</span> : null}
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <span className="opacity-70">contract:</span>{" "}
                                    <Address address={x.asset.contract} chain={getTargetNetworkById(x.asset.chainId)} />
                                    {typeof x.asset.tokenId !== "undefined" ? (
                                      <span className="font-mono opacity-70">tokenId={x.asset.tokenId}</span>
                                    ) : null}
                                    {typeof x.asset.amount !== "undefined" ? (
                                      <span className="font-mono opacity-70">amount={x.asset.amount}</span>
                                    ) : null}
                                  </div>
                                </>
                              );
                            })()}
                            {typeof x.status?.error === "string" ? (
                              <div className="mt-1 text-warning">{x.status.error}</div>
                            ) : null}
                            {isPaymasterFundingError(x.status?.error) && typeof x.asset.chainId === "number" ? (
                              <div className="mt-1">
                                <button
                                  className="btn btn-warning btn-xs rounded-full"
                                  type="button"
                                  onClick={() => openRefillModal(x.asset.chainId)}
                                  disabled={!paymaster || quoteBusy}
                                >
                                  Refill paymaster
                                </button>
                              </div>
                            ) : null}
                            {typeof x.status?.revert?.summary === "string" ? (
                              <div className="mt-1 text-[11px] text-neutral">
                                revert: <span className="font-mono">{x.status.revert.summary}</span>
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                      <div className="text-[11px] text-neutral">
                        We’ll automatically exclude these from the final recovery transaction you pay for.
                      </div>
                    </div>
                  ) : null}

                  {(() => {
                    const onlyAssetBlockedByPaymasterFunding =
                      props.assets.length === 1 &&
                      failingAssets.length === 1 &&
                      isPaymasterFundingError(failingAssets[0]?.status?.error);
                    const blurBelowPaymaster =
                      quoteBusy || (!hasRecoverableAssets && !onlyAssetBlockedByPaymasterFunding);
                    return (
                      <div className="relative">
                        <div className={blurBelowPaymaster ? "opacity-40 blur-[1px] pointer-events-none" : ""}>
                          {!paymasterHasAnyFunds ? (
                            <div className="text-xs text-warning">
                              Paymaster balance is <span className="font-semibold">0</span> on the selected chains.
                              Execution will fail until it’s funded on each chain you’re recovering from.
                            </div>
                          ) : null}

                          <div className="rounded-2xl border border-base-300 p-3 mt-3 mb-3">
                            <div className="text-xs text-neutral">Estimated costs (USD)</div>
                            <div className="mt-2 space-y-2">
                              {estimateRows.rows.map(r => (
                                <div key={r.id} className="space-y-2">
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="text-sm font-semibold truncate">
                                        {r.chainName}{" "}
                                        {r.kind === "chain" ? (
                                          r.assetCountExecutable !== r.assetCountOriginal ? (
                                            <span className="text-xs text-neutral">
                                              (<span className="line-through">{r.assetCountOriginal}</span>{" "}
                                              {r.assetCountExecutable} asset{r.assetCountExecutable === 1 ? "" : "s"})
                                            </span>
                                          ) : (
                                            <span className="text-xs text-neutral">
                                              ({r.assetCountOriginal} asset{r.assetCountOriginal === 1 ? "" : "s"})
                                            </span>
                                          )
                                        ) : null}
                                      </div>
                                      {r.kind === "chain" && typeof r.chainId === "number" ? (
                                        <div className="mt-1">
                                          <button
                                            className="btn btn-ghost btn-xs rounded-full"
                                            type="button"
                                            onClick={() =>
                                              setExpandedChainIds(prev => ({
                                                ...prev,
                                                [r.chainId as number]: !prev[r.chainId as number],
                                              }))
                                            }
                                          >
                                            {expandedChainIds[r.chainId] ? "Hide assets" : "Show assets"}
                                          </button>
                                        </div>
                                      ) : null}
                                      {r.error ? (
                                        <div className="text-xs text-warning break-words mt-1">
                                          {r.rpcUrl ? (
                                            <>
                                              rpc=<span className="font-mono">{r.rpcUrl}</span>
                                              {" · "}
                                            </>
                                          ) : null}
                                          {r.error}
                                        </div>
                                      ) : null}
                                      {r.revertName ? (
                                        <div className="text-[11px] text-neutral mt-1">
                                          revert: <span className="font-mono">{r.revertName}</span>
                                        </div>
                                      ) : null}
                                      {typeof r.revertSummary === "string" ? (
                                        <div className="text-[11px] text-neutral mt-1">
                                          detail: <span className="font-mono">{r.revertSummary}</span>
                                        </div>
                                      ) : null}
                                      {renderRefillButtonForEstimateRow(r)}
                                    </div>

                                    <div className="text-right shrink-0">
                                      {r.assetCountExecutable === 0 ? (
                                        <>
                                          <div className="text-sm font-mono">0 {r.symbol ?? "ETH"}</div>
                                          <div className="text-xs text-neutral">{fmtUsd(0)}</div>
                                        </>
                                      ) : (
                                        <>
                                          <div className="text-sm font-mono">
                                            {fmtTokenAmount(r.gasNative, r.symbol ?? "ETH")}
                                          </div>
                                          <div className="text-xs text-neutral">{fmtUsd(r.usd)}</div>
                                        </>
                                      )}
                                    </div>
                                  </div>

                                  {r.kind === "chain" &&
                                  typeof r.chainId === "number" &&
                                  expandedChainIds[r.chainId] ? (
                                    <div className="rounded-2xl border border-base-300 p-3">
                                      <div className="text-xs text-neutral mb-2">Staged assets</div>
                                      <div className="space-y-2">
                                        {assetsForExecution.some(a => a.chainId === r.chainId) ? (
                                          assetsForExecution
                                            .filter(a => a.chainId === r.chainId)
                                            .map((a, idx) => {
                                              const d = describeAsset(a);
                                              const qtyText =
                                                a.standard === "erc20"
                                                  ? fungibleMetaByKey.get(
                                                      `erc20:${a.chainId}:${a.contract.toLowerCase()}`,
                                                    )?.quantityText
                                                  : a.standard === "native"
                                                    ? fungibleMetaByKey.get(`native:${a.chainId}`)?.quantityText
                                                    : null;
                                              return (
                                                <div
                                                  key={`${a.standard}:${a.contract}:${a.tokenId ?? ""}:${idx}`}
                                                  className="text-xs"
                                                >
                                                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                    <span className="font-semibold">{d.title}</span>
                                                    {d.subtitle ? (
                                                      <span className="opacity-70">({d.subtitle})</span>
                                                    ) : null}
                                                    {a.standard !== "customcall" ? (
                                                      <span className="font-mono uppercase opacity-70">
                                                        {a.standard}
                                                      </span>
                                                    ) : null}
                                                  </div>
                                                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-neutral">
                                                    <span className="opacity-70">contract:</span>{" "}
                                                    <Address
                                                      address={a.contract}
                                                      chain={getTargetNetworkById(a.chainId)}
                                                    />
                                                    {a.standard !== "customcall" ? (
                                                      <>
                                                        {typeof a.tokenId !== "undefined" ? (
                                                          <span className="font-mono opacity-70">
                                                            tokenId={a.tokenId}
                                                          </span>
                                                        ) : null}
                                                        {typeof a.amount !== "undefined" ? (
                                                          <span className="font-mono opacity-70">
                                                            amount={a.amount}
                                                          </span>
                                                        ) : null}
                                                        {qtyText ? (
                                                          <span className="opacity-70">({qtyText})</span>
                                                        ) : null}
                                                      </>
                                                    ) : null}
                                                  </div>
                                                </div>
                                              );
                                            })
                                        ) : (
                                          <div className="text-xs text-neutral">No staged assets on this chain.</div>
                                        )}
                                      </div>
                                    </div>
                                  ) : null}
                                </div>
                              ))}

                              <div className="pt-2 mt-2 border-t border-base-300 flex items-center justify-between">
                                <div className="text-sm font-semibold">Total</div>
                                <div className="text-sm font-mono">{fmtUsd(estimateRows.totalUsd)}</div>
                              </div>
                              <div className="text-[11px] text-neutral mt-1">
                                Total due includes the estimated gas costs across all networks (in USD) plus a little
                                buffer to account for gas price fluctuations.
                              </div>
                            </div>
                          </div>

                          <div className="text-xs text-neutral">
                            Recovering {assetsForExecution.length} asset{assetsForExecution.length === 1 ? "" : "s"}{" "}
                            {failingAssets.length ? <span>(skipping {failingAssets.length})</span> : null}
                          </div>
                        </div>

                        {blurBelowPaymaster ? (
                          <div className="absolute inset-0 flex items-center justify-center p-4">
                            <div className="max-w-md w-full rounded-2xl border border-base-300 bg-base-100/95 backdrop-blur p-4">
                              {!hasRecoverableAssets ? (
                                <>
                                  <div className="text-sm font-semibold">No recoverable assets remain</div>
                                  <div className="text-xs text-neutral mt-1">
                                    All selected assets would fail at execution time, so there’s no reason to pay a fee.
                                    Go back and remove the failing asset(s), or add other assets to recover.
                                  </div>
                                </>
                              ) : (
                                <div className="flex items-center gap-2 text-sm">
                                  <span className="loading loading-spinner loading-sm" />
                                  Refreshing quote…
                                </div>
                              )}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="text-sm text-neutral">Loading quote…</div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-base-300 p-4 space-y-3">
            <div className="text-sm font-semibold">Pay fees and recover</div>
            <button
              className="btn btn-primary btn-sm rounded-full"
              disabled={!canPay || sendTx.isPending || execBusy || canExecute}
              onClick={() => {
                if (!hasRecoverableAssets) return;
                setPaymentModalOpen(true);
                loadPaymentMatrix();
              }}
              type="button"
            >
              {sendTx.isPending || execBusy ? <span className="loading loading-spinner loading-sm" /> : null}
              Pay fee ({totalUsdText})
            </button>
            {sendTx.error ? <div className="text-sm text-error break-words">{sendTx.error.message}</div> : null}
            {sendTx.data ? (
              <div className="text-xs text-neutral break-words">
                Payment tx: <span className="font-mono">{sendTx.data}</span>
              </div>
            ) : null}
            {paymentReceipt.data ? (
              <div className="text-xs text-neutral">Payment status: {paymentReceipt.data.status}</div>
            ) : null}

            {canExecute && !execError ? (
              <div className="text-xs text-neutral">
                {execBusy ? (
                  <span className="flex items-center gap-2">
                    <span className="loading loading-spinner loading-xs" />
                    Payment confirmed. Broadcasting recovery transactions…
                  </span>
                ) : (
                  <span>Payment confirmed. Broadcasting recovery transactions…</span>
                )}
              </div>
            ) : (
              <div className="text-xs text-neutral">
                {paymentReceipt.data?.status === "success"
                  ? "Payment confirmed. Broadcasting recovery transactions…"
                  : "Pay the gas fees to finalize the recovery"}
              </div>
            )}

            {execError ? (
              <>
                <div className="text-sm text-error break-words">{execError}</div>
                <button
                  className="btn btn-primary btn-sm rounded-full"
                  onClick={execute}
                  disabled={!canExecute || execBusy}
                >
                  {execBusy ? <span className="loading loading-spinner loading-sm" /> : null}
                  Retry recovery
                </button>
              </>
            ) : null}
          </div>
        </>
      )}

      {paymentModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            className="absolute inset-0 bg-black/40"
            onClick={() => (paymentModalBusy ? null : setPaymentModalOpen(false))}
            aria-label="Close payment asset picker"
            type="button"
          />
          <div className="relative w-full max-w-lg bg-base-100 rounded-3xl border border-base-300 p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-bold">Pay with…</div>
                <div className="text-xs text-neutral">
                  Total: <span className="font-semibold">{totalUsdText}</span>
                </div>
              </div>
              <button
                className="btn btn-ghost btn-xs rounded-full"
                onClick={() => setPaymentModalOpen(false)}
                disabled={paymentModalBusy}
                type="button"
              >
                Close
              </button>
            </div>

            {paymentModalError ? <div className="text-sm text-error break-words">{paymentModalError}</div> : null}

            <div className="space-y-2">
              <div className="text-xs text-neutral">Pick an asset and network (only payable options shown)</div>
              {paymentMatrixRows.length ? (
                <div className="space-y-2">
                  {paymentMatrixRows.map(r => (
                    <div key={r.key} className="rounded-2xl border border-base-300 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex items-center gap-2">
                          <div className="w-7 h-7 rounded-full bg-base-200 border border-base-300 overflow-hidden flex items-center justify-center shrink-0">
                            {r.iconUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={r.iconUrl} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div className="text-xs font-bold">{(r.symbol?.[0] ?? "?").toUpperCase()}</div>
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-semibold truncate">{r.symbol}</div>
                            {r.name ? <div className="text-[11px] text-neutral truncate">{r.name}</div> : null}
                            <div className="text-[11px] text-neutral">Balance: {fmtUsd(r.balanceUsd)}</div>
                          </div>
                        </div>
                        <div className="flex flex-wrap justify-end gap-x-0 gap-y-0">
                          {r.networks.map(n => {
                            return (
                              <button
                                key={`${r.key}:${n.chainId}`}
                                className="btn btn-ghost btn-xs rounded-full w-8 h-8 p-0 flex items-center justify-center"
                                onClick={() => payWithSelection(n.chainId, n.asset)}
                                disabled={paymentModalBusy || sendTx.isPending}
                                type="button"
                                title={`Pay on ${n.chainName}`}
                                aria-label={`Pay on ${n.chainName}`}
                              >
                                <Image
                                  src={chainIconSrc(n.chainId)}
                                  alt=""
                                  width={18}
                                  height={18}
                                  className="rounded-full"
                                />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : paymentModalBusy ? (
                <div className="text-xs text-neutral flex items-center gap-2">
                  <span className="loading loading-spinner loading-xs" />
                  Loading payment options…
                </div>
              ) : (
                <div className="text-sm text-neutral">
                  No payable options found on your target networks. Try switching wallets, or fund an account on a
                  supported network.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {refillModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            className="absolute inset-0 bg-black/40"
            onClick={() => (refillModalBusy || refillTx.isPending ? null : setRefillModalOpen(false))}
            aria-label="Close paymaster refill"
            type="button"
          />
          <div className="relative w-full max-w-lg bg-base-100 rounded-3xl border border-base-300 p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-bold">Refill paymaster</div>
                <div className="text-xs text-neutral">
                  Send a small amount of the native asset on{" "}
                  <span className="font-semibold">{refillModalChainName ?? "the selected chain"}</span> to cover
                  execution gas.
                </div>
              </div>
              <button
                className="btn btn-ghost btn-xs rounded-full"
                onClick={() => setRefillModalOpen(false)}
                disabled={refillModalBusy || refillTx.isPending}
                type="button"
              >
                Close
              </button>
            </div>

            {paymaster ? (
              <div className="text-sm">
                Paymaster: <Address address={paymaster} chain={getTargetNetworkById(refillChainId)} />
              </div>
            ) : (
              <div className="text-sm text-warning">Missing paymaster address. Refresh quote and try again.</div>
            )}

            <div className="space-y-2">
              <div className="text-sm font-semibold">Amount</div>
              <EtherInput
                placeholder="0.001"
                onValueChange={({ valueInEth }) => setRefillAmountEth(valueInEth)}
                defaultValue={refillAmountEth}
                style={{ width: "100%" }}
              />
              {refillSuggested ? (
                <div className="text-[11px] text-neutral">
                  Suggested: <span className="font-mono">{formatEther(refillSuggested.suggestedWei)}</span>{" "}
                  {refillSuggested.sym}
                </div>
              ) : null}
            </div>

            {refillModalError ? <div className="text-sm text-error break-words">{refillModalError}</div> : null}
            {refillTx.error ? <div className="text-sm text-error break-words">{refillTx.error.message}</div> : null}
            {refillTx.data ? (
              <div className="text-xs text-neutral break-words">
                Refill tx: <span className="font-mono">{refillTx.data}</span>
              </div>
            ) : null}
            {refillReceipt.data ? (
              <div className="text-xs text-neutral">Refill status: {refillReceipt.data.status}</div>
            ) : null}

            <button
              className="btn btn-primary btn-sm rounded-full"
              disabled={!connected || !paymaster || refillWei <= 0n || refillTx.isPending || refillModalBusy}
              onClick={submitRefill}
              type="button"
            >
              {refillTx.isPending || refillModalBusy ? <span className="loading loading-spinner loading-sm" /> : null}
              Send refill
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex justify-between">
        <button
          className="btn btn-ghost rounded-full"
          onClick={() => (stage === "pay" ? setStage("destination") : props.onBack())}
        >
          Back
        </button>
        {stage === "destination" ? (
          <button
            className="btn btn-primary rounded-full"
            disabled={!canContinueToPay}
            onClick={() => {
              setStage("pay");
            }}
          >
            Next
          </button>
        ) : null}
      </div>
    </div>
  );
}
