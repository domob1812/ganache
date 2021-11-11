import { EthereumInternalOptions } from "@ganache/ethereum-options";
import { Data, Quantity, KNOWN_CHAINIDS } from "@ganache/utils";
import AbortController from "abort-controller";
import Common from "@ethereumjs/common";
import { HttpHandler } from "./handlers/http-handler";
import { WsHandler } from "./handlers/ws-handler";
import { Handler } from "./types";
import { Tag } from "@ganache/ethereum-utils";
import { Block } from "@ganache/ethereum-block";
import { Address } from "@ganache/ethereum-address";
import { Account } from "@ganache/ethereum-utils";
import BlockManager from "../data-managers/block-manager";
import { ProviderHandler } from "./handlers/provider-handler";
import { BN } from "ethereumjs-util";

async function fetchChainId(fork: Fork) {
  const chainIdHex = await fork.request<string>("eth_chainId", []);
  return parseInt(chainIdHex, 16);
}
async function fetchNetworkId(fork: Fork) {
  const networkIdStr = await fork.request<string>("net_version", []);
  return parseInt(networkIdStr, 10);
}
function fetchBlockNumber(fork: Fork) {
  return fork.request<string>("eth_blockNumber", []);
}
function fetchBlock(fork: Fork, blockNumber: Quantity | Tag.LATEST) {
  return fork.request<any>("eth_getBlockByNumber", [blockNumber, true]);
}
async function fetchNonce(
  fork: Fork,
  address: Address,
  blockNumber: Quantity | Tag.LATEST
) {
  const nonce = await fork.request<string>("eth_getTransactionCount", [
    address,
    blockNumber
  ]);
  return Quantity.from(nonce);
}

export class Fork {
  public common: Common;
  #abortController = new AbortController();
  #handler: Handler;
  #options: EthereumInternalOptions;
  #accounts: Account[];
  #hardfork: string;

  public blockNumber: Quantity;
  public stateRoot: Data;
  public block: Block;
  public chainId: number;

  constructor(options: EthereumInternalOptions, accounts: Account[]) {
    this.#options = options;
    const forkingOptions = options.fork;
    this.#hardfork = options.chain.hardfork;
    this.#accounts = accounts;

    const { url } = forkingOptions;
    if (url) {
      const { protocol } = url;

      switch (protocol) {
        case "ws:":
        case "wss:":
          this.#handler = new WsHandler(options, this.#abortController.signal);
          break;
        case "http:":
        case "https:":
          this.#handler = new HttpHandler(
            options,
            this.#abortController.signal
          );
          break;
        default: {
          throw new Error(`Unsupported protocol: ${protocol}`);
        }
      }
    } else if (forkingOptions.provider) {
      this.#handler = new ProviderHandler(
        options,
        this.#abortController.signal
      );
    }
  }

  #setCommonFromChain = async () => {
    const [chainId, networkId] = await Promise.all([
      fetchChainId(this),
      fetchNetworkId(this)
    ]);

    this.chainId = chainId;

    this.common = Common.forCustomChain(
      KNOWN_CHAINIDS.has(chainId) ? chainId : 1,
      {
        name: "ganache-fork",
        defaultHardfork: this.#hardfork,
        networkId,
        chainId: this.#options.chain.chainId,
        comment: "Local test network fork"
      }
    );
    (this.common as any).on = () => {};
  };

  #setBlockDataFromChainAndOptions = async () => {
    const { fork: options } = this.#options;
    if (options.blockNumber === Tag.LATEST) {
      // if our block number option is "latest" override it with the original
      // chain's current blockNumber
      const block = await fetchBlock(this, Tag.LATEST);
      options.blockNumber = parseInt(block.number, 16);
      this.blockNumber = Quantity.from(options.blockNumber);
      this.stateRoot = Data.from(block.stateRoot);
      await this.#syncAccounts(this.blockNumber);
      return block;
    } else if (typeof options.blockNumber === "number") {
      const blockNumber = Quantity.from(options.blockNumber);
      const [block] = await Promise.all([
        fetchBlock(this, blockNumber).then(async block => {
          this.stateRoot = block.stateRoot;
          await this.#syncAccounts(blockNumber);
          return block;
        }),
        fetchBlockNumber(this).then((latestBlockNumberHex: string) => {
          const latestBlockNumberInt = parseInt(latestBlockNumberHex, 16);
          // if our block number option is _after_ the current block number
          // throw, as it likely wasn't intentional and doesn't make sense.
          if (options.blockNumber > latestBlockNumberInt) {
            throw new Error(
              `\`fork.blockNumber\` (${options.blockNumber}) must not be greater than the current block number (${latestBlockNumberInt})`
            );
          } else {
            this.blockNumber = blockNumber;
          }
        })
      ]);
      return block;
    } else {
      throw new Error(
        `Invalid value for \`fork.blockNumber\` option: "${options.blockNumber}". Must be a positive integer or the string "latest".`
      );
    }
  };

  #syncAccounts = (blockNumber: Quantity) => {
    return Promise.all(
      this.#accounts.map(async account => {
        const nonce = await fetchNonce(this, account.address, blockNumber);
        account.nonce = nonce;
      })
    );
  };

  public async initialize() {
    const [block] = await Promise.all([
      this.#setBlockDataFromChainAndOptions(),
      this.#setCommonFromChain()
    ]);
    this.block = new Block(
      BlockManager.rawFromJSON(block, this.common),
      this.common
    );
  }

  public request<T = unknown>(method: string, params: unknown[]): Promise<T> {
    return this.#handler.request<T>(method, params);
  }

  public abort() {
    return this.#abortController.abort();
  }

  public close() {
    return this.#handler.close();
  }

  public selectValidForkBlockNumber(blockNumber: Quantity) {
    return blockNumber.toBigInt() < this.blockNumber.toBigInt()
      ? blockNumber
      : this.blockNumber;
  }

  /**
   * If the blockNumber is before our fork.blockNumber return a Common instance
   * applying the rules from the remote chain's via it's original chainId. If
   * the remote chain's chain id is now "known", return a common with our local
   * common's rules applied, but with the remote chain's chainId. If the block
   * is greater than or equal to our fork.blockNumber returns `common`.
   * @param common
   * @param blockNumber
   */
  public getCommonForBlockNumber(common: Common, blockNumber: BN) {
    const bigIntBlockNumber = Quantity.from(blockNumber.toBuffer()).toBigInt();
    if (bigIntBlockNumber <= this.blockNumber.toBigInt()) {
      // we are at or before our fork block

      if (KNOWN_CHAINIDS.has(this.chainId)) {
        // we support this chain id, so let's use its rules
        const common = new Common({ chain: this.chainId });
        common.setHardforkByBlockNumber(blockNumber);
        return common;
      } else {
        // we don't know about this chain, so just carry on per usual
        return Common.forCustomChain(
          1,
          { chainId: this.chainId },
          common.hardfork()
        );
      }
    } else {
      return common;
    }
  }
}
