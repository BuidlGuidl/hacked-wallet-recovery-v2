import type { RecoveryAsset } from "./calls";
import { keccak256, toHex } from "viem";

function pow10(n: number): bigint {
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid pow10 exponent: ${String(n)}`);
  let r = 1n;
  for (let i = 0; i < n; i++) r *= 10n;
  return r;
}

function divCeil(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("divCeil: division by zero");
  return (n + d - 1n) / d;
}

export function toUsdMicros(priceUsd: number): bigint | null {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  // Round to 1e-6 USD precision.
  return BigInt(Math.round(priceUsd * 1_000_000));
}

export function weiToUsdMicros(args: { wei: bigint; nativeDecimals: number; nativeUsdMicrosPerToken: bigint }): bigint {
  const denom = pow10(args.nativeDecimals);
  return (args.wei * args.nativeUsdMicrosPerToken) / denom;
}

export function usdMicrosToWeiCeil(args: {
  usdMicros: bigint;
  nativeDecimals: number;
  nativeUsdMicrosPerToken: bigint;
}): bigint {
  const denom = pow10(args.nativeDecimals);
  return divCeil(args.usdMicros * denom, args.nativeUsdMicrosPerToken);
}

type CachedPrice = { usdMicrosPerUnit: bigint; fetchedAtMs: number };
const priceCache = new Map<string, CachedPrice>();
const PRICE_TTL_MS = 60_000;

type CachedPlatform = { platformId: string | null; nativeCoinId: string | null; fetchedAtMs: number };
const platformCacheByChainId = new Map<number, CachedPlatform>();
const PLATFORM_TTL_MS = 24 * 60 * 60_000;

const DEFAULT_COINGECKO_TIMEOUT_MS = 8_000;

function coingeckoTimeoutMs(): number {
  const raw = process.env.COINGECKO_TIMEOUT_MS ?? process.env.CG_TIMEOUT_MS;
  const n = raw && raw.trim() ? Number(raw) : DEFAULT_COINGECKO_TIMEOUT_MS;
  // Guard rails: keep it bounded so we don't hang serverless functions.
  if (!Number.isFinite(n)) return DEFAULT_COINGECKO_TIMEOUT_MS;
  return Math.max(1_000, Math.min(30_000, Math.floor(n)));
}

function cgHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY || process.env.CG_API_KEY;
  // CoinGecko supports API key headers on some plans; keep best-effort and allow anonymous for dev.
  return key ? { "x-cg-pro-api-key": key } : {};
}

function cgBaseUrl(): string {
  // Allow overriding for Pro vs free endpoints
  return (process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3").replace(/\/+$/, "");
}

function cacheGet(key: string): bigint | null {
  const now = Date.now();
  const cached = priceCache.get(key);
  if (cached && now - cached.fetchedAtMs < PRICE_TTL_MS) return cached.usdMicrosPerUnit;
  return null;
}

function cacheSet(key: string, usdMicrosPerUnit: bigint) {
  priceCache.set(key, { usdMicrosPerUnit, fetchedAtMs: Date.now() });
}

async function warmPlatformCache(chainId?: number): Promise<void> {
  const now = Date.now();
  if (typeof chainId === "number") {
    const cached = platformCacheByChainId.get(chainId);
    if (cached && now - cached.fetchedAtMs < PLATFORM_TTL_MS) return;
  } else {
    for (const v of platformCacheByChainId.values()) {
      if (now - v.fetchedAtMs < PLATFORM_TTL_MS) return;
    }
  }

  const url = `${cgBaseUrl()}/asset_platforms`;
  const json = await fetchJson(url).catch(() => null);
  if (!Array.isArray(json)) return;

  for (const p of json) {
    const cid = typeof p?.chain_identifier === "number" ? p.chain_identifier : Number(p?.chain_identifier);
    if (!Number.isFinite(cid)) continue;
    const platformId = typeof p?.id === "string" ? p.id : null;
    const nativeCoinId = typeof p?.native_coin_id === "string" ? p.native_coin_id : null;
    platformCacheByChainId.set(cid, { platformId, nativeCoinId, fetchedAtMs: now });
  }
}

// Minimal chain mappings for CoinGecko "simple" endpoints.
// Extend as needed.
export function coingeckoNativeIdForChainId(chainId: number): string | null {
  const cached = platformCacheByChainId.get(chainId);
  if (cached?.nativeCoinId) return cached.nativeCoinId;
  switch (chainId) {
    case 31337:
      return null;
    case 1:
    case 11155111:
      return "ethereum";
    case 10:
    case 11155420:
      return "ethereum"; // Optimism uses ETH
    case 42161:
    case 421614:
      return "ethereum"; // Arbitrum uses ETH
    case 8453:
    case 84532:
      return "ethereum"; // Base uses ETH
    case 130: // Unichain
    case 480: // World
    case 48900: // Zircuit
    case 57073: // Ink
    case 7777777: // Zora
    case 1868: // Soneium
    case 747474: // Katana
      return "ethereum";
    case 137:
    case 80002:
      return "matic-network";
    case 100:
      return "xdai";
    case 56:
      return "binancecoin";
    case 42220:
      return "celo";
    case 2020:
      return "ronin";
    case 5000:
      return "mantle";
    default:
      return null;
  }
}

export function coingeckoPlatformForChainId(chainId: number): string | null {
  const cached = platformCacheByChainId.get(chainId);
  if (cached?.platformId) return cached.platformId;
  switch (chainId) {
    case 31337:
      return null;
    case 1:
      return "ethereum";
    case 10:
      return "optimistic-ethereum";
    case 42161:
      return "arbitrum-one";
    case 8453:
      return "base";
    case 137:
      return "polygon-pos";
    case 100:
      return "xdai";
    case 130: // Unichain (likely on CoinGecko; otherwise resolved via /asset_platforms)
    case 143: // Monad
    case 480: // World
    case 988: // Stable
    case 1868: // Soneium
    case 57073: // Ink
    case 747474: // Katana
    case 7777777: // Zora
      return null; // will be populated via warmPlatformCache() if CoinGecko knows the chain_identifier
    case 56:
      return "binance-smart-chain";
    case 42220:
      return "celo";
    case 2020:
      return "ronin";
    case 5000:
      return "mantle";
    default:
      return null;
  }
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), coingeckoTimeoutMs());
  try {
    const res = await fetch(url, { headers: cgHeaders(), signal: controller.signal });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function getNativeUsdMicrosPerToken(chainId: number): Promise<bigint | null> {
  await warmPlatformCache(chainId);
  const coinId = coingeckoNativeIdForChainId(chainId);
  if (!coinId) {
    // Gnosis Chain native (xDAI) is intended to be ~$1.00.
    if (chainId === 100) return 1_000_000n;
    return null;
  }
  const cacheKey = `native:${coinId}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  const url = `${cgBaseUrl()}/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd`;
  const json = await fetchJson(url).catch(() => null);
  const priceUsd = json?.[coinId]?.usd;
  const usdMicros = toUsdMicros(typeof priceUsd === "number" ? priceUsd : Number(priceUsd));
  if (!usdMicros) {
    if (chainId === 100) return 1_000_000n;
    return null;
  }
  cacheSet(cacheKey, usdMicros);
  return usdMicros;
}

export async function getErc20UsdMicrosPerToken(args: {
  chainId: number;
  tokenAddress: string;
}): Promise<bigint | null> {
  await warmPlatformCache(args.chainId);
  const platform = coingeckoPlatformForChainId(args.chainId);
  if (!platform) return null;
  const addr = args.tokenAddress.toLowerCase();
  const cacheKey = `erc20:${platform}:${addr}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  const url =
    `${cgBaseUrl()}/simple/token_price/${encodeURIComponent(platform)}` +
    `?contract_addresses=${encodeURIComponent(addr)}` +
    `&vs_currencies=usd`;
  const json = await fetchJson(url).catch(() => null);
  const priceUsd = json?.[addr]?.usd;
  const usdMicros = toUsdMicros(typeof priceUsd === "number" ? priceUsd : Number(priceUsd));
  if (!usdMicros) return null;
  cacheSet(cacheKey, usdMicros);
  return usdMicros;
}

export function canonicalAssetsHash(assets: RecoveryAsset[]): `0x${string}` {
  // Stable, minimal representation: fixed key order + stable sorting.
  const normalized = assets
    .map(a => ({
      chainId: a.chainId,
      standard: a.standard,
      contract: (a.contract ?? "0x").toLowerCase(),
      tokenId: a.tokenId ?? null,
      amount: a.amount ?? null,
      functionSignature: (a as any).functionSignature ?? null,
      args: Array.isArray((a as any).args) ? (a as any).args : null,
      valueWei: (a as any).valueWei ?? null,
      dataHex: (a as any).dataHex ?? null,
    }))
    .sort((x, y) => {
      if (x.chainId !== y.chainId) return x.chainId - y.chainId;
      if (x.standard !== y.standard) return x.standard < y.standard ? -1 : 1;
      if (x.contract !== y.contract) return x.contract < y.contract ? -1 : 1;
      const xt = x.tokenId ?? "";
      const yt = y.tokenId ?? "";
      if (xt !== yt) return xt < yt ? -1 : 1;
      const xa = x.amount ?? "";
      const ya = y.amount ?? "";
      if (xa !== ya) return xa < ya ? -1 : 1;
      const xs = x.functionSignature ?? "";
      const ys = y.functionSignature ?? "";
      if (xs !== ys) return xs < ys ? -1 : 1;
      const xw = x.valueWei ?? "";
      const yw = y.valueWei ?? "";
      if (xw !== yw) return xw < yw ? -1 : 1;
      const xd = x.dataHex ?? "";
      const yd = y.dataHex ?? "";
      if (xd !== yd) return xd < yd ? -1 : 1;
      const xargs = JSON.stringify(x.args ?? []);
      const yargs = JSON.stringify(y.args ?? []);
      if (xargs !== yargs) return xargs < yargs ? -1 : 1;
      return 0;
    });

  const json = JSON.stringify(normalized);
  return keccak256(toHex(json));
}
