import type { Abi } from "abitype";
import { GenericContractsDeclaration } from "~~/utils/scaffold-eth/contract";

/**
 * @example
 * const externalContracts = {
 *   1: {
 *     DAI: {
 *       address: "0x...",
 *       abi: [...],
 *     },
 *   },
 * } as const;
 */
/**
 * UniversalRecoveryDelegate deployments across supported networks.
 */
const UNIVERSAL_RECOVERY_DELEGATE_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "_paymaster",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "receive",
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "PAYMASTER",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "executeBatchRecovery",
    inputs: [
      {
        name: "_recoveryAddress",
        type: "address",
        internalType: "address",
      },
      {
        name: "calls",
        type: "tuple[]",
        internalType: "struct UniversalRecoveryDelegate.Call[]",
        components: [
          {
            name: "to",
            type: "address",
            internalType: "address",
          },
          {
            name: "value",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "data",
            type: "bytes",
            internalType: "bytes",
          },
        ],
      },
      {
        name: "authorizer",
        type: "address",
        internalType: "address",
      },
      {
        name: "nonce",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "deadline",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "signature",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "nonces",
    inputs: [{ name: "", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "recoveryIntentDigest",
    inputs: [
      { name: "recoveryAddress", type: "address", internalType: "address" },
      {
        name: "calls",
        type: "tuple[]",
        internalType: "struct UniversalRecoveryDelegate.Call[]",
        components: [
          { name: "to", type: "address", internalType: "address" },
          { name: "value", type: "uint256", internalType: "uint256" },
          { name: "data", type: "bytes", internalType: "bytes" },
        ],
      },
      { name: "nonce", type: "uint256", internalType: "uint256" },
      { name: "deadline", type: "uint256", internalType: "uint256" },
    ],
    outputs: [
      { name: "digest", type: "bytes32", internalType: "bytes32" },
      { name: "callsHash", type: "bytes32", internalType: "bytes32" },
    ],
    stateMutability: "view",
  },
  {
    type: "error",
    name: "CallFailed",
    inputs: [
      {
        name: "index",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "value",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "data",
        type: "bytes",
        internalType: "bytes",
      },
      {
        name: "reason",
        type: "bytes",
        internalType: "bytes",
      },
    ],
  },
  {
    type: "error",
    name: "IntentExpired",
    inputs: [
      { name: "deadline", type: "uint256", internalType: "uint256" },
      { name: "nowTs", type: "uint256", internalType: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InvalidNonce",
    inputs: [
      { name: "signer", type: "address", internalType: "address" },
      { name: "expected", type: "uint256", internalType: "uint256" },
      { name: "provided", type: "uint256", internalType: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InvalidSignature",
    inputs: [],
  },
] as const satisfies Abi;

export const CREATE2_FACTORY_ABI = [
  {
    type: "function",
    name: "deploy",
    inputs: [
      {
        name: "initCode",
        type: "bytes",
        internalType: "bytes",
      },
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "addr",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "event",
    name: "Deployed",
    inputs: [
      {
        name: "addr",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "salt",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
    ],
    anonymous: false,
  },
] as const satisfies Abi;

const DELEGATE = {
  UniversalRecoveryDelegate: {
    address: "0x681BcBC1fBc1c8A2f1F5b4A43e6D38c5CA220892",
    abi: UNIVERSAL_RECOVERY_DELEGATE_ABI,
  },
} as const;

/**
 * Supported chains. Every entry must support EIP-7702 and have the delegate deployed
 * (and the paymaster funded). Chains with a public mempool need a private/encrypted
 * execution RPC (see EXECUTION_RPC_OVERRIDES in utils/recovery/viemServer.ts).
 *
 * Deliberately excluded (last checked 2026-11-11):
 * - Avalanche (43114): C-Chain rejects type-4 (EIP-7702) transactions.
 * - Blast (81457): official RPC offline, major providers dropped the chain.
 * - HyperEVM (999): delegate deployed, but rejects type-4 transactions.
 * - Polygon (137), Sonic (146), Zircuit (48900): public mempool, no private RPC option.
 */
const externalContracts = {
  1: DELEGATE, // Ethereum: public mempool, executed via Flashbots
  10: DELEGATE, // OP Mainnet
  56: DELEGATE, // BNB Chain: public mempool, executed via blinklabs
  100: DELEGATE, // Gnosis: public mempool, executed via Shutter encrypted RPC
  130: DELEGATE, // Unichain
  143: DELEGATE, // Monad
  480: DELEGATE, // World Chain
  1868: DELEGATE, // Soneium
  2020: DELEGATE, // Ronin
  5000: DELEGATE, // Mantle
  8453: DELEGATE, // Base
  42161: DELEGATE, // Arbitrum One
  42220: DELEGATE, // Celo
  57073: DELEGATE, // Ink
  747474: DELEGATE, // Katana
  7777777: DELEGATE, // Zora
} as const;

export default externalContracts satisfies GenericContractsDeclaration;
