import { id } from 'ethers';
import { ETHEREUM_MAINNET_CHAIN_ID } from '../chains/chains.config.js';

export { ETHEREUM_MAINNET_CHAIN_ID };
export const ERC20_ERC721_TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
export const ERC1155_TRANSFER_SINGLE_TOPIC = id('TransferSingle(address,address,address,uint256,uint256)');
export const ERC1155_TRANSFER_BATCH_TOPIC = id('TransferBatch(address,address,address,uint256[],uint256[])');

export const ERC721_INTERFACE_ID = '0x80ac58cd';
export const ERC1155_INTERFACE_ID = '0xd9b67a26';

export const ERC165_ABI = ['function supportsInterface(bytes4 interfaceId) view returns (bool)'];
export const ERC20_METADATA_ABI = [
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)'
];

export const ETHEREUM_EXPLORER_TX_BASE_URL = 'https://etherscan.io/tx/';
