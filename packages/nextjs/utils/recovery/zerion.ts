import type { Address } from "viem";

// Minimal Zerion API wrapper. For local-only MVP, this can return empty if `ZERION_API_KEY` is missing.
// Docs: https://developers.zerion.io/

type ZerionResponse = {
  data?: Array<{
    type?: string;
    id?: string;
    attributes?: any;
    relationships?: any;
  }>;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function shouldDebugLogZerion(): boolean {
  const v = process.env.DEBUG_ZERION?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function safeJsonStringify(value: unknown, maxChars = 50_000): string {
  try {
    const s = JSON.stringify(value, null, 2);
    if (s.length <= maxChars) return s;
    return `${s.slice(0, maxChars)}\n... truncated (${s.length} chars total)`;
  } catch {
    return "<unserializable>";
  }
}

function summarizeZerionPositionsForDebug(positionsJson: ZerionResponse) {
  const items = Array.isArray(positionsJson?.data) ? positionsJson.data : [];

  const rows = items.map(item => {
    const a: any = item?.attributes ?? {};
    const rel: any = item?.relationships ?? {};
    return {
      id: asString((item as any)?.id),
      type: asString((item as any)?.type),
      chain: asString(rel?.chain?.data?.id) ?? asString(a?.chain_id) ?? asString(a?.chain),
      positionType: asString(a?.position_type),
      protocol: asString(a?.protocol),
      appName: asString(a?.application_metadata?.name),
      dappId: asString(rel?.dapp?.data?.id),
      fungibleId: asString(rel?.fungible?.data?.id),
      tokenSymbol: asString(a?.fungible_info?.symbol),
      tokenName: asString(a?.fungible_info?.name),
      verified: a?.fungible_info?.flags?.verified,
      displayable: a?.flags?.displayable,
      valueUsd: asNumber(a?.value),
      quantityInt: asString(a?.quantity?.int),
      quantityNumeric: asString(a?.quantity?.numeric),
      quantityDecimals: asNumber(a?.quantity?.decimals),
    };
  });

  // Compute likely duplicate "positions" by chain/app/token/type.
  const keyFor = (r: any) =>
    [
      r.chain ?? "unknown",
      r.dappId ?? r.appName ?? r.protocol ?? "unknown-app",
      r.positionType ?? "unknown-type",
      r.fungibleId ?? r.tokenSymbol ?? "unknown-token",
    ].join("|");

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(keyFor(r), (counts.get(keyFor(r)) ?? 0) + 1);

  const duplicates = Array.from(counts.entries())
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([key, n]) => ({ key, count: n }));

  return {
    itemCount: items.length,
    duplicates,
    // Keep the full per-item list available, but callers should be mindful of log size.
    rows,
  };
}

export type NormalizedAsset = {
  chainId: number;
  standard: "native" | "erc20" | "erc721" | "erc1155";
  contract: Address;
  tokenId?: string;
  amount?: string;
};

export type ZerionPositionsView = {
  totalValueUsd: number;
  groups: ZerionPositionsViewGroup[];
};

export type ZerionPositionsViewGroup = {
  id: string; // "wallet" or dapp-id/app-name fallback
  title: string;
  iconUrl?: string;
  url?: string;
  totalValueUsd: number; // net (loans are negative)
  percentOfPortfolio: number; // 0-100
  rows: ZerionPositionsViewRow[];
};

export type ZerionPositionsViewRow = {
  id: string;
  chain: string;
  chainId?: number;
  standard?: "native" | "erc20";
  /**
   * Whether the token is verified per Zerion metadata (`fungible_info.flags.verified`).
   * When false, we hide it by default and show it only when the user enables
   * "Show unverified assets".
   */
  isVerified?: boolean;
  tokenName: string;
  tokenSymbol: string;
  tokenIconUrl?: string;
  contract?: Address;
  kind: "wallet" | "deposit" | "loan" | "reward" | "other";
  quantityText?: string;
  amountInt?: string;
  quantityNumeric?: string;
  quantityDecimals?: number;
  valueUsd: number; // absolute value for display
  signedValueUsd: number; // negative for loans
};

export type ZerionNftView = {
  chain: string;
  chainId?: number;
  standard: "erc721" | "erc1155";
  contract: Address;
  tokenId: string;
  amount?: string;
  name?: string;
  collectionName?: string;
  imagePreviewUrl?: string;
  imageDetailUrl?: string;
  collectionIconUrl?: string;
  collectionBannerUrl?: string;
  valueUsd?: number;
  isSpam?: boolean;
};

// Zerion network id -> EVM chainId (from GET /v1/chains, 2026-11-11).
// IMPORTANT: if a network name is missing here, positions on it are dropped rather than
// mis-labeled as Ethereum, so keep this in sync with the chains we support.
const networkNameToChainId: Record<string, number> = {
  ethereum: 1,
  optimism: 10,
  "binance-smart-chain": 56,
  xdai: 100,
  unichain: 130,
  polygon: 137,
  monad: 143,
  sonic: 146,
  opbnb: 204,
  fraxtal: 252,
  "zksync-era": 324,
  world: 480,
  hyperevm: 999,
  lisk: 1135,
  sei: 1329,
  soneium: 1868,
  ronin: 2020,
  abstract: 2741,
  megaeth: 4326,
  mantle: 5000,
  base: 8453,
  plasma: 9745,
  ape: 33139,
  mode: 34443,
  arbitrum: 42161,
  celo: 42220,
  avalanche: 43114,
  ink: 57073,
  linea: 59144,
  berachain: 80094,
  blast: 81457,
  taiko: 167000,
  scroll: 534352,
  katana: 747474,
  zora: 7777777,
};

// const chainIdToNetworkName: Record<number, string> = Object.fromEntries(
//   Object.entries(networkNameToChainId).map(([name, id]) => [id, name]),
// );

function getZerionAuthHeaderValue(apiKey: string) {
  // Zerion uses HTTP Basic auth where username=apiKey and password is empty, i.e. base64(`${apiKey}:`).
  // See: https://developers.zerion.io/
  const encoded = Buffer.from(`${apiKey}:`).toString("base64");
  return `Basic ${encoded}`;
}

function networkToChainId(network?: string): number | undefined {
  if (!network) return undefined;
  return networkNameToChainId[network];
}

function inferChainId(network?: string): number | undefined {
  if (!network) return undefined;
  const fromName = networkToChainId(network);
  if (fromName) return fromName;
  // Some Zerion payloads use numeric chain ids (e.g. "137") instead of network names.
  if (/^\d+$/.test(network)) {
    const n = Number(network);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function isNativeZerionId(id?: string): boolean {
  if (!id) return false;
  // Zerion uses different id formats in different endpoints:
  // - Fungible asset ids often look like: "base-zksync-era-asset-asset" (native)
  // - Some relationship ids may look like: "base:..." (native)
  if (id.startsWith("base-")) return true;
  if (id.split(":")[0] === "base") return true;
  return false;
}

function asString(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}

function asNumber(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

async function zerionGet(apiKey: string, url: string, timeoutMs = 15_000) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: getZerionAuthHeaderValue(apiKey),
    },
    cache: "no-store",
    // Node fetch has no default timeout; never let one slow Zerion call eat the whole function budget.
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

export async function fetchZerionFungiblePositionsRaw(params: { apiKey: string; compromisedAddress: Address }) {
  const url = `https://api.zerion.io/v1/wallets/${params.compromisedAddress}/positions/?currency=usd&filter[positions]=no_filter`;
  const res = await zerionGet(params.apiKey, url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zerion positions error ${res.status}: ${text || res.statusText}`);
  }
  return ((await res.json()) as ZerionResponse) ?? {};
}

async function fetchNftPositions(params: { apiKey: string; compromisedAddress: Address }) {
  const url = `https://api.zerion.io/v1/wallets/${params.compromisedAddress}/nft-positions/?currency=usd&page[size]=100`;

  // Zerion may respond 202 while NFT positions are still being aggregated.
  // Poll within a fixed overall deadline so the scan route stays well inside its maxDuration.
  const deadline = Date.now() + 20_000;
  let attempt = 0;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { data: [] } as ZerionResponse;
    const res = await zerionGet(params.apiKey, url, Math.min(15_000, remaining));
    if (res.status === 202) {
      await res.body?.cancel().catch(() => {});
      attempt += 1;
      const sleepMs = Math.min(4000, 500 * attempt);
      if (Date.now() + sleepMs >= deadline) return { data: [] } as ZerionResponse;
      await sleep(sleepMs);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Zerion nft-positions error ${res.status}: ${text || res.statusText}`);
    }
    return ((await res.json()) as ZerionResponse) ?? {};
  }
}

function positionKind(positionType?: string): ZerionPositionsViewRow["kind"] {
  const t = (positionType ?? "").toLowerCase();
  if (t === "wallet") return "wallet";
  if (t === "deposit") return "deposit";
  if (t === "loan") return "loan";
  if (t === "reward") return "reward";
  return "other";
}

function buildQuantityText(a: any): string | undefined {
  const qtyFloat = asNumber(a?.quantity?.float);
  const symbol = asString(a?.fungible_info?.symbol);
  if (qtyFloat == null || !symbol) return undefined;
  // Keep this intentionally compact; UI will show a more precise form using `quantityNumeric` when needed.
  return `${qtyFloat.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`;
}

export function normalizeZerionPositionsToView(positionsJson: ZerionResponse): ZerionPositionsView {
  const items = Array.isArray(positionsJson?.data) ? positionsJson.data : [];

  const appFungibleIds = new Set<string>();
  for (const item of items) {
    const a: any = item?.attributes ?? {};
    const rel: any = item?.relationships ?? {};
    const protocol = asString(a?.protocol);
    const app = a?.application_metadata;
    const isApp = Boolean(protocol || app?.name || rel?.dapp?.data?.id);
    if (!isApp) continue;
    const fungibleId = asString(rel?.fungible?.data?.id);
    if (fungibleId) appFungibleIds.add(fungibleId);
  }

  const groupMap = new Map<string, Omit<ZerionPositionsViewGroup, "percentOfPortfolio">>();

  const upsertGroup = (key: string, group: Omit<ZerionPositionsViewGroup, "percentOfPortfolio">) => {
    if (!groupMap.has(key)) groupMap.set(key, group);
    return groupMap.get(key)!;
  };

  for (const item of items) {
    const id = asString((item as any)?.id) ?? "";
    const a: any = item?.attributes ?? {};
    const rel: any = item?.relationships ?? {};

    // Zerion's `flags.displayable` controls UI inclusion; `fungible_info.flags.verified` is token trust.
    // Our UX toggle should be driven by token trust.
    const fungibleVerifiedFlag = a?.fungible_info?.flags?.verified;
    const isVerified = typeof fungibleVerifiedFlag === "boolean" ? fungibleVerifiedFlag : true;

    const value = asNumber(a?.value);
    // For verified items, keep the UI clean by requiring a positive USD value.
    // For unverified items, allow zero/unknown value as long as we have a quantity.
    const amountInt = asString(a?.quantity?.int);
    if (value == null || !Number.isFinite(value) || value <= 0) {
      if (isVerified) continue;
      if (!amountInt) continue;
    }

    const network = asString(rel?.chain?.data?.id) ?? asString(a?.chain_id) ?? asString(a?.chain) ?? "unknown";

    const fungibleId = asString(rel?.fungible?.data?.id);
    const isWallet =
      !a?.application_metadata && !a?.protocol && (asString(a?.position_type) ?? "").toLowerCase() === "wallet";
    if (isWallet && fungibleId && appFungibleIds.has(fungibleId)) {
      // Don't show wallet tokens that are accounted for by protocol/app positions.
      continue;
    }

    const appMeta = a?.application_metadata;
    const appName = asString(appMeta?.name);
    const appIconUrl = asString(appMeta?.icon?.url);
    const appUrl = asString(appMeta?.url);
    const dappId = asString(rel?.dapp?.data?.id);
    const groupId = isWallet ? "wallet" : (dappId ?? appName ?? asString(a?.protocol) ?? "unknown-app");
    const groupTitle = isWallet ? "Wallet" : (appName ?? asString(a?.protocol) ?? "App");

    const group = upsertGroup(groupId, {
      id: groupId,
      title: groupTitle,
      iconUrl: isWallet ? undefined : appIconUrl,
      url: isWallet ? undefined : appUrl,
      totalValueUsd: 0,
      rows: [],
    });

    const kind = positionKind(asString(a?.position_type));
    const valueUsd = typeof value === "number" && Number.isFinite(value) ? value : 0;
    const signed = kind === "loan" ? -valueUsd : valueUsd;
    // Keep portfolio totals/percentages driven by verified items.
    if (isVerified) group.totalValueUsd += signed;

    const tokenName = asString(a?.fungible_info?.name) ?? "Token";
    const tokenSymbol = asString(a?.fungible_info?.symbol) ?? "";
    const tokenIconUrl = asString(a?.fungible_info?.icon?.url);

    const chainId = inferChainId(network);
    if (!chainId) continue;
    // Native detection should key off the top-level id when present (e.g. "base-zksync-era-asset-asset").
    const isNative = isNativeZerionId(id) || isNativeZerionId(fungibleId);
    const impls: any[] = Array.isArray(a?.fungible_info?.implementations) ? a.fungible_info.implementations : [];
    const implForChain = impls.find(i => {
      const implChain = asString(i?.chain_id) ?? asString(i?.chain?.id) ?? asString(i?.network);
      if (implChain && implChain === network) return true;
      const implChainIdStr = asString(i?.chain_id);
      if (chainId != null && implChainIdStr && implChainIdStr === String(chainId)) return true;
      const implChainIdNum = typeof i?.chain_id === "number" ? i.chain_id : undefined;
      if (chainId != null && implChainIdNum != null && implChainIdNum === chainId) return true;
      return false;
    });
    const contract =
      asString(implForChain?.address) ??
      asString(implForChain?.contract_address) ??
      asString(a?.fungible_info?.address) ??
      asString(a?.fungible_info?.contract_address);
    const quantityNumeric = asString(a?.quantity?.numeric);
    const quantityDecimals = asNumber(a?.quantity?.decimals);
    group.rows.push({
      id: id || `${groupId}:${tokenSymbol}:${network}:${String(group.rows.length)}`,
      chain: network,
      chainId,
      standard: isNative ? "native" : "erc20",
      isVerified,
      tokenName,
      tokenSymbol,
      tokenIconUrl,
      contract: !isNative && contract && contract.startsWith("0x") ? (contract as Address) : undefined,
      kind,
      quantityText: buildQuantityText(a),
      amountInt,
      quantityNumeric,
      quantityDecimals,
      valueUsd,
      signedValueUsd: signed,
    });
  }

  // Compute portfolio total as sum of positive net groups (so debts don't create weird negative percentages).
  const groups = Array.from(groupMap.values())
    .map(g => ({
      ...g,
      // sort rows by absolute value desc
      rows: [...g.rows].sort((a, b) => b.valueUsd - a.valueUsd),
    }))
    .sort((a, b) => Math.max(b.totalValueUsd, 0) - Math.max(a.totalValueUsd, 0));

  const portfolioTotal = groups.reduce((sum, g) => sum + Math.max(g.totalValueUsd, 0), 0);

  const withPercents: ZerionPositionsViewGroup[] = groups.map(g => ({
    ...g,
    percentOfPortfolio: portfolioTotal > 0 ? (Math.max(g.totalValueUsd, 0) / portfolioTotal) * 100 : 0,
  }));

  return {
    totalValueUsd: portfolioTotal,
    groups: withPercents,
  };
}

function normalizeFungiblePositionsToAssets(params: {
  positionsJson: ZerionResponse;
  chainIds?: number[];
}): NormalizedAsset[] {
  const normalized: NormalizedAsset[] = [];

  for (const item of Array.isArray(params.positionsJson?.data) ? params.positionsJson.data : []) {
    const a: any = item?.attributes ?? {};
    const rel: any = item?.relationships ?? {};
    const id = asString((item as any)?.id);

    // Only wallet-held balances are directly transferable.
    // Protocol positions (deposit/loan/reward/etc) require an unwind and must not be treated as ERC-20 transfers.
    const positionType = (asString(a?.position_type) ?? "").toLowerCase();
    if (positionType && positionType !== "wallet") continue;
    const network = asString(rel?.chain?.data?.id) ?? asString(a?.chain_id) ?? asString(a?.chain);
    const chainId = inferChainId(network);
    if (!chainId) continue;

    const fungibleId = asString(rel?.fungible?.data?.id);
    // Native detection should key off the top-level id when present (e.g. "base-zksync-era-asset-asset").
    const isNative = isNativeZerionId(id) || isNativeZerionId(fungibleId);

    const impls: any[] = Array.isArray(a?.fungible_info?.implementations) ? a.fungible_info.implementations : [];
    const implForChain = impls.find(i => asString(i?.chain_id) === network);
    const contract = asString(implForChain?.address) ?? asString(a?.fungible_info?.address);
    const amount = asString(a?.quantity?.int);

    if (params.chainIds?.length && !params.chainIds.includes(chainId)) continue;
    if (!amount) continue;

    if (isNative) {
      normalized.push({
        chainId,
        standard: "native",
        contract: "0x0000000000000000000000000000000000000000" as Address,
        amount,
      });
      continue;
    }

    if (!contract || !contract.startsWith("0x")) continue;

    normalized.push({ chainId, standard: "erc20", contract: contract as Address, amount });
  }

  return normalized;
}

function normalizeNftPositionsToAssets(params: {
  nftPositionsJson: ZerionResponse;
  chainIds?: number[];
}): NormalizedAsset[] {
  const normalized: NormalizedAsset[] = [];

  for (const item of Array.isArray(params.nftPositionsJson?.data) ? params.nftPositionsJson.data : []) {
    const a: any = item?.attributes ?? {};
    const rel: any = item?.relationships ?? {};
    const network = asString(rel?.chain?.data?.id) ?? asString(a?.chain_id) ?? asString(a?.chain);
    const chainId = networkToChainId(network);
    if (!chainId) continue;

    const nftInfo: any = a?.nft_info ?? {};
    const contract = asString(nftInfo?.contract_address);
    const tokenId = asString(nftInfo?.token_id);
    const iface = asString(nftInfo?.interface);
    const amount = asString(a?.amount) ?? "1";
    const isSpam = Boolean(nftInfo?.flags?.is_spam);

    if (!contract || !contract.startsWith("0x")) continue;
    if (!tokenId) continue;
    if (params.chainIds?.length && !params.chainIds.includes(chainId)) continue;
    if (isSpam) continue;

    if (iface === "erc1155") {
      normalized.push({ chainId, standard: "erc1155", contract: contract as Address, tokenId, amount });
    } else {
      normalized.push({ chainId, standard: "erc721", contract: contract as Address, tokenId });
    }
  }

  return normalized;
}

function normalizeNftPositionsToView(params: {
  nftPositionsJson: ZerionResponse;
  chainIds?: number[];
}): ZerionNftView[] {
  const out: ZerionNftView[] = [];

  for (const item of Array.isArray(params.nftPositionsJson?.data) ? params.nftPositionsJson.data : []) {
    const a: any = item?.attributes ?? {};
    const rel: any = item?.relationships ?? {};
    const network = asString(rel?.chain?.data?.id) ?? asString(a?.chain_id) ?? asString(a?.chain) ?? "unknown";
    const chainId = networkToChainId(network);

    if (params.chainIds?.length && chainId != null && !params.chainIds.includes(chainId)) continue;

    const nftInfo: any = a?.nft_info ?? {};
    const collectionInfo: any = a?.collection_info ?? {};

    const contract = asString(nftInfo?.contract_address);
    const tokenId = asString(nftInfo?.token_id);
    if (!contract || !contract.startsWith("0x") || !tokenId) continue;

    const iface = (asString(nftInfo?.interface) ?? "").toLowerCase();
    const standard: ZerionNftView["standard"] = iface === "erc1155" ? "erc1155" : "erc721";
    const amount = asString(a?.amount) ?? "1";

    const isSpam = Boolean(nftInfo?.flags?.is_spam);
    if (isSpam) continue;

    const name = asString(nftInfo?.name);
    const imagePreviewUrl = asString(nftInfo?.content?.preview?.url);
    const imageDetailUrl = asString(nftInfo?.content?.detail?.url);

    const collectionName = asString(collectionInfo?.name);
    const collectionIconUrl = asString(collectionInfo?.content?.icon?.url);
    const collectionBannerUrl = asString(collectionInfo?.content?.banner?.url);

    const valueUsd = asNumber(a?.value);

    out.push({
      chain: network,
      chainId,
      standard,
      contract: contract as Address,
      tokenId,
      amount: standard === "erc1155" ? amount : undefined,
      name,
      collectionName,
      imagePreviewUrl,
      imageDetailUrl,
      collectionIconUrl,
      collectionBannerUrl,
      valueUsd,
      isSpam,
    });
  }

  return out;
}

export async function fetchZerionScanData(params: {
  compromisedAddress: Address;
  chainIds?: number[];
}): Promise<{ assets: NormalizedAsset[]; positionsView: ZerionPositionsView | null; nfts: ZerionNftView[] }> {
  const apiKey = process.env.ZERION_API_KEY;
  if (!apiKey) return { assets: [], positionsView: null, nfts: [] };

  const [positionsJson, nftPositionsJson] = await Promise.all([
    fetchZerionFungiblePositionsRaw({ apiKey, compromisedAddress: params.compromisedAddress }),
    // NFTs are best-effort: a slow/failed NFT lookup must not discard the fungible results.
    fetchNftPositions({ apiKey, compromisedAddress: params.compromisedAddress }).catch(e => {
      console.warn("[zerion] nft-positions failed; continuing without NFTs:", e instanceof Error ? e.message : e);
      return { data: [] } as ZerionResponse;
    }),
  ]);

  if (shouldDebugLogZerion()) {
    console.log("[zerion] positionsJson", JSON.stringify(positionsJson, null, 2));
    console.log("[zerion] nftPositionsJson", JSON.stringify(nftPositionsJson, null, 2));
    const summary = summarizeZerionPositionsForDebug(positionsJson);
    // Intentionally server-side only. Enable via DEBUG_ZERION=1 in env.
    console.log(
      `[zerion] scan compromisedAddress=${params.compromisedAddress} positions=${summary.itemCount} nfts=${
        Array.isArray(nftPositionsJson?.data) ? nftPositionsJson.data.length : 0
      }`,
    );
    if (summary.duplicates.length) {
      console.log(
        `[zerion] potential-duplicate-keys (top ${summary.duplicates.length}):\n${safeJsonStringify(summary.duplicates)}`,
      );
    } else {
      console.log("[zerion] potential-duplicate-keys: none detected by heuristic");
    }
    console.log(`[zerion] raw-positions (summarized):\n${safeJsonStringify(summary.rows)}`);
  }

  const assets = [
    ...normalizeFungiblePositionsToAssets({ positionsJson, chainIds: params.chainIds }),
    ...normalizeNftPositionsToAssets({ nftPositionsJson, chainIds: params.chainIds }),
  ];

  const positionsView = normalizeZerionPositionsToView(positionsJson);
  const nfts = normalizeNftPositionsToView({ nftPositionsJson, chainIds: params.chainIds });

  return { assets, positionsView, nfts };
}

export async function fetchZerionAssets(params: {
  compromisedAddress: Address;
  chainIds?: number[];
}): Promise<NormalizedAsset[]> {
  const res = await fetchZerionScanData(params);
  return res.assets;
}
