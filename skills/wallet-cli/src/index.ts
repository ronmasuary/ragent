import { execSync } from 'child_process';

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err: any) {
    const msg = err.stderr?.trim() || err.stdout?.trim() || err.message;
    throw new Error(msg);
  }
}

function tryJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

const skill = {
  name: 'wallet-cli',
  version: '1.0.0',

  tools: [
    // ── Query ──────────────────────────────────────────────────────────────
    {
      name: 'wallet_chain_info',
      description: 'Query chain information (block height, chain-id, etc.).',
      inputSchema: {
        type: 'object',
        properties: {
          rpc: { type: 'string', description: 'RPC endpoint URL (optional, overrides config)' },
        },
      },
    },
    {
      name: 'wallet_balance',
      description: 'Query the balance of an address.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Address to query' },
          denom:   { type: 'string', description: 'Token denom (optional)' },
          rpc:     { type: 'string', description: 'RPC endpoint (optional)' },
        },
        required: ['address'],
      },
    },
    {
      name: 'wallet_balances',
      description: 'Query all balances of an address.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Address to query' },
          rpc:     { type: 'string', description: 'RPC endpoint (optional)' },
        },
        required: ['address'],
      },
    },
    {
      name: 'wallet_account',
      description: 'Query account info (sequence, account number) for an address.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Address to query' },
          rpc:     { type: 'string', description: 'RPC endpoint (optional)' },
        },
        required: ['address'],
      },
    },
    {
      name: 'wallet_snapshot',
      description: 'Query the full snapshot for an address.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Address to query' },
          rpc:     { type: 'string', description: 'RPC endpoint (optional)' },
        },
        required: ['address'],
      },
    },
    {
      name: 'wallet_profile',
      description: 'Query safe/profile snapshot for an address.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Address to query' },
          rpc:     { type: 'string', description: 'RPC endpoint (optional)' },
        },
        required: ['address'],
      },
    },
    {
      name: 'wallet_assets',
      description: 'Query asset balances for the configured user.',
      inputSchema: {
        type: 'object',
        properties: {
          rpc: { type: 'string', description: 'RPC endpoint (optional)' },
        },
      },
    },
    // ── Keys ───────────────────────────────────────────────────────────────
    {
      name: 'wallet_keys_list',
      description: 'List all key IDs on the signing application.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wallet_keys_get',
      description: 'Get a key by ID from the signing application.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Key ID' },
        },
        required: ['id'],
      },
    },
    {
      name: 'wallet_keys_create',
      description: 'Create a new key pair on the signing application.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Key name/label' },
        },
        required: ['name'],
      },
    },
    // ── Transactions ───────────────────────────────────────────────────────
    {
      name: 'wallet_tx_send',
      description: 'Build an unsigned bank send transaction.',
      inputSchema: {
        type: 'object',
        properties: {
          from:   { type: 'string', description: 'Sender address' },
          to:     { type: 'string', description: 'Recipient address' },
          amount: { type: 'string', description: 'Amount with denom, e.g. 1000uatom' },
          rpc:    { type: 'string', description: 'RPC endpoint (optional)' },
        },
        required: ['from', 'to', 'amount'],
      },
    },
    {
      name: 'wallet_tx_create_transaction',
      description: 'Build a transaction to transfer assets (Omnistar safe/profile flow).',
      inputSchema: {
        type: 'object',
        properties: {
          from:   { type: 'string', description: 'Sender address' },
          to:     { type: 'string', description: 'Recipient address' },
          amount: { type: 'string', description: 'Amount with denom' },
          rpc:    { type: 'string', description: 'RPC endpoint (optional)' },
        },
        required: ['from', 'to', 'amount'],
      },
    },
    {
      name: 'wallet_tx_vote',
      description: 'Submit a vote on an object signature.',
      inputSchema: {
        type: 'object',
        properties: {
          object_id: { type: 'string', description: 'Object/transaction ID to vote on' },
          vote:      { type: 'string', description: 'Vote value (e.g. yes/no/approve)' },
          rpc:       { type: 'string', description: 'RPC endpoint (optional)' },
        },
        required: ['object_id', 'vote'],
      },
    },
    {
      name: 'wallet_tx_create_safe',
      description: 'Create a new safe with initialization and registration.',
      inputSchema: {
        type: 'object',
        properties: {
          rpc: { type: 'string', description: 'RPC endpoint (optional)' },
        },
      },
    },
    {
      name: 'wallet_tx_create_policy',
      description: 'Create a new policy with conditions.',
      inputSchema: {
        type: 'object',
        properties: {
          rpc: { type: 'string', description: 'RPC endpoint (optional)' },
        },
      },
    },
    {
      name: 'wallet_config_show',
      description: 'Show the current wallet-cli configuration.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],

  async execute(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    const rpcFlag  = input.rpc     ? `--rpc "${input.rpc}"` : '';

    switch (toolName) {
      // ── Query ─────────────────────────────────────────────────────────────
      case 'wallet_chain_info':
        return tryJson(run(`wallet-cli query chain-info ${rpcFlag}`));

      case 'wallet_balance': {
        const denomFlag = input.denom ? `--denom "${input.denom}"` : '';
        return tryJson(run(`wallet-cli query balance --address "${input.address}" ${denomFlag} ${rpcFlag}`));
      }

      case 'wallet_balances':
        return tryJson(run(`wallet-cli query balances --address "${input.address}" ${rpcFlag}`));

      case 'wallet_account':
        return tryJson(run(`wallet-cli query account --address "${input.address}" ${rpcFlag}`));

      case 'wallet_snapshot':
        return tryJson(run(`wallet-cli query snapshot --address "${input.address}" ${rpcFlag}`));

      case 'wallet_profile':
        return tryJson(run(`wallet-cli query profile --address "${input.address}" ${rpcFlag}`));

      case 'wallet_assets':
        return tryJson(run(`wallet-cli query assets ${rpcFlag}`));

      // ── Keys ──────────────────────────────────────────────────────────────
      case 'wallet_keys_list':
        return tryJson(run(`wallet-cli keys list`));

      case 'wallet_keys_get':
        return tryJson(run(`wallet-cli keys get --id "${input.id}"`));

      case 'wallet_keys_create':
        return tryJson(run(`wallet-cli keys create --name "${input.name}"`));

      // ── Transactions ──────────────────────────────────────────────────────
      case 'wallet_tx_send':
        return tryJson(run(
          `wallet-cli tx send --from "${input.from}" --to "${input.to}" --amount "${input.amount}" ${rpcFlag}`
        ));

      case 'wallet_tx_create_transaction':
        return tryJson(run(
          `wallet-cli tx create-transaction --from "${input.from}" --to "${input.to}" --amount "${input.amount}" ${rpcFlag}`
        ));

      case 'wallet_tx_vote':
        return tryJson(run(
          `wallet-cli tx vote --object-id "${input.object_id}" --vote "${input.vote}" ${rpcFlag}`
        ));

      case 'wallet_tx_create_safe':
        return tryJson(run(`wallet-cli tx create-safe ${rpcFlag}`));

      case 'wallet_tx_create_policy':
        return tryJson(run(`wallet-cli tx create-policy ${rpcFlag}`));

      // ── Config ────────────────────────────────────────────────────────────
      case 'wallet_config_show':
        return tryJson(run(`wallet-cli config show`));

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  },

  systemPrompt: `You have access to the wallet-cli skill for the Omnistar chain.

Tools available:
- wallet_chain_info — get chain status
- wallet_balance / wallet_balances — query balances
- wallet_account — query account sequence/number
- wallet_snapshot / wallet_profile — full chain state for an address
- wallet_assets — assets for the configured user
- wallet_keys_list / wallet_keys_get / wallet_keys_create — manage signing keys
- wallet_tx_send — build unsigned bank send tx
- wallet_tx_create_transaction — build Omnistar asset transfer tx
- wallet_tx_vote — vote on a pending object signature
- wallet_tx_create_safe / wallet_tx_create_policy — safe and policy management
- wallet_config_show — inspect current CLI config

All tx tools return unsigned transactions — they do not broadcast. The user must sign and submit separately.`,
};

export default skill;
