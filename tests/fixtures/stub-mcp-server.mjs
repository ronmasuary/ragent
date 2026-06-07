#!/usr/bin/env node
// Tiny stdio MCP server fixture exposing one `echo` tool. Used by manager tests.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'stub', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo back the given message.',
      inputSchema: {
        type: 'object',
        properties: { msg: { type: 'string' } },
        required: ['msg'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'echo') {
    return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true };
  }
  const msg = req.params.arguments?.msg ?? '';
  return { content: [{ type: 'text', text: `echo: ${msg}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
