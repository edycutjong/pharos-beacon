import { defineChain } from "viem";

// Source: PharosNetwork/pharos-skill-engine assets/networks.json (chains) and assets/tokens.json (TOKENS below)
export const atlantic = defineChain({
  id: 688689,
  name: "Pharos Atlantic Testnet",
  nativeCurrency: { name: "PHRS", symbol: "PHRS", decimals: 18 },
  rpcUrls: { default: { http: ["https://atlantic.dplabs-internal.com"] } },
  blockExplorers: { default: { name: "PharosScan", url: "https://atlantic.pharosscan.xyz" } },
  testnet: true,
});

export const pharos = defineChain({
  id: 1672,
  name: "Pharos Mainnet",
  nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.pharos.xyz"] } },
  blockExplorers: { default: { name: "PharosScan", url: "https://www.pharosscan.xyz" } },
});

export const TOKENS = {
  atlantic: {
    USDC: { address: "0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8", decimals: 6 },
    USDT: { address: "0xE7E84B8B4f39C507499c40B4ac199B050e2882d5", decimals: 6 },
    WBTC: { address: "0x0c64F03EEa5c30946D5c55B4b532D08ad74638a4", decimals: 18 },
    WETH: { address: "0x7d211F77525ea39A0592794f793cC1036eEaccD5", decimals: 18 },
    WPHRS: { address: "0x838800b758277CC111B2d48Ab01e5E164f8E9471", decimals: 18 },
  },
  pharos: {
    WPROS: { address: "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0", decimals: 18 },
    USDC: { address: "0xc879c018db60520f4355c26ed1a6d572cdac1815", decimals: 6 },
    LINK: { address: "0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29", decimals: 18 },
    WETH: { address: "0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9", decimals: 18 },
  },
} as const;
